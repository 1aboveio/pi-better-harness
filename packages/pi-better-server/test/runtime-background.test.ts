import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);
const { createLocalSupervisor, supervisorTaskIdForToken } = await import(new URL("../../pi-better-background-tasks/src/supervisor/index.ts", import.meta.url).href);
const { registerBackgroundTasksGoalProvider } = await import(new URL("../../pi-better-background-tasks/src/goal-provider.ts", import.meta.url).href);
const { closeBackgroundObservation } = await import(new URL("../../pi-better-background-tasks/src/work-observation.ts", import.meta.url).href);
const { registerTools } = await import(new URL("../../pi-better-background-tasks/src/tools.ts", import.meta.url).href);
import { SessionActivity } from "../src/session-activity.ts";
import { HostedSession } from "../src/hosted-session.ts";
import { EventLog } from "../src/event-log.ts";
import { checkHello } from "../src/handshake.ts";
import { fork } from "node:child_process";

test("ordinary background clients share the canonical daemon without hosted ownership", { timeout: 15000 }, async () => {
  mkdirSync(resolve(".work/754"), { recursive: true });
  const root = mkdtempSync(resolve(".work/754/local-"));
  const transport = mkdtempSync("/tmp/p754-");
  const daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: root, PI_SERVER_DIR: transport },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  daemon.stderr!.on("data", chunk => { errors += chunk; });
  const clients: WorkClient[] = [];
  const supervisor = createLocalSupervisor({ directory: join(root, "pi-better-background-tasks", "supervisor") });
  let taskId: string | undefined;
  let store: any;
  try {
    const [ready] = await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    for (let i = 0; i < 3; i++) {
      const client = new WorkClient(ready.ready, root, ["runtime-background-state-v1"]); clients.push(client);
      const observed = await client.subscribe({ background: true, cwd: root, sessionId: `local-${i}` });
      assert.equal(observed.status, "ready");
      assert.equal(observed.activity.active, 0);
      assert.equal((await client.request("runtime_get_status")).hostedSessions, 0);
      const again = await client.get({ background: true, cwd: root, sessionId: `local-${i}` });
      assert.equal(again.scopeRevision, observed.scopeRevision);
      assert.deepEqual((await client.request("list_sessions")).sessions, []);
    }
    const instances = await Promise.all(clients.map(client => client.get({ background: true, cwd: root, sessionId: "local-0" })));
    assert.equal(new Set(instances.map(snapshot => snapshot.instanceId)).size, 1);
    store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    const owner = { kind: "parent-session", workspace: root, sessionId: "local-0" };
    const started = await supervisor.start({ token: "754-daemon-runner", kind: "process", cwd: root,
      argv: [process.execPath, "-e", "const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync('finish')){clearInterval(t);process.exit(0)}},20)"] });
    taskId = started.taskId;
    store.registerOperation({ operationId: "754-daemon-operation", taskId, launchToken: started.token, owner, observer: { kind: "local-supervisor", version: "1" } });
    const waitFor = async (matches: (value: any) => boolean) => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const value = await clients[0]!.get({ background: true, cwd: root, sessionId: "local-0" });
        if (value.status === "ready" && matches(value)) return value;
        assert.ok(Date.now() < deadline, JSON.stringify(value)); await delay(20);
      }
    };
    await waitFor(value => value.activity.active === 1 && value.rows[0]?.meta.id === taskId);
    assert.equal((await clients[1]!.get({ background: true, cwd: root, sessionId: "local-1" })).activity.active, 0);
    store.registerWait({ waitId: "754-daemon-wait", owner, dependencies: [{ operationId: "754-daemon-operation" }], continuationNote: "Read exact runner evidence" });
    await waitFor(value => value.rows[0]?.meta.waits[0]?.waitId === "754-daemon-wait");
    writeFileSync(join(root, "finish"), "done");
    await waitFor(value => value.activity.active === 0 && value.rows[0]?.meta.status === "succeeded");
    assert.equal(store.getOperation("754-daemon-operation").terminalRevision, 0, "production worker never imports runner outcomes");
    assert.equal(store.listWaits({ owner })[0].phase, "waiting");
    assert.equal((await clients[0]!.request("runtime_get_status")).hostedSessions, 0);
    const metrics = await clients[0]!.request("runtime_get_metrics");
    assert.equal(metrics.background.history.inventories, 0, "real runner activity never builds completed history");
  } finally {
    for (const client of clients) client.close();
    if (taskId && !supervisor.snapshot(taskId)?.terminal) await supervisor.stop(taskId);
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, "exit"); daemon.send("stop"); await exited;
    }
    store?.close();
    rmSync(transport, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});

test("shared query observes real runner and wait without taking supervision authority", { timeout: 20000 }, async () => {
  mkdirSync(resolve(".work/754"), { recursive: true });
  const root = mkdtempSync(resolve(".work/754/background-"));
  const transport = mkdtempSync("/tmp/p754-");
  const directory = join(root, "supervisor");
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const supervisor = createLocalSupervisor({ directory });
  const model = new WorkReadModel(root, "test-instance", { supervisorDirectory: directory,
    baseDir: join(root, "subagents"), durableDir: join(root, "archives"), intervalMs: 60000 });
  const clients: WorkClient[] = [];
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const activities: SessionActivity[] = [];
  const providers: any[] = [];
  const contexts: any[] = [];
  const hosts: HostedSession[] = [];
  const apis: any[] = [];
  let activityChanges = 0;
  const tools = new Map<string, any>();
  let taskId: string | undefined;
  const server = createServer(socket => {
    const queries = new WorkQueries(model, socket);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const result = command.type === "hello" ? checkHello(command, { agentDir: root }) : { ok: true, data: queries.handle(command) };
        socket.write(JSON.stringify({ id: command.id, type: "response", success: result.ok, ...result }) + "\n");
      }
    });
  });
  try {
    server.listen(join(transport, "pi-server.sock")); await once(server, "listening");
    writeFileSync(join(root, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: root, serverDir: transport }));
    const incompatible = new WorkClient(join(transport, "pi-server.sock"), root, ["runtime-background-state-v999"]);
    clients.push(incompatible);
    await assert.rejects(incompatible.ready, /capability-mismatch/);
    incompatible.close(); clients.pop();
    const started = await supervisor.start({ token: "754-real-runner", kind: "process", cwd: root,
      argv: [process.execPath, "-e", "const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync('finish')){clearInterval(t);process.exit(0)}},20)"] });
    taskId = started.taskId;
    const owner = { kind: "parent-session" as const, sessionId: "parent", workspace: root, branchId: null, goalId: null };
    store.registerOperation({ operationId: "754-operation", taskId, launchToken: started.token, owner,
      observer: { kind: "local-supervisor", version: "1" } });
    for (const [id, foreign] of [["other-workspace", { ...owner, workspace: root + "-other" }],
      ["other-session", { ...owner, sessionId: "other" }], ["worker", { ...owner, kind: "worker-conversation" }]] as const) {
      store.registerOperation({ operationId: id, taskId: supervisorTaskIdForToken(id), launchToken: id, owner: foreign, observer: { kind: "local-supervisor", version: "1" } });
    }
    for (let i = 0; i < 100; i++) {
      const id = `history-${i}`;
      const foreign = { ...owner, sessionId: "foreign" };
      store.registerOperation({ operationId: id, taskId: supervisorTaskIdForToken(id), launchToken: id, owner: foreign, observer: { kind: "local-supervisor", version: "1" } });
      store.recordTerminalOutcome({ operationId: id, eventId: id, outcome: "succeeded", owner: foreign,
        evidence: [{ kind: "terminal-record", ref: id }] });
    }
    for (let i = 0; i < 3; i++) clients.push(new WorkClient(join(transport, "pi-server.sock"), root));
    const scope = { background: true, cwd: root, sessionId: "parent" };
    await clients[0]!.get(scope); // activate the root background query kernel
    await model.reconcile();
    const snapshots = await Promise.all(clients.map(client => client.get(scope)));
    assert.ok(snapshots.every(snapshot => snapshot.activity.active === 1));
    assert.ok(snapshots.every(snapshot => snapshot.scopeRevision === snapshots[0]!.scopeRevision));
    assert.ok(model.backgroundMetrics.runnerSnapshots <= 8, "initial observation and one shared refresh read only four active records, not 100 completed records");
    const reads = model.backgroundMetrics.runnerSnapshots;
    for (let i = 0; i < 2; i++) {
      const activity = new SessionActivity(() => {}); activities.push(activity);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => "parent" } }; contexts.push(ctx);
      const session = { extensionRunner: { createContext: () => ctx }, subscribe: () => () => {}, isStreaming: false, isCompacting: false, isBashRunning: false };
      const api = { events: activity.events, on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } }; apis.push(api);
      activity.events.on("pi-better-goal:register-provider", provider => { providers[i] = provider; });
      registerBackgroundTasksGoalProvider(api as never);
      activity.attach(session as never, () => { activityChanges++; });
      const hosted = new HostedSession(session as never, new EventLog(join(root, `host-${i}.jsonl`)), () => { activityChanges++; }, activity);
      hosts.push(hosted);
      await hosted.refreshActivity();
      assert.equal(hosted.executionActive, true);
      assert.equal((await providers[i].getActivity(ctx)).items[0].active, true);
    }
    assert.equal(model.backgroundMetrics.runnerSnapshots, reads, "hosted and Goal readers do not create additional global observations");
    registerTools(apis[0]);
    const listed = await tools.get("bg_task_list").execute("list", {}, undefined, undefined, contexts[0]);
    assert.match(listed.content[0].text, new RegExp(taskId!));
    assert.match(listed.content[0].text, /running/);
    const changes = activityChanges;
    for (const hosted of hosts) await hosted.refreshActivity();
    assert.equal(activityChanges, changes, "passive health reads do not report user activity");
    for (const foreign of [{ ...scope, cwd: root + "-other" }, { ...scope, sessionId: "other" }]) {
      const snapshot = await clients[0]!.get(foreign);
      assert.equal(snapshot.rows.length, 1);
      assert.notEqual(snapshot.rows[0]!.meta.id, taskId);
    }
    const before = snapshots[0]!.scopeRevision;
    await model.reconcile();
    assert.equal((await clients[0]!.get(scope)).scopeRevision, before);
    mkdirSync(join(directory, "observed"), { recursive: true });
    const corrupt = join(directory, "observed", `${taskId}.json`);
    writeFileSync(corrupt, "{");
    await model.reconcile();
    const degraded = await clients[0]!.get(scope);
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.activity.active, 1, "unreadable source retains the previous active observation");
    for (const hosted of hosts) { await hosted.refreshActivity(); assert.equal(hosted.executionActive, true); }
    unlinkSync(corrupt);
    await model.reconcile();
    assert.equal((await clients[0]!.get(scope)).status, "ready");
    store.registerWait({ waitId: "754-wait", owner, dependencies: [{ operationId: "754-operation" }], continuationNote: "Interpret the exact runner result" });
    await model.reconcile();
    assert.equal((await clients[0]!.get(scope)).rows[0]!.meta.waits[0].waitId, "754-wait");
    for (let i = 0; i < hosts.length; i++) {
      await hosts[i]!.refreshActivity();
      assert.equal(hosts[i]!.executionActive, true);
      assert.match((await providers[i].getActivity(contexts[i])).items[0].details.waits[0], /754-wait:waiting/);
    }
    const waitList = await tools.get("bg_task_list").execute("list-wait", {}, undefined, undefined, contexts[0]);
    assert.match(waitList.content[0].text, /waits=1/);
    writeFileSync(join(root, "finish"), "done");
    for (let attempt = 0; attempt < 200 && !supervisor.snapshot(taskId)?.terminal; attempt++) await delay(20);
    assert.equal(supervisor.snapshot(taskId)?.status, "succeeded");
    await model.reconcile();
    for (const client of clients) {
      const snapshot = await client.get(scope);
      assert.equal(snapshot.activity.active, 0);
      assert.equal(snapshot.rows[0]!.meta.status, "succeeded");
    }
    for (let i = 0; i < hosts.length; i++) {
      await hosts[i]!.refreshActivity();
      assert.equal(hosts[i]!.executionActive, false);
      assert.equal((await providers[i].getActivity(contexts[i])).items[0].status, "succeeded");
    }
    const terminalList = await tools.get("bg_task_list").execute("list-terminal", {}, undefined, undefined, contexts[0]);
    assert.match(terminalList.content[0].text, /succeeded/);
    assert.equal(store.getOperation("754-operation")!.terminalRevision, 0, "query never imports terminal or settles waits for the supervisor");
    assert.equal(store.listWaits({ owner })[0]!.phase, "waiting");
  } finally {
    for (const activity of activities) activity.dispose();
    for (const api of apis) closeBackgroundObservation(api);
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    for (const client of clients) client.close();
    if (taskId && !supervisor.snapshot(taskId)?.terminal) await supervisor.stop(taskId);
    await model.close(); store.close();
    server.close(); await once(server, "close");
    rmSync(transport, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
