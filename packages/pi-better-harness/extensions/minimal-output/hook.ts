import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface ToolUI {
  requestRender(): void;
  children?: TranscriptComponent[];
  handleViewportInput?(data: string): unknown;
}
interface ToolComponent {
  toolName: string;
  toolCallId: string;
  args: unknown;
  callRendererComponent?: Component;
  expanded: boolean;
  isPartial?: boolean;
  result?: { isError?: boolean };
  showImages: boolean;
  resultRendererComponent?: unknown;
  ui: ToolUI;
  invalidate(): void;
  setExpanded(expanded: boolean): void;
  render(width: number): string[];
}

interface TranscriptComponent extends Component {
  children?: TranscriptComponent[];
  outputPad?: number;
  lastMessage?: { content: { type: string; text?: string; thinking?: string }[]; stopReason?: string };
}
interface ToolGroup { members: ToolComponent[]; open: boolean; expanded: number }

type Method = (this: ToolComponent, ...args: unknown[]) => unknown;
interface ToolMouseEvent { type: string; button: string; x: number; y: number; screenX: number; screenY: number; width: number; shift?: boolean; alt?: boolean; ctrl?: boolean }
type MouseHandler = (this: ToolComponent, event: ToolMouseEvent) => unknown;
interface ToolPrototype {
  handleMouse?: MouseHandler;
  updateDisplay: Method;
  getResultRenderer: Method;
  getTextOutput: Method;
  setExpanded: Method;
  invalidate: Method;
  render: ToolComponent["render"];
  [HOOK]?: HookState;
}
interface HookState {
  enabled: boolean;
  owners: number;
  redraw(collapse?: boolean): void;
  restore(): void;
  completeRun(): void;
  restoreCompletedCalls(ids: Iterable<string>): void;
  handleTerminalInput(data: string): void;
}
export interface MinimalOutputHook {
  setEnabled(enabled: boolean): void;
  completeRun(): void;
  restoreCompletedCalls(ids: Iterable<string>): void;
  dispose(): void;
}

const HOOK = Symbol.for("pi-better-harness.minimal-output-hook");
const emptyResult = () => ({ render: () => [] as string[], invalidate() {} });
const TOOL_ICONS: Record<string, string> = {
  bash: "\u2318",
  read: "\u25a4",
  write: "\u2710",
  edit: "\u270e",
  grep: "\u2315",
  find: "\u2316",
  ls: "\u2261",
};

function compactCall(component: ToolComponent, width: number, theme?: Theme, indent = 3): string[] {
  if (width <= 0) return [];
  // Render the call alone at a wider width so terminal wrapping becomes truncation.
  const header = component.callRendererComponent?.render(Math.max(4096, width + 1))
    .map((line) => stripVTControlCharacters(line).trim())
    .find((line) => line.length > 0);
  let text = header;
  if (!text) {
    const args = component.args as Record<string, unknown> | undefined;
    const hint = args?.command ?? args?.path ?? args?.pattern;
    const detail = typeof hint === "string" ? hint.replace(/\r?\n/g, " ") : JSON.stringify(component.args);
    text = `${component.toolName}${detail && detail !== "{}" ? ` ${detail}` : ""}`;
  }
  const failed = component.result?.isError === true;
  const running = !component.result || component.isPartial;
  const detail = text.startsWith(`${component.toolName} `) ? text.slice(component.toolName.length).trimStart()
    : text === component.toolName ? "" : text;
  const label = component.toolName === "bash" ? "Shell"
    : component.toolName.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase());
  const suffix = failed ? " (failed)" : running ? " (running)" : "";
  const icon = TOOL_ICONS[component.toolName] ?? "\u25c7";
  const title = ` ${icon} ${label}`;
  const styled = theme
    ? ` ${theme.fg(failed ? "error" : running ? "accent" : "muted", icon)} ${theme.fg("muted", label)}${detail ? `  ${theme.fg("dim", detail)}` : ""}${theme.fg(failed ? "error" : "dim", suffix)}`
    : `${title}${detail ? `  ${detail}` : ""}${suffix}`;
  return [truncateToWidth(`${" ".repeat(Math.min(indent, Math.max(0, width - 1)))}${styled}`, width)];
}

function toolParent(component: ToolComponent): TranscriptComponent | undefined {
  const visit = (children: TranscriptComponent[]): TranscriptComponent | undefined => {
    for (const child of children) {
      if (child.children?.includes(component)) return child;
      if (child.children) {
        const found = visit(child.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(component.ui.children ?? []);
}

function paddingAnchor(component: ToolComponent, parent?: TranscriptComponent): TranscriptComponent | undefined {
  const siblings = parent?.children ?? [];
  for (let index = siblings.indexOf(component) - 1; index >= 0; index--) {
    if (typeof siblings[index].outputPad === "number") return siblings[index];
  }
  return undefined;
}

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

/** Internal TUI adapter: no tools are replaced and no result content is changed. */
export function installMinimalOutputHook(prototype: ToolPrototype, getTheme?: () => Theme): MinimalOutputHook {
  for (const name of ["updateDisplay", "getResultRenderer", "getTextOutput", "setExpanded", "invalidate", "render"] as const) {
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
      setExpanded: prototype.setExpanded,
      render: prototype.render,
      ...(typeof prototype.handleMouse === "function" ? { handleMouse: prototype.handleMouse } : {}),
    };
    let mouseHandling = false;
    const inputWrappers = new Map<ToolUI, { original: NonNullable<ToolUI["handleViewportInput"]>; wrapper: NonNullable<ToolUI["handleViewportInput"]> }>();
    let hovered: { component: ToolComponent; row: number; left: number; top: number; width: number } | undefined;
    const clearHover = () => {
      if (!hovered) return;
      const component = hovered.component;
      hovered = undefined;
      component.ui.requestRender();
    };
    const highlight = (component: ToolComponent, lines: string[], width: number): string[] => {
      if (hovered?.component !== component) return lines;
      const theme = getTheme?.();
      if (width !== hovered.width || hovered.row >= lines.length) { clearHover(); return lines; }
      if (theme) {
        const row = lines[hovered.row] + " ".repeat(Math.max(0, width - visibleWidth(lines[hovered.row])));
        const shaded = theme.bg("selectedBg", row);
        lines[hovered.row] = shaded.startsWith("\x1b[49m") ? theme.inverse(row) : shaded;
      }
      return lines;
    };
    const seen = new WeakSet<ToolComponent>();
    const components = new Set<WeakRef<ToolComponent>>();
    let completed = new Map<string, object>();
    let groups = new WeakMap<ToolComponent, ToolGroup>();
    let layouts = new WeakMap<ToolComponent, { parent: TranscriptComponent; anchor?: TranscriptComponent }>();
    const layoutFor = (component: ToolComponent) => {
      const cached = layouts.get(component);
      if (cached) return cached;
      const parent = toolParent(component);
      if (!parent) return undefined;
      const layout = { parent, anchor: paddingAnchor(component, parent) };
      layouts.set(component, layout);
      return layout;
    };
    const groupFor = (component: ToolComponent, parent?: TranscriptComponent): ToolGroup | undefined => {
      const cached = groups.get(component);
      if (cached) return cached;
      if (!completed.has(component.toolCallId) || component.isPartial || !parent?.children) return undefined;
      let members: ToolComponent[] = [];
      const save = () => {
        if (!members.length) return;
        const group = { members, open: false, expanded: members.filter(member => member.expanded).length };
        for (const member of members) groups.set(member, group);
        members = [];
      };
      for (const child of parent.children) {
        const tool = child as ToolComponent;
        if (seen.has(tool) && completed.has(tool.toolCallId) && !tool.isPartial && !groups.has(tool)) {
          if (members.length && completed.get(members[0].toolCallId) !== completed.get(tool.toolCallId)) save();
          members.push(tool);
        } else if (typeof child.outputPad === "number" && child.lastMessage
          && !["length", "error", "aborted"].includes(child.lastMessage.stopReason ?? "")
          && !child.lastMessage.content.some(content => content.text?.trim() || content.thinking?.trim())) {
          // Tool-only assistant messages occupy no transcript rows and do not split a visual block.
          continue;
        } else save();
      }
      save();
      return groups.get(component);
    };
    state = {
      enabled: false,
      owners: 0,
      completeRun() {
        const run = {};
        for (const reference of components) {
          const component = reference.deref();
          if (component?.result && !component.isPartial && !completed.has(component.toolCallId)) {
            completed.set(component.toolCallId, run);
            if (this.enabled) component.setExpanded(false);
          }
        }
        this.redraw();
      },
      restoreCompletedCalls(ids) {
        const history = {};
        completed = new Map(Array.from(ids, id => [id, history]));
        groups = new WeakMap();
        layouts = new WeakMap();
        this.redraw();
      },
      redraw(collapse = false) {
        clearHover();
        for (const reference of components) {
          const component = reference.deref();
          if (!component) { components.delete(reference); continue; }
          if (collapse) component.setExpanded(false);
          else component.invalidate();
          component.ui.requestRender();
        }
      },
      restore() {
        clearHover();
        for (const [ui, { original, wrapper }] of inputWrappers) {
          if (ui.handleViewportInput === wrapper) ui.handleViewportInput = original;
        }
        inputWrappers.clear();
        for (const name of ["updateDisplay", "getResultRenderer", "getTextOutput", "setExpanded", "render"] as const) {
          // Do not remove another extension's subsequently installed wrapper.
          if (prototype[name] === wrappers[name]) Object.assign(prototype, { [name]: originals[name] });
        }
        if (originals.handleMouse && prototype.handleMouse === mouseWrapper) prototype.handleMouse = originals.handleMouse;
        delete prototype[HOOK];
        components.clear();
      },
      handleTerminalInput(data) {
        if (!hovered) return;
        // Pi routes moves only to the new target; observe input to clear a row on exit.
        const motion = /^\x1b\[<35;(\d+);(\d+)M$/.exec(data);
        if (motion) {
          const x = Number(motion[1]) - 1;
          const y = Number(motion[2]) - 1;
          if (y === hovered.top && x >= hovered.left && x < hovered.left + hovered.width) return;
        }
        clearHover();
      },
    };
    const current = state;
    const wrappers = {
      updateDisplay(this: ToolComponent, ...args: unknown[]) {
        if (typeof this.ui.handleViewportInput === "function" && !inputWrappers.has(this.ui)) {
          const original = this.ui.handleViewportInput;
          const wrapper = function(this: ToolUI, data: string) {
            current.handleTerminalInput(data);
            return original.call(this, data);
          };
          inputWrappers.set(this.ui, { original, wrapper });
          this.ui.handleViewportInput = wrapper;
        }
        if (!seen.has(this)) { seen.add(this); components.add(new WeakRef(this)); }
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
      setExpanded(this: ToolComponent, ...args: unknown[]) {
        clearHover();
        const group = groups.get(this);
        const wasExpanded = this.expanded;
        if (args[0] === false && !mouseHandling && group) group.open = false;
        const result = originals.setExpanded.apply(this, args);
        if (group) group.expanded += Number(this.expanded) - Number(wasExpanded);
        return result;
      },
      getResultRenderer(this: ToolComponent, ...args: unknown[]) {
        return current.enabled && !this.expanded ? emptyResult : originals.getResultRenderer.apply(this, args);
      },
      getTextOutput(this: ToolComponent, ...args: unknown[]) {
        return current.enabled && !this.expanded ? "" : originals.getTextOutput.apply(this, args);
      },
      render(this: ToolComponent, width: number): string[] {
        if (!current.enabled || this.expanded) return originals.render.call(this, width);
        const layout = layoutFor(this);
        const padding = layout?.anchor?.outputPad ?? 1;
        const indent = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) + 2 : 3;
        const group = groupFor(this, layout?.parent);
        if (!group) return highlight(this, compactCall(this, width, getTheme?.(), indent), width);
        const open = group.open || group.expanded > 0;
        const first = group.members[0] === this;
        const lines: string[] = [];
        if (first && width > 0) {
          const failed = group.members.filter(member => member.result?.isError).length;
          const text = `${open ? "\u25be" : "\u25b8"} ${group.members.length} tool call${group.members.length === 1 ? "" : "s"}`;
          const failure = failed ? `${failed} failed` : "";
          const theme = getTheme?.();
          const styled = theme
            ? `${theme.fg("muted", text)}${failed ? `${theme.fg("dim", " \u00b7 ")}${theme.fg("error", failure)}` : ""}`
            : `${text}${failed ? ` \u00b7 ${failure}` : ""}`;
          lines.push(truncateToWidth(`${" ".repeat(Math.min(indent, Math.max(0, width - 1)))}${styled}`, width));
        }
        if (open) lines.push(...compactCall(this, width, getTheme?.(), indent + 2));
        return highlight(this, lines, width);
      },
    };
    const mouseWrapper: MouseHandler = function(event) {
      if (current.enabled && !this.expanded) {
        if (event.type === "move" && event.button === "none") {
          const lines = this.render(event.width);
          if (event.y < 0 || event.y >= lines.length) { clearHover(); return undefined; }
          if (hovered?.component === this && hovered.row === event.y) return { handled: true, render: false };
          clearHover();
          hovered = { component: this, row: event.y, left: event.screenX - event.x, top: event.screenY, width: event.width };
          return { handled: true, render: true };
        }
        if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
        const group = groupFor(this, layoutFor(this)?.parent);
        if (group?.members[0] === this && event.y === 0) {
          group.open = !(group.open || group.expanded > 0);
          if (!group.open) for (const member of group.members) member.setExpanded(false);
          this.ui.requestRender();
          return { handled: true, render: true };
        }
        if (event.y !== (group?.members[0] === this ? 1 : 0)) return undefined;
        this.setExpanded(true);
        this.ui.requestRender();
        return { handled: true, render: true };
      }
      mouseHandling = true;
      try { return originals.handleMouse?.call(this, event); }
      finally { mouseHandling = false; }
    };
    if (originals.handleMouse) prototype.handleMouse = mouseWrapper;
    Object.assign(prototype, wrappers);
    prototype[HOOK] = state;
  }
  const current = state;
  current.owners += 1;
  let disposed = false;
  return {
    completeRun() { if (!disposed) current.completeRun(); },
    restoreCompletedCalls(ids) { if (!disposed) current.restoreCompletedCalls(ids); },
    setEnabled(enabled) {
      if (disposed) return;
      current.enabled = enabled;
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
