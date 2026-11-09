import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { IdleSessionsLease } from "../startup/managed-types.ts";
import type { HostedSession } from "../hosted-session.ts";
import type { SessionRegistry } from "../registry.ts";
import { installPackageCatalog, readLocalPackageCatalog, type PackageSpec } from "./packages.ts";

export const NATIVE_HOST_COMMANDS = new Set([
  "client_workspaces", "client_packages", "client_packages_install", "client_browse_directory", "client_create_directory",
]);

async function existingDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("path must be an existing absolute remote directory");
  const path = await realpath(value);
  if (!(await stat(path)).isDirectory()) throw new Error("path must be an existing absolute remote directory");
  return path;
}

/** Host-level discovery and approved package installation, separate from session execution. */
export class NativeClientHost {
  private readonly registry: SessionRegistry;

  constructor(registry: SessionRegistry) { this.registry = registry; }

  get busy(): boolean { return this.registry.maintenance.busy; }

  async reload(sessionId: string): Promise<void> {
    const target = this.registry.get(sessionId);
    if (!target) throw new Error("Remote session is not open");
    await this.registry.maintenance.withIdleSessions("reload", (_live, maintenance) => this.reloadSessions([target], maintenance));
  }

  private async reloadSessions(sessions: HostedSession[], maintenance: IdleSessionsLease): Promise<void> {
    let completed = 0;
    let attempted = 0;
    const errors: unknown[] = [];
    try {
      for (const session of sessions) {
        await maintenance.refreshIdle();
        // No await between the global check and entry to the SDK reload.
        maintenance.assertIdle();
        attempted++;
        try { await session.reload(); completed++; }
        catch (error) { session.fence(); errors.push(error); }
      }
      // Startup hooks may have registered work or opened dialogs even on the last reload.
      await maintenance.refreshIdle();
      maintenance.assertIdle();
    } catch (error) {
      // Installed resources may have changed. Pending runtimes cannot safely resume with
      // old extensions; fencing admission leaves any newly started work running untouched.
      for (const pending of sessions.slice(attempted)) pending.fence();
      throw new Error(`Remote reload partial: ${completed}/${sessions.length} reloaded, ${errors.length} failed, ${sessions.length - attempted} deferred. Wait for active work and dialogs to finish; close and reopen failed or deferred sessions. History is preserved. ${String(error)}`, { cause: error });
    }
    if (errors.length) throw new Error(`Remote reload partial: ${completed}/${sessions.length} reloaded, ${errors.length} failed, 0 deferred; close and reopen failed sessions. History is preserved. ${String(errors[0])}`, { cause: errors[0] });
  }

  enterSessionOperation(): () => void { return this.registry.maintenance.enterSessionOperation(); }

  async handle(command: Record<string, unknown>): Promise<unknown> {
    if (command.type === "client_browse_directory") {
      const path = await existingDirectory(command.path);
      const directories: Array<{ name: string; path: string }> = [];
      for (const item of await readdir(path, { withFileTypes: true })) {
        if (item.isDirectory()) directories.push({ name: item.name, path: join(path, item.name) });
        else if (item.isSymbolicLink()) {
          try {
            if ((await stat(join(path, item.name))).isDirectory()) directories.push({ name: item.name, path: join(path, item.name) });
          } catch (error) {
            // A dangling link is not a browsable directory; other filesystem errors remain visible.
            if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
        }
      }
      return { path, parent: dirname(path) === path ? null : dirname(path), directories: directories.sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (command.type === "client_create_directory") {
      const name = command.name;
      if (typeof name !== "string" || !name.trim() || name === "." || name === ".." || /[/\\\\\x00-\x1f\x7f-\x9f]/.test(name)) {
        throw new Error("name must be a single new child folder name without traversal, slashes or control characters");
      }
      const parent = await existingDirectory(command.path);
      const path = join(parent, name);
      await mkdir(path);
      return { path };
    }
    if (command.type === "client_workspaces") {
      const root = process.env.PI_SERVER_WORKSPACES_DIR ?? join(homedir(), "workspaces");
      if (!isAbsolute(root)) throw new Error("PI_SERVER_WORKSPACES_DIR must be an absolute path");
      let names;
      try { names = await readdir(root, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root, workspaces: [] };
        throw error;
      }
      const workspaces = [];
      for (const item of names) {
        if (item.name.startsWith(".") || (!item.isDirectory() && !item.isSymbolicLink())) continue;
        const path = await realpath(join(root, item.name));
        if ((await stat(path)).isDirectory()) workspaces.push({ name: item.name, path });
      }
      return { root, workspaces: workspaces.sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (command.scope !== undefined && command.scope !== "global") throw new Error("Unknown package scope");
    const global = command.scope === "global";
    const cwd = global ? undefined : command.cwd === undefined ? process.cwd() : command.cwd;
    if (!global && (typeof cwd !== "string" || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory())) throw new Error("cwd must be an existing absolute remote workspace directory");
    const catalog = () => readLocalPackageCatalog(getAgentDir(), cwd as string | undefined, { scope: global ? "global" : "workspace" });
    if (command.type === "client_packages") return catalog();
    if (command.type !== "client_packages_install") throw new Error("Unknown native client host command");
    if (!Array.isArray(command.packages)) throw new Error("packages must be an array of pinned Pi package specifications");
    return this.registry.maintenance.withIdleSessions("packages", async (live, maintenance) => {
      let installError: unknown;
      try {
        await installPackageCatalog(command.packages as PackageSpec[], { agentDir: getAgentDir(), ...(global ? {} : { cwd: cwd as string }) });
      } catch (error) { installError = error; }
      // Pi mutates process-wide provider registrations, so reload serially under a
      // fresh global idle check, including providers registered by preceding reloads.
      try { await this.reloadSessions(live, maintenance); }
      catch (reloadError) {
        if (installError) throw new AggregateError([installError, reloadError], `${String(installError)} ${String(reloadError)}`, { cause: installError });
        throw reloadError;
      }
      if (installError) throw installError;
      return catalog();
    });
  }
}