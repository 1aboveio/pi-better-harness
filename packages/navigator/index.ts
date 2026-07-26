import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function navigatorExtension(): void {
  // Internal shared package. Pi may scan its symlink in the extension directory
  // for sibling relative imports; loading it directly should be harmless.
}

export type BackgroundWorkStatusTone = "running" | "success" | "failed" | "warning" | "muted";

export type BackgroundWorkRow = {
  providerId: string;
  id: string;
  name?: string;
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
  detail(id: string, now: number): BackgroundWorkDetail | null;
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
  dispose?: () => void;
};

const GLOBAL_KEY = Symbol.for("pi-better-harness.navigator.state");
const FACTORY_MARK = "__piBetterHarnessNavigatorFactory";
const FACTORY_REFRESH = "__piBetterHarnessNavigatorRefresh";

export const NAVIGATOR_STATUS_KEY = "background-work-nav";
export const CLOSE_CONFIRM_STATUS_KEY = "background-work-close";
export const DETAIL_TICK_MS = 1000;
export const CLOSE_ARM_MS = 3000;

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
  installNavigatorEditor(ctx.ui as any, deps);
  s.lastHint = undefined;
  refreshBackgroundWorkNavigator(ctx);
}

export function disposeBackgroundWorkNavigator(ctx?: ExtensionContext): void {
  const s = state();
  try { s.dispose?.(); } catch { /* ignore */ }
  s.dispose = undefined;
  const ui = (ctx ?? s.uiCtx)?.ui;
  if (ui && isNavigatorUiAvailable(ctx ?? s.uiCtx)) {
    try { applyNavigatorFooter(ui as any, 0); } catch { /* ignore */ }
    try { applyCloseConfirmFooter(ui as any, null); } catch { /* ignore */ }
  }
  s.lastHint = undefined;
  if (ctx && s.uiCtx === ctx) s.uiCtx = undefined;
}

export function refreshBackgroundWorkNavigator(ctx?: ExtensionContext): void {
  const s = state();
  const activeCtx = ctx ?? s.uiCtx;
  if (!isNavigatorUiAvailable(activeCtx)) return;
  try {
    const count = visibleCount();
    const hint = navigatorFooterHint(count);
    if (hint !== s.lastHint) {
      applyNavigatorFooter(activeCtx!.ui as any, count);
      s.lastHint = hint;
    }
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

function detailFor(navigatorId: string, now = Date.now()): BackgroundWorkDetail | null {
  const { providerId, id } = splitRowKey(navigatorId);
  const provider = state().providers.get(providerId);
  if (!provider) return null;
  try { return provider.detail(id, now); } catch { return null; }
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
          if (target.getText?.() === "" && deps.isOpenTrigger(data) && visibleCount() > 0) {
            openNavigator();
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

function openNavigator(): void {
  const s = state();
  const ctx = s.uiCtx;
  const deps = s.deps;
  if (!ctx || !deps || !isNavigatorUiAvailable(ctx)) return;
  const rows = listRows();
  if (rows.length === 0) return;
  try {
    try { s.dispose?.(); } catch { /* ignore */ }
    s.dispose = undefined;
    let disposeToken: (() => void) | undefined;
    const opened = (ctx.ui as any).custom((tui: any, theme: any, _keybindings: any, done: (v: null) => void) => {
      const component = createOverlayComponent(rows, deps, tui, theme, done, () => {
        s.lastHint = undefined;
        refreshBackgroundWorkNavigator(ctx);
      });
      disposeToken = () => component.dispose();
      s.dispose = disposeToken;
      return component;
    }, { overlay: true });
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
) {
  const overlayState: OverlayState = { rows: initialRows, selected: 0 };
  let mode: "list" | "detail" = "list";
  let detail: BackgroundWorkDetail | null = null;
  let detailId: string | null = null;
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

  function selectedRow(): InternalRow | undefined {
    if (mode === "detail" && detailId) return overlayState.rows.find((row) => row.navigatorId === detailId);
    return overlayState.rows[overlayState.selected];
  }

  function openDetail(): void {
    const row = selectedRow();
    if (!row) return;
    clearCloseArm();
    detailId = row.navigatorId;
    detail = detailFor(row.navigatorId) ?? fallbackDetail(row);
    mode = "detail";
    stopDetailTimer();
    detailTimer = setInterval(() => {
      if (!detailId || mode !== "detail") return;
      detail = detailFor(detailId) ?? detail;
      requestRender();
    }, DETAIL_TICK_MS);
    detailTimer.unref?.();
    requestRender();
  }

  function leaveDetail(): void {
    if (mode !== "detail") return;
    const viewedId = detailId;
    clearCloseArm();
    stopDetailTimer();
    mode = "list";
    detail = null;
    detailId = null;
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
        ? buildDetailLines(detail, width, deps.truncate, fg)
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
        if (deps.matchKey(data, "left")) leaveDetail();
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

function buildDetailLines(detail: BackgroundWorkDetail | null, width: number, truncate: (s: string, width: number) => string, fg: (color: string, value: string) => string): string[] {
  if (!detail) {
    return [rule("Work unavailable", width), dim("   ← back · Esc close", fg), "", dim(rule("", width), fg)].map((line) => safeTruncate(line, width, truncate));
  }
  const lines: string[] = [];
  lines.push(fg("accent", rule(detail.title, width)));
  const actions = detail.footerActions?.length ? detail.footerActions.join(" · ") : "x close";
  lines.push(dim(`   ← back · ${actions} · Esc close`, fg));
  lines.push("");
  lines.push(`   status   ${fg(toneColor(detail.statusTone, detail.status), detail.status)}`);
  if (detail.subtitle) lines.push(`   summary  ${detail.subtitle}`);
  for (const item of detail.metadata) {
    lines.push(`   ${item.label.padEnd(8, " ").slice(0, 8)} ${item.value}`);
  }
  lines.push("");
  lines.push(dim(section(detail.evidence.label, width), fg));
  const body = detail.evidence.text && detail.evidence.text.trim() ? detail.evidence.text : "(no output yet)";
  for (const raw of body.split(/\r?\n/)) lines.push(raw ? `   ${raw}` : "   ");
  lines.push("");
  lines.push(dim(`   ← back · ${actions} · Esc close`, fg));
  lines.push(dim(rule("", width), fg));
  return lines.map((line) => safeTruncate(line, width, truncate));
}

function toneColor(tone: BackgroundWorkStatusTone | undefined, status: string): string {
  if (tone === "success") return "success";
  if (tone === "failed") return "danger";
  if (tone === "warning") return "warning";
  if (tone === "running") return "accent";
  switch (status) {
    case "completed":
    case "succeeded":
      return "success";
    case "failed":
    case "lost":
    case "timed_out":
      return "danger";
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
