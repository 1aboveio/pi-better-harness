import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

interface ToolComponent {
  expanded: boolean;
  showImages: boolean;
  resultRendererComponent?: unknown;
  toolName?: string;
  toolCallId?: string;
  result?: { isError?: boolean };
  ui: { requestRender(): void; children?: ChatContainer[] };
  invalidate(): void;
  setExpanded(expanded: boolean): void;
  render(width: number): string[];
}

type Method = (this: ToolComponent, ...args: unknown[]) => unknown;
interface ToolPrototype {
  updateDisplay: Method;
  getResultRenderer: Method;
  getTextOutput: Method;
  setExpanded: Method;
  invalidate: Method;
  [HOOK]?: HookState;
}
interface ChatContainer {
  children: unknown[];
  render: (width: number) => string[];
  mouseLayout?: { width: number; children: Array<{ component: unknown; height: number }> };
  [CHAT]?: { original: (width: number) => string[]; wrapper: (width: number) => string[] };
}
interface ContainerPrototype {
  addChild: (child: unknown, ...rest: unknown[]) => unknown;
  render: (width: number) => string[];
  [ADD]?: { original: ContainerPrototype["addChild"]; wrapper: ContainerPrototype["addChild"] };
}
interface HookState {
  enabled: boolean;
  owners: number;
  foldsTurns: boolean;
  closeRuns(): void;
  redraw(collapse?: boolean): void;
  restore(): void;
  installContainer(prototype: ContainerPrototype): void;
}
export interface MinimalOutputHook {
  setEnabled(enabled: boolean): void;
  dispose(): void;
  readonly foldsTurns: boolean;
}
interface FoldSummary {
  render(width: number): string[];
  invalidate(): void;
  handleMouse(event: { type?: string; button?: string }): { handled: true } | undefined;
  setTools(tools: ToolComponent[]): void;
}

const HOOK = Symbol.for("pi-better-harness.minimal-output-hook");
const CHAT = Symbol.for("pi-better-harness.minimal-output-chat");
const ADD = Symbol.for("pi-better-harness.minimal-output-add-child");
const emptyResult = () => ({ render: () => [] as string[], invalidate() {} });

function hostRequire(): NodeRequire {
  let require = createRequire(import.meta.url);
  if (process.argv[1]) {
    try {
      const candidate = createRequire(realpathSync(process.argv[1]));
      sdkEntry(candidate);
      require = candidate;
    } catch { /* SDK embedding or a test runner: use the extension's SDK. */ }
  }
  return require;
}

/** Bundled CLI classes are distinct from the SDK's unbundled deep imports. */
function bundledHostEntry(entry: string): string | undefined {
  if (!process.argv[1]) return undefined;
  try {
    const directory = dirname(realpathSync(process.argv[1]));
    if (directory === join(dirname(entry), "bundle")) return join(directory, "index.js");
  } catch { /* An embedded host may not have a filesystem launcher. */ }
  return undefined;
}

/** Resolve the running host's SDK, not a second SDK bundled beside the extension. */
export async function loadToolPrototype(): Promise<ToolPrototype> {
  const entry = sdkEntry(hostRequire());
  const bundle = bundledHostEntry(entry);
  const path = bundle ?? join(dirname(entry), "modes/interactive/components/tool-execution.js");
  const module = await import(pathToFileURL(path).href);
  if (!module.ToolExecutionComponent?.prototype) {
    throw new Error("Pi's runtime does not expose its tool display class. Normal output remains enabled.");
  }
  return module.ToolExecutionComponent.prototype;
}

/** Use the actual tool class's Container base, including in bundled hosts. */
export async function loadContainerPrototype(): Promise<ContainerPrototype> {
  const prototype = Object.getPrototypeOf(await loadToolPrototype());
  if (typeof prototype?.addChild !== "function" || typeof prototype?.render !== "function") {
    throw new Error("Pi's chat container API is incompatible: missing Container.addChild. Turn folding is unavailable.");
  }
  return prototype;
}

export async function loadMutedText(): Promise<(text: string) => string> {
  const entry = sdkEntry(hostRequire());
  // The bundled SDK does not export its live theme singleton.
  if (bundledHostEntry(entry)) return (text) => text;
  const theme = await import(pathToFileURL(join(dirname(entry), "modes/interactive/theme/theme.js")).href);
  return (text) => {
    try { return theme.theme.fg("muted", text); } catch { return text; }
  };
}

// Pi's ESM-only export cannot be resolved with require.resolve on older SDKs.
function sdkEntry(require: ReturnType<typeof createRequire>): string {
  for (const directory of require.resolve.paths("@earendil-works/pi-coding-agent") ?? []) {
    const root = join(directory, "@earendil-works/pi-coding-agent");
    try {
      const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      const entry = metadata.exports?.["."]?.import ?? metadata.main;
      if (metadata.name === "@earendil-works/pi-coding-agent" && typeof entry === "string") return join(root, entry);
    } catch { /* Continue through Node's module search paths. */ }
  }
  throw new Error("Could not locate the running Pi SDK. Normal output remains enabled.");
}

function hasModelText(component: unknown): boolean {
  const content = (component as { lastMessage?: { content?: unknown } } | null)?.lastMessage?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
}

function formatRun(tools: ToolComponent[], open: boolean): string {
  const counts = new Map<string, number>();
  let errors = 0;
  for (const tool of tools) {
    const name = tool.toolName || "tool";
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (tool.result?.isError) errors += 1;
  }
  const names = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
  const noun = tools.length === 1 ? "tool" : "tools";
  const error = errors === 0 ? "" : errors === 1 ? " · 1 error" : ` · ${errors} errors`;
  return `${open ? "▾" : "▸"} ${tools.length} ${noun}${error} · ${names.join(", ")}`;
}

function clip(text: string, width: number): string {
  if (width <= 0 || text.length <= width) return text;
  return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

/** Internal TUI adapter: no tools are replaced and no result content is changed. */
export function installMinimalOutputHook(
  prototype: ToolPrototype,
  containerPrototype?: ContainerPrototype,
  muted: (text: string) => string = (text) => text,
): MinimalOutputHook {
  for (const name of ["updateDisplay", "getResultRenderer", "getTextOutput", "setExpanded", "invalidate"] as const) {
    if (typeof prototype[name] !== "function") {
      throw new Error(`Pi's tool display API is incompatible: missing ${name}. Normal output remains enabled.`);
    }
  }
  let state = prototype[HOOK];
  if (!state) {
    const originals = {
      updateDisplay: prototype.updateDisplay,
      getResultRenderer: prototype.getResultRenderer,
      getTextOutput: prototype.getTextOutput,
    };
    const seen = new WeakSet<ToolComponent>();
    const components = new Set<WeakRef<ToolComponent>>();
    const chats = new Set<WeakRef<ChatContainer>>();
    const summaries = new WeakMap<ToolComponent, FoldSummary>();
    const openedAt = new WeakMap<ToolComponent, number>();
    let generation = 0;
    let containerHooked = false;
    let installedContainer: ContainerPrototype | undefined;
    const isOpen = (tool: ToolComponent) => openedAt.get(tool) === generation;
    const laterModelText = (children: unknown[], index: number) => {
      for (let i = index; i < children.length; i++) {
        if (hasModelText(children[i])) return true;
      }
      return false;
    };
    const attachFromTool = (tool: ToolComponent) => {
      for (const child of tool.ui?.children ?? []) {
        if (child?.children?.includes(tool)) wrapChat(child);
      }
    };
    const wrapChat = (container: ChatContainer) => {
      if (!container || seen.has(container as unknown as ToolComponent) || container[CHAT] || typeof container.render !== "function") return;
      const original = container.render;
      const wrapper = function (this: ChatContainer, width: number) {
        if (!current.enabled || !Array.isArray(this.children) || !needsFold(this.children)) return original.call(this, width);
        const lines: string[] = [];
        const mouseChildren: Array<{ component: unknown; height: number }> = [];
        const push = (component: { render(width: number): string[] }) => {
          const childLines = component.render(width) ?? [];
          mouseChildren.push({ component, height: childLines.length });
          lines.push(...childLines);
        };
        let index = 0;
        while (index < this.children.length) {
          const child = this.children[index];
          if (!seen.has(child as ToolComponent)) {
            push(child as { render(width: number): string[] });
            index += 1;
            continue;
          }
          let end = index;
          while (end < this.children.length && seen.has(this.children[end] as ToolComponent)) end += 1;
          const tools = this.children.slice(index, end) as ToolComponent[];
          const closed = laterModelText(this.children, end) && tools.every((tool) => !tool.expanded);
          if (!closed) {
            for (const tool of tools) push(tool);
          } else {
            const open = isOpen(tools[0]!);
            let summary = summaries.get(tools[0]!);
            if (!summary) {
              summary = createSummary(tools[0]!);
              summaries.set(tools[0]!, summary);
            }
            summary.setTools(tools);
            push(summary);
            if (open) for (const tool of tools) push(tool);
          }
          index = end;
        }
        this.mouseLayout = { width, children: mouseChildren };
        return lines;
      };
      container[CHAT] = { original, wrapper };
      container.render = wrapper;
      chats.add(new WeakRef(container));
    };
    const createSummary = (anchor: ToolComponent): FoldSummary => {
      let tools = [anchor];
      return {
        setTools(next) { tools = next; },
        invalidate() {},
        render(width) {
          return ["", muted(clip(formatRun(tools, isOpen(anchor)), width))];
        },
        handleMouse(event) {
          if (event.type !== "click" || (event.button && event.button !== "left")) return undefined;
          if (isOpen(anchor)) openedAt.delete(anchor);
          else openedAt.set(anchor, generation);
          anchor.ui.requestRender();
          return { handled: true };
        },
      };
    };
    const needsFold = (children: unknown[]) => {
      let index = 0;
      while (index < children.length) {
        if (!seen.has(children[index] as ToolComponent)) { index += 1; continue; }
        let end = index;
        while (end < children.length && seen.has(children[end] as ToolComponent)) end += 1;
        const tools = children.slice(index, end) as ToolComponent[];
        if (laterModelText(children, end) && tools.every((tool) => !tool.expanded)) return true;
        index = end;
      }
      return false;
    };
    state = {
      enabled: false,
      owners: 0,
      foldsTurns: false,
      closeRuns() { generation += 1; },
      redraw(collapse = false) {
        for (const reference of components) {
          const component = reference.deref();
          if (!component) { components.delete(reference); continue; }
          if (collapse) component.setExpanded(false);
          else component.invalidate();
          attachFromTool(component);
          component.ui.requestRender();
        }
      },
      installContainer(next) {
        if (containerHooked) return;
        if (typeof next.addChild !== "function") {
          throw new Error("Pi's chat container API is incompatible: missing Container.addChild. Turn folding is unavailable.");
        }
        const original = next[ADD]?.original ?? next.addChild;
        const wrapper: ContainerPrototype["addChild"] = function (this: ChatContainer, child, ...rest) {
          const result = original.call(this, child, ...rest);
          if (seen.has(child as ToolComponent)) wrapChat(this);
          return result;
        };
        next.addChild = wrapper;
        next[ADD] = { original, wrapper };
        containerHooked = true;
        installedContainer = next;
        state!.foldsTurns = true;
      },
      restore() {
        for (const name of Object.keys(originals) as Array<keyof typeof originals>) {
          // Do not remove another extension's subsequently installed wrapper.
          if (prototype[name] === wrappers[name]) prototype[name] = originals[name];
        }
        delete prototype[HOOK];
        components.clear();
        if (installedContainer && installedContainer[ADD]?.wrapper === installedContainer.addChild) {
          installedContainer.addChild = installedContainer[ADD].original;
          delete installedContainer[ADD];
        }
        for (const reference of chats) {
          const container = reference.deref();
          if (container?.[CHAT] && container.render === container[CHAT].wrapper) container.render = container[CHAT].original;
          if (container) delete container[CHAT];
        }
        chats.clear();
      },
    };
    const current = state;
    const wrappers = {
      updateDisplay(this: ToolComponent, ...args: unknown[]) {
        if (!seen.has(this)) { seen.add(this); components.add(new WeakRef(this)); }
        attachFromTool(this);
        if (!current.enabled || this.expanded) return originals.updateDisplay.apply(this, args);
        const showImages = this.showImages;
        const lastRenderer = this.resultRendererComponent;
        this.showImages = false;
        try {
          return originals.updateDisplay.apply(this, args);
        } finally {
          this.showImages = showImages;
          // Expanded mode must get the original renderer's previous component, not our empty one.
          this.resultRendererComponent = lastRenderer;
        }
      },
      getResultRenderer(this: ToolComponent, ...args: unknown[]) {
        return current.enabled && !this.expanded ? emptyResult : originals.getResultRenderer.apply(this, args);
      },
      getTextOutput(this: ToolComponent, ...args: unknown[]) {
        return current.enabled && !this.expanded ? "" : originals.getTextOutput.apply(this, args);
      },
    };
    Object.assign(prototype, wrappers);
    prototype[HOOK] = state;
  }
  const current = state;
  if (containerPrototype) current.installContainer(containerPrototype);
  current.owners += 1;
  let disposed = false;
  return {
    foldsTurns: current.foldsTurns,
    setEnabled(enabled) {
      if (disposed) return;
      current.enabled = enabled;
      if (enabled) current.closeRuns();
      current.redraw(enabled);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      current.owners -= 1;
      if (current.owners > 0) return;
      current.enabled = false;
      current.redraw();
      current.restore();
    },
  };
}
