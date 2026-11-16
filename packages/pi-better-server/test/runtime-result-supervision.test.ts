import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkClient } from "../src/runtime/work-client.mjs";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);
const { createLocalSupervisor, supervisorPaths } = await import(new URL("../../pi-better-background-tasks/src/supervisor/index.ts", import.meta.url).href);

for (const crash of ["none", "idle-guardian", "idle-guardian-held", "concurrent-frontends", "published-permissions", "before-terminal", "after-terminal", "missing-current-authority", "missing-captured-authority", "missing-launch-evidence"]) {
test(`SDK frontend exits; server imports independent evidence with ${crash} server crash and retains exact delivery`, { timeout: 30000 }, async () => {
  const guarded = crash.startsWith("idle-guardian");
  mkdirSync(resolve(".work/760"), { recursive: true });
  const root = mkdtempSync(resolve(".work/760/flow-"));
  const runnerRoot = join(root, "frontend-volatile");
  mkdirSync(runnerRoot);
  let directory = join(runnerRoot, process.env.VITEST_POOL_ID ? `pi-better-background-tasks-vitest-${process.env.VITEST_POOL_ID}` : "pi-better-background-tasks", "supervisor");
  const transport = mkdtempSync("/tmp/p760-");
  const children: ReturnType<typeof fork>[] = [];
  const clients: WorkClient[] = [];
  const stops = new Map<ReturnType<typeof fork>, unknown>();
  let nativeSessionFile: string | undefined;
  let taskId: string | undefined;
  const taskIds: string[] = [];
  const start = async (file: string) => {
    const child = fork(new URL(file, import.meta.url), [], { execArgv: ["--import", "tsx"],
      env: { ...process.env, ...(guarded ? { PI_SERVER_RUNTIME_IDLE_MS: "1000", PI_TEST_PERSIST_RECIPIENT: "1" } : {}),
        LAUNCH_WORKSPACE: root, BACKGROUND_ONLY: "1", BACKGROUND_SESSION_FILE: nativeSessionFile,
        PI_TEST_PERMISSION_PUBLISHER: crash === "published-permissions" ? "1" : "0", TMPDIR: file.includes("result-frontend") ? runnerRoot : root, PI_CODING_AGENT_DIR: root, PI_SERVER_DIR: transport }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    stops.set(child, file.includes("measure-full-runtime") ? { stop: true } : "stop");
    const exited = once(child, "exit");
    let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
    const [ready] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(errors); })]);
    return { child, ready, exited };
  };
  try {
    let server = await start(guarded ? "./support/guarded-work-daemon.ts" : "./support/work-daemon.ts");
    const frontends = await Promise.all(Array.from({ length: crash === "concurrent-frontends" ? 2 : 1 }, () => start("./support/result-frontend.ts")));
    const frontend = frontends[0]!;
    nativeSessionFile = frontend.ready.sessionFile;
    taskIds.push(...frontends.map(frontend => frontend.ready.taskId));
    taskId = frontend.ready.taskId;
    // The fixed runtime owns launch evidence now. Follow its persisted exact
    // grant rather than inferring a supervisor path from the frontend's TMPDIR.
    const evidenceStore = new DatabaseSync(join(root, "operation-coordinator.sqlite"), { readOnly: true });
    try {
      const grant = evidenceStore.prepare("SELECT value FROM coordinator_state WHERE key='result-supervision-v1:'||(SELECT operation_id FROM operations WHERE task_id=?)").get(taskId!);
      assert.ok(grant, 'accepted task has a durable result supervision grant');
      directory = JSON.parse(String(grant.value)).directory;
      assert.ok(existsSync(supervisorPaths(directory, taskId!).launch), 'captured launch evidence exists before fault injection');
    } finally { evidenceStore.close(); }
    const wait = frontend.ready.wait;
    for (const frontend of frontends) {
      const exited = once(frontend.child, "exit"); frontend.child.kill("SIGKILL"); await exited;
    }
    const executions = "start\n".repeat(frontends.length);
    if (crash === "none" || guarded) {
      const client = new WorkClient(server.ready.ready, root); clients.push(client); await client.ready;
      const scope = { background: true, cwd: root, sessionId: frontend.ready.sessionId };
      const deadline = Date.now() + 5000;
      let status: any;
      do {
        await client.get(scope);
        status = await client.request("runtime_get_status");
        if (status.livenessReasons.some((reason: any) => reason.kind === "runner" && reason.id === taskId)) break;
        await delay(20);
      } while (Date.now() < deadline);
      if (!status.livenessReasons.some((reason: any) => reason.kind === "runner" && reason.id === taskId)) {
        const claim = JSON.parse(readFileSync(supervisorPaths(directory, taskId!).claim, "utf8"));
        writeFileSync(resolve(".work/760/runner-identity-gap.json"), JSON.stringify({
          claimPid: claim.pid, claimPidStartTime: claim.pidStartTime ?? null,
          runtimeReasons: status.livenessReasons, capturedDirectory: directory,
        }, null, 2));
      }
      assert.ok(status.livenessReasons.some((reason: any) => reason.kind === "runner" && reason.id === taskId),
        "Exact runner start identity must retain the server after every frontend exits, using the captured non-default supervisor directory");
      client.close();
    }
    const negative = crash.startsWith("missing-");
    if (crash === "before-terminal" || negative) {
      const stopped = once(server.child, "exit"); server.child.kill("SIGKILL"); await stopped;
    }
    if (crash.endsWith("-authority")) {
      const db = new DatabaseSync(join(root, "operation-coordinator.sqlite"));
      try {
        const grant = db.prepare("SELECT key, value FROM coordinator_state WHERE key LIKE 'result-supervision-v1:%'").get()!;
        const value = JSON.parse(String(grant.value)); value.capability[crash === "missing-current-authority" ? "current" : "captured"] = null;
        db.prepare("UPDATE coordinator_state SET value = ? WHERE key = ?").run(JSON.stringify(value), String(grant.key));
      } finally { db.close(); }
    }
    if (crash === "missing-launch-evidence") {
      const deadline = Date.now() + 5000;
      while (!existsSync(join(root, "executions")) && Date.now() < deadline) await delay(20);
      assert.equal(existsSync(join(root, "executions")), true);
      const path = supervisorPaths(directory, taskId!).launch;
      renameSync(path, path + ".saved");
    }
    writeFileSync(join(root, "finish"), "finish");
    if (crash === "before-terminal" || negative) server = await start("./support/work-daemon.ts");
    const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    try {
      if (negative) {
        const deadline = Date.now() + 5000;
        while (!existsSync(supervisorPaths(directory, taskId!).result) && Date.now() < deadline) await delay(20);
        assert.equal(existsSync(supervisorPaths(directory, taskId!).result), true, "independent runner must actually finish before refusal is proved");
        const client = new WorkClient(server.ready.ready, root, ["runtime-result-supervision-v1"]); clients.push(client); await client.ready;
        const status = await client.request("runtime_result_supervision");
        assert.match(status.reason, crash.endsWith("-authority") ? /permission-unavailable/ : /reconciling/);
        assert.equal(store.listOperations({ taskId })[0]!.terminalRevision, 0);
        assert.notEqual(store.getWait({ waitId: wait.waitId })?.phase, "ready");
        assert.equal(readFileSync(join(root, "executions"), "utf8"), "start\n");
        return;
      }
      const deadline = Date.now() + 10000;
      while (store.getWait({ waitId: wait.waitId })?.phase !== "ready" && Date.now() < deadline) await delay(20);
      const settled = store.getWait({ waitId: wait.waitId })!;
      assert.equal(settled.phase, "ready");
      const operation = store.listOperations({ taskId })[0]!;
      assert.equal(operation.terminalOutcome, "succeeded");
      assert.equal(operation.terminalRevision, 1);
      assert.equal(operation.owner.sessionId, frontend.ready.sessionId);
      const events = store.listOutbox({ recipient: operation.owner });
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].recipient, operation.owner);
      assert.equal(store.listOutbox({ recipient: { ...operation.owner, sessionId: "foreign-recipient" } }).length, 0);
      assert.equal(events[0].deliveredAt, null);
      assert.equal(readFileSync(join(root, "executions"), "utf8"), executions);
      for (const other of frontends.slice(1)) {
        const deadline = Date.now() + 5000;
        while (store.getWait({ waitId: other.ready.wait.waitId })?.phase !== "ready" && Date.now() < deadline) await delay(20);
        assert.equal(store.getWait({ waitId: other.ready.wait.waitId })?.phase, "ready");
        const operation = store.listOperations({ taskId: other.ready.taskId })[0]!;
        assert.equal(operation.terminalRevision, 1);
        assert.equal(operation.owner.sessionId, other.ready.sessionId);
        assert.equal(store.listOutbox({ recipient: operation.owner }).length, 1);
      }
      if (crash === "after-terminal") {
        const stopped = once(server.child, "exit"); server.child.kill("SIGKILL"); await stopped;
        server = await start("./support/work-daemon.ts");
      }
      for (let i = 0; i < 2; i++) {
        const client = new WorkClient(server.ready.ready, root, ["runtime-result-supervision-v1"]); clients.push(client);
        await client.ready; await client.request("runtime_result_supervision"); client.close();
      }
      assert.equal(store.getOperation(operation.operationId)?.terminalRevision, 1);
      assert.equal(store.listOutbox({ recipient: operation.owner }).length, 1);
      assert.equal(readFileSync(join(root, "executions"), "utf8"), executions);
      if (guarded) {
        let detachedAt = Date.now();
        if (crash === "idle-guardian-held") {
          store.transitionWaitPhase({ waitId: wait.waitId, generation: wait.generation,
            from: "ready", to: "held", reason: "User decision required; no automatic continuation" });
          assert.equal(store.getWait({ waitId: wait.waitId })?.phase, "held");
        } else {
        const handoff = new WorkClient(server.ready.ready, root); clients.push(handoff); await handoff.ready;
        writeFileSync(join(root, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: root, serverDir: transport }));
        const recipient = await start("../scripts/measure-full-runtime/frontend.ts");
        assert.equal(recipient.ready.sessionId, operation.owner.sessionId, "reopen the real persisted recipient, not a replacement identity");
        handoff.close();
        let sequence = 0;
        const call = async (request: any) => {
          const response = once(recipient.child, "message");
          recipient.child.send({ ...request, id: ++sequence, key: `receipt-${sequence}` });
          const [reply] = await response;
          assert.equal(reply.error, undefined, reply.stack);
          return reply.result;
        };
        const deadline = Date.now() + 10000;
        let messages: any[] = [];
        do {
          await call({ tool: "bg_task_status", params: { id: taskId } });
          messages = (await call({ entries: true })).filter((entry: any) => entry.type === "custom_message"
            && entry.details?.completionEventIds?.includes(events[0].eventId));
          if (messages.length) break;
          assert.ok(Date.now() < deadline, "Exact native completion receipt was not delivered");
          await delay(20);
        } while (true);
        assert.equal(messages.length, 1);
        await call({ tool: "bg_task_status", params: { id: taskId } });
        assert.equal((await call({ entries: true })).filter((entry: any) => entry.type === "custom_message"
          && entry.details?.completionEventIds?.includes(events[0].eventId)).length, 1);
        recipient.child.send({ stop: true }); await recipient.exited;
        detachedAt = Date.now();
        }
        const [code, signal] = await server.exited;
        assert.equal(code, 0);
        assert.equal(signal, null);
        assert.ok(Date.now() - detachedAt < 5000, "idle exit must remain within the existing shutdown budget");
        const checkpoint = JSON.parse(readFileSync(join(transport, "clean-stop.json"), "utf8"));
        assert.equal(checkpoint.reason, "clean-stop");
        assert.equal(checkpoint.idleEvidence.lifecycle.runtimeIdleMs, 1000);
        assert.deepEqual(checkpoint.idleEvidence.obligations, []);
        assert.ok(checkpoint.idleEvidence.at >= checkpoint.idleEvidence.deadline);
        assert.ok(checkpoint.idleEvidence.at - checkpoint.idleEvidence.deadline < 2000, "idle deadline must not wait for derived read rebuilding");
        const { inspectDaemonOwner } = await import("../src/daemon-owner.ts");
        assert.equal(inspectDaemonOwner(transport).status, "missing");
        assert.equal(inspectDaemonOwner(transport, "guardian-owner").status, "missing");
        if (crash === "idle-guardian-held") assert.equal(store.getWait({ waitId: wait.waitId })?.phase, "held");
      }
    } finally { store.close(); }
  } finally {
    for (const client of clients) client.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.send(stops.get(child) as any); await exited;
    }
    for (const id of taskIds) await createLocalSupervisor({ directory }).stop(id);
    rmSync(transport, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
}

test("SDK standalone Subagents cannot acquire Background capability from carried code", { timeout: 30000 }, async () => {
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { getObservedWaitService } = await import(new URL("../../pi-better-background-tasks/src/observed-waits.ts", import.meta.url).href);
  mkdirSync(resolve(".work/760"), { recursive: true });
  const root = mkdtempSync(resolve(".work/760/standalone-"));
  const transport = mkdtempSync("/tmp/p760-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let session: any;
  let daemon: Awaited<ReturnType<typeof import("../src/server.ts").startDaemon>> | undefined;
  let probe: (() => unknown) | undefined;
  try {
    const { startDaemon } = await import("../src/server.ts");
    daemon = await startDaemon({ serverDir: transport, sessionIdleMs: 0, daemonIdleMs: 0 });
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
      additionalExtensionPaths: [new URL("../../pi-better-subagents/index.ts", import.meta.url).pathname],
      extensionFactories: [pi => { probe = () => getObservedWaitService(pi); }],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));
    await session.bindExtensions({ onError: (error: unknown) => { throw new Error(String(error)); }, shutdownHandler: () => {} });
    assert.equal(probe?.(), undefined);
    assert.equal(session.agent.state.tools.some((tool: any) => tool.name === "wait_for_operations" || tool.name === "bg_task_spawn"), false);
    const coordinator = join(root, "operation-coordinator.sqlite");
    if (existsSync(coordinator)) {
      const db = new DatabaseSync(coordinator, { readOnly: true });
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coordinator_state WHERE key LIKE 'result-supervision-v1:%'").get()!.n, 0); }
      finally { db.close(); }
    }
  } finally {
    await session?._extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    await daemon?.stop();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(transport, { recursive: true, force: true });
  }
});

test("two actual HostedSessions share server supervision without a discovery host", { timeout: 30000 }, async () => {
  const { startDaemon } = await import("../src/server.ts");
  mkdirSync(resolve(".work/760"), { recursive: true });
  const root = mkdtempSync(resolve(".work/760/hosted-"));
  const transport = mkdtempSync("/tmp/p760-");
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, tmp: process.env.TMPDIR };
  process.env.PI_CODING_AGENT_DIR = root; process.env.TMPDIR = root;
  writeFileSync(join(root, "settings.json"), JSON.stringify({ extensions: [new URL("../../pi-better-background-tasks/src/index.ts", import.meta.url).pathname] }));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ serverDir: transport, sessionIdleMs: 0, daemonIdleMs: 0 });
    for (let i = 0; i < 2; i++) {
      const created = await daemon.registry.create({ type: "create_session", cwd: root });
      const hosted = daemon.registry.get(created.sessionId)!;
      const tool = (name: string) => {
        const found = hosted.session.agent.state.tools.find(tool => tool.name === name);
        assert.ok(found, `${name} must be loaded in the HostedSession`); return found;
      };
      const launch = await tool("bg_task_spawn").execute(`hosted-launch-${i}`, { shell: false, callback: false,
        argv: [process.execPath, "-e", "console.log('hosted independent result')"] });
      const taskId = (launch.details as { id?: string })?.id;
      assert.ok(taskId, JSON.stringify(launch));
      const waited = await tool("wait_for_operations").execute(`hosted-wait-${i}`, { task_ids: [taskId], continuation_note: "Interpret hosted evidence" });
      assert.ok((waited.details as any)?.waitId, JSON.stringify(waited));
    }
    const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    try {
      const deadline = Date.now() + 5000;
      while (store.listOperations().some((op: any) => op.terminalRevision === 0) && Date.now() < deadline) await delay(20);
      const operations = store.listOperations();
      assert.equal(operations.length, 2);
      assert.equal(new Set(operations.map((op: any) => op.supervision.hostId)).size, 1);
      assert.ok(operations.every((op: any) => op.supervision.hostId.startsWith("server:") && op.terminalRevision === 1));
      const db = new DatabaseSync(join(root, "operation-coordinator.sqlite"), { readOnly: true });
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM discovery_claims").get()!.n, 0); }
      finally { db.close(); }
      const { WorkClient } = await import("../src/runtime/work-client.mjs");
      const client = new WorkClient(daemon.socketPath, root);
      try {
        await client.ready;
        const status = await client.request("runtime_get_status");
        assert.equal(status.hostedSessions, 2);
        assert.ok(store.resultSupervisions().every((grant: any) => grant.epoch === status.instanceId), "both sessions must use the same root supervisor epoch");
      } finally { client.close(); }
    } finally { store.close(); }
  } finally {
    await daemon?.stop();
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.tmp;
    rmSync(transport, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});

test("scope handoff refuses live, unknown and untransferred dead legacy holders", { timeout: 30000 }, async () => {
  const { createObservedWaitHost } = await import(new URL("../../pi-better-background-tasks/src/observed-waits.ts", import.meta.url).href);
  mkdirSync(resolve(".work/760"), { recursive: true });
  const root = mkdtempSync(resolve(".work/760/holder-"));
  const transport = mkdtempSync("/tmp/p760-");
  const children: ReturnType<typeof fork>[] = [];
  const start = async (file: string, args: string[] = []) => {
    const child = fork(new URL(file, import.meta.url), args, { execArgv: ["--import", "tsx"],
      env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_SERVER_DIR: transport }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
    const [ready] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors); })]);
    return { child, ready };
  };
  const host = createObservedWaitHost({ events: new EventEmitter(), on() {} }, { storePath: join(root, "operation-coordinator.sqlite"),
    supervisorDirectory: join(root, "supervisor"), pollMs: 0, serverOwnedResults: true });
  const ctx = { cwd: root, isIdle: () => true, sessionManager: { getSessionId: () => "parent-759", getBranch: () => [] } };
  let taskId: string | undefined;
  try {
    await start("./support/work-daemon.ts");
    const original = await start("./support/cancellation-legacy-host.ts", [root]);
    taskId = original.ready.launch.id;
    host.start(ctx);
    await assert.rejects(host.superviseParentWait(ctx, [taskId], "foreign holder must remain fenced"), /live or unknown original/);
    const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    try {
      const op = store.getOperation(original.ready.launch.operationId)!;
      assert.equal(store.resultSupervision(op.operationId), null);
      store.recordSupervision({ operationId: op.operationId, owner: op.owner, expectedHostId: op.supervision.hostId,
        supervision: { hostId: `${original.child.pid}:legacy` } });
      const scope = createHash("sha256").update(`${join(root, "operation-coordinator.sqlite")}\0${join(root, "supervisor")}`).digest("hex");
      const claim = store.readDiscoveryClaim(scope);
      if (claim) store.releaseDiscoveryClaim(claim);
      await assert.rejects(host.superviseParentWait(ctx, [taskId], "unknown holder must remain fenced"), /live or unknown original|original supervision owner/);
      assert.equal(store.getOperation(op.operationId)?.supervision.hostId, `${original.child.pid}:legacy`);
      assert.equal(store.resultSupervision(op.operationId), null);
      assert.equal(store.getOperation(op.operationId)?.terminalRevision, 0);
      // Restore the exact host identity, then kill only the frontend. Its
      // independent runner remains active, with no server result grant.
      store.recordSupervision({ operationId: op.operationId, owner: op.owner,
        expectedHostId: `${original.child.pid}:legacy`, supervision: op.supervision });
      const exited = once(original.child, "exit"); original.child.kill("SIGKILL"); await exited;
      await assert.rejects(host.launchParent({ kind: "process", params: { shell: false, callback: false,
        argv: [process.execPath, "-e", "process.exit(0)"] }, ctx }), /untransferred legacy operation/);
      assert.equal(store.resultScopeManaged(scope), false, "refusal must leave legacy discovery enabled");
      assert.equal(store.resultSupervision(op.operationId), null);
      assert.equal(store.listOperations({ phase: "running" }).length, 1, "no replacement task was admitted");

      // Explicit adoption uses A's own captured authority, never the rejected
      // new task's authority. Its terminal evidence can then advance its wait.
      const wait = await host.superviseParentWait(ctx, [taskId], "adopt the exact legacy dependency");
      assert.ok(store.resultSupervision(op.operationId));
      await createLocalSupervisor({ directory: join(root, "supervisor") }).stop(taskId);
      const deadline = Date.now() + 5000;
      while (store.getOperation(op.operationId)?.terminalRevision === 0 && Date.now() < deadline) await delay(25);
      assert.equal(store.getOperation(op.operationId)?.terminalRevision, 1);
      assert.equal(host.waitViewForParent(ctx, wait.waitId, wait.generation)?.phase, "ready");
    } finally { store.close(); }
  } finally {
    host.close();
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.send("stop"); await exited;
    }
    if (taskId) await createLocalSupervisor({ directory: join(root, "supervisor") }).stop(taskId);
    rmSync(transport, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
