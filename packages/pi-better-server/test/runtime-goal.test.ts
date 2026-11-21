import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { checkHello } from "../src/handshake.ts";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);
const { createLocalSupervisor } = await import(new URL("../../pi-better-background-tasks/src/supervisor/index.ts", import.meta.url).href);
const { registerBackgroundTasksGoalProvider } = await import(new URL("../../pi-better-background-tasks/src/goal-provider.ts", import.meta.url).href);
const { closeBackgroundObservation } = await import(new URL("../../pi-better-background-tasks/src/work-observation.ts", import.meta.url).href);
const { registerSubagentsGoalProvider } = await import(new URL("../../pi-better-subagents/goal-provider.ts", import.meta.url).href);
const { writeMeta, logPathFor, removeMetaArtifacts } = await import(new URL("../../pi-better-subagents/registry.ts", import.meta.url).href);

test("Goal consumes real Subagent and Background transitions without granting server turn authority", { timeout: 15000 }, async () => {
  const root = mkdtempSync("/tmp/g805-");
  const directory = join(root, "supervisor");
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const supervisor = createLocalSupervisor({ directory });
  const model = new WorkReadModel(root, "goal-805", { supervisorDirectory: directory, baseDir: join(root, "runs"), durableDir: join(root, "archives"), intervalMs: 60000 });
  const clients: WorkClient[] = [];
  let fullQueries = 0;
  const server = createServer(socket => {
    const queries = new WorkQueries(model, socket);
    let buffer = "";
    socket.on("close", () => queries.close());
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), command = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (command.type === "runtime_get_snapshot") fullQueries++;
        try {
          const result = command.type === "hello" ? checkHello(command, { agentDir: root }) : { ok: true, data: queries.handle(command) };
          socket.write(JSON.stringify({ id: command.id, type: "response", success: result.ok, ...result }) + "\n");
        } catch (error) { socket.write(JSON.stringify({ id: command.id, success: false, error: String(error) }) + "\n"); }
      }
    });
  });
  const events = new EventEmitter();
  const handlers = new Map<string, any>(), commands = new Map<string, any>();
  const entries: any[] = [{ id: "branch-a" }], wakes: any[] = [];
  let latest: any;
  const ctx = { cwd: root, hasUI: false, isIdle: () => true, sessionManager: {
    getSessionId: () => "parent", getBranch: () => entries, getLeafId: () => "branch-a",
  }, ui: { notify() {}, setWidget() {} } };
  const api: any = { events, on: (key: string, handler: any) => handlers.set(key, handler),
    registerCommand: (key: string, command: any) => commands.set(key, command), registerTool() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }), sendMessage: (message: any) => wakes.push(message) };
  const worker: any = { id: "sa_goal805", sessionId: "worker805", cwd: root, spawnPid: process.pid, pid: process.pid,
    callbackOrigin: { cwd: root, sessionId: "parent", branchId: "branch-a" }, status: "running", startedAt: Date.now(), promptPreview: "worker", logPath: logPathFor("sa_goal805") };
  let taskId: string | undefined;
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < deadline, JSON.stringify(latest)); await delay(10); }
  };
  try {
    server.listen(join(root, "socket")); await once(server, "listening");
    events.on("pi-better-runtime:connect", request => {
      const client = new WorkClient(join(root, "socket"), root); clients.push(client); request.accept(client);
    });
    const saved = new Map(["PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS", "PI_BETTER_GOAL_DISABLE_WAKE", "PI_BETTER_EXTENSION_DISABLE_WAKE"].map(key => [key, process.env[key]]));
    let goal: typeof import("../../pi-better-goal/src/index.ts").default;
    try {
      delete process.env.PI_BETTER_GOAL_DISABLE_WAKE; delete process.env.PI_BETTER_EXTENSION_DISABLE_WAKE;
      process.env.PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS = "5";
      goal = (await import("../../pi-better-goal/src/index.ts")).default;
    } finally {
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    goal(api);
    registerBackgroundTasksGoalProvider(api); registerSubagentsGoalProvider(api);
    events.on("pi-better-goal:activity", value => { latest = value; });
    writeMeta(worker);
    const started = await supervisor.start({ token: "goal805", kind: "process", cwd: root,
      argv: [process.execPath, "-e", "const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync('finish')){clearInterval(t);console.log('exact805');process.exit(0)}},10)"] });
    taskId = started.taskId;
    const owner = { kind: "parent-session" as const, sessionId: "parent", workspace: root, branchId: "branch-a" };
    store.registerOperation({ operationId: "goal805", taskId, launchToken: started.token, owner, observer: { kind: "local-supervisor", version: "1" } });
    await model.reconcile();
    await handlers.get("session_start")({}, ctx);
    await commands.get("goal").handler("integrate exact results", ctx);
    await handlers.get("agent_start")({}, ctx);
    await handlers.get("agent_settled")({}, ctx);
    assert.equal(latest.activeBackgroundCount, 2);
    const warm = fullQueries;
    for (let i = 0; i < 10; i++) await handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
    assert.equal(fullQueries, warm, "healthy notifying providers send no full-state query");
    store.registerWait({ waitId: "goal805-wait", owner, dependencies: [{ operationId: "goal805" }], continuationNote: "Inspect exact result" });
    await model.reconcile();
    await until(() => latest.providers.some((p: any) => p.items.some((item: any) => item.details?.waits?.includes("goal805-wait:waiting"))));
    writeMeta({ ...worker, status: "completed", endedAt: Date.now() });
    writeFileSync(join(root, "finish"), "done");
    await until(() => supervisor.snapshot(taskId!)?.terminal === true);
    assert.match(readFileSync(supervisor.snapshot(taskId!)!.logs.stdout, "utf8"), /exact805/);
    await model.reconcile();
    await until(() => latest.activeBackgroundCount === 0);
    await until(() => wakes.filter(message => message.details?.kind === "background-drained").length === 1);
    assert.equal(store.getOperation("goal805")!.terminalRevision, 0, "activity observation cannot import or consume a result");
    assert.equal(store.listWaits({ owner })[0]!.phase, "waiting");
    for (let i = 0; i < 5; i++) await handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
    assert.equal(wakes.filter(message => message.details?.kind === "background-drained").length, 1);
    assert.equal(latest.providers.find((p: any) => p.providerId === "background-tasks").items[0].id, taskId);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    closeBackgroundObservation(api);
    for (const client of clients) client.close();
    if (taskId && !supervisor.snapshot(taskId)?.terminal) await supervisor.stop(taskId);
    removeMetaArtifacts(worker);
    await model.close(); store.close();
    server.close(); await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});
