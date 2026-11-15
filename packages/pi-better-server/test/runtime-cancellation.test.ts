import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { setTimeout as delay } from "node:timers/promises";
const { createObservedWaitHost } = await import(new URL("../../pi-better-background-tasks/src/observed-waits.ts", import.meta.url).href);
const { registerTools } = await import(new URL("../../pi-better-background-tasks/src/tools.ts", import.meta.url).href);
const { createLocalSupervisor, supervisorPaths } = await import(new URL("../../pi-better-background-tasks/src/supervisor/index.ts", import.meta.url).href);
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

test("registered stop tool cancels through authorized socket and another connection recovers the exact receipt", { timeout: 30000 }, async () => {
  mkdirSync(resolve(".work/759"), { recursive: true });
  const root = mkdtempSync(resolve(".work/759/cancel-"));
  const transport = mkdtempSync("/tmp/p759-");
  const daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: root, PI_SERVER_DIR: transport },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  daemon.stderr!.on("data", chunk => { errors += chunk; });
  const tools = new Map<string, any>();
  const pi = { events: new EventEmitter(), on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } };
  const directory = join(root, "supervisor");
  const host = createObservedWaitHost(pi, { storePath: join(root, "operation-coordinator.sqlite"), supervisorDirectory: directory, pollMs: 0 });
  const ctx = { cwd: root, isIdle: () => true, sessionManager: { getSessionId: () => "parent-759", getBranch: () => [] } };
  const clients: WorkClient[] = [];
  let taskId: string | undefined;
  let legacy: ReturnType<typeof fork> | undefined;
  try {
    const [ready] = await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    host.start(ctx);
    registerTools(pi);
    const launch = await host.launchParent({ kind: "process", params: { shell: false, callback: false,
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }, ctx });
    taskId = launch.id;
    const result = await tools.get("bg_task_stop").execute("registered-cancel-759", { id: taskId, request_id: "cancel-once" }, undefined, undefined, ctx);
    assert.match(result.content.map((part: any) => part.text).join("\n"), /cancelled/);
    const stopPath = supervisorPaths(directory, taskId).stop;
    const original = readFileSync(stopPath, "utf8");
    const mtime = statSync(stopPath).mtimeMs;
    const credential = host.authorizeCancellationForParent(ctx, taskId, "cancel-once");
    const second = new WorkClient(ready.ready, root); clients.push(second);
    await second.ready;
    const receipt = await second.request("runtime_query_cancellation", { credential });
    assert.equal(receipt.idempotencyKey, "cancel-once");
    assert.equal(receipt.result.status, "cancelled");
    assert.equal(receipt.result.terminal, true);
    assert.deepEqual(await second.request("runtime_cancel_task", { credential }), receipt);
    assert.equal(readFileSync(stopPath, "utf8"), original);
    assert.equal(statSync(stopPath).mtimeMs, mtime, "journal replay must not call supervisor.stop again");
    await assert.rejects(host.stopForParent(ctx, taskId), /admission transferred/);
    await assert.rejects(second.request("runtime_cancel_task", { credential: "parent-759" }), /permission-unavailable/);
    await assert.rejects(second.request("runtime_cancel_task", { credential, module: "arbitrary", method: "stop" }), /not_accepted.*unsupported cancellation field/);
    assert.throws(() => host.authorizeCancellationForParent({ ...ctx, cwd: root + "-foreign" }, taskId, "foreign"), /another execution owner/);
    const other = await host.launchParent({ kind: "process", params: { shell: false, callback: false,
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }, ctx });
    taskId = other.id;
    assert.throws(() => host.authorizeCancellationForParent(ctx, other.id, "cancel-once"), /request-conflict/);
    const exactCredential = host.authorizeCancellationForParent(ctx, other.id, "exact-token-refusal");
    const foreignStop = JSON.stringify({ version: 1, taskId: other.id, token: "foreign-token", requestedAt: Date.now() });
    writeFileSync(supervisorPaths(directory, other.id).stop, foreignStop);
    assert.equal((await second.request("runtime_cancel_task", { credential: exactCredential })).state, "outcome_unknown");
    assert.equal((await second.request("runtime_query_cancellation", { credential: exactCredential })).state, "outcome_unknown");
    assert.equal(readFileSync(supervisorPaths(directory, other.id).stop, "utf8"), foreignStop, "unknown token must not be rewritten or acted upon");
    const unknownStore = openStore({ path: join(root, "operation-coordinator.sqlite") });
    try { assert.equal(unknownStore.getOperation(other.operationId)?.terminalRevision, 0); }
    finally { unknownStore.close(); }
    await createLocalSupervisor({ directory }).stop(other.id);
    legacy = fork(new URL("./support/cancellation-legacy-host.ts", import.meta.url), [root], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let legacyErrors = ""; legacy.stderr!.on("data", chunk => { legacyErrors += chunk; });
    const [legacyReady] = await Promise.race([once(legacy, "message"), once(legacy, "exit").then(() => { throw new Error(legacyErrors); })]);
    taskId = legacyReady.launch.id;
    const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    try {
      const operation = store.getOperation(legacyReady.launch.operationId)!;
      const legacyHost = operation.supervision!.hostId;
      assert.throws(() => host.authorizeCancellationForParent(ctx, taskId, "legacy-refusal"), /live legacy or unknown supervisor/);
      assert.equal(store.getOperation(operation.operationId)?.supervision?.hostId, legacyHost, "unknown identity must retain its authority fence");
      assert.equal(store.getTaskCancellation({ owner: operation.owner, idempotencyKey: "legacy-refusal" }), null);
      assert.equal(existsSync(supervisorPaths(directory, taskId).stop), false);
      store.recordSupervision({ operationId: operation.operationId, owner: operation.owner, expectedHostId: legacyHost,
        supervision: { hostId: `${legacy.pid}:legacy` } });
      assert.throws(() => host.authorizeCancellationForParent(ctx, taskId, "unknown-refusal"), /live legacy or unknown supervisor/);
      assert.equal(store.getOperation(operation.operationId)?.supervision?.hostId, `${legacy.pid}:legacy`);
    } finally { store.close(); }
  } finally {
    for (const client of clients) client.close();
    host.close();
    if (legacy && legacy.exitCode === null && legacy.signalCode === null) { const exited = once(legacy, "exit"); legacy.send("stop"); await exited; }
    if (taskId) await createLocalSupervisor({ directory }).stop(taskId);
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, "exit"); daemon.send("stop"); await exited;
    }
    rmSync(transport, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

for (const stage of ["unaccepted", "accepted", "before-stop-file", "after-stop-file", "after-process-action"]) {
  test(`exact-token recovery after server SIGKILL at ${stage}`, { timeout: 30000 }, async () => {
    mkdirSync(resolve(".work/759"), { recursive: true });
    const root = mkdtempSync(resolve(".work/759/crash-"));
    const transport = mkdtempSync("/tmp/p759-");
    const directory = join(root, "supervisor");
    const tools = new Map<string, any>();
    const pi = { events: new EventEmitter(), on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } };
    const ctx = { cwd: root, isIdle: () => true, sessionManager: { getSessionId: () => "crash-parent", getBranch: () => [] } };
    const host = createObservedWaitHost(pi, { storePath: join(root, "operation-coordinator.sqlite"), supervisorDirectory: directory, pollMs: 0 });
    const children: ReturnType<typeof fork>[] = [];
    const clients: WorkClient[] = [];
    const start = async (fault?: string) => {
      const child = fork(new URL("./support/cancellation-daemon.ts", import.meta.url), [], { execArgv: ["--import", "tsx"],
        env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_SERVER_DIR: transport, PI_TEST_CANCEL_FAULT: fault ?? "" },
        stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.push(child);
      let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
      const [ready] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors); })]);
      const client = new WorkClient(ready.ready, root); clients.push(client); await client.ready;
      await client.request("runtime_cancellation_status");
      await client.request("runtime_result_supervision");
      assert.deepEqual((await client.request("runtime_get_metrics")).mutationSqlite, { active: 1, leases: 2 });
      return { child, client };
    };
    let taskId: string | undefined;
    try {
      host.start(ctx);
      registerTools(pi);
      const launched = await host.launchParent({ kind: "process", params: { shell: false, callback: false,
        argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }, ctx });
      taskId = launched.id;
      const launchToken = JSON.parse(readFileSync(supervisorPaths(directory, taskId).launch, "utf8")).token;
      const first = await start(stage);
      const credential = host.authorizeCancellationForParent(ctx, taskId, "crash-key");
      const exited = once(first.child, "exit");
      if (stage === "unaccepted") first.child.kill("SIGKILL");
      else {
        const result = await tools.get("bg_task_stop").execute(`fault-${stage}`, { id: taskId, request_id: "crash-key" }, undefined, undefined, ctx);
        assert.match(result.content.map((part: any) => part.text).join("\n"), /outcome_unknown/);
      }
      assert.equal((await exited)[1], "SIGKILL");
      const stopPath = supervisorPaths(directory, taskId).stop;
      let before: string | undefined;
      try { before = readFileSync(stopPath, "utf8"); } catch (error) { if ((error as any).code !== "ENOENT") throw error; }
      const second = await start();
      if (stage === "unaccepted") {
        assert.equal((await second.client.request("runtime_query_cancellation", { credential })).state, "not_accepted");
        await assert.rejects(second.client.request("runtime_cancel_task", { credential }), /not_accepted.*stale-runtime-epoch/);
        assert.equal(existsSync(stopPath), false);
        return;
      }
      let receipt: any;
      const deadline = Date.now() + 10000;
      do {
        receipt = await second.client.request("runtime_query_cancellation", { credential });
        if (receipt.result) break;
        await delay(20);
      } while (Date.now() < deadline);
      assert.equal(receipt.idempotencyKey, "crash-key");
      assert.equal(receipt.expectedLaunchToken, launchToken);
      assert.notEqual(receipt.state, "not_accepted");
      assert.ok(receipt.result, "recovery must commit a durable receipt");
      if (before) assert.equal(readFileSync(stopPath, "utf8"), before, "recovery must not rewrite the already-published stop action");
      const stored = readFileSync(stopPath, "utf8");
      await second.client.request("runtime_cancel_task", { credential });
      assert.equal(readFileSync(stopPath, "utf8"), stored);
      assert.equal(host.statusForParent(ctx, taskId).terminalOutcome === "succeeded", false);
    } finally {
      for (const client of clients) client.close();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.send("stop"); await exited;
      }
      host.close();
      if (taskId) await createLocalSupervisor({ directory }).stop(taskId);
      rmSync(transport, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
    }
  });
}

test("real Pi SDK loads the Background extension and executes the socket cancellation tool", { timeout: 30000 }, async () => {
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  mkdirSync(resolve(".work/759"), { recursive: true });
  const root = mkdtempSync(resolve(".work/759/sdk-"));
  const transport = mkdtempSync("/tmp/p759-");
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, tmp: process.env.TMPDIR };
  process.env.PI_CODING_AGENT_DIR = root; process.env.TMPDIR = root;
  const daemon = fork(new URL("./support/cancellation-daemon.ts", import.meta.url), [], { execArgv: ["--import", "tsx"],
    env: { ...process.env, PI_SERVER_DIR: transport, PI_TEST_CANCEL_FAULT: "" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; daemon.stderr!.on("data", chunk => { errors += chunk; });
  let session: any;
  try {
    await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
      additionalExtensionPaths: [new URL("../../pi-better-background-tasks/src/index.ts", import.meta.url).pathname],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));
    const extensionErrors: string[] = [];
    await session.bindExtensions({ onError: (error: unknown) => extensionErrors.push(String(error)), shutdownHandler: () => {} });
    const tool = (name: string) => {
      const found = session.agent.state.tools.find((tool: any) => tool.name === name);
      assert.ok(found, `${name} must be registered by the actual SDK extension loader`);
      return found;
    };
    const launched = await tool("bg_task_spawn").execute("sdk-spawn", { shell: false, callback: false,
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
    const taskId = launched.content.map((part: any) => part.text ?? "").join("\n").match(/bgs_[0-9a-f]{20}/)?.[0];
    assert.ok(taskId, JSON.stringify(launched));
    const stopped = await tool("bg_task_stop").execute("sdk-cancel|fc-759", { id: taskId });
    assert.match(stopped.content.map((part: any) => part.text ?? "").join("\n"), /cancelled/);
    const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    try {
      const operation = store.listOperations({ taskId })[0]!;
      // Native request keys include the requester scope. Find the exact durable
      // target intent rather than assuming the public tool key is the ledger key.
      const ledger = new DatabaseSync(join(root, "operation-coordinator.sqlite"), { readOnly: true });
      let requestKey: string;
      try {
        const intents = ledger.prepare("SELECT request_key FROM task_cancellation_requests WHERE operation_id=?").all(operation.operationId);
        assert.equal(intents.length, 1);
        requestKey = String(intents[0]!.request_key);
      } finally { ledger.close(); }
      const receipt = store.getTaskCancellation({ owner: operation.owner, idempotencyKey: requestKey });
      assert.equal(receipt?.result?.status, "cancelled");
      assert.equal(receipt?.expectedLaunchToken, operation.launchToken);
      assert.equal(operation.terminalOutcome, "cancelled");
    } finally { store.close(); }
    assert.deepEqual(extensionErrors, []);
  } finally {
    if (session) {
      await session._extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, "exit"); daemon.send("stop"); await exited; }
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.tmp;
    rmSync(transport, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
