import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inspectDaemonOwner, ownerIsAlive, processMatchesStart } from "../src/daemon-owner.ts";
import { startDaemon } from "../src/server.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { OwnershipStore } from "../src/core/ownership.ts";
import { ownershipPathFor } from "../src/paths.ts";
import { Client, makeEnv, waitFor } from "./helpers.ts";
import { onlyStatusProbeRemains } from "./support/runtime-status.ts";

test("real SQLite runner obligations exclude terminal history, unread waits and corrupt records", { timeout: 25_000 }, async t => {
  const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);
  const { createLocalSupervisor, supervisorTaskIdForToken } = await import(new URL("../../pi-better-background-tasks/src/supervisor/index.ts", import.meta.url).href);
  mkdirSync(resolve(".work/755"), { recursive: true });
  const root = mkdtempSync(resolve(".work/755/runner-"));
  const directory = join(root, "supervisor");
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const supervisor = createLocalSupervisor({ directory });
  const model = new WorkReadModel(root, "runner-instance", { supervisorDirectory: directory,
    baseDir: join(root, "subagents"), durableDir: join(root, "archives") });
  const executor = new WorkQueryExecutor(root, "runner-executor", { modelOptions: {
    supervisorDirectory: directory, baseDir: join(root, "subagents"), durableDir: join(root, "archives"),
  } });
  let taskId: string | undefined;
  t.after(async () => {
    if (taskId && !supervisor.snapshot(taskId)?.terminal) await supervisor.stop(taskId);
    await executor.close(); await model.close(); store.close(); rmSync(root, { recursive: true, force: true });
  });
  const started = await supervisor.start({ token: "755-real-runner", kind: "process", cwd: root,
    argv: [process.execPath, "-e", "const fs=require('fs'); const t=setInterval(()=>{if(fs.existsSync('finish')){clearInterval(t)}},20)"] });
  taskId = started.taskId;
  assert.ok(supervisor.snapshot(taskId)?.claim?.pidStartTime, "Qualified runner identity requires process-start evidence; ps denial must remain visible");
  const owner = { kind: "parent-session" as const, sessionId: "parent", workspace: root, branchId: null, goalId: null };
  store.registerOperation({ operationId: "live-operation", taskId, launchToken: started.token, owner, observer: { kind: "local-supervisor", version: "1" } });
  store.registerWait({ waitId: "retained-wait", owner, dependencies: [{ operationId: "live-operation" }], continuationNote: "Interpret the real command" });
  for (let index = 0; index < 25; index++) {
    const id = `history-${index}`;
    store.registerOperation({ operationId: id, taskId: supervisorTaskIdForToken(id), launchToken: id, owner, observer: { kind: "local-supervisor", version: "1" } });
    store.recordTerminalOutcome({ operationId: id, eventId: id, outcome: "succeeded", owner, evidence: [{ kind: "terminal-record", ref: id }] });
  }
  store.registerOperation({ operationId: "missing-runner", taskId: supervisorTaskIdForToken("missing"), launchToken: "missing", owner, observer: { kind: "local-supervisor", version: "1" } });
  const { supervisorPaths } = await import(new URL("../../pi-better-background-tasks/src/supervisor/store.ts", import.meta.url).href);
  const corrupt = supervisorPaths(directory, supervisorTaskIdForToken("missing"));
  mkdirSync(corrupt.dir, { recursive: true }); writeFileSync(corrupt.launch, "{");
  await model.reconcile();
  assert.deepEqual(model.livenessReasons().map(reason => reason.id), [taskId]);
  assert.deepEqual((await executor.livenessReasons()).map(reason => reason.id), [taskId], "worker executor preserves valid runner retention alongside corrupt records");
  const claim = supervisor.snapshot(taskId)!.claim!;
  assert.equal(processMatchesStart(claim.pid, "Thu Jan  1 00:00:00 1970"), false, "a live PID with a different start identity cannot retain the runtime");
  writeFileSync(join(root, "finish"), "done");
  await waitFor("runner terminal record", () => supervisor.snapshot(taskId!)?.terminal);
  await model.reconcile();
  assert.deepEqual(model.livenessReasons(), []);
  assert.deepEqual(await executor.livenessReasons(), [], "terminal runner and unread waits do not retain the runtime");
  assert.equal(store.listWaits({ owner })[0]!.phase, "waiting", "idle observation does not consume unread waits");
  assert.equal(store.getOperation("live-operation")!.terminalRevision, 0, "idle observation does not become terminal authority");
  assert.equal(model.backgroundMetrics.historyQueries, 0);
});

function runtime(env: ReturnType<typeof makeEnv>) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--agent", "pi"], {
    env: { ...process.env, ...env.vars }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stderr.on("data", chunk => { log += chunk; }); child.stdout.resume();
  return { child, exited: once(child, "exit"), log: () => log };
}

async function liveServer(env: ReturnType<typeof makeEnv>) {
  return waitFor("runtime owner and listener", async () => {
    const owner = inspectDaemonOwner(env.serverDir);
    if (owner.status !== "live") return;
    // A replacement owner can precede removal of the killed server's socket path.
    let probe: Client | undefined;
    try {
      probe = await Client.connect(join(env.serverDir, "pi-server.sock"));
      const response = await probe.request({ type: "hello", protocolVersion: 1, runtimeRoot: env.agentDir });
      return response.success && response.data.instanceId === owner.owner.token ? owner.owner : undefined;
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally { probe?.close(); }
  });
}

test("guardian signal shutdown closes captured pipes and releases both owners naturally", { timeout: 15_000 }, async t => {
  const env = makeEnv();
  const fixture = runtime(env);
  const closed = once(fixture.child, "close");
  t.after(async () => {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGTERM");
    await closed;
  });
  const server = await liveServer(env);
  fixture.child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert.equal(code, 0, fixture.log());
  assert.equal(signal, null);
  assert.equal(ownerIsAlive(server), false);
  assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
  assert.equal(inspectDaemonOwner(env.serverDir, "guardian-owner").status, "missing");
  assert.equal(JSON.parse(readFileSync(join(env.serverDir, "clean-stop.json"), "utf8")).token, server.token);
});

test("idle shutdown fault gets one bounded recovery within the shutdown budget", { timeout: 25_000 }, async t => {
  const env = makeEnv(); mkdirSync(env.serverDir);
  // A real persistence fault, not a replaced obligation provider.
  mkdirSync(join(env.serverDir, "clean-stop.json"));
  const fixture = runtime({ ...env, vars: { ...env.vars, PI_SERVER_RUNTIME_IDLE_MS: "100" } });
  const started = Date.now();
  t.after(async () => { if (fixture.child.exitCode === null && fixture.child.signalCode === null) { fixture.child.kill("SIGTERM"); await fixture.exited; } });
  const [code] = await fixture.exited;
  assert.equal(code, 1, fixture.log());
  assert.ok(Date.now() - started < 15000, fixture.log());
  assert.match(readFileSync(join(env.serverDir, "daemon.log"), "utf8"), /EISDIR/);
  assert.match(fixture.log(), /idle recovery budget exhausted/);
  assert.equal(JSON.parse(readFileSync(join(env.serverDir, "guardian-idle-restarts.json"), "utf8")).length, 1);
  assert.equal(inspectDaemonOwner(env.serverDir).status, "dead");
});

test("guardian loss binds exact live server without replacing its owner, then follows clean idle exit", { timeout: 40_000 }, async t => {
  const env = makeEnv();
  const original = runtime(env);
  t.after(async () => {
    const server = inspectDaemonOwner(env.serverDir);
    if (server.status === "live") process.kill(server.owner.pid, "SIGTERM");
    await waitFor("server cleanup", () => inspectDaemonOwner(env.serverDir).status !== "live");
    const guardian = inspectDaemonOwner(env.serverDir, "guardian-owner");
    if (guardian.status === "live") process.kill(guardian.owner.pid, "SIGTERM");
  });
  const server = await liveServer(env);
  assert.ok(server.start, "Process-start identity is required for qualified guardian binding; local ps denial must remain visible");
  const closed = once(original.child, "close");
  original.child.kill("SIGKILL"); await closed;
  const binding = await waitFor("replacement guardian handshake", async () => {
    const probe = await Client.connect(join(env.serverDir, "pi-server.sock"));
    try {
      await probe.request({ type: "hello", protocolVersion: 1, runtimeRoot: env.agentDir });
      return (await probe.request({ type: "runtime_get_status" })).data.guardianBinding;
    } finally { probe.close(); }
  });
  assert.notEqual(binding.pid, original.child.pid);
  assert.ok(binding.start);
  const current = inspectDaemonOwner(env.serverDir);
  assert.equal(current.status, "live");
  if (current.status === "live") assert.deepEqual(current.owner, server);
  await waitFor("server and rebound guardian idle exit", () => inspectDaemonOwner(env.serverDir).status === "missing"
    && inspectDaemonOwner(env.serverDir, "guardian-owner").status === "missing", 35_000);
});

test("all recovery processes lost require explicit restart and preserve durable state", { timeout: 20_000 }, async t => {
  const env = makeEnv(); const first = runtime(env);
  t.after(async () => { if (first.child.exitCode === null && first.child.signalCode === null) { first.child.kill("SIGTERM"); await first.exited; } });
  const server = await liveServer(env);
  const client = await Client.connect(join(env.serverDir, "pi-server.sock"));
  const created = await client.request({ type: "create_session", cwd: env.cwd });
  client.close(); assert.equal(created.success, true);
  const ownership = new OwnershipStore(ownershipPathFor(env.serverDir));
  const fenced = ownership.fence(created.sessionId, "unverified-move-writer");
  const evidence = join(env.agentDir, "retained-evidence.json");
  writeFileSync(evidence, JSON.stringify({ revision: 9, unread: true }));
  first.child.kill("SIGKILL"); process.kill(server.pid, "SIGKILL"); await first.exited;
  await waitFor("old server death", () => !ownerIsAlive(server));
  const second = runtime(env);
  t.after(async () => { second.child.kill("SIGTERM"); await second.exited; });
  const replacement = await liveServer(env);
  assert.notEqual(replacement.token, server.token);
  assert.notEqual(replacement.pid, server.pid);
  assert.deepEqual(JSON.parse(readFileSync(evidence, "utf8")), { revision: 9, unread: true });
  const retained = new OwnershipStore(ownershipPathFor(env.serverDir));
  assert.deepEqual(retained.get(created.sessionId), fenced, "recovery cannot release an unresolved execution fence");
  const probe = await Client.connect(join(env.serverDir, "pi-server.sock"));
  try {
    const refused = await probe.request({ type: "open_session", sessionId: created.sessionId });
    assert.equal(refused.success, false); assert.match(refused.error, /fenced/);
  } finally { probe.close(); }
});

test("restart budget survives guardian reconstruction and stops repeated crash spin", { timeout: 25_000 }, async t => {
  const env = makeEnv(); const first = runtime(env);
  t.after(async () => { if (first.child.exitCode === null && first.child.signalCode === null) { first.child.kill("SIGTERM"); await first.exited; } });
  for (let index = 0; index < 3; index++) {
    const server = await liveServer(env);
    process.kill(server.pid, "SIGKILL");
    await waitFor("persisted failure", () => {
      try { return JSON.parse(readFileSync(join(env.serverDir, "guardian-restarts.json"), "utf8")).length >= index + 1; } catch { return false; }
    });
    await waitFor("old owner death", () => !ownerIsAlive(server));
  }
  const [code] = await first.exited;
  assert.equal(code, 1); assert.match(first.log(), /budget exhausted/);
  const before = readFileSync(join(env.serverDir, "guardian-restarts.json"), "utf8");
  const reconstructed = runtime(env);
  const [nextCode] = await reconstructed.exited;
  assert.equal(nextCode, 1); assert.match(reconstructed.log(), /budget exhausted/);
  assert.equal(inspectDaemonOwner(env.serverDir).status, "dead");
  assert.equal(readFileSync(join(env.serverDir, "guardian-restarts.json"), "utf8"), before);
});

test("concurrent alias launches converge and an unresponsive live owner is not reclaimed", { timeout: 20_000 }, async t => {
  const env = makeEnv(); const alias = join(env.root, "alias"); symlinkSync(env.agentDir, alias);
  const launches = Array.from({ length: 5 }, (_, index) => runtime({ ...env, vars: { ...env.vars, PI_CODING_AGENT_DIR: index % 2 ? alias : env.agentDir } }));
  t.after(async () => {
    const server = inspectDaemonOwner(env.serverDir);
    if (server.status === "live") { process.kill(server.owner.pid, "SIGCONT"); process.kill(server.owner.pid, "SIGTERM"); }
    for (const launch of launches) if (launch.child.exitCode === null && launch.child.signalCode === null) launch.child.kill("SIGTERM");
    await Promise.all(launches.map(launch => launch.exited));
  });
  const server = await liveServer(env);
  const guardian = inspectDaemonOwner(env.serverDir, "guardian-owner"); assert.equal(guardian.status, "live");
  process.kill(server.pid, "SIGSTOP");
  const competing = runtime(env); const [code] = await competing.exited;
  assert.equal(code, 1); assert.match(competing.log(), /already running/);
  const still = inspectDaemonOwner(env.serverDir);
  assert.equal(still.status, "live"); if (still.status === "live") assert.deepEqual(still.owner, server);
  process.kill(server.pid, "SIGCONT");
});

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
      return onlyStatusProbeRemains((await probe.request({ type: "runtime_get_status" })).data);
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
  let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
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
      assert.match(String(error), /disconnected|ECONNRESET|ECONNREFUSED|EPIPE|ENOENT|shutting down|runtime-draining/);
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
  // Ownership is acquired before socket readiness. Crash a ready service, not
  // a still-booting child whose startup failure follows a different contract.
  await waitFor("first server protocol readiness", async () => {
    const client = new WorkClient(join(env.serverDir, "pi-server.sock"), env.agentDir);
    try { await client.ready; await client.request("runtime_get_status"); return true; }
    catch { return false; } finally { client.close(); }
  });
  process.kill(original.pid, "SIGKILL");
  const replacement = await waitFor("replacement server", () => { const owner = inspectDaemonOwner(env.serverDir); return owner.status === "live" && owner.owner.token !== original.token ? owner.owner : undefined; });
  assert.notEqual(replacement.pid, original.pid);
  assert.equal(ownerIsAlive(original), false);
  const guardian = inspectDaemonOwner(env.serverDir, "guardian-owner");
  assert.equal(guardian.status, "live");
  if (guardian.status === "live") assert.equal(guardian.owner.pid, child.pid);
  assert.equal(JSON.parse(readFileSync(join(env.serverDir, "guardian-restarts.json"), "utf8")).length, 1);
});

test("a failed read worker cannot retain a detached daemon indefinitely", { timeout: 15_000 }, async t => {
  const env = makeEnv();
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./support/failed-read-worker-daemon.ts", import.meta.url))], {
    env: { ...process.env, ...env.vars }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "exit");
  let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const [ready] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(errors); })]);
  const client = new WorkClient(ready.socketPath, env.agentDir);
  try {
    await client.ready;
    await assert.rejects(client.get({ cwd: env.agentDir }), /worker|runtime-unhealthy/);
  } finally { client.close(); }
  const disconnectedAt = Date.now();
  const [code] = await exited;
  assert.equal(code, 0, errors);
  assert.ok(Date.now() - disconnectedAt < 5000, "failed observation must not exceed the shutdown budget");
  assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
  const checkpoint = JSON.parse(readFileSync(join(env.serverDir, "clean-stop.json"), "utf8"));
  assert.equal(checkpoint.observation, "unavailable", "shutdown must disclose that obligations could not be verified");
});

test("upgrade observation refuses unknown writer metadata instead of treating it as idle", async t => {
  const root = mkdtempSync(join('/tmp', 'upgrade-writer-'));
  const baseDir = join(root, 'subagents');
  const run = join(baseDir, 'runs', 'sa_unknown_1'); mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'meta.json'), JSON.stringify({ id: 'sa_unknown_1', sessionId: 'sa_unknown_1',
    status: 'running', pid: process.pid, spawnPid: process.pid, cwd: root, startedAt: Date.now(),
    promptPreview: 'unknown writer', logPath: join(run, 'log.jsonl') }));
  const model = new WorkReadModel(root, 'upgrade-test', { baseDir, durableDir: join(root, 'archives') });
  t.after(async () => { await model.close(); rmSync(root, { recursive: true, force: true }); });
  await model.reconcile();
  assert.ok(model.upgradeObligations().some(reason => reason.kind === 'unresolved-writer' && reason.id === 'sa_unknown_1'));
});
