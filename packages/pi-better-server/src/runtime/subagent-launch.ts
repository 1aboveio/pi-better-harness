import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

export function hasSubagentManagement(root: string): boolean {
  const path = join(root, "operation-coordinator.sqlite");
  if (!existsSync(path)) return false;
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subagent_management'").get(); }
  finally { db.close(); }
}

/** Fixed bundled domain adapter. No client module paths reach this boundary. */
export async function createSubagentLaunch(root: string, instance: string, catalog: unknown) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Managed subagents require Node 24 or newer");
  const path = "./domain/subagents/managed-launch-host.domain.mjs";
  const { ManagedSubagentHost } = await import(path);
  const host = new ManagedSubagentHost(root, instance, catalog);
  try {
    await host.recover();
    return host;
  } catch (error) {
    await host.close();
    throw error;
  }
}
