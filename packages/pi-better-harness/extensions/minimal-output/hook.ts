import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

interface ToolComponent {
  expanded: boolean;
  showImages: boolean;
  resultRendererComponent?: unknown;
  ui: { requestRender(): void };
  invalidate(): void;
  setExpanded(expanded: boolean): void;
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

/** Resolve the running host's SDK, not a second SDK bundled beside the extension. */
export async function loadToolPrototype(): Promise<ToolPrototype> {
  let require = createRequire(import.meta.url);
  if (process.argv[1]) {
    try {
      const hostRequire = createRequire(realpathSync(process.argv[1]));
      sdkEntry(hostRequire);
      require = hostRequire;
    } catch { /* SDK embedding or a test runner: use the extension's SDK. */ }
  }
  const entry = sdkEntry(require);
  const path = join(dirname(entry), "modes/interactive/components/tool-execution.js");
  const module = await import(pathToFileURL(path).href);
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
          if (prototype[name] === wrappers[name]) prototype[name] = originals[name];
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
