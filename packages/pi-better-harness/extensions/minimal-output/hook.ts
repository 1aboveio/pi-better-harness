import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

interface ToolComponent {
  toolName: string;
  args: unknown;
  callRendererComponent?: Component;
  expanded: boolean;
  showImages: boolean;
  resultRendererComponent?: unknown;
  ui: { requestRender(): void };
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
  render: ToolComponent["render"];
  [HOOK]?: HookState;
}
interface HookState {
  enabled: boolean;
  owners: number;
  redraw(collapse?: boolean): void;
  restore(): void;
}
export interface MinimalOutputHook {
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

const HOOK = Symbol.for("pi-better-harness.minimal-output-hook");
const emptyResult = () => ({ render: () => [] as string[], invalidate() {} });

function compactCall(component: ToolComponent, width: number): string[] {
  if (width <= 0) return [];
  // Render the call alone at a wider width so terminal wrapping becomes truncation.
  const header = component.callRendererComponent?.render(Math.max(4096, width + 1))
    .map((line) => stripVTControlCharacters(line).trim())
    .find((line) => line.length > 0);
  let text = header;
  if (!text) {
    const args = JSON.stringify(component.args);
    text = `${component.toolName}${args && args !== "{}" ? ` ${args}` : ""}`;
  }
  return [truncateToWidth(text, width)];
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
export function installMinimalOutputHook(prototype: ToolPrototype): MinimalOutputHook {
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
      render: prototype.render,
    };
    const seen = new WeakSet<ToolComponent>();
    const components = new Set<WeakRef<ToolComponent>>();
    state = {
      enabled: false,
      owners: 0,
      redraw(collapse = false) {
        for (const reference of components) {
          const component = reference.deref();
          if (!component) { components.delete(reference); continue; }
          if (collapse) component.setExpanded(false);
          else component.invalidate();
          component.ui.requestRender();
        }
      },
      restore() {
        for (const name of Object.keys(originals) as Array<keyof typeof originals>) {
          // Do not remove another extension's subsequently installed wrapper.
          if (prototype[name] === wrappers[name]) Object.assign(prototype, { [name]: originals[name] });
        }
        delete prototype[HOOK];
        components.clear();
      },
    };
    const current = state;
    const wrappers = {
      updateDisplay(this: ToolComponent, ...args: unknown[]) {
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
      getResultRenderer(this: ToolComponent, ...args: unknown[]) {
        return current.enabled && !this.expanded ? emptyResult : originals.getResultRenderer.apply(this, args);
      },
      getTextOutput(this: ToolComponent, ...args: unknown[]) {
        return current.enabled && !this.expanded ? "" : originals.getTextOutput.apply(this, args);
      },
      render(this: ToolComponent, width: number): string[] {
        return current.enabled && !this.expanded ? compactCall(this, width) : originals.render.call(this, width);
      },
    };
    Object.assign(prototype, wrappers);
    prototype[HOOK] = state;
  }
  const current = state;
  current.owners += 1;
  let disposed = false;
  return {
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
