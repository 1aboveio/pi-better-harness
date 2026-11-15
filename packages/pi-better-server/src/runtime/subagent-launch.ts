import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { acquireMutationStore } from "./mutation-store.ts";

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
  const lease = acquireMutationStore(root);
  let host: any;
  try {
    const servicePath = "./domain/background-service/observed-waits.domain.mjs";
    const { createObservedWaitHost } = await import(servicePath);
    host = new ManagedSubagentHost(root, instance, catalog, lease.store, (pi: any) =>
      createObservedWaitHost(pi, { sharedStore: lease.store, storePath: join(root, "operation-coordinator.sqlite"), serverOwnedResults: true }));
    await host.recover();
    const close = host.close.bind(host);
    host.close = async () => {
      try { await close(); } finally { lease.release(); }
    };
    return host;
  } catch (error) {
    try { await host?.close(); } finally { lease.release(); }
    throw error;
  }
}
