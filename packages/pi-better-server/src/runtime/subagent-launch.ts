import { effectiveBackgroundPolicy } from './background-policy.ts';
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
export async function createSubagentLaunch(root: string, instance: string, catalog: unknown, verificationMs = 30000) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Managed subagents require Node 24 or newer");
  const path = "./domain/subagents/managed-launch-host.domain.mjs";
  const { ManagedSubagentHost } = await import(path);
  const lease = acquireMutationStore(root);
  let host: any;
  try {
    const servicePath = "./domain/background-service/observed-waits.domain.mjs";
    const { createObservedWaitHost } = await import(servicePath);
    const permissionPath = "./domain/sandbox-policy/permission-settings.domain.mjs";
    const { readPermissionSettings } = await import(permissionPath);
    const toolsPath = "./domain/background-service/tools.domain.mjs";
    const runtimePath = "./domain/background-service/runtime.domain.mjs";
    const { registerTools } = await import(toolsPath);
    const { createBackgroundTaskRuntime } = await import(runtimePath);
    const sandboxPath="./domain/background-service/sandbox.domain.mjs";
    const sandbox=await import(sandboxPath);
    host = new ManagedSubagentHost(root, instance, catalog, lease.store, (pi: any) => {
      const service = createObservedWaitHost(pi, { sharedStore: lease.store, storePath: join(root, "operation-coordinator.sqlite"), serverOwnedResults: true, pollMs: 0,
        enterControl: () => lease.budget.enter("control"), verificationMs,
        prepareWorkerPolicy(run:any){
          const resolve=()=>{
            const attempt=lease.store.subagentLaunchJournal().attempt(run.runId);
            if(!attempt?.launchAuthority)throw new Error('permission-unavailable: captured worker launch authority missing');
            const saved=attempt.launchAuthority.permissions;
            const captured=saved?.backgroundPolicy ?? (saved?.subagentPermissions?{state:saved.subagentPermissions.enabled?'enabled':'inactive',permissions:saved.subagentPermissions}:undefined);
            return effectiveBackgroundPolicy(captured,readPermissionSettings({agentDir:()=>root}).background,run.workspace) ?? {state:'inactive'};
          };
          const workerPolicy=resolve();sandbox.clearForegroundSandboxPolicy(pi);
          pi.events.emit('pi-better-sandbox:policy',{...workerPolicy,background:workerPolicy});
          const expected=JSON.stringify(workerPolicy);
          return ()=>{if(JSON.stringify(resolve())!==expected)throw new Error('permission-unavailable: Background policy changed before worker dispatch');};
        }
      });
      const runtime = createBackgroundTaskRuntime(undefined, undefined, undefined,
        (kind: string, _id: string, work: () => unknown) => lease.budget.source(`legacy-${kind}`, work));
      registerTools(pi, runtime, () => undefined);
      const close = service.close.bind(service);
      service.close = () => { try { close(); } finally { runtime.suspendScheduledWork(); } };
      return service;
    }, () => readPermissionSettings({ agentDir: () => root }), verificationMs, () => lease.budget.enter("control"));
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
