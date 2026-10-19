import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../client.ts";
import type { SessionSummary } from "../protocol.ts";

type BrowserTab = "active" | "closed";
export type RemoteSessionBrowserResult = { action: "attach"; session: SessionSummary } | { action: "create" } | undefined;
export type RemoteSessionBrowserIntent = RemoteSessionBrowserResult | { action: "refresh" } | { action: "close" | "rename"; session: SessionSummary };

const singleLine = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const inTab = (session: SessionSummary, tab: BrowserTab): boolean => tab === "active"
  ? session.status === "running" && session.ownership !== "moved"
  : session.status === "closed" || session.ownership === "moved";

export class RemoteSessionBrowserState {
  sessions: SessionSummary[] = [];
  tab: BrowserTab = "active";
  error: string | undefined;
  private selectedIds: Record<BrowserTab, string | undefined> = { active: undefined, closed: undefined };

  rows(tab = this.tab): SessionSummary[] { return this.sessions.filter(session => inTab(session, tab)); }
  get selected(): SessionSummary | undefined { return this.rows().find(session => session.sessionId === this.selectedIds[this.tab]); }

  replaceSessions(sessions: SessionSummary[]): void {
    const oldIndices = { active: this.rows("active").findIndex(s => s.sessionId === this.selectedIds.active), closed: this.rows("closed").findIndex(s => s.sessionId === this.selectedIds.closed) };
    this.sessions = sessions;
    for (const tab of ["active", "closed"] as const) {
      const rows = this.rows(tab);
      if (!rows.some(session => session.sessionId === this.selectedIds[tab])) {
        this.selectedIds[tab] = rows[Math.min(Math.max(0, oldIndices[tab]), rows.length - 1)]?.sessionId;
      }
    }
  }

  select(sessionId: string): void {
    if (this.rows().some(session => session.sessionId === sessionId)) this.selectedIds[this.tab] = sessionId;
  }

  changeTab(): void { this.tab = this.tab === "active" ? "closed" : "active"; }
}

interface BrowserUI {
  theme: Pick<Theme, "fg" | "bold">;
  requestRender(): void;
  rows(): number;
  done(intent: RemoteSessionBrowserIntent): void;
}

function sessionActivity(session: SessionSummary): string {
  if (session.ownership === "moved") return "moved - cannot attach";
  if (session.ownership === "fenced") return "fenced";
  if (session.status === "closed") return "closed";
  if (session.needsInput.length) return "needsInput";
  return session.isStreaming ? "busy" : "idle";
}

/** One native interaction only. Dialogs and daemon calls belong to the outer loop. */
export class RemoteSessionBrowser implements Component {
  private list: SelectList | undefined;
  private finished = false;

  readonly state: RemoteSessionBrowserState;
  private readonly host: string;
  private readonly ui: BrowserUI;
  private readonly options: { cwd?: string; loading?: string };

  constructor(state: RemoteSessionBrowserState, host: string, ui: BrowserUI, options: { cwd?: string; loading?: string } = {}) {
    this.state = state;
    this.host = host;
    this.ui = ui;
    this.options = options;
  }

  private makeList(height: number): SelectList {
    const theme = this.ui.theme;
    const rows = this.state.rows();
    const list = new SelectList(rows.map(session => ({
      value: session.sessionId,
      label: `[${sessionActivity(session)}] ${singleLine(session.name || "Untitled session")}`,
      description: singleLine(session.cwd),
    })), height, {
      selectedPrefix: text => theme.fg("accent", text),
      selectedText: text => theme.fg("accent", text),
      description: text => theme.fg("muted", text),
      scrollInfo: text => theme.fg("dim", text),
      noMatch: text => theme.fg("muted", text),
    });
    const selectedId = this.state.selected?.sessionId;
    list.setSelectedIndex(Math.max(0, rows.findIndex(session => session.sessionId === selectedId)));
    list.onSelectionChange = item => this.state.select(item.value);
    this.list = list;
    return list;
  }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    if (width === 0) return [];
    const theme = this.ui.theme;
    const fit = (text: string) => truncateToWidth(text, width, "");
    // Leave two terminal lines for Pi's footer, independently of our own fixed content.
    const budget = Math.max(0, Math.floor(this.ui.rows()) - 2);
    if (budget === 0) return [];
    const rows = this.state.rows();
    const minimumBody = this.options.loading ? 1 : Math.min(3, Math.max(1, rows.length));
    const renderTabs = (compact: boolean): string[] => {
      const labels = (["active", "closed"] as const).map(tab => `${tab === "active" ? "Active" : "Closed"}${compact ? "" : " sessions"} (${this.state.rows(tab).length})`);
      if (compact && visibleWidth(labels.join("  ")) + 2 > width) {
        labels[0] = "Active";
        labels[1] = "Closed";
      }
      const tabs = labels.map((label, index) => this.state.tab === (index === 0 ? "active" : "closed")
        ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("muted", label));
      return (visibleWidth(tabs.join("  ")) <= width ? [tabs.join("  ")] : tabs).map(fit);
    };
    let tabLines = renderTabs(false);
    let host = [theme.bold(fit(`Remote: ${singleLine(this.host)}`))];
    let legend = wrapTextWithAnsi("Up/Down select  Tab/ShiftTab/Left/Right tabs  Enter attach  x close  n rename  c Create session  r refresh  Esc back", width);
    const selected = this.state.selected;
    let details = selected ? [
      ...wrapTextWithAnsi(`ID: ${singleLine(selected.sessionId)}`, width),
      fit(`cwd: ${singleLine(selected.cwd)}`),
    ] : this.options.cwd ? [fit(`cwd: ${singleLine(this.options.cwd)}`)] : [];
    let errors = this.state.error ? wrapTextWithAnsi(singleLine(this.state.error), width).slice(0, 2) : [];
    const fixedHeight = () => host.length + tabLines.length + errors.length + details.length + legend.length;
    if (fixedHeight() + minimumBody > budget) {
      tabLines = renderTabs(true);
      legend = wrapTextWithAnsi("Up/Down Tab tabs Enter attach x close n rename c create r refresh Esc back", width);
      details = selected ? [fit(`ID: ${singleLine(selected.sessionId)}`)] : details;
      errors = errors.slice(0, 1);
    }
    if (fixedHeight() + minimumBody > budget) host = [];
    if (fixedHeight() + minimumBody > budget) details = [];
    // At physically tiny sizes, bound the controls too instead of overflowing fixed content.
    tabLines = tabLines.slice(0, Math.max(0, budget - 1));
    legend = legend.slice(0, Math.max(0, budget - tabLines.length - errors.length - 1));
    const bodyBudget = Math.max(0, budget - fixedHeight());
    const listHeight = Math.max(1, bodyBudget - (rows.length > bodyBudget ? 1 : 0));
    const body = bodyBudget === 0 ? [] : this.options.loading ? [theme.fg("muted", fit(this.options.loading))]
      : rows.length ? this.makeList(listHeight).render(Math.max(4, width)).slice(0, bodyBudget).map(fit)
      : [theme.fg("muted", fit(this.state.tab === "active" ? "No active sessions" : "No closed sessions"))];
    return [...host, ...tabLines, ...errors.map(line => theme.fg("error", line)), ...body,
      ...details.map(line => theme.fg("muted", line)), ...legend.map(line => theme.fg("dim", line))].map(fit);
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.finish(undefined); return; }
    if (this.options.loading) return;
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.state.changeTab();
      this.list = undefined;
    } else if (matchesKey(data, "c")) { this.finish({ action: "create" }); return; }
    else if (matchesKey(data, "r")) { this.finish({ action: "refresh" }); return; }
    else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      (this.list ?? this.makeList(1)).handleInput(data);
    } else {
      const session = this.state.selected;
      if (!session) return;
      if (matchesKey(data, Key.enter) || matchesKey(data, "x") || matchesKey(data, "n")) {
        if (session.ownership !== undefined) {
          this.state.error = session.ownership === "moved"
            ? "Session moved away; cannot attach, close, or rename on this host. Select another session."
            : "Session fenced for a move; cannot attach, close, or rename. Refresh or select another session.";
        } else if (matchesKey(data, Key.enter)) { this.finish({ action: "attach", session }); return; }
        else if (matchesKey(data, "x") && this.state.tab === "active") { this.finish({ action: "close", session }); return; }
        else if (matchesKey(data, "n")) { this.finish({ action: "rename", session }); return; }
        else return;
      } else return;
    }
    this.ui.requestRender();
  }

  private finish(intent: RemoteSessionBrowserIntent): void {
    if (this.finished) return;
    this.finished = true;
    this.ui.done(intent);
  }

  invalidate(): void { this.list?.invalidate(); }
  dispose(): void { this.finished = true; }
}

type PendingResult<T> = { value: T } | { error: unknown } | undefined;

/** The operation is already started by the caller, never by the custom-screen factory. */
async function showPending<T>(ui: ExtensionUIContext, state: RemoteSessionBrowserState, host: string, options: { cwd?: string }, loading: string, pending: Promise<T>): Promise<PendingResult<T>> {
  const settled = pending.then(value => ({ value }), error => ({ error }));
  return ui.custom<PendingResult<T>>((tui, theme, _keys, done) => {
    let disposed = false;
    const screen = new RemoteSessionBrowser(state, host, {
      theme, requestRender: () => tui.requestRender(), rows: () => tui.terminal.rows,
      done: () => { if (!disposed) { disposed = true; done(undefined); } },
    }, { ...options, loading });
    void settled.then(result => { if (!disposed) { disposed = true; done(result); } });
    return {
      render: width => screen.render(width),
      handleInput: data => screen.handleInput(data),
      invalidate: () => screen.invalidate(),
      dispose: () => { disposed = true; screen.dispose(); },
    };
  });
}

export async function browseRemoteSessions(ui: ExtensionUIContext, client: DaemonClient, host: string, options: { cwd?: string } = {}): Promise<{ action: "attach"; session: SessionSummary } | { action: "create" } | undefined> {
  const state = new RemoteSessionBrowserState();
  let refresh = true;
  for (;;) {
    if (refresh) {
      const result = await showPending(ui, state, host, options, "Loading sessions...", client.call({ type: "list_sessions" }));
      if (!result) return undefined;
      if ("error" in result) state.error = `Refresh failed: ${errorText(result.error)}. Press r to retry.`;
      else state.replaceSessions(result.value.data.sessions as SessionSummary[]);
      refresh = false;
    }
    const intent = await ui.custom<RemoteSessionBrowserIntent>((tui, theme, _keys, done) => new RemoteSessionBrowser(state, host, {
      theme, requestRender: () => tui.requestRender(), rows: () => tui.terminal.rows, done,
    }, options));
    if (!intent || intent.action === "attach" || intent.action === "create") return intent;
    state.error = undefined;
    if (intent.action === "refresh") { refresh = true; continue; }
    const session = intent.session;
    let command: Record<string, unknown>;
    if (intent.action === "close") {
      if ((session.isStreaming || session.needsInput.length > 0) && !await ui.confirm("Close session?", `${singleLine(session.name || session.sessionId)} (${session.sessionId}) is ${session.needsInput.length ? "waiting for input" : "busy"}. Closing interrupts this session.`)) continue;
      command = { type: "close_session", sessionId: session.sessionId };
    } else {
      const input = await ui.input(`Rename session (${session.sessionId})`, session.name);
      if (input === undefined) continue;
      const name = input.trim();
      if (!name) { state.error = "Name cannot be empty. Press n to rename again."; continue; }
      command = { type: "rename_session", sessionId: session.sessionId, name };
    }
    const result = await showPending(ui, state, host, options, intent.action === "close" ? "Closing session..." : "Renaming session...", client.call(command));
    if (!result) return undefined;
    if ("error" in result) state.error = `${intent.action === "close" ? "Close" : "Rename"} failed: ${errorText(result.error)}. Press ${intent.action === "close" ? "x" : "n"} to retry or r to refresh.`;
    refresh = true;
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
