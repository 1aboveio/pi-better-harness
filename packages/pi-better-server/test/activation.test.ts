import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { activateStagedRuntime, adoptActivation, commitActivationStop, compatibleUpgrade, hasActivationReservations, readActivationJournal, runActivationWorker, type ActivationPorts, type ActivationProbe } from "../src/startup/activation.ts";
import { claimDaemonOwner, currentOwnerIdentity, inspectDaemonOwner } from "../src/daemon-owner.ts";
import type { IdleSessionsLease, ServerBuild, StagedRuntime, UpgradeRequest } from "../src/startup/managed-types.ts";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-activation-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const serverDir = join(root, "state");
  const agentDir = join(root, "agent");
  mkdirSync(serverDir); mkdirSync(agentDir);
  const build = (id: string): ServerBuild => ({ format: 1, contentId: id.repeat(64), sourceDigest: id.repeat(64), dependencyLockDigest: "d".repeat(64), piSdkVersion: "1.2.0", nodeVersion: "24.14.1", platform: "linux-x64", protocolVersion: 1, serverVersion: "0.1.0" });
  const runtime = (id: string): StagedRuntime => ({ format: 1, build: build(id), root: join(root, id), node: process.execPath, entrypoint: join(root, id, "cli.ts"), manifestPath: join(root, id, "runtime.json"), installRoot: root });
  const desired = runtime("b");
  const previous = runtime("a");
  const request = { runtime: desired, serverDir, agentDir, operationId: "first-observer" };
  let probe: ActivationProbe = { kind: "absent" };
  let release: (() => void) | undefined;
  t.after(() => release?.());
  function serve(runtime: StagedRuntime, adopt = false) {
    release = claimDaemonOwner(serverDir);
    if (adopt) adoptActivation(serverDir, readActivationJournal(serverDir)!.operationId, runtime.build);
    const owner = inspectDaemonOwner(serverDir);
    assert.equal(owner.status, "live");
    if (owner.status !== "live") throw new Error("fixture owner missing");
    probe = { kind: "ready", readiness: { version: 1, agent: "pi", serverDir, socketPath: join(serverDir, "pi-server.sock"), hello: {
      protocolVersion: 1, piVersion: "1.2.0", extensionVersions: {}, capabilities: ["safe-upgrade-v1"], build: runtime.build, instanceId: owner.owner.token,
    } } };
  }
  function stop() { release?.(); release = undefined; probe = { kind: "absent" }; }
  let launches = 0;
  let schedules = 0;
  const ports: ActivationPorts = {
    probe: async () => probe,
    schedule: async upgrade => {
      schedules++;
      commitActivationStop(upgrade, { assertIdle() {}, refreshIdle: async () => {}, commitStop() {} }, stop);
    },
    launch: async (upgrade, options) => { launches++; serve(upgrade.runtime, options?.adopt !== false); return { exited: () => false }; },
    pause: async () => {},
  };
  return { root, serverDir, agentDir, desired, previous, request, ports, serve, stop, get probe() { return probe; }, set probe(value) { probe = value; }, get launches() { return launches; }, get schedules() { return schedules; } };
}

test("empty namespace adopts before readiness and preserves agent files", async t => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "auth.json"), "private-auth");
  writeFileSync(join(f.agentDir, "settings.json"), "packages-and-settings");
  const outcome = await activateStagedRuntime({ ...f.request, ports: f.ports });
  assert.equal(outcome.status, "ready");
  assert.equal(f.launches, 1);
  assert.equal(readActivationJournal(f.serverDir)?.candidateOwner?.pid, process.pid);
  assert.equal(JSON.parse(readFileSync(join(f.serverDir, "active-runtime.json"), "utf8")).runtime.build.contentId, f.desired.build.contentId);
  assert.equal(readFileSync(join(f.agentDir, "auth.json"), "utf8"), "private-auth");
  assert.equal(readFileSync(join(f.agentDir, "settings.json"), "utf8"), "packages-and-settings");
});

test("same target coalesces across canonical aliases while a different target conflicts", async t => {
  const f = fixture(t);
  f.serve(f.previous);
  const alias = join(f.root, "alias"); symlinkSync(f.serverDir, alias);
  let releaseGate!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  let scheduled!: () => void;
  const entered = new Promise<void>(resolve => { scheduled = resolve; });
  const realSchedule = f.ports.schedule;
  f.ports.schedule = async request => { scheduled(); await gate; await realSchedule(request); };
  const first = activateStagedRuntime({ ...f.request, ports: f.ports });
  await entered;
  const same = await activateStagedRuntime({ ...f.request, operationId: "second-observer", serverDir: alias, ports: f.ports });
  assert.equal(same.operationId, "first-observer");
  const other = await activateStagedRuntime({ ...f.request, runtime: f.previous, operationId: "conflicting", ports: f.ports });
  assert.equal(other.status, "deferred");
  assert.match(other.reason, /activation-conflict/);
  assert.equal(readActivationJournal(f.serverDir)?.desiredBuild.contentId, f.desired.build.contentId);
  releaseGate();
  assert.equal((await first).status, "ready");
  const late = await runActivationWorker({ ...f.request, runtime: f.previous, operationId: "conflicting" }, f.ports);
  assert.equal(late.status, "deferred");
  assert.match(late.reason, /activation-conflict/);
  assert.equal(readActivationJournal(f.serverDir)?.desiredBuild.contentId, f.desired.build.contentId);
  assert.equal(f.launches, 1);
});

for (const guard of ["exited", "live", "ambiguous", "unknown-compatibility", "downgrade", "protocol", "agent", "candidate", "previous-alive", "cancelled", "prepared", "starting"] as const) {
  test(`stale staged activation cleanup: ${guard}`, async t => {
    const f = fixture(t);
    const source = `import {claimDaemonOwner,inspectDaemonOwner} from ${JSON.stringify(new URL("../src/daemon-owner.ts", import.meta.url).href)}; const release=claimDaemonOwner(${JSON.stringify(f.serverDir)}); console.log(JSON.stringify(inspectDaemonOwner(${JSON.stringify(f.serverDir)}).owner)); release();`;
    const old = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
    assert.equal(old.status, 0, old.stderr);
    const previousOwner = JSON.parse(old.stdout);
    const journal = { ...f.request, serverDir: realpathSync(f.serverDir), operationId: "abandoned", runtime: f.previous, desiredBuild: f.previous.build,
      version: 1, phase: guard === "prepared" || guard === "starting" ? guard : "staged", emptyNamespace: false,
      previousOwner: guard === "previous-alive" ? currentOwnerIdentity() : previousOwner,
      candidateOwner: guard === "candidate" ? previousOwner : undefined,
      previousCompatibility: guard === "unknown-compatibility" ? undefined : {
        piSdkVersion: guard === "downgrade" ? "2.0.0" : "1.2.0", protocolVersion: guard === "protocol" ? 2 : 1,
      }, reason: "Legacy or unverified live daemon; staged runtime is pending verified owner exit" };
    writeFileSync(join(f.serverDir, "activation.json"), JSON.stringify(journal));
    mkdirSync(join(f.serverDir, "activation-reservations"));
    writeFileSync(join(f.serverDir, "activation-reservations", "a".repeat(64)), JSON.stringify({
      buildId: f.previous.build.contentId, operationId: "abandoned", baseOperationId: null,
    }));
    writeFileSync(join(f.serverDir, "sessions.json"), "persisted-state");
    if (guard === "live") f.serve(f.previous);
    if (guard === "ambiguous") { mkdirSync(join(f.serverDir, "daemon-owner")); writeFileSync(join(f.serverDir, "daemon-owner", "foreign"), "keep"); }
    const controller = new AbortController();
    if (guard === "cancelled") f.ports.probe = async () => { controller.abort(); return { kind: "absent" }; };
    const outcome = await activateStagedRuntime({ ...f.request, ports: f.ports, signal: controller.signal,
      agentDir: guard === "agent" ? f.root : f.agentDir });
    assert.equal(outcome.status, guard === "exited" ? "ready" : "deferred");
    assert.equal(f.launches, guard === "exited" ? 1 : 0);
    assert.equal(f.schedules, 0);
    assert.equal(readFileSync(join(f.serverDir, "sessions.json"), "utf8"), "persisted-state");
    if (guard === "exited") {
      assert.equal(readActivationJournal(f.serverDir)?.desiredBuild.contentId, f.desired.build.contentId);
      assert.equal(readdirSync(join(f.serverDir, "activation-reservations")).length, 0);
    } else {
      assert.equal(readActivationJournal(f.serverDir)?.operationId, "abandoned");
      assert.equal(hasActivationReservations(journal), true);
    }
  });
}

for (const scenario of ["same-build", "different-build", "live-owner"] as const) {
  test(`concurrent stale activation waits for retirement proof: ${scenario}`, { timeout: 5_000 }, async t => {
    const f = fixture(t);
    const source = `import {currentOwnerIdentity} from ${JSON.stringify(new URL("../src/daemon-owner.ts", import.meta.url).href)}; console.log(JSON.stringify(currentOwnerIdentity()));`;
    const old = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
    assert.equal(old.status, 0, old.stderr);
    const journal = { ...f.request, operationId: "abandoned", runtime: f.previous, desiredBuild: f.previous.build,
      version: 1, phase: "staged", emptyNamespace: false, previousOwner: JSON.parse(old.stdout),
      previousCompatibility: { piSdkVersion: "1.2.0", protocolVersion: 1 }, reason: "Waiting for legacy owner exit" };
    writeFileSync(join(f.serverDir, "activation.json"), JSON.stringify(journal));
    mkdirSync(join(f.serverDir, "activation-reservations"));
    writeFileSync(join(f.serverDir, "activation-reservations", "a".repeat(64)), JSON.stringify({
      buildId: f.previous.build.contentId, operationId: "abandoned", baseOperationId: null,
    }));
    writeFileSync(join(f.serverDir, "sessions.json"), "persisted-state");
    if (scenario === "live-owner") f.serve(f.previous);
    const target = scenario === "different-build"
      ? { ...f.desired, build: { ...f.desired.build, contentId: "c".repeat(64), sourceDigest: "c".repeat(64) } } : f.desired;
    let entered!: () => void;
    const probing = new Promise<void>(resolve => { entered = resolve; });
    let releaseProbe!: () => void;
    const held = new Promise<void>(resolve => { releaseProbe = resolve; });
    t.after(releaseProbe);
    const probe = f.ports.probe;
    f.ports.probe = async dir => { entered(); await held; return probe(dir); };
    const winner = activateStagedRuntime({ ...f.request, ports: f.ports });
    await probing;
    const coordinator = inspectDaemonOwner(f.serverDir, "activation-owner");
    assert.equal(coordinator.status, "live");
    let retrying!: () => void;
    const contended = new Promise<void>(resolve => { retrying = resolve; });
    const contender = activateStagedRuntime({ ...f.request, runtime: target, operationId: "second-observer", ports: {
      ...f.ports, pause: async () => { retrying(); await winner; },
    } });
    try {
      await Promise.race([contended, contender.then(outcome => {
        assert.fail(`Contender returned before the coordinator finished stale-owner proof: ${JSON.stringify(outcome)}`);
      })]);
      assert.equal(readActivationJournal(f.serverDir)?.operationId, "abandoned");
      assert.deepEqual(inspectDaemonOwner(f.serverDir, "activation-owner"), coordinator);
      assert.equal(f.launches, 0);
    } finally { releaseProbe(); await winner; }
    const [outcome, coalesced] = await Promise.all([winner, contender]);
    assert.equal(outcome.status, scenario === "live-owner" ? "deferred" : "ready");
    if (scenario === "same-build") assert.deepEqual(coalesced, outcome);
    else {
      assert.equal(coalesced.status, "deferred");
      assert.match(coalesced.reason, /activation-conflict/);
      assert.equal(coalesced.operationId, scenario === "live-owner" ? "abandoned" : f.request.operationId);
    }
    assert.equal(f.launches, scenario === "live-owner" ? 0 : 1);
    assert.equal(f.schedules, 0);
    assert.equal(readActivationJournal(f.serverDir)?.desiredBuild.contentId,
      scenario === "live-owner" ? f.previous.build.contentId : f.desired.build.contentId);
    assert.equal(readFileSync(join(f.serverDir, "sessions.json"), "utf8"), "persisted-state");
    if (scenario === "live-owner") assert.equal(hasActivationReservations(journal), true);
    else assert.equal(readdirSync(join(f.serverDir, "activation-reservations")).length, 0);
  });
}

for (const state of ["legacy-listener", "live-no-socket", "ambiguous-owner", "missing-owner-nonempty"]) {
  test(`${state} never schedules a stop or launches a successor`, async t => {
    const f = fixture(t);
    if (state === "legacy-listener") {
      f.serve(f.previous);
      if (f.probe.kind === "ready") f.probe.readiness.hello.capabilities = [];
    } else if (state === "live-no-socket") { f.serve(f.previous); f.probe = { kind: "absent" }; }
    else if (state === "ambiguous-owner") { mkdirSync(join(f.serverDir, "daemon-owner")); writeFileSync(join(f.serverDir, "daemon-owner", "foreign"), "keep"); }
    else writeFileSync(join(f.serverDir, "sessions.json"), "existing-state");
    const outcome = await activateStagedRuntime({ ...f.request, ports: f.ports });
    assert.equal(outcome.status, "deferred");
    assert.equal(f.schedules, 0);
    assert.equal(f.launches, 0);
    if (state === "missing-owner-nonempty") assert.equal(readFileSync(join(f.serverDir, "sessions.json"), "utf8"), "existing-state");
  });
}

test("cancelling one coalesced observer does not cancel another reservation", async t => {
  const f = fixture(t);
  f.serve(f.previous);
  const controller = new AbortController();
  const realSchedule = f.ports.schedule;
  f.ports.schedule = async request => {
    await activateStagedRuntime({ ...f.request, operationId: "other-observer", ports: f.ports });
    controller.abort();
    assert.equal(hasActivationReservations(readActivationJournal(f.serverDir)!), true);
    await realSchedule(request);
  };
  assert.equal((await activateStagedRuntime({ ...f.request, signal: controller.signal, ports: f.ports })).status, "ready");
  assert.equal(f.launches, 1);
});

test("last observer cancellation before commit releases only its reservation", async t => {
  const f = fixture(t);
  f.serve(f.previous);
  const controller = new AbortController();
  let fenced = false;
  f.ports.schedule = async request => {
    controller.abort();
    assert.throws(() => commitActivationStop(request, { assertIdle() {}, refreshIdle: async () => {}, commitStop() { fenced = true; } }, () => {}), /reservation/);
  };
  const outcome = await activateStagedRuntime({ ...f.request, signal: controller.signal, ports: f.ports });
  assert.equal(outcome.status, "deferred");
  assert.equal(fenced, false);
  assert.equal(f.launches, 0);
  assert.equal(inspectDaemonOwner(f.serverDir).status, "live");
});

for (const namespace of ["empty", "proven-exited"] as const) {
  test(`last observer cancellation during held probe leaves ${namespace} namespace uncommitted`, async t => {
    const f = fixture(t);
    if (namespace === "proven-exited") {
      const source = `import {claimDaemonOwner} from ${JSON.stringify(new URL("../src/daemon-owner.ts", import.meta.url).href)}; claimDaemonOwner(${JSON.stringify(f.serverDir)});`;
      const previous = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
      assert.equal(previous.status, 0, previous.stderr);
      assert.equal(inspectDaemonOwner(f.serverDir).status, "dead");
      writeFileSync(join(f.serverDir, "active-runtime.json"), JSON.stringify({ version: 1, serverDir: f.serverDir, runtime: f.previous }));
    }
    const previousOwner = inspectDaemonOwner(f.serverDir);
    const controller = new AbortController();
    let entered!: () => void;
    const probing = new Promise<void>(resolve => { entered = resolve; });
    let releaseProbe!: () => void;
    const held = new Promise<void>(resolve => { releaseProbe = resolve; });
    f.ports.probe = async () => { entered(); await held; return f.probe; };
    const activation = activateStagedRuntime({ ...f.request, signal: controller.signal, ports: f.ports });
    await probing;
    assert.equal(readActivationJournal(f.serverDir)?.phase, "staged");
    controller.abort();
    assert.equal(hasActivationReservations(readActivationJournal(f.serverDir)!), false);
    releaseProbe();
    const outcome = await activation;
    assert.equal(outcome.status, "deferred");
    assert.equal(readActivationJournal(f.serverDir)?.phase, "staged", "cancellation during probe must not commit stopping");
    assert.equal(f.schedules, 0);
    assert.equal(f.launches, 0);
    assert.deepEqual(inspectDaemonOwner(f.serverDir), previousOwner);
  });
}

test("cancellation after stop commitment detaches without stopping host activation", async t => {
  const f = fixture(t);
  f.serve(f.previous);
  const controller = new AbortController();
  const realSchedule = f.ports.schedule;
  f.ports.schedule = async request => { await realSchedule(request); controller.abort(); };
  assert.equal((await activateStagedRuntime({ ...f.request, signal: controller.signal, ports: f.ports })).status, "ready");
  assert.equal(f.launches, 1);
});

test("a final idle invalidation does not commit stop", async t => {
  const f = fixture(t);
  f.serve(f.previous);
  let committed = false;
  f.ports.schedule = async request => {
    const lease: IdleSessionsLease = { assertIdle() { throw new Error("dialog answer started work"); }, refreshIdle: async () => {}, commitStop() { committed = true; } };
    assert.throws(() => commitActivationStop(request, lease, () => {}), /dialog answer/);
    throw new Error("busy");
  };
  assert.equal((await activateStagedRuntime({ ...f.request, ports: f.ports })).status, "deferred");
  assert.equal(committed, false);
  assert.equal(readActivationJournal(f.serverDir)?.phase, "prepared");
  assert.equal(f.launches, 0);
});

test("a pending daemon cannot commit after its coordinator has released ownership", async t => {
  const f = fixture(t);
  f.serve(f.previous);
  let pending!: UpgradeRequest;
  f.ports.schedule = async request => { pending = request; throw new Error("transport response lost"); };
  assert.equal((await activateStagedRuntime({ ...f.request, ports: f.ports })).status, "deferred");
  let stopped = false;
  assert.throws(() => commitActivationStop(pending, { assertIdle() {}, refreshIdle: async () => {}, commitStop() { stopped = true; } }, f.stop), /coordinator/);
  assert.equal(stopped, false);
  assert.equal(inspectDaemonOwner(f.serverDir).status, "live");
});

test("adopted startup work survives readiness failure and recovery never relaunches", async t => {
  const f = fixture(t);
  let workRunning = false;
  let readyProbe!: ActivationProbe;
  f.ports.launch = async request => {
    f.serve(request.runtime, true);
    readyProbe = f.probe;
    workRunning = true;
    f.probe = { kind: "ambiguous", reason: "startup hook has not finished" };
    return { exited: () => false };
  };
  const outcome = await activateStagedRuntime({ ...f.request, ports: f.ports });
  assert.equal(outcome.status, "recovery-required");
  assert.equal(workRunning, true);
  assert.equal(inspectDaemonOwner(f.serverDir).status, "live");
  assert.equal(readActivationJournal(f.serverDir)?.candidateOwner?.pid, process.pid);
  f.ports.launch = async () => { throw new Error("must never launch another writer"); };
  assert.equal((await runActivationWorker(f.request, f.ports)).status, "recovery-required");
  assert.equal(workRunning, true);
  f.probe = readyProbe;
  assert.equal((await runActivationWorker(f.request, f.ports)).status, "ready", "the same adopted owner can finish becoming ready without another launch");
  assert.equal(workRunning, true);
});

test("a crashed coordinator with ambiguous launch intent cannot launch twice", async t => {
  const f = fixture(t);
  f.ports.launch = async () => { throw new Error("launch interrupted"); };
  await activateStagedRuntime({ ...f.request, ports: f.ports });
  const journal = readActivationJournal(f.serverDir)!;
  journal.phase = "starting";
  writeFileSync(join(f.serverDir, "activation.json"), JSON.stringify(journal));
  f.ports.launch = async () => { throw new Error("second launch forbidden"); };
  assert.equal((await runActivationWorker(f.request, f.ports)).status, "recovery-required");
  assert.equal(inspectDaemonOwner(f.serverDir).status, "missing");
});

test("candidate adoption during held restart probe preserves the exact owner for later readiness", async t => {
  const f = fixture(t);
  // Persist the launch intent left by a coordinator that exited before adoption.
  writeFileSync(join(f.serverDir, "activation.json"), JSON.stringify({
    ...f.request, version: 1, phase: "starting", desiredBuild: f.desired.build,
    previousRuntime: f.previous, previousBuild: f.previous.build, emptyNamespace: false,
  }));
  let entered!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; });
  let releaseProbe!: () => void;
  const held = new Promise<void>(resolve => { releaseProbe = resolve; });
  const realProbe = f.ports.probe;
  f.ports.probe = async () => {
    const beforeAdoption = f.probe;
    entered();
    await held;
    return beforeAdoption;
  };
  const recovery = activateStagedRuntime({ ...f.request, ports: f.ports });
  await probing;
  f.serve(f.desired, true);
  const adopted = readActivationJournal(f.serverDir)!;
  assert.equal(adopted.phase, "adopted");
  assert.ok(adopted.candidateOwner);
  releaseProbe();
  assert.equal((await recovery).status, "recovery-required");
  const pending = readActivationJournal(f.serverDir)!;
  assert.equal(pending.phase, "recovery-required");
  assert.deepEqual(pending.candidateOwner, adopted.candidateOwner, "the stale pre-adoption journal must not erase candidate ownership");
  assert.deepEqual(inspectDaemonOwner(f.serverDir), { status: "live", owner: adopted.candidateOwner });
  f.ports.probe = realProbe;
  const outcome = await runActivationWorker(f.request, f.ports);
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") throw new Error("matching candidate did not reconcile");
  assert.equal(outcome.readiness.hello.instanceId, adopted.candidateOwner.token);
  assert.deepEqual(readActivationJournal(f.serverDir)?.candidateOwner, adopted.candidateOwner);
  assert.equal(f.launches, 0, "recovery must neither relaunch the candidate nor roll back");
  assert.equal(f.schedules, 0);
});

test("pre-adoption failure rolls back code only after candidate exit and owner release", async t => {
  const f = fixture(t);
  f.serve(f.previous);
  writeFileSync(join(f.serverDir, "active-runtime.json"), JSON.stringify({ version: 1, serverDir: f.serverDir, runtime: f.previous }));
  writeFileSync(join(f.agentDir, "auth.json"), "keep-new-auth");
  const launched: string[] = [];
  f.ports.launch = async (request, options) => {
    launched.push(request.runtime.build.contentId);
    if (request.runtime.build.contentId === f.desired.build.contentId) return { exited: () => true };
    assert.equal(options?.adopt, false);
    f.serve(f.previous);
    return { exited: () => false };
  };
  const outcome = await activateStagedRuntime({ ...f.request, ports: f.ports });
  assert.equal(outcome.status, "deferred");
  assert.match(outcome.reason, /previous compatible runtime restored/);
  assert.deepEqual(launched, [f.desired.build.contentId, f.previous.build.contentId]);
  assert.equal(readFileSync(join(f.agentDir, "auth.json"), "utf8"), "keep-new-auth");
});

test("a live activation owner is never evicted because its lock is old", async t => {
  const f = fixture(t);
  const release = claimDaemonOwner(f.serverDir, "activation-owner");
  t.after(release);
  const lock = join(f.serverDir, "activation-owner");
  utimesSync(lock, new Date(0), new Date(0));
  const before = inspectDaemonOwner(f.serverDir, "activation-owner");
  assert.equal((await activateStagedRuntime({ ...f.request, ports: f.ports })).status, "deferred");
  assert.deepEqual(inspectDaemonOwner(f.serverDir, "activation-owner"), before);
  assert.equal(f.launches, 0);
});

test("verified dead owner permits activation of existing state without restoring files", async t => {
  const f = fixture(t);
  const source = `import {claimDaemonOwner} from ${JSON.stringify(new URL("../src/daemon-owner.ts", import.meta.url).href)}; claimDaemonOwner(${JSON.stringify(f.serverDir)});`;
  const old = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(old.status, 0, old.stderr);
  assert.equal(inspectDaemonOwner(f.serverDir).status, "dead");
  writeFileSync(join(f.serverDir, "sessions.json"), "persisted-state");
  writeFileSync(join(f.serverDir, "active-runtime.json"), JSON.stringify({ version: 1, serverDir: f.serverDir, runtime: f.previous }));
  assert.equal((await activateStagedRuntime({ ...f.request, ports: f.ports })).status, "ready");
  assert.equal(readFileSync(join(f.serverDir, "sessions.json"), "utf8"), "persisted-state");
  assert.equal(f.launches, 1);
});

test("SDK downgrade is rejected while supported minor/major upgrades remain possible", async t => {
  const f = fixture(t);
  assert.equal(compatibleUpgrade({ ...f.previous.build, piSdkVersion: "0.82.0" }, f.desired.build), true);
  assert.equal(compatibleUpgrade(f.previous.build, { ...f.desired.build, piSdkVersion: "0.82.0" }), false);
  assert.equal(compatibleUpgrade(f.previous.build, { ...f.desired.build, piSdkVersion: "1.2.1" }), true);
  assert.equal(compatibleUpgrade(f.previous.build, { ...f.desired.build, protocolVersion: 2 }), false);
});
