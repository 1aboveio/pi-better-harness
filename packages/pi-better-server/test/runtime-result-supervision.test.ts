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

for (const crash of ["none", "before-terminal", "after-terminal", "missing-current-authority", "missing-captured-authority", "missing-launch-evidence"]) {
test(`SDK frontend exits; server imports independent evidence with ${crash} server crash and retains exact delivery`, { timeout: 30000 }, async () => {
  mkdirSync(resolve(".work/760"), { recursive: true });
  const root = mkdtempSync(resolve(".work/760/flow-"));
  const transport = mkdtempSync("/tmp/p760-");
  const children: ReturnType<typeof fork>[] = [];
  const clients: WorkClient[] = [];
  let taskId: string | undefined;
  const start = async (file: string) => {
    const child = fork(new URL(file, import.meta.url), [], { execArgv: ["--import", "tsx"],
      env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: root, PI_SERVER_DIR: transport }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
    const [ready] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors); })]);
    return { child, ready };
  };
  try {
    let server = await start("./support/work-daemon.ts");
    const frontend = await start("./support/result-frontend.ts");
    taskId = frontend.ready.taskId;
    const wait = frontend.ready.wait;
    const exited = once(frontend.child, "exit"); frontend.child.kill("SIGKILL"); await exited;
    const directory = join(root, process.env.VITEST_POOL_ID ? `pi-better-background-tasks-vitest-${process.env.VITEST_POOL_ID}` : "pi-better-background-tasks", "supervisor");
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
      const events = store.listOutbox({ owner: operation.owner });
      assert.equal(events.length, 1);
      assert.equal(events[0].deliveredAt, null);
      assert.equal(readFileSync(join(root, "executions"), "utf8"), "start\n");
      if (crash === "after-terminal") {
        const stopped = once(server.child, "exit"); server.child.kill("SIGKILL"); await stopped;
        server = await start("./support/work-daemon.ts");
      }
      for (let i = 0; i < 2; i++) {
        const client = new WorkClient(server.ready.ready, root, ["runtime-result-supervision-v1"]); clients.push(client);
        await client.ready; await client.request("runtime_result_supervision"); client.close();
      }
      assert.equal(store.getOperation(operation.operationId)?.terminalRevision, 1);
      assert.equal(store.listOutbox({ owner: operation.owner }).length, 1);
      assert.equal(readFileSync(join(root, "executions"), "utf8"), "start\n");
    } finally { store.close(); }
  } finally {
    for (const client of clients) client.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.send("stop"); await exited;
    }
    if (taskId) await createLocalSupervisor({ directory: join(root, process.env.VITEST_POOL_ID ? `pi-better-background-tasks-vitest-${process.env.VITEST_POOL_ID}` : "pi-better-background-tasks", "supervisor") }).stop(taskId);
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
      const taskId = launch.content.map((part: any) => part.text ?? "").join("\n").match(/bgs_[0-9a-f]{20}/)?.[0];
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

test("a live or unknown original holder refuses result handoff without changing the execution owner", { timeout: 30000 }, async () => {
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
