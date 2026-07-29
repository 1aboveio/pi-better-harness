import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export default function navigatorExtension(): void {
  // Internal shared package. Pi may scan its symlink in the extension directory
  // for sibling relative imports; loading it directly should be harmless.
}

export type BackgroundWorkStatusTone = "running" | "success" | "failed" | "warning" | "muted";

export type BackgroundWorkRow = {
  providerId: string;
  id: string;
  name?: string;
  model?: string;
  effort?: string;
  tool?: string;
  tokens?: string;
  command?: string;
  status: string;
  statusTone: BackgroundWorkStatusTone;
  kind: string;
  elapsed: string;
  primary: string;
  secondary?: string;
  facts?: string[];
  sortStartedAt: number;
};

export type BackgroundWorkDetail = {
  providerId: string;
  id: string;
  title: string;
  status: string;
  statusTone: BackgroundWorkStatusTone;
  subtitle?: string;
  metadata: Array<{ label: string; value: string }>;
  foldedSections?: Array<{ id: string; label: string; text: string; collapsedText?: string }>;
  evidence: { label: string; text: string };
  footerActions?: string[];
};

export type BackgroundWorkCloseOutcome = {
  action: string;
  providerId: string;
  id: string;
  status?: string;
};

export type BackgroundWorkProvider = {
  id: string;
  label: string;
  priority: number;
  visibleCount(): number;
  listRows(now: number): BackgroundWorkRow[];
  detail(id: string, now: number, options?: { logTailLines?: number }): BackgroundWorkDetail | null;
  armCloseLabel(row: BackgroundWorkRow): string;
  close(id: string): BackgroundWorkCloseOutcome;
  onVisibleChanged?(notify: () => void): () => void;
};

type HostDeps = {
  createDefaultEditor: (tui: unknown, theme: unknown, keybindings: unknown) => unknown;
  isOpenTrigger: (data: string) => boolean;
  matchKey: (data: string, keyId: string) => boolean;
  truncate: (s: string, width: number) => string;
};

type NavigatorState = {
  providers: Map<string, BackgroundWorkProvider>;
  unsubscribers: Map<string, () => void>;
  uiCtx?: ExtensionContext;
  deps?: HostDeps;
  lastHint?: string | null;
  lastMainListLines?: string[];
  mainListWidgetInstalled?: boolean;
  mainListRequestRender?: () => void;
  mainListSelectedId?: string;
  mainListFocused?: boolean;
  mainListCloseArm?: { id: string; armedAt: number };
  mainListCloseArmTimer?: ReturnType<typeof setTimeout>;
  mainListTimer?: ReturnType<typeof setInterval>;
  detailOverlayRows?: number;
  dispose?: () => void;
};

const GLOBAL_KEY = Symbol.for("pi-better-harness.navigator.state");
const FACTORY_MARK = "__piBetterHarnessNavigatorFactory";
const FACTORY_REFRESH = "__piBetterHarnessNavigatorRefresh";

export const NAVIGATOR_STATUS_KEY = "background-work-nav";
export const CLOSE_CONFIRM_STATUS_KEY = "background-work-close";
export const MAIN_LIST_WIDGET_KEY = "background-work-list";
export const DETAIL_TICK_MS = 1000;
export const CLOSE_ARM_MS = 3000;
export const DEFAULT_LOG_TAIL_ROWS = 10;
export const LOG_TAIL_ROW_CHOICES = [10, 25, 50, 100] as const;
const MAIN_LIST_TICK_MS = 1000;
const MAIN_LIST_FALLBACK_WIDTH = 100;
const DETAIL_OVERLAY_HEADER_MARGIN_ROWS = 5;
const DETAIL_OVERLAY_FOOTER_MARGIN_ROWS = 3;
const EVIDENCE_SECTION_ID = "__evidence__";

function state(): NavigatorState {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: NavigatorState };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { providers: new Map(), unsubscribers: new Map() };
  }
  return g[GLOBAL_KEY]!;
}

export function registerBackgroundWorkProvider(provider: BackgroundWorkProvider): () => void {
  const s = state();
  const previousUnsub = s.unsubscribers.get(provider.id);
  if (previousUnsub) {
    try { previousUnsub(); } catch { /* ignore */ }
  }
  s.providers.set(provider.id, provider);
  if (typeof provider.onVisibleChanged === "function") {
    try {
      s.unsubscribers.set(provider.id, provider.onVisibleChanged(() => refreshBackgroundWorkNavigator()));
    } catch {
      s.unsubscribers.delete(provider.id);
    }
  } else {
    s.unsubscribers.delete(provider.id);
  }
  refreshBackgroundWorkNavigator();
  return () => unregisterBackgroundWorkProvider(provider.id);
}

export function unregisterBackgroundWorkProvider(id: string): void {
  const s = state();
  const unsub = s.unsubscribers.get(id);
  if (unsub) {
    try { unsub(); } catch { /* ignore */ }
  }
  s.unsubscribers.delete(id);
  s.providers.delete(id);
  refreshBackgroundWorkNavigator();
}

export function isNavigatorUiAvailable(ctx: ExtensionContext | undefined): boolean {
  return Boolean(ctx && ctx.mode === "tui" && ctx.hasUI === true && ctx.ui);
}

export function navigatorFooterHint(count: number): string | null {
  return count > 0 ? `← background work · ${count}` : null;
}

export function applyNavigatorFooter(ui: { setStatus(key: string, value: string | undefined): void }, count: number): string | null {
  const hint = navigatorFooterHint(count);
  ui.setStatus(NAVIGATOR_STATUS_KEY, hint ?? undefined);
  return hint;
}

export function applyCloseConfirmFooter(ui: { setStatus(key: string, value: string | undefined): void }, hint: string | null | undefined): string | null {
  ui.setStatus(CLOSE_CONFIRM_STATUS_KEY, hint ?? undefined);
  return hint ?? null;
}

export function ensureBackgroundWorkNavigator(ctx: ExtensionContext, deps: HostDeps): void {
  if (!isNavigatorUiAvailable(ctx)) return;
  const s = state();
  s.uiCtx = ctx;
  s.deps = deps;
  try { (ctx.ui as any).setWidget?.(MAIN_LIST_WIDGET_KEY, undefined); } catch { /* ignore */ }
  s.mainListWidgetInstalled = false;
  s.mainListRequestRender = undefined;
  installNavigatorEditor(ctx.ui as any, deps);
  s.lastHint = undefined;
  startMainListWidget(ctx);
  refreshBackgroundWorkNavigator(ctx);
  refreshMainListWidget();
}

export function disposeBackgroundWorkNavigator(ctx?: ExtensionContext): void {
  const s = state();
  try { s.dispose?.(); } catch { /* ignore */ }
  s.dispose = undefined;
  stopMainListWidget();
  const ui = (ctx ?? s.uiCtx)?.ui;
  if (ui && isNavigatorUiAvailable(ctx ?? s.uiCtx)) {
    try { applyNavigatorFooter(ui as any, 0); } catch { /* ignore */ }
    try { applyCloseConfirmFooter(ui as any, null); } catch { /* ignore */ }
    try { (ui as any).setWidget?.(MAIN_LIST_WIDGET_KEY, undefined); } catch { /* ignore */ }
  }
  s.lastHint = undefined;
  s.lastMainListLines = undefined;
  s.mainListWidgetInstalled = false;
  s.mainListRequestRender = undefined;
  s.detailOverlayRows = undefined;
  s.mainListSelectedId = undefined;
  s.mainListFocused = false;
  if (ctx && s.uiCtx === ctx) s.uiCtx = undefined;
}

export function refreshBackgroundWorkNavigator(ctx?: ExtensionContext): void {
  const s = state();
  const activeCtx = isNavigatorUiAvailable(ctx) ? ctx : s.uiCtx;
  if (!isNavigatorUiAvailable(activeCtx)) return;
  try {
    const count = visibleCount();
    const hint = navigatorFooterHint(count);
    if (hint !== s.lastHint) {
      applyNavigatorFooter(activeCtx!.ui as any, count);
      s.lastHint = hint;
    }
    refreshMainListWidget();
  } catch { /* ignore */ }
}

function providers(): BackgroundWorkProvider[] {
  return [...state().providers.values()].sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
}

function visibleCount(): number {
  return providers().reduce((sum, provider) => {
    try { return sum + Math.max(0, provider.visibleCount()); } catch { return sum; }
  }, 0);
}

function startMainListWidget(ctx: ExtensionContext): void {
  const s = state();
  if (s.mainListTimer || !isNavigatorUiAvailable(ctx)) return;
  s.mainListTimer = setInterval(() => refreshMainListWidget(), MAIN_LIST_TICK_MS);
  s.mainListTimer.unref?.();
}

function stopMainListWidget(): void {
  const s = state();
  if (s.mainListTimer) clearInterval(s.mainListTimer);
  s.mainListTimer = undefined;
  clearMainListCloseArm();
}

function clearMainListCloseArm(): void {
  const s = state();
  if (s.mainListCloseArmTimer) clearTimeout(s.mainListCloseArmTimer);
  s.mainListCloseArmTimer = undefined;
  if (!s.mainListCloseArm) return;
  s.mainListCloseArm = undefined;
  try { applyCloseConfirmFooter((s.uiCtx as any).ui, null); } catch { /* ignore */ }
}

function refreshMainListWidget(): void {
  const s = state();
  const ctx = s.uiCtx;
  const deps = s.deps;
  if (!ctx || !deps || !isNavigatorUiAvailable(ctx)) return;
  const rows = listRows();
  syncMainListSelection(rows);
  s.lastMainListLines = rows.length ? buildMainListLines(rows, MAIN_LIST_FALLBACK_WIDTH, deps.truncate, themeFg(ctx), {
    selectedId: s.mainListFocused ? s.mainListSelectedId : undefined,
    focused: s.mainListFocused === true,
  }) : undefined;
  if (!rows.length) {
    if (!s.mainListWidgetInstalled) return;
    try { (ctx.ui as any).setWidget?.(MAIN_LIST_WIDGET_KEY, undefined); } catch { /* ignore */ }
    s.mainListWidgetInstalled = false;
    s.mainListRequestRender = undefined;
    return;
  }
  if (!s.mainListWidgetInstalled) {
    try {
      (ctx.ui as any).setWidget?.(MAIN_LIST_WIDGET_KEY, (tui: { requestRender?(): void }, theme: unknown) => createMainListWidget(tui, theme, deps), { placement: "aboveEditor" });
      s.mainListWidgetInstalled = true;
    } catch { /* ignore */ }
  }
  try { s.mainListRequestRender?.(); } catch { /* ignore */ }
}

function themeFg(ctx: ExtensionContext): (color: string, value: string) => string {
  return themeFgFromTheme((ctx.ui as any).theme);
}

function themeFgFromTheme(theme: unknown): (color: string, value: string) => string {
  const maybeTheme = theme as { fg?: (color: string, value: string) => string } | undefined;
  return (color, value) => maybeTheme?.fg ? maybeTheme.fg(color, value) : value;
}

function createMainListWidget(tui: { requestRender?(): void }, theme: unknown, deps: HostDeps): Component & { dispose?(): void } {
  const requestRender = () => tui.requestRender?.();
  state().mainListRequestRender = requestRender;
  return {
    render(width: number): string[] {
      const rows = listRows();
      syncMainListSelection(rows);
      if (!rows.length) {
        state().lastMainListLines = undefined;
        return [];
      }
      const lines = buildMainListLines(rows, renderWidth(width), deps.truncate, themeFgFromTheme(theme), {
        selectedId: state().mainListFocused ? state().mainListSelectedId : undefined,
        focused: state().mainListFocused === true,
      });
      state().lastMainListLines = lines;
      return lines;
    },
    invalidate() { state().lastMainListLines = undefined; },
    dispose() {
      const s = state();
      if (s.mainListRequestRender === requestRender) s.mainListRequestRender = undefined;
    },
  };
}

function renderWidth(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : MAIN_LIST_FALLBACK_WIDTH;
}

type InternalRow = BackgroundWorkRow & { navigatorId: string; providerLabel: string };

function rowKey(providerId: string, id: string): string {
  return `${providerId}:${id}`;
}

function splitRowKey(key: string): { providerId: string; id: string } {
  const idx = key.indexOf(":");
  if (idx < 0) return { providerId: "", id: key };
  return { providerId: key.slice(0, idx), id: key.slice(idx + 1) };
}

function listRows(now = Date.now()): InternalRow[] {
  const rows: InternalRow[] = [];
  for (const provider of providers()) {
    let providerRows: BackgroundWorkRow[] = [];
    try { providerRows = provider.listRows(now) ?? []; } catch { providerRows = []; }
    for (const row of providerRows) {
      rows.push({ ...row, navigatorId: rowKey(provider.id, row.id), providerLabel: provider.label });
    }
  }
  return rows.sort((a, b) => b.sortStartedAt - a.sortStartedAt || a.providerLabel.localeCompare(b.providerLabel));
}

function syncMainListSelection(rows: InternalRow[]): void {
  const s = state();
  if (rows.length === 0) {
    s.mainListSelectedId = undefined;
    s.mainListFocused = false;
    return;
  }
  if (!s.mainListSelectedId || !rows.some((row) => row.navigatorId === s.mainListSelectedId)) {
    s.mainListSelectedId = rows[0]!.navigatorId;
  }
}

function selectedMainListRow(): InternalRow | undefined {
  const rows = listRows();
  syncMainListSelection(rows);
  return rows.find((row) => row.navigatorId === state().mainListSelectedId) ?? rows[0];
}

function moveMainListSelection(delta: number): boolean {
  const rows = listRows();
  syncMainListSelection(rows);
  const s = state();
  const idx = rows.findIndex((row) => row.navigatorId === s.mainListSelectedId);
  const next = Math.min(Math.max((idx >= 0 ? idx : 0) + delta, 0), Math.max(0, rows.length - 1));
  const nextId = rows[next]?.navigatorId;
  if (!nextId || nextId === s.mainListSelectedId) return false;
  s.mainListSelectedId = nextId;
  return true;
}

function focusMainList(): void {
  const rows = listRows();
  if (rows.length === 0) return;
  const s = state();
  syncMainListSelection(rows);
  s.mainListFocused = true;
  refreshMainListWidget();
}

function unfocusMainList(): void {
  const s = state();
  if (!s.mainListFocused) return;
  s.mainListFocused = false;
  clearMainListCloseArm();
  refreshMainListWidget();
}

function buildMainListLines(
  rows: InternalRow[],
  width: number,
  truncate: (s: string, width: number) => string,
  fg: (color: string, value: string) => string,
  options: { selectedId?: string; focused?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const grouped = new Map<string, InternalRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.providerLabel) ?? [];
    existing.push(row);
    grouped.set(row.providerLabel, existing);
  }
  lines.push(dim(`background work · ${mainListSummary(rows, options)}`, fg));
  const orderedLabels = providers().map((provider) => provider.label).filter((label) => grouped.has(label));
  for (const label of grouped.keys()) if (!orderedLabels.includes(label)) orderedLabels.push(label);
  const showProviderLabels = orderedLabels.length > 1;
  for (const label of orderedLabels) {
    const group = grouped.get(label)!;
    if (showProviderLabels) lines.push(dim(providerGroupLabel(label), fg));
    for (const row of group) {
      const selected = options.focused && row.navigatorId === options.selectedId;
      lines.push(formatMainListRow(row, selected === true, fg, width));
    }
  }
  lines.push(dim(options.focused ? "↑↓ select · Enter detail · x stop · Esc unfocus" : "<- to navigate", fg));
  return lines.map((line) => safeTruncate(line, width, truncate));
}

function mainListSummary(rows: InternalRow[], options: { selectedId?: string; focused?: boolean }): string {
  if (options.focused) return `${options.selectedId ? "1 selected" : "focused"} · ${rows.length} visible`;
  const running = rows.filter((row) => row.statusTone === "running").length;
  const failed = rows.filter((row) => row.statusTone === "failed").length;
  const warning = rows.filter((row) => row.statusTone === "warning").length;
  const recent = Math.max(0, rows.length - running - failed - warning);
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (warning > 0) parts.push(`${warning} warning`);
  if (recent > 0) parts.push(`${recent} recent`);
  return parts.length ? parts.join(" · ") : `${rows.length} visible`;
}

function providerGroupLabel(label: string): string {
  return singleLine(label).toLowerCase();
}

function formatMainListRow(row: InternalRow, selected: boolean, fg: (color: string, value: string) => string, width: number): string {
  const prefix = selected ? fg("accent", "› ") : "  ";
  const name = row.name || row.id;
  const status = fg(toneColor(row.statusTone, row.status), row.status);
  const elapsed = singleLine(row.elapsed || "-");
  const available = Math.max(24, width || MAIN_LIST_FALLBACK_WIDTH);
  const elapsedWidth = Math.min(Math.max(visibleWidth(elapsed), 4), 12);
  const statusWidth = 10;
  const nameWidth = Math.min(32, Math.max(16, Math.floor(available * 0.28)));
  const fixedWidth = visibleWidth(prefix) + statusWidth + 1 + nameWidth + 1 + elapsedWidth;
  const summaryWidth = Math.max(8, available - fixedWidth - 1);
  return `${prefix}${fit(status, statusWidth)} ${fit(name, nameWidth)} ${fit(rowSummary(row), summaryWidth)} ${fitRight(elapsed, elapsedWidth)}`;
}

function rowSummary(row: InternalRow): string {
  const facts = row.facts?.map(singleLine).filter(Boolean).join(" · ");
  if (facts) return facts;
  if (row.providerId === "background-tasks") {
    if (row.statusTone === "running") return row.kind === "watch" ? "watching condition" : "process running";
    if (row.statusTone === "success") return "completed";
    if (row.statusTone === "failed") return row.kind === "watch" ? "condition failed" : "inspect log";
    if (row.statusTone === "warning") return "needs attention";
    return row.kind || "background task";
  }
  if (row.tokens) return row.tokens;
  if (row.primary) return row.primary;
  if (row.tool) return row.tool;
  if (row.secondary) return row.secondary;
  return row.kind || "work item";
}

function fit(value: string, width: number): string {
  const str = singleLine(value);
  const visible = visibleWidth(str);
  if (visible >= width) return truncateVisible(str, width);
  return str + " ".repeat(width - visible);
}

function fitRight(value: string, width: number): string {
  const str = singleLine(value);
  const visible = visibleWidth(str);
  if (visible >= width) return truncateVisible(str, width);
  return " ".repeat(width - visible) + str;
}

function singleLine(value: unknown): string {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

function detailFor(navigatorId: string, now = Date.now(), options?: { logTailLines?: number }): BackgroundWorkDetail | null {
  const { providerId, id } = splitRowKey(navigatorId);
  const provider = state().providers.get(providerId);
  if (!provider) return null;
  try { return provider.detail(id, now, options); } catch { return null; }
}

function closeFor(row: InternalRow): BackgroundWorkCloseOutcome {
  const provider = state().providers.get(row.providerId);
  if (!provider) return { action: "missing", providerId: row.providerId, id: row.id };
  try { return provider.close(row.id); } catch { return { action: "missing", providerId: row.providerId, id: row.id }; }
}

function closeHintFor(row: InternalRow | undefined): string | null {
  if (!row) return null;
  const provider = state().providers.get(row.providerId);
  if (!provider) return null;
  try { return `${provider.armCloseLabel(row)} ${row.name || row.id}`; } catch { return null; }
}

function installNavigatorEditor(ui: any, deps: HostDeps): unknown {
  const prev = typeof ui.getEditorComponent === "function" ? ui.getEditorComponent() : undefined;
  if (prev && prev[FACTORY_MARK] === true) {
    prev[FACTORY_REFRESH](deps);
    return prev;
  }
  let currentDeps = deps;
  const base = prev;
  const factory = ((tui: unknown, theme: unknown, keybindings: unknown) => {
    const inner = base ? base(tui, theme, keybindings) : currentDeps.createDefaultEditor(tui, theme, keybindings);
    return wrapEditor(inner as any, currentDeps);
  }) as any;
  factory[FACTORY_MARK] = true;
  factory[FACTORY_REFRESH] = (next: HostDeps) => { currentDeps = next; };
  ui.setEditorComponent(factory);
  return factory;
}

function wrapEditor(inner: any, deps: HostDeps): unknown {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "handleInput") {
        return (data: string) => {
          if (target.getText?.() === "" && handleMainListInput(data, deps)) {
            return;
          }
          target.handleInput(data);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
}

function handleMainListInput(data: string, deps: HostDeps): boolean {
  const s = state();
  const rows = listRows();
  if (rows.length === 0) return false;
  if (!s.mainListFocused) {
    if (!deps.isOpenTrigger(data)) return false;
    focusMainList();
    return true;
  }
  if (deps.matchKey(data, "up")) {
    clearMainListCloseArm();
    if (moveMainListSelection(-1)) refreshMainListWidget();
    return true;
  }
  if (deps.matchKey(data, "down")) {
    clearMainListCloseArm();
    if (moveMainListSelection(1)) refreshMainListWidget();
    return true;
  }
  if (deps.matchKey(data, "enter")) {
    openNavigator();
    return true;
  }
  if (data === "x" || data === "X" || deps.matchKey(data, "x") || deps.matchKey(data, "X")) {
    handleMainListCloseKey();
    return true;
  }
  if (deps.matchKey(data, "escape") || deps.isOpenTrigger(data)) {
    unfocusMainList();
    return true;
  }
  return false;
}

function handleMainListCloseKey(): void {
  const row = selectedMainListRow();
  if (!row) return;
  const s = state();
  const now = Date.now();
  const arm = s.mainListCloseArm;
  if (arm?.id === row.navigatorId && now >= arm.armedAt && now < arm.armedAt + CLOSE_ARM_MS) {
    clearMainListCloseArm();
    closeFor(row);
    s.mainListSelectedId = undefined;
    refreshBackgroundWorkNavigator(s.uiCtx);
    refreshMainListWidget();
    return;
  }
  clearMainListCloseArm();
  s.mainListCloseArm = { id: row.navigatorId, armedAt: now };
  try { applyCloseConfirmFooter((s.uiCtx as any).ui, closeHintFor(row)); } catch { /* ignore */ }
  s.mainListCloseArmTimer = setTimeout(() => {
    clearMainListCloseArm();
    refreshMainListWidget();
  }, CLOSE_ARM_MS);
  s.mainListCloseArmTimer.unref?.();
  refreshMainListWidget();
}

function openNavigator(): void {
  const s = state();
  const ctx = s.uiCtx;
  const deps = s.deps;
  if (!ctx || !deps || !isNavigatorUiAvailable(ctx)) return;
  const rows = listRows();
  if (rows.length === 0) return;
  const selectedId = selectedMainListRow()?.navigatorId ?? rows[0]!.navigatorId;
  try {
    try { s.dispose?.(); } catch { /* ignore */ }
    s.dispose = undefined;
    let disposeToken: (() => void) | undefined;
    const opened = (ctx.ui as any).custom((tui: any, theme: any, _keybindings: any, done: (v: null) => void) => {
      const component = createOverlayComponent(rows, deps, tui, theme, done, () => {
        s.lastHint = undefined;
        refreshBackgroundWorkNavigator(ctx);
      }, selectedId);
      disposeToken = () => component.dispose();
      s.dispose = disposeToken;
      return component;
    }, { overlay: true, overlayOptions: detailOverlayOptions });
    const clear = () => {
      if (s.dispose === disposeToken) s.dispose = undefined;
    };
    void Promise.resolve(opened).then(clear, clear);
  } catch { /* keep foreground usable */ }
}

type OverlayState = { rows: InternalRow[]; selected: number };

function createOverlayComponent(
  initialRows: InternalRow[],
  deps: HostDeps,
  tui: { requestRender(): void },
  theme: { fg?(color: string, value: string): string } | undefined,
  done: (v: null) => void,
  onClosed: () => void,
  initialDetailId?: string,
) {
  const overlayState: OverlayState = { rows: initialRows, selected: 0 };
  let mode: "list" | "detail" = initialDetailId ? "detail" : "list";
  let logTailRows: number = DEFAULT_LOG_TAIL_ROWS;
  const expandedSections = new Set<string>();
  let detailId: string | null = initialDetailId ?? null;
  let detail: BackgroundWorkDetail | null = detailId ? (detailFor(detailId, Date.now(), { logTailLines: logTailRows }) ?? null) : null;
  if (detailId) {
    const idx = overlayState.rows.findIndex((row) => row.navigatorId === detailId);
    if (idx >= 0) overlayState.selected = idx;
  }
  let detailTimer: ReturnType<typeof setInterval> | undefined;
  let closeArm: { id: string; armedAt: number } | undefined;
  let closeArmTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const fg = (color: string, value: string) => theme?.fg ? theme.fg(color, value) : value;

  function requestRender(): void {
    try { tui.requestRender(); } catch { /* ignore */ }
  }

  function refreshRows(): void {
    const selectedId = overlayState.rows[overlayState.selected]?.navigatorId;
    overlayState.rows = listRows();
    const nextIdx = selectedId ? overlayState.rows.findIndex((row) => row.navigatorId === selectedId) : -1;
    overlayState.selected = nextIdx >= 0 ? nextIdx : Math.min(overlayState.selected, Math.max(0, overlayState.rows.length - 1));
  }

  function clearCloseArm(): void {
    if (closeArmTimer) clearTimeout(closeArmTimer);
    closeArmTimer = undefined;
    if (closeArm) {
      closeArm = undefined;
      try { applyCloseConfirmFooter((state().uiCtx as any).ui, null); } catch { /* ignore */ }
    }
  }

  function stopDetailTimer(): void {
    if (detailTimer) clearInterval(detailTimer);
    detailTimer = undefined;
  }

  function startDetailTimer(): void {
    stopDetailTimer();
    detailTimer = setInterval(() => {
      if (!detailId || mode !== "detail") return;
      detail = detailFor(detailId, Date.now(), { logTailLines: logTailRows }) ?? detail;
      requestRender();
    }, DETAIL_TICK_MS);
    detailTimer.unref?.();
  }

  function selectedRow(): InternalRow | undefined {
    if (mode === "detail" && detailId) return overlayState.rows.find((row) => row.navigatorId === detailId);
    return overlayState.rows[overlayState.selected];
  }

  function openDetail(): void {
    const row = selectedRow();
    if (!row) return;
    clearCloseArm();
    detailId = row.navigatorId;
    expandedSections.clear();
    detail = detailFor(row.navigatorId, Date.now(), { logTailLines: logTailRows }) ?? fallbackDetail(row);
    mode = "detail";
    startDetailTimer();
    requestRender();
  }

  if (detailId) startDetailTimer();

  function leaveDetail(): void {
    if (mode !== "detail") return;
    const viewedId = detailId;
    clearCloseArm();
    stopDetailTimer();
    mode = "list";
    detail = null;
    detailId = null;
    expandedSections.clear();
    refreshRows();
    if (viewedId) {
      const idx = overlayState.rows.findIndex((row) => row.navigatorId === viewedId);
      if (idx >= 0) overlayState.selected = idx;
    }
    requestRender();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearCloseArm();
    stopDetailTimer();
    try { done(null); } catch { /* ignore */ }
  }

  function handleCloseKey(): void {
    const row = selectedRow();
    if (!row) return;
    const now = Date.now();
    if (closeArm?.id === row.navigatorId && now >= closeArm.armedAt && now < closeArm.armedAt + CLOSE_ARM_MS) {
      clearCloseArm();
      closeFor(row);
      if (mode === "detail") {
        stopDetailTimer();
        mode = "list";
        detail = null;
        detailId = null;
      }
      refreshRows();
      onClosed();
      requestRender();
      return;
    }
    clearCloseArm();
    closeArm = { id: row.navigatorId, armedAt: now };
    try { applyCloseConfirmFooter((state().uiCtx as any).ui, closeHintFor(row)); } catch { /* ignore */ }
    closeArmTimer = setTimeout(() => {
      closeArmTimer = undefined;
      closeArm = undefined;
      try { applyCloseConfirmFooter((state().uiCtx as any).ui, null); } catch { /* ignore */ }
      requestRender();
    }, CLOSE_ARM_MS);
    closeArmTimer.unref?.();
    requestRender();
  }

  return {
    render(width: number) {
      const lines = mode === "detail"
        ? buildDetailLines(detail, width, deps.truncate, fg, { expandedSections, logTailRows, minRows: state().detailOverlayRows })
        : buildListLines(overlayState, width, deps.truncate, fg);
      return lines;
    },
    handleInput(data: string) {
      if (closed) return;
      if (data === "x" || data === "X" || deps.matchKey(data, "x") || deps.matchKey(data, "X")) {
        handleCloseKey();
        return;
      }
      if (mode === "detail") {
        if (deps.matchKey(data, "left")) close();
        else if (deps.matchKey(data, "enter")) {
          const sectionId = firstToggleableSectionId(detail);
          if (sectionId) {
            if (expandedSections.has(sectionId)) expandedSections.delete(sectionId);
            else expandedSections.add(sectionId);
            requestRender();
          }
        }
        else if (data === "[") {
          logTailRows = previousLogTailRows(logTailRows);
          if (detailId) detail = detailFor(detailId, Date.now(), { logTailLines: logTailRows }) ?? detail;
          requestRender();
        }
        else if (data === "]") {
          logTailRows = nextLogTailRows(logTailRows);
          if (detailId) detail = detailFor(detailId, Date.now(), { logTailLines: logTailRows }) ?? detail;
          requestRender();
        }
        else if (data === "l" || data === "L") {
          logTailRows = cycleLogTailRows(logTailRows);
          if (detailId) detail = detailFor(detailId, Date.now(), { logTailLines: logTailRows }) ?? detail;
          requestRender();
        }
        else if (deps.matchKey(data, "escape")) close();
        return;
      }
      if (deps.matchKey(data, "up")) {
        overlayState.selected = Math.max(0, overlayState.selected - 1);
        clearCloseArm();
        requestRender();
      } else if (deps.matchKey(data, "down")) {
        overlayState.selected = Math.min(Math.max(0, overlayState.rows.length - 1), overlayState.selected + 1);
        clearCloseArm();
        requestRender();
      } else if (deps.matchKey(data, "enter")) {
        openDetail();
      } else if (deps.matchKey(data, "escape")) {
        close();
      }
    },
    invalidate() {},
    dispose() {
      clearCloseArm();
      stopDetailTimer();
    },
  };
}

function detailOverlayOptions() {
  const navigatorRows = state().lastMainListLines?.length ?? 0;
  const marginBottom = DETAIL_OVERLAY_FOOTER_MARGIN_ROWS + navigatorRows;
  return {
    anchor: "top-left" as const,
    width: "100%" as const,
    maxHeight: "100%" as const,
    margin: {
      top: DETAIL_OVERLAY_HEADER_MARGIN_ROWS,
      right: 0,
      bottom: marginBottom,
      left: 0,
    },
    visible: (_termWidth: number, termHeight: number) => {
      state().detailOverlayRows = Math.max(1, termHeight - DETAIL_OVERLAY_HEADER_MARGIN_ROWS - marginBottom);
      return true;
    },
  };
}

function fallbackDetail(row: InternalRow): BackgroundWorkDetail {
  return {
    providerId: row.providerId,
    id: row.id,
    title: row.name || row.id,
    status: row.status,
    statusTone: row.statusTone,
    subtitle: row.primary,
    metadata: [
      { label: "provider", value: row.providerLabel },
      { label: "kind", value: row.kind },
      { label: "elapsed", value: row.elapsed },
    ],
    evidence: { label: "details", text: row.secondary || "(no details)" },
  };
}

function buildListLines(nav: OverlayState, width: number, truncate: (s: string, width: number) => string, fg: (color: string, value: string) => string): string[] {
  const lines: string[] = [];
  lines.push(rule(`Background work · ${nav.rows.length}`, width));
  const selected = nav.rows[nav.selected];
  const closeAction = selected ? "x close" : null;
  lines.push(dim(`   ${["↑↓ select", "Enter view", closeAction, "Esc close"].filter(Boolean).join(" · ")}`, fg));
  lines.push("");
  if (nav.rows.length === 0) lines.push("   (no background work)");
  let lastProvider = "";
  for (let i = 0; i < nav.rows.length; i += 1) {
    const row = nav.rows[i]!;
    if (row.providerLabel !== lastProvider) {
      lines.push(dim(section(row.providerLabel, width), fg));
      lastProvider = row.providerLabel;
    }
    const prefix = i === nav.selected ? fg("accent", "›  ") : "   ";
    const status = fg(toneColor(row.statusTone, row.status), row.status);
    const facts = (row.facts ?? []).filter(Boolean).slice(0, 2);
    const suffix = facts.length ? ` · ${facts.join(" · ")}` : "";
    lines.push(`${prefix}${row.name || row.id} · ${row.kind} · ${row.elapsed} · ${row.primary} · ${status}${suffix}`);
    if (row.secondary) lines.push(`      ${row.secondary}`);
  }
  lines.push("");
  lines.push(dim(rule("", width), fg));
  return lines.map((line) => safeTruncate(line, width, truncate));
}

function buildDetailLines(
  detail: BackgroundWorkDetail | null,
  width: number,
  truncate: (s: string, width: number) => string,
  fg: (color: string, value: string) => string,
  options: { expandedSections?: Set<string>; logTailRows?: number; minRows?: number } = {},
): string[] {
  if (!detail) {
    const lines = [rule("Work unavailable", width), dim("   ← back · Esc close", fg), ""];
    const footerLines = [dim(rule("", width), fg)];
    padBeforeFooter(lines, footerLines.length, options.minRows);
    lines.push(...footerLines);
    return lines.map((line) => safeTruncate(line, width, truncate));
  }
  const lines: string[] = [];
  lines.push(fg("accent", rule(detail.title, width)));
  const toggleableSectionId = firstToggleableSectionId(detail);
  const foldedAction = toggleableSectionId
    ? (options.expandedSections?.has(toggleableSectionId) ? "Enter collapse" : "Enter expand")
    : null;
  const actions = [foldedAction, ...(detail.footerActions?.length ? detail.footerActions : ["x close"]), "[ fewer", "] more", "l cycle", "Esc close"].filter(Boolean).join(" · ");
  lines.push(dim(`   ← back · ${actions}`, fg));
  lines.push("");
  lines.push(`   status   ${fg(toneColor(detail.statusTone, detail.status), detail.status)}`);
  if (detail.subtitle) lines.push(`   summary  ${detail.subtitle}`);
  for (const item of detail.metadata) {
    lines.push(`   ${item.label.padEnd(8, " ").slice(0, 8)} ${item.value}`);
  }
  if (detail.foldedSections?.length) {
    lines.push("");
    for (const section of detail.foldedSections) {
      const expanded = options.expandedSections?.has(section.id) === true;
      if (!expanded) {
        const label = section.label.padEnd(8, " ").slice(0, 8);
        const folded = dim("folded", fg);
        const previewWidth = Math.max(8, width - visibleWidth(`   ${label}  ${folded}`));
        const preview = truncateVisible(singleLine(section.collapsedText ?? section.text), previewWidth);
        lines.push(`   ${label} ${preview} ${folded}`);
        continue;
      }
      lines.push(dim(sectionHeader(section.label, width), fg));
      for (const raw of wrapDetailText(section.text, width - 6)) lines.push(`   ${raw}`);
    }
  }
  lines.push("");
  const tailRows = options.logTailRows ?? DEFAULT_LOG_TAIL_ROWS;
  const body = detail.evidence.text && detail.evidence.text.trim() ? detail.evidence.text : "(no output yet)";
  if (isFoldableEvidence(detail)) {
    const expanded = options.expandedSections?.has(EVIDENCE_SECTION_ID) === true;
    if (!expanded) {
      lines.push(dim(section(`${detail.evidence.label} · folded`, width), fg));
      const folded = dim("folded", fg);
      const previewWidth = Math.max(8, width - visibleWidth(`    ${folded}`));
      const preview = truncateVisible(singleLine(body), previewWidth);
      lines.push(`   ${preview} ${folded}`);
    } else {
      const wrapped = wrapEvidenceText(body, width - 6);
      const shown = wrapped.slice(0, tailRows);
      lines.push(dim(section(`${detail.evidence.label} · showing ${shown.length}/${wrapped.length} rows`, width), fg));
      for (const raw of shown) lines.push(raw ? `   ${raw}` : "   ");
    }
  } else {
    const evidenceLabel = /log/i.test(detail.evidence.label) ? `${detail.evidence.label} · latest ${tailRows} rows` : detail.evidence.label;
    lines.push(dim(section(evidenceLabel, width), fg));
    for (const raw of body.split(/\r?\n/)) lines.push(raw ? `   ${raw}` : "   ");
  }
  lines.push("");
  const footerLines = [dim(`   ← back · ${actions}`, fg), dim(rule("", width), fg)];
  padBeforeFooter(lines, footerLines.length, options.minRows);
  lines.push(...footerLines);
  return lines.map((line) => safeTruncate(line, width, truncate));
}

function padBeforeFooter(lines: string[], footerLineCount: number, minRows: number | undefined): void {
  if (minRows === undefined || !Number.isFinite(minRows)) return;
  const target = Math.max(1, Math.floor(minRows));
  while (lines.length + footerLineCount < target) lines.push("");
}

function firstToggleableSectionId(detail: BackgroundWorkDetail | null | undefined): string | undefined {
  const first = detail?.foldedSections?.[0];
  if (first) return first.id;
  return detail && isFoldableEvidence(detail) ? EVIDENCE_SECTION_ID : undefined;
}

function isFoldableEvidence(detail: BackgroundWorkDetail): boolean {
  return !/log/i.test(detail.evidence.label);
}

function sectionHeader(label: string, width: number): string {
  return section(label, width);
}

function wrapDetailText(text: string, width: number): string[] {
  const max = Math.max(16, width);
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (visibleWidth(`${line} ${word}`) <= max) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ["(empty)"];
}

function wrapEvidenceText(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (!raw.trim()) {
      rows.push("");
      continue;
    }
    rows.push(...wrapDetailText(raw, width));
  }
  return rows.length ? rows : ["(no output yet)"];
}

function nextLogTailRows(current: number): number {
  for (const value of LOG_TAIL_ROW_CHOICES) if (value > current) return value;
  return LOG_TAIL_ROW_CHOICES[LOG_TAIL_ROW_CHOICES.length - 1];
}

function previousLogTailRows(current: number): number {
  for (let i = LOG_TAIL_ROW_CHOICES.length - 1; i >= 0; i -= 1) {
    const value = LOG_TAIL_ROW_CHOICES[i]!;
    if (value < current) return value;
  }
  return LOG_TAIL_ROW_CHOICES[0];
}

function cycleLogTailRows(current: number): number {
  const idx = LOG_TAIL_ROW_CHOICES.findIndex((value) => value === current);
  return LOG_TAIL_ROW_CHOICES[(idx + 1) % LOG_TAIL_ROW_CHOICES.length];
}

function toneColor(tone: BackgroundWorkStatusTone | undefined, status: string): string {
  if (tone === "success") return "success";
  if (tone === "failed") return "error";
  if (tone === "warning") return "warning";
  if (tone === "running") return "accent";
  switch (status) {
    case "completed":
    case "succeeded":
      return "success";
    case "failed":
    case "lost":
    case "timed_out":
      return "error";
    case "cancelled":
    case "killed":
    case "orphaned":
      return "warning";
    default:
      return "dim";
  }
}

function dim(value: string, fg: (color: string, value: string) => string): string {
  return fg("dim", value);
}

function section(label: string, width: number): string {
  return fill("─", label, width);
}

function rule(label: string, width: number): string {
  return fill("━", label, width);
}

function fill(glyph: string, label: string, width: number): string {
  const w = Math.max(0, Math.floor(width || 0));
  if (w <= 0) return "";
  if (!label) return glyph.repeat(w);
  const prefix = `${glyph}${glyph} ${label} `;
  if (visibleWidth(prefix) >= w) return truncateVisible(prefix, w);
  return prefix + glyph.repeat(w - visibleWidth(prefix));
}

function safeTruncate(line: string, width: number, truncate: (s: string, width: number) => string): string {
  const cut = truncate(line, width);
  return visibleWidth(cut) > width ? truncateVisible(cut, width) : cut;
}

const ANSI_RE = new RegExp("[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))", "g");

function visibleWidth(value: string): number {
  return String(value ?? "")
    .replace(ANSI_RE, "")
    .replace(/<\/?[a-zA-Z][\w-]*>/g, "")
    .replace(/<\/>/g, "")
    .length;
}

function truncateVisible(value: string, width: number): string {
  const str = String(value ?? "");
  const max = Math.max(0, Math.floor(width || 0));
  if (visibleWidth(str) <= max) return str;
  let out = "";
  let vis = 0;
  let i = 0;
  while (i < str.length && vis < max) {
    if (str[i] === "\u001b" || str[i] === "\u009b") {
      const match = str.slice(i).match(ANSI_RE);
      if (match && match.index === 0) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (str[i] === "<") {
      const close = str.indexOf(">", i);
      if (close !== -1) {
        const tag = str.slice(i, close + 1);
        if (/^<\/?[a-zA-Z][\w-]*>$/.test(tag) || tag === "</>") {
          out += tag;
          i = close + 1;
          continue;
        }
      }
    }
    out += str[i];
    vis += 1;
    i += 1;
  }
  return out;
}
