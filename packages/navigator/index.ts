import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createRenderScheduler, type RenderScheduler } from "./shared-render-scheduler.ts";

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
  expiresAt?: number;
};

export type BackgroundWorkDetail = {
  providerId: string;
  id: string;
  title: string;
  status: string;
  statusTone: BackgroundWorkStatusTone;
  subtitle?: string;
  metadata: Array<{ label: string; value: string }>;
  foldedSections?: Array<{ id: string; label: string; text: string; collapsedText?: string; expandedByDefault?: boolean }>;
  evidence: { label: string; text: string };
  transcript?: Array<
    | { type: "assistant"; content: Array<{ type: string; text?: string; thinking?: string }>; streaming: boolean }
    | { type: "tool"; id?: string; name: string; args?: unknown; result?: unknown; isError: boolean; state: "running" | "completed" }
  >;
  transcriptDiagnostic?: string;
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
  showSection?(rows: BackgroundWorkRow[], now: number): boolean;
  parentRow?(now: number): BackgroundWorkRow | null;
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
  createTranscriptComponent?: (detail: BackgroundWorkDetail, theme: unknown) => Component;
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
  mainListDeadlineScheduler?: RenderScheduler;
  detailOverlayRows?: number;
  dispose?: () => void;
};

const GLOBAL_KEY = Symbol.for("pi-better-harness.navigator.state");
const FACTORY_MARK = "__piBetterHarnessNavigatorFactory";
const FACTORY_REFRESH = "__piBetterHarnessNavigatorRefresh";

export const NAVIGATOR_STATUS_KEY = "background-work-nav";
export const CLOSE_CONFIRM_STATUS_KEY = "background-work-close";
export const MAIN_LIST_WIDGET_KEY = "background-work-list";
export const DETAIL_TICK_MS = 10_000;
export const CLOSE_ARM_MS = 3000;
export const DEFAULT_LOG_TAIL_ROWS = 10;
export const LOG_TAIL_ROW_CHOICES = [10, 25] as const;
const MAIN_LIST_FALLBACK_WIDTH = 100;
const DETAIL_OVERLAY_HEADER_MARGIN_ROWS = 5;
const DETAIL_OVERLAY_FOOTER_MARGIN_ROWS = 3;
const EVIDENCE_SECTION_ID = "__evidence__";
const RUNNING_DOT_GLYPH = "●";
const RUNNING_DOT_FRAMES = ["dim", "accent", "accent", "dim"] as const;

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
  return count > 0 ? `← navigate · ${count}` : null;
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
  s.mainListDeadlineScheduler?.dispose();
  s.mainListDeadlineScheduler = createRenderScheduler(() => refreshMainListWidget());
  installNavigatorEditor(ctx.ui as any, deps);
  s.lastHint = undefined;
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
  s.mainListDeadlineScheduler?.dispose();
  s.mainListDeadlineScheduler = undefined;
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

function stopMainListWidget(): void {
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
  const now = Date.now();
  const rows = listRows(now);
  s.mainListDeadlineScheduler?.cancel();
  const nextExpiry = rows.reduce<number | undefined>((next, row) => {
    if (row.expiresAt === undefined || row.expiresAt <= now) return next;
    return next === undefined ? row.expiresAt : Math.min(next, row.expiresAt);
  }, undefined);
  if (nextExpiry !== undefined) {
    s.mainListDeadlineScheduler?.schedule(nextExpiry - now);
  }
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

type InternalRow = BackgroundWorkRow & { navigatorId: string; providerLabel: string; parentRow?: boolean };

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
    const orderedProviderRows = [...providerRows].sort((a, b) => b.sortStartedAt - a.sortStartedAt || rowDisplayName(a).localeCompare(rowDisplayName(b)));
    let showSection = orderedProviderRows.length > 0 || provider.parentRow !== undefined;
    try { showSection = provider.showSection?.(orderedProviderRows, now) ?? showSection; } catch { showSection = false; }
    if (!showSection) continue;
    let parentRow: BackgroundWorkRow | null = null;
    try { parentRow = provider.parentRow?.(now) ?? null; } catch { parentRow = null; }
    if (parentRow) {
      rows.push({
        ...parentRow,
        navigatorId: rowKey(parentRow.providerId, parentRow.id),
        providerLabel: provider.label,
        parentRow: true,
      });
    }
    for (const row of orderedProviderRows) {
      rows.push({ ...row, navigatorId: rowKey(provider.id, row.id), providerLabel: provider.label });
    }
  }
  return rows;
}

function rowDisplayName(row: Pick<BackgroundWorkRow, "name" | "id">): string {
  return singleLine(row.name || row.id);
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
  s.mainListSelectedId = rows.find((row) => row.parentRow && row.id === "main")?.navigatorId ?? rows[0]!.navigatorId;
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
  const orderedLabels = providers().map((provider) => provider.label).filter((label) => grouped.has(label));
  for (const label of grouped.keys()) if (!orderedLabels.includes(label)) orderedLabels.push(label);
  for (let i = 0; i < orderedLabels.length; i += 1) {
    const label = orderedLabels[i]!;
    const group = grouped.get(label)!;
    if (i > 0) lines.push("");
    lines.push(providerGroupLabel(label, fg));
    for (const row of group) {
      const selected = options.focused && row.navigatorId === options.selectedId;
      lines.push(formatMainListRow(row, selected === true, fg, width));
    }
  }
  lines.push("");
  lines.push(shortcutsLine(options.focused === true, fg));
  return lines.map((line) => safeTruncate(line, width, truncate));
}

function shortcutsLine(focused: boolean, fg: (color: string, value: string) => string): string {
  const keys = focused ? "↑↓ switch · Enter detail · x stop · Esc unfocus" : "← to navigate";
  return dim(keys, fg);
}

function providerGroupLabel(label: string, fg: (color: string, value: string) => string): string {
  const normalized = singleLine(label).toLowerCase();
  return `${dim("▸", fg)} ${fg("warning", normalized)}`;
}

function formatMainListRow(row: InternalRow, selected: boolean, fg: (color: string, value: string) => string, width: number): string {
  const prefix = selected ? fg("accent", "› ") : "  ";
  const name = row.name || row.id;
  const indicator = statusIndicator(row);
  const status = fg(indicator.color, indicator.glyph);
  const elapsed = singleLine(row.elapsed || "-");
  const available = Math.max(24, width || MAIN_LIST_FALLBACK_WIDTH);
  const elapsedWidth = Math.min(Math.max(visibleWidth(elapsed), 4), 12);
  const statusWidth = 2;
  const leftPrefixWidth = visibleWidth(prefix) + statusWidth + 1;
  const maxNameWidth = Math.max(8, Math.floor(available * 0.36));
  const nameWidth = Math.max(8, Math.min(44, maxNameWidth, available - leftPrefixWidth - elapsedWidth - 10));
  const rightWidth = Math.max(8, available - leftPrefixWidth - nameWidth - 1);
  const summaryWidth = Math.max(1, rightWidth - elapsedWidth - 1);
  const left = `${prefix}${fit(status, statusWidth)} ${fit(name, nameWidth)}`;
  const right = `${dim(fitRight(rowSummary(row), summaryWidth), fg)} ${fitRight(elapsed, elapsedWidth)}`;
  const gap = Math.max(1, available - visibleWidth(left) - visibleWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function statusGlyph(row: InternalRow): string {
  if (row.statusTone === "success") return "✓";
  if (row.statusTone === "failed") return "✕";
  if (row.statusTone === "warning") return "◇";
  if (row.statusTone === "running") return RUNNING_DOT_GLYPH;
  return "·";
}

function statusIndicator(row: InternalRow, now = Date.now()): { glyph: string; color: string } {
  if (row.statusTone !== "running") return { glyph: statusGlyph(row), color: toneColor(row.statusTone, row.status) };
  const frame = Math.floor(now / DETAIL_TICK_MS) % RUNNING_DOT_FRAMES.length;
  return { glyph: RUNNING_DOT_GLYPH, color: RUNNING_DOT_FRAMES[frame]! };
}

function rowSummary(row: InternalRow): string {
  if (row.providerId === "subagents") {
    const parts: string[] = [];
    if (row.model) parts.push(row.effort ? `${singleLine(row.model)} ${singleLine(row.effort)}` : singleLine(row.model));
    if (row.tool) parts.push(`tool ${singleLine(row.tool)}`);
    if (row.tokens) parts.push(singleLine(row.tokens));
    else if (row.primary) parts.push(singleLine(row.primary));
    if (parts.length) return parts.join(" · ");
  }
  const facts = row.facts?.map(singleLine).filter(Boolean).join(" · ");
  if (facts) return facts;
  if (row.providerId === "background-tasks") {
    if (row.statusTone === "running") return row.kind === "watch" ? "watching condition" : "process running";
    if (row.statusTone === "success") return "completed";
    if (row.statusTone === "failed") return "failed, inspect log";
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
  if (row.parentRow) return { action: "not-closable", providerId: row.providerId, id: row.id };
  const provider = state().providers.get(row.providerId);
  if (!provider) return { action: "missing", providerId: row.providerId, id: row.id };
  try { return provider.close(row.id); } catch { return { action: "missing", providerId: row.providerId, id: row.id }; }
}

function closeHintFor(row: InternalRow | undefined): string | null {
  if (!row || row.parentRow) return null;
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
    if (moveMainListSelection(-1)) {
      refreshMainListWidget();
      if (!selectedMainListRow()?.parentRow) openNavigator();
    }
    return true;
  }
  if (deps.matchKey(data, "down")) {
    clearMainListCloseArm();
    if (moveMainListSelection(1)) {
      refreshMainListWidget();
      if (!selectedMainListRow()?.parentRow) openNavigator();
    }
    return true;
  }
  if (deps.matchKey(data, "enter")) {
    const selected = selectedMainListRow();
    if (selected?.parentRow) unfocusMainList();
    else openNavigator();
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
  if (!row || row.parentRow) return;
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
  applyDefaultExpandedSections(detail, expandedSections);
  if (detailId) {
    const idx = overlayState.rows.findIndex((row) => row.navigatorId === detailId);
    if (idx >= 0) overlayState.selected = idx;
  }
  let closeArm: { id: string; armedAt: number } | undefined;
  let closeArmTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let transcriptDetail: BackgroundWorkDetail | null = null;
  let transcriptComponent: Component | null = null;

  const fg = (color: string, value: string) => theme?.fg ? theme.fg(color, value) : value;

  function requestRender(): void {
    try { tui.requestRender(); } catch { /* ignore */ }
  }

  const detailScheduler = createRenderScheduler(() => {
    if (!detailId || mode !== "detail" || closed) return;
    detail = detailFor(detailId, Date.now(), { logTailLines: logTailRows }) ?? detail;
    requestRender();
    startDetailTimer();
  });

  function refreshRows(): void {
    const selectedId = state().mainListSelectedId ?? overlayState.rows[overlayState.selected]?.navigatorId;
    overlayState.rows = listRows();
    const nextIdx = selectedId ? overlayState.rows.findIndex((row) => row.navigatorId === selectedId) : -1;
    overlayState.selected = nextIdx >= 0 ? nextIdx : Math.min(overlayState.selected, Math.max(0, overlayState.rows.length - 1));
  }

  function selectOverlayRow(next: number): void {
    overlayState.selected = Math.min(Math.max(0, overlayState.rows.length - 1), Math.max(0, next));
    state().mainListSelectedId = overlayState.rows[overlayState.selected]?.navigatorId;
    clearCloseArm();
    refreshMainListWidget();
  }

  function activateSelectedRow(): void {
    if (selectedRow()?.parentRow) close();
    else openDetail();
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
    detailScheduler.cancel();
  }

  function startDetailTimer(): void {
    detailScheduler.cancel();
    if (detail?.status === "running" || detail?.status === "orphaned") {
      detailScheduler.schedule(DETAIL_TICK_MS);
    }
  }

  function selectedRow(): InternalRow | undefined {
    return overlayState.rows[overlayState.selected];
  }

  function openDetail(): void {
    const row = selectedRow();
    if (!row) return;
    if (row.parentRow) {
      close();
      return;
    }
    clearCloseArm();
    detailId = row.navigatorId;
    expandedSections.clear();
    detail = detailFor(row.navigatorId, Date.now(), { logTailLines: logTailRows }) ?? fallbackDetail(row);
    applyDefaultExpandedSections(detail, expandedSections);
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
    detailScheduler.dispose();
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
      refreshRows();
      const railLines = mode === "detail"
        ? buildMainListLines(overlayState.rows, width, deps.truncate, fg, {
            selectedId: selectedRow()?.navigatorId,
            focused: true,
          })
        : [];
      const detailRows = Math.max(1, (state().detailOverlayRows ?? 1) - railLines.length - 1);
      let contentLines: string[];
      if (mode === "detail" && detail?.transcript && deps.createTranscriptComponent) {
        if (transcriptDetail !== detail || !transcriptComponent) {
          transcriptDetail = detail;
          transcriptComponent = deps.createTranscriptComponent(detail, theme);
        }
        contentLines = buildTranscriptDetailLines(
          detail,
          transcriptComponent.render(width),
          width,
          deps.truncate,
          fg,
          { minRows: detailRows },
        );
      } else {
        transcriptDetail = null;
        transcriptComponent = null;
        contentLines = mode === "detail"
          ? buildDetailLines(detail, width, deps.truncate, fg, { expandedSections, logTailRows, minRows: detailRows })
          : buildListLines(overlayState, width, deps.truncate, fg);
      }
      return mode === "detail" ? [...contentLines, "", ...railLines] : contentLines;
    },
    handleInput(data: string) {
      if (closed) return;
      if (data === "x" || data === "X" || deps.matchKey(data, "x") || deps.matchKey(data, "X")) {
        handleCloseKey();
        return;
      }
      if (mode === "detail") {
        if (deps.matchKey(data, "up")) {
          selectOverlayRow(overlayState.selected - 1);
          activateSelectedRow();
        }
        else if (deps.matchKey(data, "down")) {
          selectOverlayRow(overlayState.selected + 1);
          activateSelectedRow();
        }
        else if (deps.matchKey(data, "left")) {
          const mainIdx = overlayState.rows.findIndex((row) => row.parentRow && row.id === "main");
          if (mainIdx >= 0) selectOverlayRow(mainIdx);
          close();
        }
        else if (deps.matchKey(data, "enter")) {
          const row = selectedRow();
          if (row?.parentRow || row?.navigatorId !== detailId) openDetail();
          else {
            const sectionId = firstToggleableSectionId(detail);
            if (!sectionId) return;
            if (expandedSections.has(sectionId)) expandedSections.delete(sectionId);
            else expandedSections.add(sectionId);
            requestRender();
          }
        }
        else if (data === "l" || data === "L") {
          logTailRows = cycleLogTailRows(logTailRows);
          if (detailId) detail = detailFor(detailId, Date.now(), { logTailLines: logTailRows }) ?? detail;
          requestRender();
        }
        else if (deps.matchKey(data, "escape")) {
          unfocusMainList();
          close();
        }
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
    invalidate() { transcriptComponent?.invalidate(); },
    dispose() {
      clearCloseArm();
      detailScheduler.dispose();
    },
  };
}

function buildTranscriptDetailLines(
  detail: BackgroundWorkDetail,
  transcriptLines: string[],
  width: number,
  truncate: (s: string, width: number) => string,
  fg: (color: string, value: string) => string,
  options: { minRows?: number } = {},
): string[] {
  const actions = [...(detail.footerActions ?? ["x close"]), "Esc close"].join(" · ");
  const lines: string[] = [
    fg("accent", rule(detail.title, width)),
    dim(`   ← main · ${actions}`, fg),
    "",
    `   status   ${fg(toneColor(detail.statusTone, detail.status), detail.status)}`,
  ];
  if (detail.subtitle) lines.push(`   summary  ${detail.subtitle}`);
  for (const item of detail.metadata) lines.push(`   ${item.label.padEnd(8, " ").slice(0, 8)} ${item.value}`);
  lines.push("", dim(section("transcript", width), fg));
  if (detail.transcriptDiagnostic) lines.push(`   ${dim(detail.transcriptDiagnostic, fg)}`);
  lines.push(...(transcriptLines.length ? transcriptLines : ["   (no transcript yet)"]));
  lines.push("");
  const footerLines = [dim(`   ← main · ${actions}`, fg), dim(rule("", width), fg)];
  padBeforeFooter(lines, footerLines.length, options.minRows);
  lines.push(...footerLines);
  return lines.map((line) => safeTruncate(line, width, truncate));
}

function detailOverlayOptions() {
  const marginBottom = DETAIL_OVERLAY_FOOTER_MARGIN_ROWS;
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
  lines.push(rule(`Work · ${nav.rows.length}`, width));
  const selected = nav.rows[nav.selected];
  const closeAction = selected ? "x close" : null;
  lines.push(dim(`   ${["↑↓ select", "Enter view", closeAction, "Esc close"].filter(Boolean).join(" · ")}`, fg));
  lines.push("");
  if (nav.rows.length === 0) lines.push("   (no work)");
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
  const actions = [foldedAction, ...(detail.footerActions?.length ? detail.footerActions : ["x close"]), "l 10/25", "Esc close"].filter(Boolean).join(" · ");
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
    const wrapped = /log/i.test(detail.evidence.label)
      ? wrapLogText(body, width - 6)
      : body.split(/\r?\n/);
    for (const raw of wrapped) lines.push(raw ? `   ${raw}` : "   ");
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

function applyDefaultExpandedSections(detail: BackgroundWorkDetail | null, expandedSections: Set<string>): void {
  for (const section of detail?.foldedSections ?? []) {
    if (section.expandedByDefault) expandedSections.add(section.id);
  }
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

/**
 * Wrap terminal log rows without flattening entries together. Continuations
 * retain the source indentation, and long paths/JSON tokens are hard-wrapped
 * so the final width guard never has to discard their suffix.
 */
export function wrapLogText(text: string, width: number): string[] {
  const max = Math.max(8, Math.floor(width));
  const rows: string[] = [];
  for (const source of String(text ?? "").split(/\r?\n/)) {
    if (!source) {
      rows.push("");
      continue;
    }
    const sourceIndent = source.match(/^[ \t]*/)?.[0] ?? "";
    const indent = sourceIndent.replace(/\t/g, "  ");
    let remaining = source.slice(sourceIndent.length);
    const contentWidth = Math.max(1, max - visibleWidth(indent));
    if (!remaining) {
      rows.push(indent);
      continue;
    }
    while (visibleWidth(remaining) > contentWidth) {
      let [head, tail] = splitVisiblePrefix(remaining, contentWidth);
      const minSoftBreak = Math.floor(contentWidth * 0.45);
      const delimiterBreak = lastDelimiterBreak(head);
      const whitespace = head.match(/\s+\S*$/)?.index;
      if (delimiterBreak > minSoftBreak) {
        tail = head.slice(delimiterBreak) + tail;
        head = head.slice(0, delimiterBreak);
      } else if (whitespace !== undefined && whitespace > minSoftBreak) {
        tail = head.slice(whitespace).trimStart() + tail;
        head = head.slice(0, whitespace).trimEnd();
      }
      rows.push(indent + head);
      remaining = tail.trimStart();
    }
    rows.push(indent + remaining);
  }
  return rows.length ? rows : [""];
}

function lastDelimiterBreak(value: string): number {
  let last = -1;
  for (const match of value.matchAll(/[\/,}:]/g)) last = match.index + 1;
  return last;
}

function splitVisiblePrefix(value: string, width: number): [string, string] {
  const max = Math.max(0, Math.floor(width));
  let visible = 0;
  let index = 0;
  while (index < value.length && visible < max) {
    if (value[index] === "\u001b" || value[index] === "\u009b") {
      const match = value.slice(index).match(ANSI_RE);
      if (match?.index === 0) {
        index += match[0].length;
        continue;
      }
    }
    if (value[index] === "<") {
      const close = value.indexOf(">", index);
      if (close !== -1) {
        const tag = value.slice(index, close + 1);
        if (/^<\/?[a-zA-Z][\w-]*>$/.test(tag) || tag === "</>") {
          index = close + 1;
          continue;
        }
      }
    }
    const codePoint = value.codePointAt(index)!;
    index += codePoint > 0xFFFF ? 2 : 1;
    visible += 1;
  }
  return [value.slice(0, index), value.slice(index)];
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
  if (visibleWidth(line) <= width) return line;
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
