import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inspectDaemonOwner, ownerIsAlive } from "../src/daemon-owner.ts";
import { startDaemon } from "../src/server.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { Client, makeEnv, waitFor } from "./helpers.ts";

test("real process start evidence retains a worker; a running label alone does not", async t => {
  const env = makeEnv();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  await once(child, "spawn");
  const pid = child.pid!;
  const pidStartTime = process.platform === "linux"
    ? readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19]
    : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
  const baseDir = join(env.root, "subagents");
  for (const [id, start] of [["live", pidStartTime], ["unverified", undefined]]) {
    const directory = join(baseDir, "runs", id!); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ id, cwd: env.cwd, startedAt: 1, status: "running", pid, pidStartTime: start }));
  }
  const model = new WorkReadModel(env.agentDir, "test-instance", { baseDir, durableDir: join(env.root, "durable") });
  t.after(() => model.close());
  await model.reconcile();
  assert.deepEqual(model.livenessReasons().map(reason => reason.id), ["live"]);
  child.kill(); await exited;
  assert.deepEqual(model.livenessReasons(), []);
});

test("registered work connection retains runtime without hosted ownership; probes do not renew idle", async t => {
  const env = makeEnv(); Object.assign(process.env, env.vars);
  let now = 1000;
  const daemon = await startDaemon({ serverDir: env.serverDir, runtimeIdleMs: 100, startupGraceMs: 0, now: () => now });
  t.after(() => daemon.stop());
  const client = new WorkClient(daemon.socketPath, env.agentDir);
  t.after(() => client.close());
  await client.ready;
  now += 1000; await daemon.sweepIdle();
  assert.equal(daemon.registry.activeCount, 0);
  assert.equal(existsSync(daemon.socketPath), true);
  const status = await client.request("runtime_get_status");
  assert.equal(status.livenessReasons[0].kind, "connection");
  client.close();
  await waitFor("connection removal", async () => {
    const probe = await Client.connect(daemon.socketPath);
    try {
      await probe.request({ type: "hello", protocolVersion: 1, runtimeRoot: env.agentDir });
      return (await probe.request({ type: "runtime_get_status" })).data.livenessReasons.length === 0;
    } finally { probe.close(); }
  });
  now += 99; await daemon.sweepIdle(); assert.equal(existsSync(daemon.socketPath), true);
  now++; await daemon.sweepIdle(); await daemon.closed;
  assert.equal(existsSync(daemon.socketPath), false);
});

test("default runtime-only idle exits real server and guardian within 30s plus 5s", { timeout: 40_000 }, async t => {
  const env = makeEnv();
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--agent", "pi"], {
    env: { ...process.env, ...env.vars }, stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } });
  const owner = await waitFor("real server", () => {
    const owner = inspectDaemonOwner(env.serverDir);
    return owner.status === "live" && existsSync(join(env.serverDir, "pi-server.sock")) ? owner.owner : undefined;
  });
  const guardian = inspectDaemonOwner(env.serverDir, "guardian-owner");
  assert.equal(guardian.status, "live", errors);
  assert.notEqual(owner.pid, child.pid);
  const started = Date.now();
  const [code, signal] = await exited;
  assert.equal(code, 0, errors); assert.equal(signal, null, errors);
  assert.ok(Date.now() - started <= 35_000, errors);
  assert.equal(ownerIsAlive(owner), false);
  assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
  assert.equal(inspectDaemonOwner(env.serverDir, "guardian-owner").status, "missing");
  assert.equal(JSON.parse(readFileSync(join(env.serverDir, "clean-stop.json"), "utf8")).token, owner.token);
});

test("100 runtime registration/shutdown races accept or reject for reconnect", { timeout: 60_000 }, async () => {
  for (let iteration = 0; iteration < 100; iteration++) {
    const env = makeEnv(); Object.assign(process.env, env.vars);
    let now = 0;
    const daemon = await startDaemon({ serverDir: env.serverDir, runtimeIdleMs: 100, startupGraceMs: 0, now: () => now });
    const client = new WorkClient(daemon.socketPath, env.agentDir);
    const registration = client.ready.then(() => "accepted", error => {
      assert.match(String(error), /disconnected|ECONNRESET|ECONNREFUSED|ENOENT|shutting down|runtime-draining/);
      return "retry";
    });
    try {
      now = 100;
      await daemon.sweepIdle();
      const outcome = await registration;
      if (outcome === "accepted") {
        assert.equal((await client.request("runtime_get_status")).hostedSessions, 0);
        assert.equal(inspectDaemonOwner(env.serverDir).status, "live");
      }
    } finally { client.close(); await daemon.stop(); }
    assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
  }
});

test("SIGKILL of server recovers under the same guardian and persists restart accounting", { timeout: 20_000 }, async t => {
  const env = makeEnv();
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--agent", "pi"], {
    env: { ...process.env, ...env.vars }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } });
  const original = await waitFor("first server", () => { const owner = inspectDaemonOwner(env.serverDir); return owner.status === "live" ? owner.owner : undefined; });
  process.kill(original.pid, "SIGKILL");
  const replacement = await waitFor("replacement server", () => { const owner = inspectDaemonOwner(env.serverDir); return owner.status === "live" && owner.owner.token !== original.token ? owner.owner : undefined; });
  assert.notEqual(replacement.pid, original.pid);
  assert.equal(ownerIsAlive(original), false);
  const guardian = inspectDaemonOwner(env.serverDir, "guardian-owner");
  assert.equal(guardian.status, "live");
  if (guardian.status === "live") assert.equal(guardian.owner.pid, child.pid);
  assert.equal(JSON.parse(readFileSync(join(env.serverDir, "guardian-restarts.json"), "utf8")).length, 1);
});
