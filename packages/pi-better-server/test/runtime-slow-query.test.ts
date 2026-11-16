import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { privateRuntimeNode } from "./private-runtime-node.ts";

test("a wedged reader cannot delay the configured idle fence after the last client disconnects", { timeout: 10000 }, async () => {
  const root = realpathSync(mkdtempSync("/tmp/idle-wedge-runtime-"));
  const agent = join(root, "agent"); mkdirSync(agent);
  const child = fork(new URL("./support/slow-query-daemon.ts", import.meta.url), [], {
    execPath: privateRuntimeNode().node, execArgv: ["--import", "tsx"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: join(root, "server"), TMPDIR: root,
      PI_SERVER_RUNTIME_IDLE_MS: "100", PI_TEST_EXIT_ON_IDLE: "1" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let client: WorkClient | undefined;
  const exited = once(child, "exit");
  let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
  try {
    const [started] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(errors); })]);
    client = new WorkClient(started.socket, agent); await client.ready; await client.get({});
    const wedged = once(child, "message"); child.send("wedge");
    assert.equal((await wedged)[0].type, "wedged");
    client.close();
    const [code, signal] = await exited;
    assert.equal(code, 0, errors); assert.equal(signal, null);
    const checkpoint = JSON.parse(readFileSync(join(root, "server", "clean-stop.json"), "utf8"));
    assert.equal(checkpoint.idleEvidence.lifecycle.runtimeIdleMs, 100);
    assert.deepEqual(checkpoint.idleEvidence.obligations, []);
    assert.ok(checkpoint.idleEvidence.at >= checkpoint.idleEvidence.deadline);
  } finally {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) { child.send("stop"); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("real daemon isolates caller timeout, controls and worker recovery for two socket clients", { timeout: 20000 }, async t => {
  const root = realpathSync(mkdtempSync("/tmp/slow-runtime-"));
  const agent = join(root, "agent"); mkdirSync(agent);
  const child = fork(new URL("./support/slow-query-daemon.ts", import.meta.url), [], {
    execPath: privateRuntimeNode().node, execArgv: ["--import", "tsx"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: join(root, "server"), TMPDIR: root },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
  const clients: WorkClient[] = [];
  try {
    const [started] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors); })]);
    for (let i = 0; i < 2; i++) { const client = new WorkClient(started.socket, agent); clients.push(client); await client.ready; }
    const [a, b] = clients;
    await b!.subscribe({});
    const epoch = b!.snapshot!.instanceId;
    const blocked = once(child, "message");
    const began = performance.now();
    const slow = assert.rejects(a!.request("runtime_get_snapshot", { scope: { id: "sa_slow" } }), /runtime-timeout/);
    assert.equal((await blocked)[0].type, "query-blocked");
    await new Promise(resolve => setTimeout(resolve, 1000));
    const other = b!.get({ limit: 2 });
    const control = performance.now();
    const status = await b!.request("runtime_get_status");
    assert.equal(status.hostedSessions, 0);
    assert.deepEqual(await a!.request("runtime_unsubscribe"), { unsubscribed: true });
    const controlMs = performance.now() - control;
    await slow;
    assert.equal((await other).status, "ready");
    const timeoutMs = performance.now() - began;
    assert.equal((await b!.request("runtime_get_metrics")).executor.restarts, 0);
    assert.equal(b!.snapshot!.instanceId, epoch);
    child.send("release-query");
    const wedged = once(child, "message"); child.send("wedge");
    assert.equal((await wedged)[0].type, "wedged");
    const restart = performance.now();
    const until = Date.now() + 7000;
    while (b!.snapshot?.instanceId === epoch || b!.snapshot?.status !== "ready") {
      assert.ok(Date.now() < until, "daemon did not recover its read worker");
      await b!.request("runtime_get_status");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await b!.request("runtime_get_metrics")).executor.restarts, 1);
    t.diagnostic(JSON.stringify({ timeoutMs, controlMs, restartMs: performance.now() - restart,
      metrics: await b!.request("runtime_get_metrics") }));
  } finally {
    clients.forEach(client => client.close());
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.send("stop");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited; clearTimeout(timer);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
