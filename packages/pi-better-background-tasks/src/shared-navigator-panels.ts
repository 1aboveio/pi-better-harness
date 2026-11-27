// Generated from packages/navigator/panels.ts. Do not edit directly.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { readHarnessSetting, updateHarnessSetting } from "./shared-harness-settings.js";

export const NAVIGATOR_PANEL_WIDGET_KEY = "background-work-list";
export const NAVIGATOR_ENTRY_TYPE = "pi-better-harness-navigator-panels";
export const NAVIGATOR_STICKY_SETTING_ID = "navigator-sticky";
type MouseEvent = { type: string; button: string; x: number; y: number; width: number; shift?: boolean; alt?: boolean; ctrl?: boolean };
type PanelComponent = Component & { dispose?(): void; handleMouse?(event: MouseEvent): { handled: true; render: boolean } | undefined };
export type NavigatorPanelLayout = { availableRows(): number };
export type NavigatorPanelFactory = (tui: TUI, theme: Theme, layout: NavigatorPanelLayout) => PanelComponent;
type Panel = { factory: NavigatorPanelFactory; component?: PanelComponent | undefined };
type Preference = { version: 1; sticky: boolean };
type Owner = { pi: ExtensionAPI; stop?: (() => void) | undefined };
type State = {
  panels: Map<string, Panel>;
  owners: Map<ExtensionAPI, Owner>;
  ctx?: ExtensionContext | undefined;
  ui?: ExtensionContext["ui"] | undefined;
  pi?: ExtensionAPI | undefined;
  sticky: boolean;
  mounted: boolean;
  tui?: TUI | undefined;
  theme?: Theme | undefined;
  host?: Component | undefined;
  availableRows?: number | undefined;
  anchor?: string | undefined;
  pendingAnchor: boolean;
  generation: number;
  ranges: Array<{ start: number; end: number; component: PanelComponent }>;
  control?: { id: string; label: string; values: string[]; get(): string; change(value: string, ctx: ExtensionContext): void } | undefined;
};
const KEY = Symbol.for("pi-better-harness.navigator-panels.state");
function state(): State {
  const global = globalThis as typeof globalThis & { [KEY]?: State };
  return global[KEY] ??= { panels: new Map(), owners: new Map(), sticky: true, mounted: false, pendingAnchor: false, generation: 0, ranges: [] };
}
function parsePreference(value: unknown): Preference {
  if (value === undefined) return { version: 1, sticky: true };
  const preference = value as Partial<Preference> | null;
  if (!preference || preference.version !== 1 || typeof preference.sticky !== "boolean") {
    throw new Error("Navigator preference must contain version 1 and a boolean sticky value.");
  }
  return { version: 1, sticky: preference.sticky };
}
function canScroll(pi: ExtensionAPI | undefined): boolean {
  return typeof pi?.registerEntryRenderer === "function" && typeof pi?.appendEntry === "function";
}
function isTui(ctx: ExtensionContext | undefined): ctx is ExtensionContext {
  return ctx?.mode === "tui" && ctx.hasUI && typeof ctx.ui?.setWidget === "function";
}
function disposePanels(s: State): void {
  for (const panel of s.panels.values()) {
    try { panel.component?.dispose?.(); } catch { /* stale UI cleanup is best effort */ }
    panel.component = undefined;
  }
  s.ranges = [];
}
function orderedPanels(s: State): Panel[] {
  const rank = (key: string) => key === "pi-better-goal" ? 0 : key === "pi-better-plan" ? 1 : 2;
  return [...s.panels.entries()].sort(([a], [b]) => rank(a) - rank(b)).map(([, panel]) => panel);
}
function buildPanels(s: State): void {
  if (!s.tui || !s.theme) return;
  for (const panel of orderedPanels(s)) panel.component ??= panel.factory(s.tui, s.theme, { availableRows: () => s.availableRows ?? Infinity });
}
// Count the editor, footer and other siblings following the host in regular mode.
// Never render ancestors here: they contain this host and would recurse.
function rowsAfter(root: object, target: Component, width: number): number | undefined {
  if (root === target) return 0;
  const children = (root as Component & { children?: Component[] }).children;
  if (!children) return undefined;
  for (let i = children.length - 1; i >= 0; i--) {
    const after = rowsAfter(children[i]!, target, width);
    if (after !== undefined) return after + children.slice(i + 1).reduce((sum, child) => sum + child.render(width).length, 0);
  }
  return undefined;
}
function renderPanels(s: State, width: number): string[] {
  buildPanels(s);
  const lines: string[] = [];
  s.ranges = [];
  const after = s.sticky && s.tui && s.host ? rowsAfter(s.tui, s.host, width) : undefined;
  const height = s.tui?.terminal?.rows;
  const budget = after !== undefined && height ? Math.max(0, height - after) : Infinity;
  for (const panel of orderedPanels(s)) {
    if (!panel.component) continue;
    s.availableRows = Math.max(0, budget - lines.length);
    const rendered = panel.component.render(width);
    s.ranges.push({ start: lines.length, end: lines.length + rendered.length, component: panel.component });
    lines.push(...rendered);
  }
  return lines;
}
function mouse(s: State, event: MouseEvent) {
  const range = s.ranges.find(range => event.y >= range.start && event.y < range.end);
  return range?.component.handleMouse?.({ ...event, y: event.y - range.start });
}
function restoreAnchor(ctx: ExtensionContext): string | undefined {
  let anchor: string | undefined;
  for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
    if (entry.type !== "custom" || entry.customType !== NAVIGATOR_ENTRY_TYPE) continue;
    const data = entry.data as { version?: unknown; anchor?: unknown } | undefined;
    if (data?.version === 1 && typeof data.anchor === "string") anchor = data.anchor;
  }
  return anchor;
}
function appendAnchor(s: State): void {
  if (s.sticky || s.anchor || !canScroll(s.pi)) return;
  const anchor = randomUUID();
  s.anchor = anchor;
  try { s.pi!.appendEntry(NAVIGATOR_ENTRY_TYPE, { version: 1, anchor }); }
  catch (error) { s.anchor = undefined; throw error; }
}
function scheduleAnchor(s: State): void {
  if (s.anchor || s.pendingAnchor || s.sticky) return;
  s.pendingAnchor = true;
  const generation = s.generation;
  // Session writes cannot run inside a component render. Empty sessions stay untouched.
  queueMicrotask(() => {
    if (generation !== s.generation) return;
    s.pendingAnchor = false;
    if (!s.sticky && s.panels.size) appendAnchor(s);
  });
}
function clearHost(s: State): void {
  s.generation++;
  s.pendingAnchor = false;
  try {
    if (s.mounted && isTui(s.ctx)) s.ctx.ui.setWidget(NAVIGATOR_PANEL_WIDGET_KEY, undefined);
  } catch { /* an old session context may already be detached */ }
  disposePanels(s);
  s.mounted = false;
  s.tui = undefined;
  s.host = undefined;
  s.theme = undefined;
}
function adoptContext(s: State, ctx: ExtensionContext): void {
  if (s.ui && s.ui !== ctx.ui) {
    clearHost(s);
    s.panels.clear();
    s.anchor = undefined;
  }
  s.ctx = ctx;
  s.ui = ctx.ui;
}
function mountHost(s: State): void {
  if (!isTui(s.ctx) || s.mounted || !s.panels.size) return;
  s.mounted = true;
  s.ctx.ui.setWidget(NAVIGATOR_PANEL_WIDGET_KEY, (tui, theme) => {
    if (s.tui !== tui || s.theme !== theme) disposePanels(s);
    s.tui = tui;
    s.theme = theme;
    buildPanels(s);
    const host: PanelComponent = {
      render(width: number) {
        const lines = renderPanels(s, width);
        if (s.sticky) return lines;
        if (lines.length) scheduleAnchor(s);
        return [];
      },
      handleMouse: (event: MouseEvent) => s.sticky ? mouse(s, event) : undefined,
      invalidate() {
        for (const panel of s.panels.values()) panel.component?.invalidate();
      },
      dispose() { disposePanels(s); s.mounted = false; },
    };
    s.host = host;
    return host;
  }, { placement: "aboveEditor" });
}
function changeSticky(value: string, ctx: ExtensionContext): void {
  if (value !== "On" && value !== "Off") throw new Error("Sticky navigator expects On or Off.");
  const s = state();
  if (value === "Off" && !canScroll(s.pi)) {
    throw new Error("Scrolling navigator requires a Pi version with registerEntryRenderer support.");
  }
  updateHarnessSetting("navigator", current => {
    parsePreference(current);
    return { version: 1, sticky: value === "On" };
  });
  adoptContext(s, ctx);
  if (s.sticky && value === "Off") s.anchor = undefined;
  s.sticky = value === "On";
  refreshNavigatorPanels(ctx);
}
export function initializeNavigatorPanels(pi: ExtensionAPI): void {
  const s = state();
  if (s.owners.has(pi)) return;
  s.pi = pi;
  try { s.sticky = parsePreference(readHarnessSetting("navigator")).sticky; }
  catch { s.sticky = true; }
  if (!canScroll(pi)) s.sticky = true;
  if (canScroll(pi)) pi.registerEntryRenderer(NAVIGATOR_ENTRY_TYPE, (entry) => {
    const data = entry.data as { version?: number; anchor?: string } | undefined;
    if (data?.version !== 1 || !data.anchor) return undefined;
    // Pi reconstructs chat before session_start restores the visible branch.
    // Keep the component mounted and resolve its active anchor at render time.
    return {
      render: width => !s.sticky && data.anchor === s.anchor ? renderPanels(s, width) : [],
      handleMouse: event => !s.sticky && data.anchor === s.anchor ? mouse(s, event) : undefined,
      invalidate() { for (const panel of s.panels.values()) panel.component?.invalidate(); },
    } as PanelComponent;
  });
  s.control ??= {
    id: NAVIGATOR_STICKY_SETTING_ID, label: "Sticky navigator", values: ["On", "Off"],
    get: () => state().sticky ? "On" : "Off", change: changeSticky,
  };
  const owner: Owner = { pi };
  s.owners.set(pi, owner);
  // Use one stable contribution callback across vendored copies, but each owner
  // cleans up its own event subscription when its extension is unloaded.
  const register = () => pi.events?.emit?.("harness-settings:register", s.control);
  owner.stop = pi.events?.on?.("harness-settings:request", register);
  register();
  pi.on("session_start", (_event, ctx) => {
    adoptContext(s, ctx);
    s.anchor = restoreAnchor(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    adoptContext(s, ctx);
    s.anchor = restoreAnchor(ctx);
    refreshNavigatorPanels(ctx);
  });
  pi.on("session_shutdown", () => {
    owner.stop?.();
    s.owners.delete(pi);
    if (s.owners.size) return;
    clearHost(s);
    s.panels.clear();
    s.anchor = undefined;
    s.ctx = undefined;
    s.ui = undefined;
    s.pi = undefined;
  });
}
export function setNavigatorPanel(
  ctx: ExtensionContext, key: string, content: NavigatorPanelFactory | undefined,
  _options?: { placement?: "aboveEditor" | "belowEditor" },
): void {
  const s = state();
  if (!isTui(ctx)) return;
  adoptContext(s, ctx);
  s.panels.get(key)?.component?.dispose?.();
  if (content) s.panels.set(key, { factory: content });
  else s.panels.delete(key);
  if (!s.panels.size) { clearHost(s); return; }
  mountHost(s);
  buildPanels(s);
  s.tui?.requestRender?.();
}
export function refreshNavigatorPanels(ctx?: ExtensionContext): void {
  const s = state();
  if (ctx) adoptContext(s, ctx);
  mountHost(s);
  s.tui?.requestRender?.(true);
}
export function __resetNavigatorPanelsForTests(): void {
  const s = state();
  clearHost(s);
  for (const owner of s.owners.values()) owner.stop?.();
  s.owners.clear();
  s.panels.clear();
  s.pi = undefined;
  s.ctx = undefined;
  s.ui = undefined;
  s.anchor = undefined;
  s.sticky = true;
  s.control = undefined;
}
