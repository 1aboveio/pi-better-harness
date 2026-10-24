import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../client.ts";
import type { SessionSummary } from "../protocol.ts";
import { showRemoteProgress } from "./remote-progress.ts";

type BrowserTab = "active" | "closed";
export type RemoteSessionBrowserResult = { action: "attach"; session: SessionSummary } | { action: "create"; cwd?: string } | { action: "transfer"; copy: boolean; cwd?: string } | undefined;
export type RemoteSessionBrowserIntent = RemoteSessionBrowserResult | { action: "refresh" } | { action: "close" | "rename"; session: SessionSummary };

interface BrowserOptions {
  cwd?: string;
  loading?: string;
  notice?: string;
  allowTransfer?: boolean;
  selectFolder?: (initialPath: string) => Promise<string | undefined>;
}

const singleLine = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const inTab = (session: SessionSummary, tab: BrowserTab): boolean => tab === "active"
  ? session.status === "running" && session.ownership !== "moved"
  : session.status === "closed" || session.ownership === "moved";

export class RemoteSessionBrowserState {
  sessions: SessionSummary[] = [];
  tab: BrowserTab = "active";
  error: string | undefined;
  private selectedIds: Record<BrowserTab, string | undefined> = { active: undefined, closed: undefined };

  rows(tab = this.tab): SessionSummary[] {
    const groups = new Map<string, SessionSummary[]>();
    for (const session of this.sessions) {
      if (!inTab(session, tab)) continue;
      const group = groups.get(session.cwd) ?? [];
      group.push(session);
      groups.set(session.cwd, group);
    }
    return [...groups.values()].flat();
  }
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
  if (session.needsInput.length) return "needs input";
  return session.isStreaming ? "busy" : "idle";
}

/** One native interaction only. Dialogs and daemon calls belong to the outer loop. */
export class RemoteSessionBrowser implements Component {
  private finished = false;

  readonly state: RemoteSessionBrowserState;
  private readonly host: string;
  private readonly ui: BrowserUI;
  private readonly options: BrowserOptions;

  constructor(state: RemoteSessionBrowserState, host: string, ui: BrowserUI, options: BrowserOptions = {}) {
    this.state = state;
    this.host = host;
    this.ui = ui;
    this.options = options;
  }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    const terminalRows = Math.min(this.ui.rows(), process.stdout.rows ?? Number.POSITIVE_INFINITY);
    const budget = Math.max(0, Math.floor(terminalRows) - 3);
    if (!width || !budget) return [];
    const theme = this.ui.theme;
    const fit = (text: string, size = width) => truncateToWidth(text, Math.max(0, size), "...");
    const rows = this.state.rows();
    const selected = this.state.selected;
    const selectedIndex = Math.max(0, rows.findIndex(session => session.sessionId === selected?.sessionId));
    const tabs = (["active", "closed"] as const).map(tab => {
      const label = `${tab === "active" ? "Active" : "Closed"} ${this.state.rows(tab).length}`;
      return this.state.tab === tab ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("muted", label);
    });
    const tabLines = (visibleWidth(tabs.join(" ")) <= width ? [tabs.join(width < 40 ? " " : "  ")] : tabs).map(line => fit(line));
    const commands = this.options.loading ? ["Esc cancel"] : [
      "Tab tabs",
      ...(selected ? [width < 40 ? "Enter open" : this.state.tab === "closed" ? "Enter reopen" : "Enter attach",
        ...(this.state.tab === "active" ? ["x close"] : []), "F2 rename"] : []),
      "n new", "r refresh", ...(this.options.allowTransfer ? ["m move", "c copy"] : []), "Esc back",
    ];
    const legend: string[] = [];
    for (const command of commands) {
      const previous = legend.at(-1);
      if (previous && visibleWidth(`${previous}  ${command}`) <= width) legend[legend.length - 1] = `${previous}  ${command}`;
      else legend.push(fit(command));
    }
    const hostLabel = this.host === "localhost" ? "Local daemon" : `Remote: ${singleLine(this.host)}`;
    let header = [theme.bold(fit(hostLabel)),
      ...(this.options.cwd ? [theme.fg("muted", fit(`Folder: ${singleLine(this.options.cwd)}`))] : [])];
    let details = selected ? [
      ...wrapTextWithAnsi(singleLine(selected.name || "Untitled session"), width).slice(0, 2).map(line => theme.fg("accent", line)),
      ...wrapTextWithAnsi(`cwd: ${singleLine(selected.cwd)}`, width).slice(0, 2).map(line => theme.fg("muted", line)),
      theme.fg("dim", fit(`ID: ${singleLine(selected.sessionId).slice(0, 8)}`)),
    ] : [];
    let notices = this.options.notice ? wrapTextWithAnsi(singleLine(this.options.notice), width).slice(0, budget < 14 ? 1 : 2).map(line => theme.fg("warning", line)) : [];
    const errors = this.state.error ? wrapTextWithAnsi(singleLine(this.state.error), width).slice(0, budget < 14 ? 1 : 2).map(line => theme.fg("error", line)) : [];
    let spacious = width >= 48 && budget >= 16;
    const gaps = () => spacious ? 3 + (details.length ? 1 : 0) : 0;
    const minimumBody = Math.min(3, Math.max(1, rows.length));
    const fixed = () => header.length + tabLines.length + notices.length + errors.length + details.length + legend.length + gaps();
    const scrollRoom = rows.length > minimumBody ? 1 : 0;
    if (fixed() + minimumBody + scrollRoom > budget) details = [];
    if (fixed() + minimumBody + scrollRoom > budget) spacious = false;
    if (fixed() + minimumBody + scrollRoom > budget) notices = [];
    while (header.length && fixed() + minimumBody + scrollRoom > budget) header.pop();
    const available = Math.max(0, budget - fixed());
    // Use the height the terminal offers; only very short windows shed rows.
    const unreservedHeight = available;
    const entryCount = rows.length + (unreservedHeight >= 4 ? new Set(rows.map(session => session.cwd)).size : 0);
    const bodyHeight = Math.max(0, unreservedHeight - (entryCount > unreservedHeight && available > 1 ? 1 : 0));
    const grouped = bodyHeight >= 4;
    const entries: Array<{ folder: string } | { session: SessionSummary }> = [];
    let lastFolder: string | undefined;
    for (const session of rows) {
      if (grouped && session.cwd !== lastFolder) entries.push({ folder: session.cwd });
      entries.push({ session });
      lastFolder = session.cwd;
    }
    const selectedEntry = Math.max(0, entries.findIndex(entry => "session" in entry && entry.session.sessionId === selected?.sessionId));
    let start = Math.min(Math.max(0, selectedEntry - Math.floor(bodyHeight / 2)), Math.max(0, entries.length - bodyHeight));
    // Repeat the visible group's path when scrolling starts inside its sessions.
    const firstEntry = entries[start];
    const context = grouped && firstEntry && "session" in firstEntry ? [theme.fg("muted", fit(singleLine(firstEntry.session.cwd)))] : [];
    if (context.length && selectedEntry >= start + bodyHeight - 1) start++;
    const body: string[] = [];
    if (this.options.loading) body.push(theme.fg("muted", fit(this.options.loading)));
    else if (!rows.length) body.push(theme.fg("muted", fit(this.state.tab === "active" ? "No active sessions" : "No closed sessions")));
    else {
      body.push(...context);
      for (const entry of entries.slice(start, start + Math.max(0, bodyHeight - context.length))) {
        if ("folder" in entry) { body.push(theme.fg("muted", fit(singleLine(entry.folder)))); continue; }
        const session = entry.session;
        const chosen = session.sessionId === selected?.sessionId;
        const badge = available === 1 && rows.length > 1 ? `(${selectedIndex + 1}/${rows.length})` : `[${sessionActivity(session)}]`;
        const statusWidth = Math.min(visibleWidth(badge), Math.max(0, width - 5));
        const nameWidth = Math.max(0, width - 2 - statusWidth - 2);
        const name = fit(singleLine(session.name || "Untitled session"), nameWidth);
        const paddedName = name + " ".repeat(Math.max(0, nameWidth - visibleWidth(name)));
        const statusColor = session.ownership || session.needsInput.length ? "warning" : session.isStreaming ? "accent" : "muted";
        body.push(fit(`${chosen ? theme.fg("accent", "> ") : "  "}${chosen ? theme.fg("accent", paddedName) : paddedName}  ${theme.fg(statusColor, fit(badge, statusWidth))}`));
      }
    }
    const scrolling = entries.length > bodyHeight && bodyHeight > 0 && available > 1 ? [theme.fg("dim", fit(`(${selectedIndex + 1}/${rows.length})`))] : [];
    const gap = spacious ? [""] : [];
    return [...header, ...gap, ...tabLines, ...gap, ...notices, ...errors, ...body, ...scrolling,
      ...(details.length ? [...gap, ...details] : []), ...gap, ...legend.map(line => theme.fg("dim", line))].slice(0, budget).map(line => fit(line));
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.finish(undefined); return; }
    if (this.options.loading) return;
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.state.changeTab();
    } else if (matchesKey(data, "n")) { this.finish({ action: "create" }); return; }
    else if (this.options.allowTransfer && (matchesKey(data, "m") || matchesKey(data, "c"))) { this.finish({ action: "transfer", copy: matchesKey(data, "c") }); return; }
    else if (matchesKey(data, "r")) { this.finish({ action: "refresh" }); return; }
    else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const rows = this.state.rows();
      const index = Math.max(0, rows.findIndex(session => session.sessionId === this.state.selected?.sessionId));
      const next = rows[(index + (matchesKey(data, Key.up) ? -1 : 1) + rows.length) % rows.length];
      if (next) this.state.select(next.sessionId);
    } else {
      const session = this.state.selected;
      if (!session) return;
      if (matchesKey(data, Key.enter) || matchesKey(data, "x") || matchesKey(data, Key.f2)) {
        if (session.ownership !== undefined) {
          this.state.error = session.ownership === "moved"
            ? "Session moved away; cannot attach, close, or rename on this host. Select another session."
            : "Session fenced for a move; cannot attach, close, or rename. Refresh or select another session.";
        } else if (matchesKey(data, Key.enter)) { this.finish({ action: "attach", session }); return; }
        else if (matchesKey(data, "x") && this.state.tab === "active") { this.finish({ action: "close", session }); return; }
        else if (matchesKey(data, Key.f2)) { this.finish({ action: "rename", session }); return; }
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

  invalidate(): void {}
  dispose(): void { this.finished = true; }
}

type PendingResult<T> = { value: T } | { error: unknown } | undefined;

async function showPending<T>(ui: ExtensionUIContext, host: string, loading: string, run: () => Promise<T>, cancellable = true): Promise<PendingResult<T>> {
  try { return await showRemoteProgress(ui, host, loading, run, { cancellable }); }
  catch (error) { return { error }; }
}

export async function browseRemoteSessions(ui: ExtensionUIContext, client: DaemonClient, host: string, options: BrowserOptions = {}): Promise<RemoteSessionBrowserResult> {
  const state = new RemoteSessionBrowserState();
  let refresh = true;
  for (;;) {
    if (refresh) {
      const result = await showPending(ui, host, "Loading sessions...", () => client.call({ type: "list_sessions" }));
      if (!result) return undefined;
      if ("error" in result) state.error = `Refresh failed: ${errorText(result.error)}. Press r to retry.`;
      else state.replaceSessions(result.value.data.sessions as SessionSummary[]);
      refresh = false;
    }
    const intent = await ui.custom<RemoteSessionBrowserIntent>((tui, theme, _keys, done) => new RemoteSessionBrowser(state, host, {
      theme, requestRender: () => tui.requestRender(), rows: () => tui.terminal.rows, done,
    }, options));
    if (!intent || intent.action === "attach") return intent;
    if (intent.action === "create" || intent.action === "transfer") {
      if (!options.selectFolder) return intent;
      try {
        const cwd = await options.selectFolder(options.cwd ?? "/");
        if (cwd !== undefined) return { ...intent, cwd };
      } catch (error) { state.error = `Folder browser failed: ${errorText(error)}. Press n to retry.`; }
      continue;
    }
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
      if (!name) { state.error = "Name cannot be empty. Press F2 to rename again."; continue; }
      command = { type: "rename_session", sessionId: session.sessionId, name };
    }
    const result = await showPending(ui, host, intent.action === "close" ? "Closing session..." : "Renaming session...", () => client.call(command), false);
    if (!result) return undefined;
    if ("error" in result) state.error = `${intent.action === "close" ? "Close" : "Rename"} failed: ${errorText(result.error)}. Press ${intent.action === "close" ? "x" : "F2"} to retry or r to refresh.`;
    refresh = true;
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
