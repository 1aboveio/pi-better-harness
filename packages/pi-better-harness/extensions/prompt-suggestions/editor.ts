import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BLOCKED = Symbol.for("pi-better-harness.editor-input-blocked");
const BASE = Symbol.for("pi-better-harness.editor-base-factory");


export interface GhostEditor {
  show(text: string): boolean;
  clear(): void;
  available(): boolean;
  unsupportedReason(): string | undefined;
  dispose(): void;
}

export function installGhostEditor(ctx: any, callbacks: { changed(): void; accepted(): void; unused(): void; eligible?(): boolean }): GhostEditor {
  const previous = ctx.ui.getEditorComponent();
  let inner: any;
  let live: any;
  let tui: any;
  let ghost: string | undefined;
  let disposed = false;
  let changing = false;
  // Unknown factories may carry modal state; do not recreate them to probe compatibility.
  let base = previous;
  const decorators = new Set();
  while (base) {
    if (typeof base !== "function" || decorators.has(base) || !Object.hasOwn(base, BASE)) { disposed = true; break; }
    decorators.add(base);
    base = base[BASE];
  }
  function clear(unused = false): void {
    if (ghost && unused) callbacks.unused();
    ghost = undefined;
    tui?.requestRender();
  }
  function available(): boolean {
    if (callbacks.eligible?.() === false || unsupportedReason() || !inner || inner.getText() !== "" || !inner.focused || inner.isShowingAutocomplete?.() || inner[BLOCKED]?.()) return false;
    return true;
  }
  function unsupportedReason(): string | undefined {
    if (disposed) return "Custom editor is not supported";
    let current = ctx.ui.getEditorComponent();
    const seen = new Set();
    while (current !== factory) {
      if (typeof current !== "function" || seen.has(current)) return "Editor was replaced by another extension";
      seen.add(current);
      current = current[BASE];
    }
    return undefined;
  }
  const factory: any = (host: any, theme: any, kb: any) => {
    tui = host;
    inner = previous ? previous(host, theme, kb) : new CustomEditor(host, theme, kb);
    // Only the native editor contract is suitable for empty-buffer ghost rendering.
    if (Object.getPrototypeOf(inner)?.constructor?.name !== "CustomEditor") { disposed = true; return inner; }
    let originalChange = inner.onChange;
    const onChange = (text: string) => {
      originalChange?.(text);
      if (!changing) { clear(true); callbacks.changed(); }
    };
    inner.onChange = onChange;
    live = new Proxy(inner, {
      get(target, prop) {
        if (prop === "handleInput") return (data: string) => {
          const suggestionKey = matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "escape");
          if (ghost && available() && suggestionKey) {
            const appAction = [...target.actionHandlers.keys()].some(action =>
              (action !== "app.interrupt" || !matchesKey(data, "escape")) && kb.matches(data, action));
            if (appAction) { clear(true); callbacks.changed(); target.handleInput(data); return; }
            if (target.onExtensionShortcut?.(data)) { clear(true); callbacks.changed(); return; }
          }
          if (ghost && available() && (matchesKey(data, "tab") || matchesKey(data, "right"))) {
            const text = ghost;
            clear();
            changing = true;
            try { target.insertTextAtCursor(text); } finally { changing = false; }
            callbacks.accepted();
            return;
          }
          if (ghost && available() && matchesKey(data, "escape")) { clear(true); callbacks.changed(); return; }
          clear(true);
          callbacks.changed();
          target.handleInput(data);
        };
        if (prop === "render") return (width: number) => {
          const lines = target.render(width);
          if (!ghost || !available()) return lines;
          const row = lines.findIndex((line: string) => line.includes(CURSOR_MARKER));
          if (row < 0) return lines;
          const before = lines[row].split(CURSOR_MARKER)[0];
          const room = Math.max(0, width - visibleWidth(before));
          const cursor = room > 0 ? "\x1b[7m \x1b[0m" : "";
          lines[row] = before + CURSOR_MARKER + cursor + ctx.ui.theme.fg("muted", truncateToWidth(ghost, Math.max(0, room - 1)));
          return lines;
        };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, prop, value) {
        if (prop === "onChange") { originalChange = value; target.onChange = onChange; return true; }
        return Reflect.set(target, prop, value);
      },
    });
    return live;
  };

  if (!disposed) ctx.ui.setEditorComponent(factory);
  return {
    available,
    unsupportedReason,
    show(text) { if (!available()) return false; ghost = text; tui.requestRender(); return true; },
    clear() { clear(); },
    dispose() {
      disposed = true;
      clear();
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
    },
  };
}