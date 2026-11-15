import { join } from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const root = process.env.PI_CODING_AGENT_DIR!;
// This process already runs under tsx. Use the SDK's real factory entry point
// instead of compiling the same extension closure again in each jiti instance.
const { default: background } = await import(new URL("../../../pi-better-background-tasks/src/index.ts", import.meta.url).href);
const factories = [background];
if (process.env.PI_TEST_PERMISSION_PUBLISHER === "1") {
  const { default: sandbox } = await import(new URL("../../../pi-better-sandbox/index.ts", import.meta.url).href);
  factories.push(sandbox);
}
// The SDK loads the production extension; no model request is needed to exercise its registered tools.
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
  extensionFactories: factories,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await resourceLoader.reload();
if (resourceLoader.getExtensions().errors.length) throw new Error(JSON.stringify(resourceLoader.getExtensions().errors));
const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader,
  sessionManager: SessionManager.inMemory(root) });
await session.bindExtensions({ onError: error => { throw new Error(String(error)); }, shutdownHandler: () => {} });
const tool = (name: string) => {
  const found = session.agent.state.tools.find(tool => tool.name === name);
  if (!found) throw new Error(`Production SDK tool missing: ${name}`);
  return found;
};
const request = { shell: false, callback: true,
  argv: [process.execPath, "-e", `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(root, "executions"))},'start\\n');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, "finish"))})){clearInterval(t);console.log('independent terminal evidence');}},20);`] };
const launched = await tool("bg_task_spawn").execute("spawn-760", request);
const receipt = launched.details as { id?: string; operationId?: string; owner?: { sessionId: string; workspace: string } } | undefined;
assert.ok(receipt?.id && receipt.operationId, `Registered tool did not return a durable admission receipt: ${JSON.stringify(launched)}`);
const taskId = receipt.id;
const db = new DatabaseSync(join(root, "operation-coordinator.sqlite"), { readOnly: true });
try {
  const operation = db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(receipt.operationId)!;
  assert.equal(operation.task_id, taskId);
  assert.equal(operation.owner_session_id, session.sessionId);
  assert.equal(operation.owner_workspace, root);
  assert.equal(receipt.owner?.sessionId, session.sessionId);
  assert.equal(receipt.owner?.workspace, root);
  const grant = JSON.parse(String(db.prepare("SELECT value FROM coordinator_state WHERE key = ?").get(`result-supervision-v1:${receipt.operationId}`)!.value));
  assert.equal(grant.launchToken, operation.launch_token);
  const { readLaunchRecord } = await import(new URL("../../../pi-better-background-tasks/src/supervisor/store.ts", import.meta.url).href);
  const execution = readLaunchRecord(grant.directory, taskId).value;
  assert.equal(execution?.token, operation.launch_token);
  assert.deepEqual(execution.command.argv, request.argv);
  assert.equal(execution.command.cwd, root);
  assert.equal(grant.authorityRef, operation.authority_ref);
  assert.equal(grant.owner.sessionId, session.sessionId);
  assert.equal(grant.owner.workspace, root);
  assert.equal(grant.capability.captured.provenance.policySource, process.env.PI_TEST_PERMISSION_PUBLISHER === "1" ? "background" : "no-publisher");
  assert.equal(grant.capability.current.policySource, process.env.PI_TEST_PERMISSION_PUBLISHER === "1" ? "background" : "no-publisher");
} finally { db.close(); }
const waited = await tool("wait_for_operations").execute("wait-760", { task_ids: [taskId], continuation_note: "Interpret the independent result" });
if (!(waited.details as any)?.waitId) throw new Error(JSON.stringify(waited));
process.send?.({ taskId, wait: waited.details, sessionId: session.sessionId });
process.on("message", () => { session.dispose(); process.exit(0); });
