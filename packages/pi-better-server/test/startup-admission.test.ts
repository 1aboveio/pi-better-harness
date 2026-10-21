import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { claimDaemonOwner, inspectDaemonOwner } from "../src/daemon-owner.ts";
import { activateStagedRuntime, adoptActivation, commitActivationStop, defaultActivationPorts, hasActivationReservations, readActivationJournal, type ActivationJournal } from "../src/startup/activation.ts";
import { activationArgs } from "../src/startup/commands.ts";
import { admitDaemonStartup, checkStartupAdmission, startupIntentFromEnv, type StartupRequest } from "../src/startup/admission.ts";
import { DaemonClient } from "../src/client.ts";
import type { StagedRuntime } from "../src/startup/managed-types.ts";
import { digest, stable } from "../scripts/private-runtime/format.ts";
import { llmCalls, makeEnv, waitFor, type Env } from "./helpers.ts";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
function staged(env: Env, seed: string): StagedRuntime {
  const identity = { format: 1 as const, sourceDigest: digest(seed), dependencyLockDigest: digest("shared SDK"), piSdkVersion: PI_VERSION,
    nodeVersion: "24.14.1", platform: `${process.platform}-${process.arch}` as "darwin-arm64", protocolVersion: 1, serverVersion: "0.1.0" };
  const build = { ...identity, contentId: digest(stable(identity)) };
  const installRoot = join(env.root, "managed"), root = join(installRoot, "releases", build.contentId);
  mkdirSync(root, { recursive: true });
  cpSync(join(packageDir, "src"), join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts/private-runtime"), { recursive: true });
  cpSync(join(packageDir, "scripts/private-runtime/format.ts"), join(root, "scripts/private-runtime/format.ts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "managed-build.json"), JSON.stringify(build));
  symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(root, "node_modules"));
  mkdirSync(join(root, "node/bin"), { recursive: true });
  symlinkSync(process.execPath, join(root, "node/bin/node"));
  const runtime = { format: 1 as const, root, installRoot, build, node: join(root, "node/bin/node"), entrypoint: join(root, "src/cli.ts"), manifestPath: join(root, "runtime.json") };
  writeFileSync(runtime.manifestPath, JSON.stringify(runtime));
  return runtime;
}
function fixture(t: TestContext) {
  const env = makeEnv();
  mkdirSync(env.serverDir);
  t.after(async () => {
    const owner = inspectDaemonOwner(env.serverDir);
    if (owner.status === "live" && owner.owner.pid !== process.pid) {
      process.kill(owner.owner.pid, "SIGTERM");
      await waitFor("private daemon release", () => inspectDaemonOwner(env.serverDir).status !== "live");
    }
  });
  return env;
}
function run(env: Env, entrypoint: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env.vars, HOME: env.root, PI_SERVER_AGENT: "pi", PI_SERVER_DAEMON_IDLE_MS: "0", PI_SERVER_SESSION_IDLE_MS: "0" };
  for (const name of ["PI_SERVER_COMMAND", "PI_SERVER_LAUNCHER", "PI_SERVER_ACTIVATION_ID", "PI_SERVER_ROLLBACK_OPERATION_ID", "PI_SERVER_ROLLBACK_PERMIT"]) delete childEnv[name];
  Object.assign(childEnv, extra);
  const child = spawn(process.execPath, [entrypoint, ...args], { env: childEnv, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return { child, result: once(child, "close").then(([code]) => ({ code, stdout, stderr })) };
}
function journal(env: Env, runtime: StagedRuntime, phase: ActivationJournal["phase"], previous?: StagedRuntime): ActivationJournal {
  return { version: 1, phase, operationId: "upgrade-B", serverDir: env.serverDir, agentDir: env.agentDir,
    runtime, desiredBuild: runtime.build, previousRuntime: previous, previousBuild: previous?.build, emptyNamespace: !previous };
}
function save(env: Env, value: ActivationJournal) { writeFileSync(join(env.serverDir, "activation.json"), JSON.stringify(value)); }
function pointer(env: Env, runtime: StagedRuntime) {
  writeFileSync(join(env.serverDir, "active-runtime.json"), JSON.stringify({ version: 1, serverDir: env.serverDir, agentDir: env.agentDir, runtime }));
}

test("ordinary CLI ensure cannot restart A after same-SDK B adopts and fails", { timeout: 30_000 }, async t => {
  const env = fixture(t), a = staged(env, "A"), b = staged(env, "B");
  assert.equal(a.build.piSdkVersion, b.build.piSdkVersion);
  pointer(env, a);
  const release = claimDaemonOwner(env.serverDir, "activation-owner");
  t.after(release);
  const coordinator = inspectDaemonOwner(env.serverDir, "activation-owner");
  assert.equal(coordinator.status, "live");
  if (coordinator.status !== "live") throw new Error("missing coordinator");
  save(env, { ...journal(env, b, "starting", a), coordinator: coordinator.owner });
  writeFileSync(join(env.serverDir, "sessions.json"), "broken index forces failure after adoption");
  const failed = await run(env, b.entrypoint, [], { PI_SERVER_ACTIVATION_ID: "upgrade-B" }).result;
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(readActivationJournal(env.serverDir)?.phase, "adopted");
  assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
  writeFileSync(join(env.serverDir, "sessions.json"), JSON.stringify({ version: 1, sessions: [] }));
  for (const phase of ["adopted", "recovery-required"] as const) {
    save(env, { ...readActivationJournal(env.serverDir)!, phase });
    const before = readFileSync(join(env.serverDir, "activation.json"));
    const result = await run(env, a.entrypoint, ["ensure", "--timeout-ms", "2500"], { PI_SERVER_ACTIVATION_ID: "upgrade-B" }).result;
    assert.equal(result.code, 1, `must refuse ${phase}; ${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, /Startup admission/);
    assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
    assert.equal(existsSync(join(env.serverDir, "daemon.log")), false, "ensure must refuse before spawning A");
    assert.deepEqual(readFileSync(join(env.serverDir, "activation.json")), before);
  }
});

function request(env: Env, runtime: StagedRuntime, intent: StartupRequest["intent"] = { kind: "ordinary" }): StartupRequest {
  return { canonicalServerDir: env.serverDir, agentDir: env.agentDir, build: runtime.build, intent };
}
function coordinate(t: TestContext, env: Env) {
  const release = claimDaemonOwner(env.serverDir, "activation-owner");
  t.after(release);
  const state = inspectDaemonOwner(env.serverDir, "activation-owner");
  if (state.status !== "live") throw new Error("missing coordinator");
  return { owner: state.owner, release };
}

test("ordinary admission rejects every pending phase and rereads after a successful ready preflight", t => {
  const env = fixture(t), a = staged(env, "phase-A"), b = staged(env, "phase-B");
  pointer(env, a);
  for (const phase of ["staged", "prepared", "stopping", "starting", "adopted", "recovery-required"] as const) {
    save(env, journal(env, b, phase, a));
    assert.throws(() => checkStartupAdmission(request(env, a)), /Startup admission/);
  }
  save(env, journal(env, a, "ready"));
  checkStartupAdmission(request(env, a));
  const release = claimDaemonOwner(env.serverDir);
  t.after(release);
  save(env, journal(env, b, "adopted", a));
  assert.throws(() => admitDaemonStartup(request(env, a)), /adopted forbids/);
});

test("ready restart requires matching journal, pointer, executing identity and agent directory", t => {
  const env = fixture(t), a = staged(env, "identity-A"), b = staged(env, "identity-B");
  pointer(env, a);
  save(env, journal(env, a, "ready"));
  checkStartupAdmission(request(env, a));
  assert.throws(() => checkStartupAdmission({ ...request(env, a), build: undefined }), /executing build identity/);
  assert.throws(() => checkStartupAdmission(request(env, b)), /must match/);
  pointer(env, b);
  assert.throws(() => checkStartupAdmission(request(env, a)), /must match/);
  pointer(env, a);
  assert.throws(() => checkStartupAdmission({ ...request(env, a), agentDir: env.cwd }), /agent directory/);
  const changed = { ...a.build, piSdkVersion: "999.0.0" };
  assert.throws(() => checkStartupAdmission({ ...request(env, a), build: changed }), /content identity mismatch/);
  writeFileSync(join(env.serverDir, "activation.json"), "{");
  assert.throws(() => checkStartupAdmission(request(env, a)), /invalid startup state/);
  rmSync(join(env.serverDir, "activation.json"));
  assert.throws(() => checkStartupAdmission(request(env, a)), /no activation journal/);
});

test("malformed daemon or coordinator ownership fails closed without removing owner files", t => {
  const env = fixture(t), a = staged(env, "owner-A");
  for (const lock of ["daemon-owner", "activation-owner"]) {
    const dir = join(env.serverDir, lock);
    mkdirSync(dir);
    writeFileSync(join(dir, "foreign"), "keep");
    assert.throws(() => checkStartupAdmission(request(env, a)), /ownership is ambiguous/);
    assert.equal(readFileSync(join(dir, "foreign"), "utf8"), "keep");
    rmSync(dir, { recursive: true });
  }
});

test("direct CLI preserves an empty ambiguous owner directory before claiming", { timeout: 20_000 }, async t => {
  const env = fixture(t), a = staged(env, "empty-owner");
  mkdirSync(join(env.serverDir, "daemon-owner"));
  const result = await run(env, a.entrypoint).result;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /ownership is ambiguous/);
  assert.equal(existsSync(join(env.serverDir, "daemon-owner")), true);
  assert.equal(inspectDaemonOwner(env.serverDir).status, "ambiguous");
  assert.equal(existsSync(join(env.serverDir, "sessions.json")), false);
});

test("only exact starting candidate can adopt and admission durably precedes registry work", t => {
  const env = fixture(t), a = staged(env, "candidate-A"), b = staged(env, "candidate-B");
  const coordinator = coordinate(t, env);
  save(env, { ...journal(env, b, "starting", a), coordinator: coordinator.owner });
  const valid = request(env, b, { kind: "activation", operationId: "upgrade-B" });
  for (const wrong of [request(env, a, valid.intent), { ...valid, agentDir: env.cwd },
    request(env, b, { kind: "activation", operationId: "old-operation" })]) {
    assert.throws(() => checkStartupAdmission(wrong), /Startup admission/);
  }
  checkStartupAdmission(valid);
  assert.equal(readActivationJournal(env.serverDir)?.phase, "starting", "preflight does not adopt");
  assert.throws(() => admitDaemonStartup(valid), /exclusive owner claim/);
  const release = claimDaemonOwner(env.serverDir);
  t.after(release);
  admitDaemonStartup(valid);
  assert.equal(readActivationJournal(env.serverDir)?.phase, "adopted");
  const owner = inspectDaemonOwner(env.serverDir);
  assert.equal(owner.status, "live");
  if (owner.status === "live") assert.deepEqual(readActivationJournal(env.serverDir)?.candidateOwner, owner.owner);
  assert.throws(() => admitDaemonStartup(valid), /adopted forbids/);
});

for (const launch of ["CLI", "startDaemon"] as const) {
  test(`untagged ${launch} refuses managed state before registry loading and releases its own claim`, { timeout: 20_000 }, async t => {
    const env = fixture(t), a = staged(env, `direct-${launch}`), b = staged(env, `desired-${launch}`);
    pointer(env, a);
    const index = join(env.serverDir, "sessions.json");
    writeFileSync(index, "registry constructor must not read this invalid index");
    let entrypoint = a.entrypoint;
    if (launch === "startDaemon") {
      entrypoint = join(env.root, "direct.mjs");
      writeFileSync(entrypoint, `import {startDaemon} from ${JSON.stringify(pathToFileURL(join(a.root, "src/server.ts")).href)};
        try { const daemon = await startDaemon(); await daemon.stop(); }
        catch (error) { console.error(error.message); process.exitCode = 1; }`);
    }
    for (const phase of ["staged", "prepared", "stopping", "starting", "adopted", "recovery-required"] as const) {
      save(env, journal(env, b, phase, a));
      const before = readFileSync(join(env.serverDir, "activation.json"));
      const outcome = await run(env, entrypoint).result;
      assert.equal(outcome.code, 1);
      assert.match(outcome.stderr, /Startup admission/);
      assert.doesNotMatch(outcome.stderr, /JSON|Unexpected token|resume/);
      assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
      assert.deepEqual(readFileSync(join(env.serverDir, "activation.json")), before);
      assert.equal(readFileSync(index, "utf8"), "registry constructor must not read this invalid index");
    }
  });
}

test("ordinary ready restart clears inherited activation and rollback intents and concurrent ensures share one writer", { timeout: 30_000 }, async t => {
  const env = fixture(t), a = staged(env, "restart-A");
  pointer(env, a);
  save(env, journal(env, a, "ready"));
  const inherited = { PI_SERVER_ACTIVATION_ID: "old-operation", PI_SERVER_ROLLBACK_OPERATION_ID: "old-rollback", PI_SERVER_ROLLBACK_PERMIT: "stale-token" };
  const results = await Promise.all(Array.from({ length: 3 }, () => run(env, a.entrypoint, ["ensure"], inherited).result));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const records = results.map(result => JSON.parse(result.stdout));
  assert.equal(new Set(records.map(record => record.hello.instanceId)).size, 1);
  assert.equal(records[0].hello.build.contentId, a.build.contentId);
  const client = await DaemonClient.connect(records[0].socketPath);
  t.after(() => client.close());
  const created = await client.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  assert.ok(created.sessionId);
  // A healthy existing listener stays usable even when a newer activation is pending.
  save(env, journal(env, a, "recovery-required"));
  const reused = await run(env, a.entrypoint, ["ensure"], inherited).result;
  assert.equal(reused.code, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).hello.instanceId, records[0].hello.instanceId);
  assert.deepEqual((await client.call({ type: "list_sessions" })).data.sessions.map((s: any) => s.sessionId), [created.sessionId]);
});

test("direct startup after the awaited stale-socket probe rereads the journal before registry construction", { timeout: 20_000 }, async t => {
  const env = fixture(t), a = staged(env, "socket-reread-A"), b = staged(env, "socket-reread-B");
  pointer(env, a); save(env, journal(env, a, "ready"));
  const socketPath = join(env.serverDir, "pi-server.sock");
  const stale = join(env.root, "stale-socket.mjs");
  writeFileSync(stale, `import {createServer} from 'node:net'; createServer().listen(${JSON.stringify(socketPath)}, () => process.exit(0));`);
  assert.equal((await run(env, stale).result).code, 0);
  assert.equal(existsSync(socketPath), true);
  writeFileSync(join(env.serverDir, "sessions.json"), "constructor must not read this");
  const entrypoint = join(env.root, "held-probe.mjs");
  writeFileSync(entrypoint, `
    import { Socket } from 'node:net';
    import { startDaemon } from ${JSON.stringify(pathToFileURL(join(a.root, "src/server.ts")).href)};
    const emit = Socket.prototype.emit;
    let held = false;
    Socket.prototype.emit = function(event, ...args) {
      if (event === 'error' && !held && args[0]?.code === 'ECONNREFUSED') {
        held = true;
        process.send('probe-held');
        process.once('message', () => emit.call(this, event, ...args));
        return true;
      }
      return emit.call(this, event, ...args);
    };
    try { const daemon = await startDaemon(); await daemon.stop(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    process.disconnect();
  `);
  const child = spawn(process.execPath, [entrypoint], { env: { ...process.env, ...env.vars }, timeout: 10_000, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const closed = once(child, "close");
  await Promise.race([once(child, "message"), closed.then(() => { throw new Error(`probe child exited before gate: ${stderr}`); })]);
  assert.equal(inspectDaemonOwner(env.serverDir).status, "live", "probe follows ownership claim");
  save(env, journal(env, b, "adopted", a));
  child.send("release-probe");
  assert.equal((await closed)[0], 1, stderr);
  assert.match(stderr, /adopted forbids any new registry writer/);
  assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
});

for (const direct of ["CLI", "startDaemon"] as const) {
  test(`${direct} admission prevents persisted session startup hooks from running`, { timeout: 20_000 }, async t => {
    const env = fixture(t), a = staged(env, `hook-${direct}`), b = staged(env, `blocked-${direct}`);
    const marker = join(env.root, "session-started");
    writeFileSync(join(env.agentDir, "extensions/admission-marker.ts"), `
      import {writeFileSync} from 'node:fs';
      export default function(pi) { pi.on('session_start', () => writeFileSync(${JSON.stringify(marker)}, String(process.pid))); }
    `);
    const initial = await run(env, a.entrypoint, ["ensure"]).result;
    assert.equal(initial.code, 0, initial.stderr);
    const client = await DaemonClient.connect(JSON.parse(initial.stdout).socketPath);
    const created = await client.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
    assert.ok(created.sessionId);
    client.close();
    assert.equal(existsSync(marker), true, "real SDK startup hook ran for the initial session");
    const owner = inspectDaemonOwner(env.serverDir);
    if (owner.status !== "live") throw new Error("missing initial daemon");
    process.kill(owner.owner.pid, "SIGTERM");
    await waitFor("initial daemon release", () => inspectDaemonOwner(env.serverDir).status === "missing");
    rmSync(marker);
    const index = readFileSync(join(env.serverDir, "sessions.json"));
    pointer(env, a); save(env, journal(env, b, "recovery-required", a));
    let entrypoint = a.entrypoint;
    if (direct === "startDaemon") {
      entrypoint = join(env.root, "direct-hook.mjs");
      writeFileSync(entrypoint, `import {startDaemon} from ${JSON.stringify(pathToFileURL(join(a.root, "src/server.ts")).href)};
        try { const daemon = await startDaemon(); await daemon.stop(); } catch (error) { console.error(error.message); process.exitCode = 1; }`);
    }
    const refused = await run(env, entrypoint).result;
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /Startup admission/);
    assert.equal(existsSync(marker), false, "refused startup never resumes hooks");
    assert.deepEqual(readFileSync(join(env.serverDir, "sessions.json")), index);
    assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
  });
}

test("ordinary source startup cannot borrow a managed manifest identity", { timeout: 20_000 }, async t => {
  const env = fixture(t), a = staged(env, "unknown-source");
  pointer(env, a); save(env, journal(env, a, "ready"));
  const result = await run(env, join(packageDir, "src/cli.ts"), [], { PI_SERVER_RUNTIME_MANIFEST: a.manifestPath }).result;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /executing build identity/);
  assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
});

test("startup intent rejects partial or conflicting rollback credentials", () => {
  for (const env of [{ PI_SERVER_ROLLBACK_OPERATION_ID: "op" }, { PI_SERVER_ROLLBACK_PERMIT: "token" },
    { PI_SERVER_ACTIVATION_ID: "op", PI_SERVER_ROLLBACK_OPERATION_ID: "op", PI_SERVER_ROLLBACK_PERMIT: "token" }]) {
    assert.throws(() => startupIntentFromEnv(env), /incomplete startup intent/);
  }
});

async function activate(env: Env, runtime: StagedRuntime, operationId: string, timeoutMs?: number) {
  // Run the coordinator CLI from source so the candidate entrypoint can fail before adoption.
  const args = activationArgs(runtime, env.agentDir, env.serverDir, operationId);
  if (timeoutMs !== undefined) args.push("--timeout-ms", String(timeoutMs));
  const result = await run(env, join(packageDir, "src/cli.ts"), args).result;
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function restoredRuntime(t: TestContext) {
  const env = fixture(t), a = staged(env, "retry-A"), b = staged(env, "retry-B");
  const initial = await activate(env, a, "initial-A");
  assert.equal(initial.status, "ready");
  const client = await DaemonClient.connect(initial.readiness.socketPath, { hello: { capabilities: ["runtime-reconnect-v1"] } });
  t.after(() => client.close());
  const created = await client.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  const sessionId = created.sessionId!;
  await client.call({ type: "acquire_control", sessionId });
  assert.equal((await client.call({ type: "prompt", sessionId, message: "persist exactly once before rollback" })).success, true);
  const entrypoint = readFileSync(b.entrypoint);
  writeFileSync(b.entrypoint, "process.exit(1);\n");
  await activate(env, b, "failed-B");
  const rolledBack = await waitFor("successful rollback and coordinator release", () => {
    const value = readActivationJournal(env.serverDir);
    return value?.phase === "staged" && value.rollbackPermit?.consumedBy && inspectDaemonOwner(env.serverDir, "activation-owner").status === "missing" ? value : undefined;
  });
  const restored = await DaemonClient.connect(join(env.serverDir, "pi-server.sock"), { hello: { capabilities: ["runtime-reconnect-v1"] } });
  t.after(() => restored.close());
  assert.equal(restored.server?.build?.contentId, a.build.contentId);
  assert.deepEqual(inspectDaemonOwner(env.serverDir), { status: "live", owner: rolledBack.rollbackPermit!.consumedBy });
  writeFileSync(b.entrypoint, entrypoint);
  return { env, a, b, restored, rolledBack, sessionId, sessionFile: created.data.sessionFile };
}

test("same-operation retry after rollback leaves restored A usable without shutdown or permit changes", { timeout: 30_000 }, async t => {
  const { env, b, restored, rolledBack, sessionId } = await restoredRuntime(t);
  const notices: unknown[] = [];
  restored.onEvent(event => { if ((event.event as { type?: string })?.type === "runtime_upgrade") notices.push(event); });
  const retry = await activateStagedRuntime({ runtime: b, serverDir: env.serverDir, agentDir: env.agentDir, operationId: "failed-B", ports: defaultActivationPorts });
  assert.equal(retry.status, "deferred");
  assert.equal((await activate(env, b, "failed-B")).status, "deferred");
  assert.deepEqual(readActivationJournal(env.serverDir), rolledBack, "same operation cannot mutate its completed attempt");
  assert.deepEqual(inspectDaemonOwner(env.serverDir), { status: "live", owner: rolledBack.previousOwner });
  assert.equal(hasActivationReservations(rolledBack), false, "terminal observers must not leave B reserved");
  await restored.call({ type: "acquire_control", sessionId });
  assert.equal((await restored.call({ type: "prompt", sessionId, message: "still usable after same-operation retry" })).success, true);
  assert.equal(notices.length, 0, "same-operation retry must not announce a shutdown");
});

for (const target of ["B", "C", "exited-A", "exited-B"] as const) {
  test(`fresh operation after rollback activates ${target} with retained history and no replay`, { timeout: 30_000 }, async t => {
    const { env, a, b, restored, rolledBack, sessionId, sessionFile } = await restoredRuntime(t);
    const before = readFileSync(sessionFile, "utf8");
    const calls = llmCalls(env).length;
    if (target.startsWith("exited-")) {
      restored.close();
      process.kill(rolledBack.previousOwner!.pid, "SIGTERM");
      await waitFor("restored A clean exit", () => inspectDaemonOwner(env.serverDir).status === "missing");
    }
    const desired = target === "C" ? staged(env, "retry-C") : target === "exited-A" ? a : b;
    const operationId = `fresh-${target}`;
    const retry = await activate(env, desired, operationId);
    assert.equal(retry.operationId, operationId, "caller must observe its fresh attempt, not the old rollback reason");
    const ready = await waitFor("fresh attempt ready", () => {
      const value = readActivationJournal(env.serverDir);
      return value?.phase === "ready" && value.operationId === operationId ? value : undefined;
    });
    assert.equal(ready.rollbackPermit, undefined, "only the new journal retires the old permit");
    assert.equal(ready.desiredBuild.contentId, desired.build.contentId);
    assert.deepEqual(inspectDaemonOwner(env.serverDir), { status: "live", owner: ready.candidateOwner });
    assert.notEqual(ready.candidateOwner!.token, rolledBack.previousOwner!.token);
    assert.equal(hasActivationReservations(rolledBack), false, "failed B reservations cannot block C");
    const next = await DaemonClient.connect(ready.readiness!.socketPath);
    t.after(() => next.close());
    assert.equal(next.server?.instanceId, ready.candidateOwner!.token);
    assert.equal(next.server?.build?.contentId, desired.build.contentId);
    assert.deepEqual((await next.call({ type: "list_sessions" })).data.sessions.map((s: any) => s.sessionId), [sessionId]);
    assert.equal(readFileSync(sessionFile, "utf8"), before, "restart must not append or replay session history");
    assert.equal(llmCalls(env).length, calls, "upgrade must not replay the completed prompt");
    assert.throws(() => checkStartupAdmission(request(env, a, { kind: "pre-adoption-rollback", operationId: "failed-B", permitToken: rolledBack.rollbackPermit!.token })), /Startup admission/);
    const replay = await run(env, a.entrypoint, [], { PI_SERVER_ROLLBACK_OPERATION_ID: "failed-B", PI_SERVER_ROLLBACK_PERMIT: rolledBack.rollbackPermit!.token }).result;
    assert.equal(replay.code, 1);
    assert.deepEqual(inspectDaemonOwner(env.serverDir), { status: "live", owner: ready.candidateOwner });
  });
}

test("fresh rollback reservation survives the old reason, caller timeout and a same-operation observer", { timeout: 30_000 }, async t => {
  const { env, b, rolledBack } = await restoredRuntime(t);
  const held = coordinate(t, env);
  const pending = await activate(env, b, "reserved-fresh-B", 1);
  assert.equal(pending.status, "deferred");
  assert.equal(pending.operationId, "reserved-fresh-B");
  const reservations = () => readdirSync(join(env.serverDir, "activation-reservations")).filter(name => /^[a-f0-9]{64}$/.test(name));
  assert.equal(reservations().length, 1, "the timed out fresh caller retains its authorization");
  const observer = await activateStagedRuntime({ runtime: b, serverDir: env.serverDir, agentDir: env.agentDir, operationId: "reserved-fresh-B", ports: defaultActivationPorts });
  assert.equal(observer.operationId, "reserved-fresh-B", "worker contention must not report the old rollback as the new attempt");
  assert.equal(reservations().length, 2, "both fresh observers retain their reservations");
  assert.equal((await activate(env, b, "failed-B")).status, "deferred");
  assert.equal(reservations().length, 2, "same-operation observer removes only its own reservation");
  assert.deepEqual(readActivationJournal(env.serverDir), rolledBack);
  held.release();
  const args = activationArgs(b, env.agentDir, env.serverDir, "reserved-fresh-B");
  args[0] = "activation-worker";
  assert.equal((await run(env, join(packageDir, "src/cli.ts"), args).result).code, 0);
  await waitFor("reserved fresh attempt ready", () => readActivationJournal(env.serverDir)?.phase === "ready");
  assert.equal(readActivationJournal(env.serverDir)?.operationId, "reserved-fresh-B");
  assert.equal(reservations().length, 0);
});

test("fresh rollback retry preserves unknown, changed, unconsumed and post-adoption records without scheduling", { timeout: 30_000 }, async t => {
  const { env, a, b, rolledBack } = await restoredRuntime(t);
  const otherOwner = { ...rolledBack.previousOwner!, token: "00000000-0000-4000-8000-000000000000" };
  const changed = [
    { ...rolledBack, previousOwner: otherOwner },
    { ...rolledBack, previousOwner: otherOwner, rollbackPermit: { ...rolledBack.rollbackPermit!, consumedBy: otherOwner } },
    { ...rolledBack, rollbackPermit: { ...rolledBack.rollbackPermit!, consumedBy: undefined } },
    { ...rolledBack, rollbackPermit: { ...rolledBack.rollbackPermit!, operationId: "foreign-attempt" } },
    { ...rolledBack, rollbackPermit: { ...rolledBack.rollbackPermit!, coordinator: otherOwner } },
    { ...rolledBack, previousBuild: b.build },
    { ...rolledBack, candidateOwner: rolledBack.previousOwner },
    { ...rolledBack, phase: "prepared" as const },
    { ...rolledBack, phase: "adopted" as const },
    { ...rolledBack, phase: "recovery-required" as const },
    rolledBack, // The last case changes only the active pointer.
  ];
  for (const [index, value] of changed.entries()) {
    save(env, value);
    if (index === changed.length - 1) pointer(env, b);
    const outcome = await activateStagedRuntime({ runtime: b, serverDir: env.serverDir, agentDir: env.agentDir, operationId: `unverified-${index}`, ports: {
      ...defaultActivationPorts,
      schedule: async () => assert.fail("unverified rollback must not schedule a shutdown"),
      launch: async () => assert.fail("unverified rollback must not launch a writer"),
    } });
    assert.notEqual(outcome.status, "ready");
    assert.deepEqual(readActivationJournal(env.serverDir), JSON.parse(JSON.stringify(value)), "refusal must preserve old permit scope and status");
    assert.deepEqual(inspectDaemonOwner(env.serverDir), { status: "live", owner: rolledBack.previousOwner });
  }
  pointer(env, a);
  save(env, rolledBack);
});

test("stop commitment refuses an unexpected prepared journal carrying a consumed rollback permit", { timeout: 30_000 }, async t => {
  const { env, b, rolledBack } = await restoredRuntime(t);
  const coordinator = coordinate(t, env);
  const prepared = { ...rolledBack, phase: "prepared" as const, coordinator: coordinator.owner };
  save(env, prepared);
  writeFileSync(join(env.serverDir, "activation-reservations", "a".repeat(64)), JSON.stringify({ buildId: b.build.contentId, operationId: prepared.operationId }));
  let fenced = false, drained = false;
  assert.throws(() => commitActivationStop(prepared, {
    assertIdle() {}, refreshIdle: async () => {}, commitStop() { fenced = true; },
  }, () => { drained = true; }));
  assert.equal(fenced, false);
  assert.equal(drained, false);
  assert.deepEqual(readActivationJournal(env.serverDir), prepared);
  assert.deepEqual(inspectDaemonOwner(env.serverDir), { status: "live", owner: rolledBack.previousOwner });
});

async function failedCandidate(t: TestContext, verify: (env: Env, a: StagedRuntime, b: StagedRuntime, token: string) => Promise<void>) {
  const env = fixture(t), a = staged(env, "rollback-A"), b = staged(env, "rollback-B");
  pointer(env, a);
  // A real exited process leaves a verifiable stale claim; no live daemon is killed.
  const old = join(env.root, "old-owner.mjs");
  writeFileSync(old, `import {claimDaemonOwner} from ${JSON.stringify(new URL("../src/daemon-owner.ts", import.meta.url).href)}; claimDaemonOwner(${JSON.stringify(env.serverDir)});`);
  assert.equal((await run(env, old).result).code, 0);
  writeFileSync(b.entrypoint, "process.exit(1);\n");
  let rollbackObserved = false;
  const outcome = await activateStagedRuntime({ runtime: b, serverDir: env.serverDir, agentDir: env.agentDir, operationId: "upgrade-B", ports: {
    ...defaultActivationPorts,
    launch: async (upgrade, options) => {
      if (options?.adopt === false) {
        assert.equal(rollbackObserved, false, "only one rollback launch is attempted");
        rollbackObserved = true;
        assert.ok(options.rollbackPermitToken);
        await verify(env, a, b, options.rollbackPermitToken);
      }
      return defaultActivationPorts.launch(upgrade, options);
    },
  } });
  return { env, a, b, outcome, rollbackObserved };
}

test("real pre-adoption failure restores code using one durable permit consumed by the rollback child", { timeout: 30_000 }, async t => {
  const result = await failedCandidate(t, async (env, a, b, token) => {
    writeFileSync(join(env.agentDir, "auth.json"), "{\"keep\":\"new-auth\"}");
    const permit = readActivationJournal(env.serverDir)!.rollbackPermit!;
    assert.equal(permit.token, token);
    assert.equal(permit.consumedBy, undefined);
    assert.equal(permit.previousBuild.contentId, a.build.contentId);
    const release = claimDaemonOwner(env.serverDir);
    try { assert.throws(() => adoptActivation(env.serverDir, "upgrade-B", b.build), /cannot adopt/); }
    finally { release(); }
  });
  assert.equal(result.rollbackObserved, true);
  assert.equal(result.outcome.status, "deferred", JSON.stringify(result.outcome));
  if (result.outcome.status !== "deferred") throw new Error("rollback did not restore previous runtime");
  assert.match(result.outcome.reason, /previous compatible runtime restored/);
  const latest = readActivationJournal(result.env.serverDir)!;
  assert.equal(latest.phase, "staged");
  const owner = inspectDaemonOwner(result.env.serverDir);
  assert.equal(owner.status, "live");
  if (owner.status === "live") assert.deepEqual(latest.rollbackPermit?.consumedBy, owner.owner);
  assert.equal(readFileSync(join(result.env.agentDir, "auth.json"), "utf8"), '{"keep":"new-auth"}');
  const client = await DaemonClient.connect(join(result.env.serverDir, "pi-server.sock"));
  t.after(() => client.close());
  assert.equal(client.server?.build?.contentId, result.a.build.contentId);
});

test("wrong, stale, reused, post-adoption and changed-coordinator permits fail closed", { timeout: 30_000 }, async t => {
  const result = await failedCandidate(t, async (env, a, b, token) => {
    const valid = request(env, a, { kind: "pre-adoption-rollback", operationId: "upgrade-B", permitToken: token });
    const issued = readActivationJournal(env.serverDir)!;
    checkStartupAdmission(valid);
    for (const wrong of [request(env, b, valid.intent), { ...valid, agentDir: env.cwd },
      request(env, a, { kind: "pre-adoption-rollback", operationId: "stale-operation", permitToken: token }),
      request(env, a, { kind: "pre-adoption-rollback", operationId: "upgrade-B", permitToken: "wrong-token" })]) {
      assert.throws(() => checkStartupAdmission(wrong), /Startup admission/);
    }
    for (const rollbackPermit of [
      { ...issued.rollbackPermit!, serverDir: env.cwd },
      { ...issued.rollbackPermit!, agentDir: env.cwd },
      { ...issued.rollbackPermit!, previousBuild: b.build },
      { ...issued.rollbackPermit!, token: "malformed" },
    ]) {
      save(env, { ...issued, rollbackPermit });
      assert.throws(() => checkStartupAdmission(valid), /Startup admission/);
    }
    for (const phase of ["adopted", "recovery-required", "ready", "staged"] as const) {
      save(env, { ...issued, phase });
      assert.throws(() => checkStartupAdmission(valid), /Startup admission/);
    }
    save(env, { ...issued, coordinator: { ...issued.coordinator!, token: "00000000-0000-4000-8000-000000000000" } });
    assert.throws(() => checkStartupAdmission(valid), /Startup admission/);
    save(env, issued);
    const release = claimDaemonOwner(env.serverDir);
    try {
      admitDaemonStartup(valid);
      const consumed = readActivationJournal(env.serverDir)!;
      assert.ok(consumed.rollbackPermit?.consumedBy);
      assert.throws(() => checkStartupAdmission(valid), /consumed/);
      assert.throws(() => admitDaemonStartup(valid), /consumed/);
      assert.deepEqual(readActivationJournal(env.serverDir), consumed, "replay does not rewrite the journal");
    } finally { release(); }
    // Keep the consumed record. The coordinator's real launcher must reject it too.
  });
  assert.equal(result.outcome.status, "recovery-required");
  assert.equal(inspectDaemonOwner(result.env.serverDir).status, "missing");
});

test("a replacement live coordinator cannot use an earlier coordinator's rollback permit", { timeout: 20_000 }, async t => {
  const result = await failedCandidate(t, async (env, a, _b, token) => {
    const valid = request(env, a, { kind: "pre-adoption-rollback", operationId: "upgrade-B", permitToken: token });
    checkStartupAdmission(valid);
    // Replace only this test's lock to model coordinator turnover after issuance.
    rmSync(join(env.serverDir, "activation-owner"), { recursive: true });
    assert.throws(() => checkStartupAdmission(valid), /stale or consumed/, "permit loses authority when its coordinator exits");
    const replacement = coordinate(t, env);
    assert.notDeepEqual(replacement.owner, readActivationJournal(env.serverDir)!.coordinator);
    assert.throws(() => checkStartupAdmission(valid), /stale or consumed/);
  });
  assert.equal(result.outcome.status, "recovery-required");
  assert.deepEqual(inspectDaemonOwner(result.env.serverDir), { status: "dead", owner: readActivationJournal(result.env.serverDir)!.previousOwner },
    "refusing the launch preserves the previous stale owner record");
});

