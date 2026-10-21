import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../hosted-session.ts";
import type { SessionRegistry } from "../registry.ts";
import { installPackageCatalog, readLocalPackageCatalog, type PackageSpec } from "./packages.ts";

export const NATIVE_HOST_COMMANDS = new Set(["client_workspaces", "client_packages", "client_packages_install"]);

type Maintenance = {
  assertIdle(): void;
  refreshIdle(): Promise<void>;
  fence(session: HostedSession): void;
};

/** Host-level discovery and approved package installation, separate from session execution. */
export class NativeClientHost {
  private installing = false;
  private sessionOperations = 0;
  private readonly stale = new WeakSet<HostedSession>();
  private readonly registry: SessionRegistry;

  constructor(registry: SessionRegistry) { this.registry = registry; }

  get busy(): boolean { return this.installing; }

  async reload(sessionId: string): Promise<void> {
    const target = this.registry.get(sessionId);
    if (!target) throw new Error("Remote session is not open");
    await this.withIdleSessions((_live, maintenance) => this.reloadSessions([target], maintenance));
  }

  /** Pi 0.82 and 1.2 bind extension actions through these public session methods.
   * Guard admission before any SDK preflight await; never abort or queue new work.
   * Arbitrary extension background work is observed separately through refreshActivity.
   */
  private guardAdmission(hosted: HostedSession): () => void {
    if (this.stale.has(hosted)) return () => {};
    const session = hosted.session;
    const restore: Array<() => void> = [];
    for (const key of ["prompt", "steer", "followUp", "sendUserMessage", "sendCustomMessage", "executeBash", "compact", "navigateTree"] as const) {
      const original = session[key];
      const descriptor = Object.getOwnPropertyDescriptor(session, key);
      const host = this;
      Object.defineProperty(session, key, {
        configurable: true, writable: true,
        value: async function (...args: unknown[]) {
          if (host.stale.has(hosted)) throw new Error("Session runtime is closed; close and reopen the session. History is preserved.");
          // Non-triggering custom messages remain available to initialization hooks.
          const options = args[1] as { triggerTurn?: boolean; deliverAs?: string } | undefined;
          const startsWork = key !== "sendCustomMessage" || (options?.triggerTurn && options.deliverAs !== "nextTurn");
          if (host.installing && startsWork) throw new Error("Remote session maintenance is in progress; extensions are being updated. Retry after maintenance.");
          return Reflect.apply(original, session, args);
        },
      });
      restore.push(() => {
        if (descriptor) Object.defineProperty(session, key, descriptor);
        else delete (session as unknown as Record<string, unknown>)[key];
      });
    }
    return () => { if (!this.stale.has(hosted)) for (const reset of restore) reset(); };
  }

  private async reloadSessions(sessions: HostedSession[], maintenance: Maintenance): Promise<void> {
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
        catch (error) { maintenance.fence(session); errors.push(error); }
      }
      // Startup hooks may have registered work or opened dialogs even on the last reload.
      await maintenance.refreshIdle();
      maintenance.assertIdle();
    } catch (error) {
      // Installed resources may have changed. Pending runtimes cannot safely resume with
      // old extensions; fencing admission leaves any newly started work running untouched.
      for (const pending of sessions.slice(attempted)) maintenance.fence(pending);
      throw new Error(`Remote reload partial: ${completed}/${sessions.length} reloaded, ${errors.length} failed, ${sessions.length - attempted} deferred. Wait for active work and dialogs to finish; close and reopen failed or deferred sessions. History is preserved. ${String(error)}`, { cause: error });
    }
    if (errors.length) throw new Error(`Remote reload partial: ${completed}/${sessions.length} reloaded, ${errors.length} failed, 0 deferred; close and reopen failed sessions. History is preserved. ${String(errors[0])}`, { cause: errors[0] });
  }

  private async withIdleSessions<T>(run: (sessions: HostedSession[], maintenance: Maintenance) => Promise<T>): Promise<T> {
    if (this.installing || this.sessionOperations > 0 || this.registry.hasPendingOperations) throw new Error("Remote session maintenance is already in progress");
    const live = this.registry.list().filter(item => item.live).map(item => this.registry.get(item.sessionId)!);
    const assertIdle = () => {
      if (live.some(session => session.executionActive || session.activityChecking || session.needsInput.length)) {
        throw new Error("Wait for remote model, tool, bash, compaction, background work and dialogs to finish before reloading");
      }
    };
    assertIdle();
    // SDK reload changes process-wide providers, so other live sessions must also be idle.
    this.installing = true;
    const restore: Array<() => void> = [];
    const maintenance: Maintenance = {
      assertIdle,
      refreshIdle: async () => {
        await Promise.all(live.map(session => session.refreshActivity()));
        assertIdle();
      },
      fence: session => { session.fence(); this.stale.add(session); },
    };
    try {
      for (const session of live) restore.push(this.guardAdmission(session));
      await maintenance.refreshIdle();
      return await run(live, maintenance);
    } finally {
      for (const reset of restore) reset();
      this.installing = false;
    }
  }

  enterSessionOperation(): () => void {
    if (this.installing) throw new Error("Remote extensions are being updated");
    this.sessionOperations++;
    let released = false;
    return () => { if (!released) { released = true; this.sessionOperations--; } };
  }

  async handle(command: Record<string, unknown>): Promise<unknown> {
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
    const cwd = command.cwd === undefined ? process.cwd() : command.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("cwd must be an existing absolute remote workspace directory");
    if (command.type === "client_packages") return readLocalPackageCatalog(getAgentDir(), cwd);
    if (command.type !== "client_packages_install") throw new Error("Unknown native client host command");
    if (!Array.isArray(command.packages)) throw new Error("packages must be an array of pinned Pi package specifications");
    return this.withIdleSessions(async (live, maintenance) => {
      let installError: unknown;
      try {
        await installPackageCatalog(command.packages as PackageSpec[], { agentDir: getAgentDir(), cwd });
      } catch (error) { installError = error; }
      // Pi mutates process-wide provider registrations, so reload serially under a
      // fresh global idle check, including providers registered by preceding reloads.
      try { await this.reloadSessions(live, maintenance); }
      catch (reloadError) {
        if (installError) throw new AggregateError([installError, reloadError], `${String(installError)} ${String(reloadError)}`, { cause: installError });
        throw reloadError;
      }
      if (installError) throw installError;
      return readLocalPackageCatalog(getAgentDir(), cwd);
    });
  }
}