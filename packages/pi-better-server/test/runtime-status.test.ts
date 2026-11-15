import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkClient } from "../src/runtime/work-client.mjs";

test("runtime status observes a blocked initial inventory without timing out or terminating the read worker", { timeout: 15000 }, async () => {
  const root = realpathSync(mkdtempSync("/tmp/status-root-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  const child = fork(new URL("./support/blocked-inventory-daemon.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, PI_CODING_AGENT_DIR: agent,
      PI_SERVER_DIR: join(root, "server"), TMPDIR: root }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr!.on("data", chunk => { errors += chunk; });
  let client: WorkClient | undefined;
  try {
    const [ready] = await Promise.race([once(child, "message"), once(child, "exit").then(() => {
      throw new Error(`daemon exited before readiness: ${errors}`);
    })]);
    assert.equal(ready.type, "ready");
    client = new WorkClient(ready.socket, agent);
    const blocked = once(child, "message");
    const snapshot = await client.get({});
    assert.equal((await blocked)[0].type, "inventory-blocked");
    assert.equal(snapshot.status, "rebuilding", "ordinary snapshots remain available while initial inventory is blocked");
    const before = await client.request("runtime_get_metrics");
    for (let i = 0; i < 5; i++) {
      const status = await client.request("runtime_get_status");
      assert.equal(status.workObservation.status, "rebuilding");
      assert.equal(status.hostedSessions, 0);
      assert.ok(status.livenessReasons.some((reason: any) => reason.kind === "connection"));
    }
    const after = await client.request("runtime_get_metrics");
    assert.equal(after.executor.completed, before.executor.completed, "status must not admit a read or force reconciliation");
    assert.equal(after.executor.timeouts, 0);
    assert.equal(after.executor.status, "ready");
    assert.equal(after.inventories, 0, "the initial inventory remains blocked until explicitly released");
    child.send("release-inventory");
    await client.subscribe({});
    if (client.snapshot?.status !== "ready") await new Promise<void>(resolve => {
      const stop = client!.onChange(value => { if (value.status === "ready") { stop(); resolve(); } });
    });
    assert.equal((await client.request("runtime_get_status")).workObservation.status, "ready");
  } finally {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.send("stop");
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(kill);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
