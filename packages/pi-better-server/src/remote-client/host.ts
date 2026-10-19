import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionRegistry } from "../registry.ts";
import { installPackageCatalog, readLocalPackageCatalog, type PackageSpec } from "./packages.ts";

export const NATIVE_HOST_COMMANDS = new Set(["client_workspaces", "client_packages", "client_packages_install"]);

/** Host-level discovery and approved package installation, separate from session execution. */
export class NativeClientHost {
  private installing = false;
  private sessionOperations = 0;
  private readonly registry: SessionRegistry;

  constructor(registry: SessionRegistry) { this.registry = registry; }

  get busy(): boolean { return this.installing; }

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
    if (this.installing) throw new Error("Another client is updating remote extensions");
    if (this.sessionOperations > 0 || this.registry.list().some((session) => session.live)) {
      throw new Error("Close remote daemon sessions before updating extensions; their running extension code must not be replaced");
    }
    this.installing = true;
    try {
      await installPackageCatalog(command.packages as PackageSpec[], { agentDir: getAgentDir(), cwd });
      return await readLocalPackageCatalog(getAgentDir(), cwd);
    } finally {
      this.installing = false;
    }
  }
}