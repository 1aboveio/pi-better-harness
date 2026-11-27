import { posix } from "node:path";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../client.ts";
import { showRemoteProgress } from "./remote-progress.ts";

interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
}
export type RemoteFolderIntent = { action: "open"; path: string } | { action: "select" | "create" | "retry" } | undefined;
const singleLine = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, " ");
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class RemoteFolderBrowserState {
  path: string;
  parent: string | null;
  directories: DirectoryListing["directories"] = [];
  loaded = false;
  selectedIndex = 0;
  error: string | undefined;

  constructor(path: string) {
    if (!posix.isAbsolute(path)) throw new Error("Folder path must be absolute on the remote host");
    this.path = posix.normalize(path);
    this.parent = this.path === "/" ? null : posix.dirname(this.path);
  }

  rows(): Array<{ name: string; path: string }> {
    return [...(this.parent ? [{ name: ".. / Parent folder", path: this.parent }] : []), ...this.directories];
  }

  replace(listing: DirectoryListing): void {
    const selectedPath = this.rows()[this.selectedIndex]?.path;
    this.path = listing.path;
    this.parent = listing.parent;
    this.directories = listing.directories;
    this.loaded = true;
    this.selectedIndex = Math.max(0, this.rows().findIndex(row => row.path === selectedPath));
  }
}

interface FolderUI {
  theme: Pick<Theme, "fg" | "bold">;
  rows(): number;
  requestRender(): void;
  done(intent: RemoteFolderIntent): void;
}

/** One interaction only. All requests and dialogs run after this screen closes. */
export class RemoteFolderBrowser implements Component {
  private finished = false;
  private readonly state: RemoteFolderBrowserState;
  private readonly host: string;
  private readonly ui: FolderUI;

  constructor(state: RemoteFolderBrowserState, host: string, ui: FolderUI) {
    this.state = state;
    this.host = host;
    this.ui = ui;
  }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    const budget = Math.max(0, Math.floor(Math.min(this.ui.rows(), process.stdout.rows ?? Infinity)) - 3);
    if (!width || !budget) return [];
    const { theme } = this.ui;
    const fit = (text: string) => truncateToWidth(text, width, "...");
    const legend: string[] = [];
    for (const command of ["Enter open", "s select", "n new folder", "r retry", "Esc back"]) {
      const previous = legend.at(-1);
      if (previous && visibleWidth(`${previous}  ${command}`) <= width) legend[legend.length - 1] = `${previous}  ${command}`;
      else legend.push(fit(command));
    }
    const rows = this.state.rows();
    const error = this.state.error ? [theme.fg("error", fit(singleLine(this.state.error)))] : [];
    const path = theme.fg("accent", fit(`Folder: ${singleLine(this.state.path)}`));
    const header = budget >= legend.length + error.length + 3 ? [theme.bold(fit(`New session on ${singleLine(this.host)}`))] : [];
    const available = Math.max(0, budget - header.length - 1 - error.length - legend.length);
    const height = Math.min(10, available);
    const start = Math.min(Math.max(0, this.state.selectedIndex - Math.floor(height / 2)), Math.max(0, rows.length - height));
    const body = rows.length ? rows.slice(start, start + height).map((row, index) => {
      const chosen = start + index === this.state.selectedIndex;
      const position = rows.length > height && chosen ? ` (${this.state.selectedIndex + 1}/${rows.length})` : "";
      const prefix = `${chosen ? "> " : "  "}${position ? `${position.trim()} ` : ""}`;
      const line = fit(`${prefix}${singleLine(row.name)}${row.path === this.state.parent ? "" : "/"}`);
      return chosen ? theme.fg("accent", line) : line;
    }) : height ? [theme.fg("muted", fit(this.state.loaded ? "No subfolders" : "Folder unavailable"))] : [];
    return [...header, path, ...error, ...body, ...legend.map(line => theme.fg("dim", line))].slice(0, budget).map(fit);
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.finish(undefined); return; }
    if (matchesKey(data, "r")) { this.finish({ action: "retry" }); return; }
    if (matchesKey(data, "s") || matchesKey(data, "n")) {
      if (!this.state.loaded) this.state.error = "Folder unavailable. Open its parent or press r to retry.";
      else { this.finish({ action: matchesKey(data, "s") ? "select" : "create" }); return; }
    } else if (matchesKey(data, Key.enter)) {
      const row = this.state.rows()[this.state.selectedIndex];
      if (row) this.finish({ action: "open", path: row.path });
      return;
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const count = this.state.rows().length;
      if (count) this.state.selectedIndex = (this.state.selectedIndex + (matchesKey(data, Key.up) ? -1 : 1) + count) % count;
    } else return;
    this.ui.requestRender();
  }

  private finish(intent: RemoteFolderIntent): void {
    this.finished = true;
    this.ui.done(intent);
  }

  invalidate(): void {}
  dispose(): void { this.finished = true; }
}

export async function browseRemoteFolders(ui: ExtensionUIContext, client: DaemonClient, host: string, initialPath: string): Promise<string | undefined> {
  let state = new RemoteFolderBrowserState(initialPath);
  let refresh = true;
  for (;;) {
    if (refresh) {
      state.loaded = false;
      state.error = undefined;
      try {
        const result = await showRemoteProgress(ui, host, "Loading remote folders...", () => client.call({ type: "client_browse_directory", path: state.path }));
        if (!result) return undefined;
        state.replace(result.value.data as DirectoryListing);
      } catch (error) {
        state.directories = [];
        state.error = `List failed: ${errorText(error)}. Press r to retry or open parent.`;
        state.selectedIndex = 0;
      }
      refresh = false;
    }
    const intent = await ui.custom<RemoteFolderIntent>((tui, theme, _keys, done) => new RemoteFolderBrowser(state, host, {
      theme, rows: () => tui.terminal.rows, requestRender: () => tui.requestRender(), done,
    }));
    if (!intent) return undefined;
    if (intent.action === "select") return state.path;
    if (intent.action === "retry") { refresh = true; continue; }
    if (intent.action === "open") {
      state = new RemoteFolderBrowserState(intent.path);
      refresh = true;
      continue;
    }
    const name = await ui.input(`New folder in ${singleLine(state.path)}`, "Folder name");
    if (name === undefined) continue;
    if (!name.trim() || name === "." || name === ".." || /[/\\\x00-\x1f\x7f-\x9f]/.test(name)) {
      state.error = "Enter a new child folder name without traversal, slashes or control characters. Press n to retry.";
      continue;
    }
    state.error = undefined;
    try {
      const result = await showRemoteProgress(ui, host, "Creating remote folder...", () => client.call({ type: "client_create_directory", path: state.path, name }), { cancellable: false });
      if (!result) return undefined;
      state = new RemoteFolderBrowserState(result.value.data.path as string);
      refresh = true;
    } catch (error) {
      state.error = `Create failed: ${errorText(error)}. Press n to retry or r to refresh.`;
    }
  }
}
