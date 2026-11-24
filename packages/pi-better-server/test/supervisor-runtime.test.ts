import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { WorkClient } from "../src/runtime/work-client.mjs";

test("isolated daemon admits live owners, consolidates decisions and honors live settings", { timeout: 30_000 }, async t => {
  const root = realpathSync(mkdtempSync("/tmp/pisv-"));
  const agent = join(root, "agent"), server = join(root, "server");
  mkdirSync(agent);
  const child = fork(new URL("./support/work-daemon.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: server, TMPDIR: root }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const adapters: { closeCatalogHost(): void }[] = [], clients: WorkClient[] = [];
  t.after(async () => {
    adapters.forEach(a => a.closeCatalogHost()); clients.forEach(c => c.close());
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.send("stop"); await exited; }
    rmSync(root, { recursive: true, force: true });
  });
  const [started] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("Daemon startup failed"); })]);
  const set = (enabled: boolean) => writeFileSync(join(agent, "settings.json"),
    JSON.stringify({ piBetterHarness: { supervisorMode: { enabled, scenarios: ["scope-review", "shared-decisions", "shared-fault"] } } }));
  const path = new URL("../../pi-better-subagents/catalog-host-admission.ts", import.meta.url).href;
  const { createCatalogHostAdapter } = await import(path);
  for (const sessionId of ["a", "b", "c"]) {
    const client = new WorkClient(started.ready, agent, ["runtime-catalog-v1"]); clients.push(client);
    const adapter = createCatalogHostAdapter(); adapters.push(adapter);
    adapter.noteCatalogHostContext({ cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionId: () => sessionId } }, () => ({}));
    await client.ready;
    const authority = await adapter.catalogHostAuthority(agent, root, started.ready);
    await client.request("runtime_register_catalog", { cwd: root, sessionId, authority });
  }
  const rpc = (i: number, action: string, extra: object = {}) => clients[i]!.request("runtime_supervisor_review", { scenario: "scope-review", action, ...extra });
  assert.equal((await rpc(0, "begin")).status, "disabled");
  set(true);
  const admitted = await rpc(0, "begin");
  assert.equal(admitted.status, "admitted");
  assert.equal((await rpc(1, "finish", { token: admitted.token })).status, "stale");
  set(false); assert.equal((await rpc(0, "finish", { token: admitted.token })).status, "disabled");
  // The Harness can load in a different module graph from the Subagents extension.
  set(true);
  writeFileSync(join(agent, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: agent, serverDir: server }));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const native = await import(new URL("../../pi-better-subagents/supervisor-client.mjs", import.meta.url).href);
  try {
    process.env.PI_CODING_AGENT_DIR = agent;
    const ctx = { cwd: root, isProjectTrusted: () => true, sessionManager: {
      getSessionId: () => "independent-harness", getLeafId: () => "tip", getBranch: () => [],
    } };
    const standalone = await native.openSupervisorClient({ appendEntry() {} }, ctx, AbortSignal.timeout(5000));
    try {
      const permission = await standalone.review("scope-review", "begin");
      assert.ok(permission.token);
      assert.ok((await standalone.role())?.model);
      assert.equal((await standalone.review("scope-review", "finish", permission.token)).status, "admitted");
    } finally { standalone.close(); }
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  }
  const scope = { reference: "run-1", operation: "stop watcher", host: "localhost", resource: "observer-1", effect: "local process stopped" };
  set(true);
  const leader = await rpc(0, "decision-request", { scope });
  assert.equal(leader.status, "ask");
  assert.equal((await rpc(1, "decision-request", { scope })).status, "pending");
  assert.equal((await rpc(0, "decision-answer", { scope, token: leader.token, answer: "approved" })).status, "approved");
  assert.equal((await rpc(1, "decision-query", { scope })).status, "approved");
  assert.equal((await rpc(2, "decision-query", { scope: { ...scope, host: "other" } })).status, "missing");
  const cpu = async () => { const result = once(child, "message"); child.send("cpu"); return (await result)[0]; };
  const snapshot = () => clients[0]!.request("runtime_get_snapshot", { scope: { cwd: root, limit: 1 } });
  await snapshot();
  for (const enabled of [false, true]) {
    set(enabled);
    const before = await cpu();
    const ms: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now(); await snapshot(); ms.push(performance.now() - start);
    }
    const after = await cpu();
    ms.sort((a, b) => a - b);
    t.diagnostic(JSON.stringify({ enabled, snapshots: ms.length, p95Ms: ms[37], daemonCpuMs: (after.user + after.system - before.user - before.system) / 1000 }));
  }
});
