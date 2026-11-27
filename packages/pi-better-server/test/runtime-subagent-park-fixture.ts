import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { defaultSandboxPermissions } from "../../pi-better-sandbox/permissions.ts";
import { connect } from "node:net";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { inspectDaemonOwner, ownerIdentityVerified, ownerIsAlive, processMatchesStart, type DaemonOwnerIdentity } from "../src/daemon-owner.ts";
import { onlyStatusProbeRemains } from "./support/runtime-status.ts";
import { parkPhaseTrace } from "./support/park-phase-trace.ts";
const { launchFixtureRequest } = await import(String("./support/launch-phase-probe.mjs"));

type RecoveryScenario = "standalone" | "unavailable" | "parent" | "park" | "writer" | "claim" | "spawn" | "result" | "bootstrap" | "published" | "lease" | "tools";

export function testContinuationRecovery(scenario: RecoveryScenario): void {
  test(`managed worker continuation recovery: ${scenario}`, { timeout: scenario === "unavailable" ? 90000 : 60000 }, t => runScenario(scenario, t));
}

async function runScenario(scenario: RecoveryScenario, t: import("node:test").TestContext) {
  const trace = scenario === "unavailable" ? parkPhaseTrace(t.signal, record => console.error(JSON.stringify(record))) : undefined;
  trace?.mark("fixture-setup");
  t.after(() => trace?.close());
  const restart = scenario === "park";
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "launch-")), transport = realpathSync(mkdtempSync("/tmp/p761-"));
  const agent = join(root, "agent"), cwd = join(root, "workspace"); mkdirSync(join(agent, "agents/roles"), { recursive: true }); mkdirSync(cwd);
  const entered = join(cwd, "entered.json"), release = join(cwd, "release");
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "offline-fixture" } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { providerExtensions: { openai: new URL("./support/subagent-park-model.ts", import.meta.url).pathname }, defaultTools: "read", maxConcurrent: 1 } } }));
  writeFileSync(join(agent, "agents/roles/fixture.md"), "---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: Fixture\ndefaults:\n  model: openai/gpt-4.1\n---\nFrozen launch instructions.\n");
  const toolPolicy = defaultSandboxPermissions();
  toolPolicy.subagentTools = { applyPatch: true, trusted: [{ name: "unused_tool", package: "npm:fixture" }] };
  const env = { ...process.env,
    ...(scenario === "tools" ? { LAUNCH_POLICY: JSON.stringify({ state: "disabled", permissions: toolPolicy.main, subagentPermissions: toolPolicy.subagents, subagentTools: toolPolicy.subagentTools }) } : {}), PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport, TMPDIR: root,
    LAUNCH_BACKGROUND: scenario === "standalone" ? "0" : "1", LAUNCH_WORKSPACE: cwd, LAUNCH_ENTERED: entered, LAUNCH_RELEASE: release,
    ...(scenario === "bootstrap" ? { CONTINUATION_BOOTSTRAP_GATE: join(cwd, "resume-release") } : {}),
    ...(scenario === "writer" ? { CONTINUATION_WRITER_GATE: join(cwd, "writer-release") } : {}),
    ...(["claim", "spawn", "result", "published", "lease"].includes(scenario) ? { CONTINUATION_CRASH_POINT: scenario, CONTINUATION_CRASH_MARKER: join(cwd, "crashed") } : {}) };
  const execPath = process.env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath;
  let daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = ""; daemon.stderr!.on("data", data => { errors += data; });
  let parent: ReturnType<typeof fork> | undefined;
  let sibling: ReturnType<typeof fork> | undefined;
  const attempts: string[] = [];
  let bootstrapProof: Record<string, unknown> | undefined;
  let initialInstance: string | undefined;
  const runtimeOwners: DaemonOwnerIdentity[] = [];
  const awaitRuntimeExit = async (deadline: number) => {
    while (runtimeOwners.some(owner => ownerIsAlive(owner))) {
      assert.ok(Date.now() < deadline, `Exact runtime owners did not exit within idle shutdown budget: ${JSON.stringify(runtimeOwners)}`);
      await delay(25);
    }
  };
  const metaFor = (id: string) => JSON.parse(readFileSync(join(root, "pi-better-subagents/runs", id, "meta.json"), "utf8"));
  const terminal = async (id: string) => {
    // Recovered children have no exit listener; the current health pass is 15 s.
    const deadline = Date.now() + 20000;
    while (["running", "orphaned"].includes(metaFor(id).status)) {
      assert.ok(Date.now() < deadline, `Terminal publication timed out for ${id}: ${errors}`);
      await delay(25);
    }
    return metaFor(id);
  };
  const waitFile = async (path: string) => {
    if (existsSync(path)) return;
    const watcher = watch(cwd);
    try { while (!existsSync(path)) await once(watcher, "change"); } finally { watcher.close(); }
  };
  try {
    trace?.mark("initial-daemon-ready");
    await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    writeFileSync(join(agent, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: agent, serverDir: transport }));
    if (scenario === "unavailable") {
      // Exercise the fixed-artifact successor deterministically. A source fixture
      // clock cannot control the runtime installed by the real SDK parent.
      const probe = new WorkClient(connect(join(transport, "pi-server.sock")), agent);
      trace?.mark("initial-daemon-hello");
      try { initialInstance = (await probe.ready).instanceId; } finally { probe.close(); }
      trace?.mark("initial-daemon-stop");
      const stopped = once(daemon, "exit"); daemon.send("stop"); await stopped;
    }
    parent = fork(new URL("./support/subagent-launch-sdk.mjs", import.meta.url), [], { execPath: process.execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    parent.stderr!.on("data", data => { errors += data; });
    trace?.mark("sdk-parent-ready");
    const [ready] = await Promise.race([once(parent, "message"), once(parent, "exit").then(() => { throw new Error(errors); })]);
    const launch = async (params: object, key = "same-launch", child = parent!, goalComplete = false) => {
      const message = await launchFixtureRequest(child, { key, params, goalComplete, traceLaunch: Boolean(trace) }, trace);
      if (scenario === "standalone") { assert.match(String(message.error ?? JSON.stringify(message.result)), /did not authorize.*Background/); return { denied: true }; }
      assert.equal(message.error, undefined, `${message.stack ?? message.error}\n${errors}`); return message.result;
    };
    const params = { prompt: "Execute fixture", role: "fixture", model: "openai/gpt-4.1", callback: false, tools: "read,bg_task_spawn,bg_task_status,bg_task_log,wait_for_operations,acknowledge_operation_result", skills: [] };
    trace?.mark("authoritative-launch-receipt");
    const first = await launch(params);
    if (scenario === "standalone") { assert.equal(first.denied, true); return; }
    assert.equal(first.details.launched, true);
    attempts.push(first.details.runId);
    trace?.mark("sdk-parent-stop");
    const exited = once(parent, "exit"); parent.send({ stop: true }); await exited; parent = undefined;
    if (scenario === "writer") {
      const marker = join(cwd, "writer-release.entered");
      const deadline = Date.now() + 15000;
      while (!existsSync(marker)) { assert.ok(Date.now() < deadline, "Live writer barrier not reached"); await delay(25); }
      const writer = JSON.parse(readFileSync(marker, "utf8"));
      assert.equal(writer.pid, metaFor(first.details.runId).pid);
      const death = once(daemon, "exit"); daemon.kill("SIGKILL"); await death;
      daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      daemon.stderr!.on("data", data => { errors += data; });
      await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
      const observer = new WorkClient(join(transport, "pi-server.sock"), agent);
      try {
        await observer.ready;
        const readyBy = Date.now() + 10000;
        while (!(await observer.request("runtime_get_status")).subagentManagement?.continuationReady) {
          assert.ok(Date.now() < readyBy, `Recovered writer bridge unavailable: ${errors}`); await delay(25);
        }
      } finally { observer.close(); }
      writeFileSync(join(cwd, "writer-release"), "release");
    }
    const parkedDeadline = Date.now() + 20000;
    trace?.mark("authoritative-park-file");
    while (!existsSync(join(root, "pi-better-subagents/runs", first.details.runId, "park.json"))) {
      assert.ok(Date.now() < parkedDeadline, `Worker did not park: ${errors}`);
      await delay(50);
    }
    if (restart) {
      await terminal(first.details.runId);
      const death = once(daemon, "exit"); daemon.kill("SIGKILL"); await death;
      daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      daemon.stderr!.on("data", data => { errors += data; });
      await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    }
    if (scenario === "unavailable") {
      const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
      settings.piBetterHarness.sandboxPermissions = { version: 999 };
      writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
    }
    if (scenario === "tools") {
      const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
      settings.piBetterHarness.sandboxPermissions = { version: 1, permissions: { ...toolPolicy, subagentTools: { applyPatch: false, trusted: [] } } };
      writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
    }
    writeFileSync(release, "release");
    if (scenario === "unavailable") {
      trace?.mark("successor-hello");
      const observer = new WorkClient(join(transport, "pi-server.sock"), agent);
      let observedInstance: string;
      try {
        // Complete hello/retention registration before closing this observer.
        const hello = await observer.ready;
        observedInstance = hello.instanceId;
        assert.notEqual(observedInstance, initialInstance, "SDK starts the fixed-artifact successor");
        assert.equal(hello.build?.format, 1, "successor reports its installed artifact identity");
        // The fixed Pi CLI starts a guardian before its serving child. Both
        // exact owners must exist by protocol readiness, not arrive later.
        for (const lock of ["daemon-owner", "guardian-owner"]) {
          const inspection = inspectDaemonOwner(transport, lock);
          assert.equal(inspection.status, "live", `successor ${lock} identity must be captured while live`);
          if (inspection.status !== "live") throw new Error("Missing exact runtime owner");
          assert.ok(ownerIdentityVerified(inspection.owner));
          if (lock === "daemon-owner") assert.equal(inspection.owner.token, observedInstance);
          runtimeOwners.push(inspection.owner);
        }
        const deadline = Date.now() + 10000;
        trace?.mark("unavailable-control-status");
        let state: any;
        do {
          state = (await observer.request("runtime_get_status")).subagentManagement;
          if (state?.continuationUnavailable?.length) break;
          assert.ok(Date.now() < deadline, "Unavailable permission source was not reported"); await delay(25);
        } while (true);
        assert.match(state.continuationUnavailable[0].reason, /permission/i);
        assert.equal(state.inFlight, 0);
      } finally { observer.close(); }
      trace?.mark("original-attempt-terminal");
      await terminal(first.details.runId);
      trace?.mark("sqlite-dependencies-terminal");
      const completedDependencies = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
      try {
        assert.equal(completedDependencies.prepare("SELECT count(*) AS n FROM operations WHERE terminal_revision=0").get()?.n, 0, "all accepted dependencies have durable terminal facts before testing idle shutdown");
        const park = JSON.parse(readFileSync(join(root, "pi-better-subagents/runs", first.details.runId, "park.json"), "utf8"));
        const held = completedDependencies.prepare("SELECT phase, owner_session_id, owner_workspace, owner_branch_id FROM waits WHERE wait_id=? AND generation=?").get(park.waitId, park.generation);
        assert.equal(held?.phase, "held", "unavailable continuation must acknowledge the exact durable generation before idle proof");
        assert.equal(held?.owner_session_id, metaFor(first.details.runId).sessionId);
        assert.equal(held?.owner_workspace, cwd);
        assert.equal(held?.owner_branch_id, park.ownerBranchId);
      }
      finally { completedDependencies.close(); }
      const terminalObservedAt = Date.now();
      trace?.mark("diagnostic-hello");
      // Use the SDK-free runtime handshake, including exact-root/capability
      // validation. A supplied socket does not register runtime-client retention.
      // Hosted-session SDK negotiation is a different protocol and can reject
      // this workspace's SDK against an independently installed fixed runtime.
      const diagnostic = !existsSync(join(transport, "pi-server.sock")) ? undefined : await (async () => {
        const probe = new WorkClient(connect(join(transport, "pi-server.sock")), agent);
        let hello;
        try {
          hello = await probe.ready;
        } catch (error) {
          probe.close();
          if (!existsSync(join(transport, "pi-server.sock"))) return undefined;
          throw error;
        }
        if (hello.instanceId !== observedInstance) {
          probe.close();
          assert.fail("diagnostic must observe the same accepted daemon instance");
        }
        return probe;
      })();
      let lastStatus: any;
      if (diagnostic) try {
        trace?.mark("runtime-clients-detached");
        const detachedBy = Date.now() + 10000;
        do {
          lastStatus = await diagnostic.request("runtime_get_status");
          assert.equal(lastStatus.instanceId, observedInstance);
          assert.equal(lastStatus.lifecycle.runtimeIdleMs, 30000, "exercise the actual default managed-runtime idle policy");
          if (!lastStatus.livenessReasons.some((reason: any) => reason.kind === "connection")) break;
          assert.ok(Date.now() < detachedBy, `Runtime clients did not detach: ${JSON.stringify(lastStatus)}`); await delay(25);
        } while (true);
        // Status is a cached inventory, not a fresh liveness query. An older
        // runner observation may remain until the idle shutdown recheck.
        const assertFreshLiveness = () => {
          if (lastStatus.livenessObservation.observedAt >= terminalObservedAt)
            assert.equal(onlyStatusProbeRemains(lastStatus), true, "terminal unavailable work grants no fresh runtime liveness beyond its exact status dispatch");
        };
        assertFreshLiveness();
        // Measure the current successor's real 30-second idle + five-second
        // shutdown contract. Never advance the preceding fixture daemon's clock.
        const idleStarted = Date.now(), idleDeadline = idleStarted + 35000;
        trace?.mark("idle-socket-close");
        if (lastStatus.nextIdleDeadline !== null) assert.ok(lastStatus.nextIdleDeadline <= idleStarted + 30000);
        while (existsSync(join(transport, "pi-server.sock"))) {
          assert.ok(Date.now() < idleDeadline, `Unavailable wait kept runtime management active: ${JSON.stringify(lastStatus)}`);
          await delay(50);
          if (!existsSync(join(transport, "pi-server.sock"))) break;
          try {
            lastStatus = await diagnostic.request("runtime_get_status");
            assert.equal(lastStatus.instanceId, observedInstance, "idle observation stays on the accepted successor");
            assertFreshLiveness();
          } catch (error) {
            if (existsSync(join(transport, "pi-server.sock")) && !diagnostic.closed) throw error;
            // The real shutdown can close the diagnostic before unlinking socket.
          }
        }
        // Socket close is the start of shutdown; the fixed CLI can still write
        // its clean-stop checkpoint and release leases before actually exiting.
        trace?.mark("exact-runtime-owner-exit");
        await awaitRuntimeExit(idleDeadline);
        console.log(JSON.stringify({ unavailableIdle: { instanceId: observedInstance, initialInstance,
          runtimeIdleMs: 30000, shutdownBudgetMs: 5000, elapsedMs: Date.now() - idleStarted,
          exitedOwners: runtimeOwners } }));
      } finally { diagnostic.close(); }
      else await awaitRuntimeExit(Date.now() + 5000);
      trace?.mark("continuation-remains-unlaunched");
      assert.equal(existsSync(`${entered}.continued`), false);
      return;
    }
    if (scenario === "bootstrap") {
      const deadline = Date.now() + 15000;
      while (!existsSync(join(cwd, "resume-release.entered"))) { assert.ok(Date.now() < deadline, "Resumed bootstrap not reached"); await delay(25); }
      const death = once(daemon, "exit"); daemon.kill("SIGKILL"); await death;
      daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      daemon.stderr!.on("data", data => { errors += data; });
      await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
      const observer = new WorkClient(join(transport, "pi-server.sock"), agent);
      try {
        // Complete hello/retention registration before closing this observer.
        await observer.ready;
        const readyBy = Date.now() + 10000;
        while (!(await observer.request("runtime_get_status")).subagentManagement?.continuationReady) {
          assert.ok(Date.now() < readyBy, `Runtime bridge did not recover: ${errors}`); await delay(25);
        }
      } finally { observer.close(); }
      writeFileSync(join(cwd, "resume-release"), "resume");
    }
    if (["claim", "spawn", "result", "published", "lease"].includes(scenario)) {
      await Promise.race([once(daemon, "exit"), delay(15000, undefined, { ref: false }).then(() => { throw new Error("Claim crash was not reached"); })]);
      if (scenario === "lease") {
        const proof = JSON.parse(readFileSync(join(cwd, "crashed"), "utf8"));
        assert.equal(proof.sessionId, metaFor(first.details.runId).sessionId);
        assert.notEqual(proof.attemptId, first.details.runId);
        const beforeRestart = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
        try {
          const intents = beforeRestart.prepare("SELECT attempts FROM subagent_launch_intents").all() as any[];
          assert.ok(intents.every(intent => !JSON.parse(intent.attempts).some((attempt: any) => attempt.id === proof.attemptId)), "crash precedes the journal's no-dispatch boundary");
        } finally { beforeRestart.close(); }
      }
      daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      daemon.stderr!.on("data", data => { errors += data; });
      await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    }
    const continuedDeadline = Date.now() + 25000;
    while (!existsSync(`${entered}.continued`)) {
      assert.ok(Date.now() < continuedDeadline, `Worker did not continue: ${errors}`);
      await delay(50);
    }
    const park = JSON.parse(readFileSync(join(root, "pi-better-subagents/runs", first.details.runId, "park.json"), "utf8"));
    attempts.push(park.resumedBy);
    const resumed = await terminal(park.resumedBy);
    assert.equal(resumed.status, "completed");
    if (scenario === "bootstrap") assert.equal(resumed.pid, JSON.parse(readFileSync(join(cwd, "resume-release.entered"), "utf8")).pid, "the exact bootstrapped writer reconnects");
    assert.equal(resumed.sessionId, metaFor(first.details.runId).sessionId);
    assert.equal(resumed.spawnPid, metaFor(first.details.runId).spawnPid);
    const db = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
    try {
      // Metadata reaches terminal before the asynchronous outcome publication.
      // Wait for the durable contract rather than racing that separate commit.
      const outcomeDeadline = Date.now() + 10000;
      let outcome: any;
      while (!(outcome = db.prepare("SELECT record_json FROM assignment_outcomes WHERE assignment_id=?").get(first.details.runId))) {
        assert.ok(Date.now() < outcomeDeadline, `Assignment outcome was not published: ${errors}`);
        await delay(25);
      }
      assert.equal(JSON.parse(outcome.record_json).outcome, "succeeded", "final outcome is durable without a foreground recipient");
      const resumedIntents = db.prepare("SELECT attempts FROM subagent_launch_intents WHERE request_key LIKE 'continuation:%'").all() as any[];
      assert.ok(resumedIntents.length >= 1 && resumedIntents.length <= (scenario === "spawn" ? 2 : 1));
      for (const intent of resumedIntents) assert.equal(JSON.parse(intent.attempts).length, 1, "one token per admitted attempt, including bounded safe repair");
      assert.equal(db.prepare("SELECT count(*) AS n FROM operations").get()?.n, 1, "the external dependency side effect is never relaunched");
    } finally { db.close(); }
    assert.notEqual(JSON.parse(readFileSync(`${entered}.continued`, "utf8")).pid, metaFor(first.details.runId).pid);
  } catch (error) {
    trace?.report("failure");
    console.error("Managed launch scenario failed:", error, errors);
    throw error;
  } finally {
    trace?.mark("cleanup");
    writeFileSync(release, "release");
    if (parent?.exitCode === null) { const exit = once(parent, "exit"); parent.send({ stop: true }); await exit; }
    if (sibling?.exitCode === null) { const exit = once(sibling, "exit"); sibling.send({ stop: true }); await exit; }
    if (daemon.exitCode === null) { const exit = once(daemon, "exit"); daemon.send("stop"); await exit; }
    for (const id of attempts) {
      const meta = metaFor(id);
      if (processMatchesStart(meta.pid, meta.pidStartTime)) {
        try { process.kill(-meta.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        const deadline = Date.now() + 2000;
        while (processMatchesStart(meta.pid, meta.pidStartTime)) {
          assert.ok(Date.now() < deadline, `Fixture worker ${id} did not exit`);
          await delay(25);
        }
      }
    }
    // On a failed assertion, clean up only captured, still-matching fixture
    // owners. A successful idle proof has already observed all of them exit.
    for (const owner of [...runtimeOwners].reverse()) if (ownerIsAlive(owner)) {
      assert.ok(ownerIdentityVerified(owner), "refuse to signal an unverified fixture runtime owner");
      try { process.kill(owner.pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      const cleanupDeadline = Date.now() + 5000;
      while (ownerIsAlive(owner)) {
        assert.ok(Date.now() < cleanupDeadline, "fixture runtime did not stop; preserve its evidence directory");
        await delay(25);
      }
    }
    // No owner may still write a checkpoint into the transport being removed.
    rmSync(transport, { recursive: true, force: true });
  }
}
