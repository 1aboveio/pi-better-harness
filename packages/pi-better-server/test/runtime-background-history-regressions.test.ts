import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { createLocalWorkClient } from "../src/runtime/local-client.ts";
import { BackgroundObservation } from "../src/runtime/background.ts";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { registerHooks } from "node:module";
const load = (name: string) => import(new URL(`../src/runtime/domain/background-service/${name}.domain.mjs`, import.meta.url).href);

for (const historyActive of [false, true]) test(`repaired legacy watch releases its degraded poll after history activation=${historyActive}`, async t => {
  const root = mkdtempSync(join(tmpdir(), "background-poll-recovery-"));
  const lease = acquireMutationStore(root);
  const owner = { kind: "parent-session", workspace: root, sessionId: "reload-parent" };
  lease.store.registerOperation({ operationId: "prior-local-operation", taskId: "bgs_00000000000000000822", launchToken: "prior-token",
    owner, observer: { kind: "local-supervisor", version: "1" } });
  const registry = await load("registry");
  const id = "bg_reload_watch";
  const running = { id, kind: "command_watch", status: "running", startedAt: Date.now(), cwd: root,
    callbackOrigin: { cwd: root, sessionId: owner.sessionId }, logPath: registry.logPathFor(id), spawnPid: process.pid };
  registry.writeMeta(running); writeFileSync(running.logPath, "");
  const model = new WorkReadModel(root, "poll-recovery", { baseDir: join(root, "raw"), durableDir: join(root, "archive"),
    supervisorDirectory: join(root, "supervisor"), intervalMs: 60000 });
  const background = (model as any).background;
  const scope = { background: true, cwd: root, sessionId: owner.sessionId };
  try {
    assert.equal(model.snapshot(scope).status, "ready");
    if (historyActive) {
      background.historyIndex(scope);
      const history = background.history;
      while (history.pending) await history.pending;
      assert.equal(history.queryStatus, "ready");
    }
    const beforeInventories = background.historyMetrics.inventories;
    writeFileSync(registry.metaPathFor(id), '{"id":');
    background.refresh();
    assert.equal(background.status, "degraded");
    assert.match(background.reason, /Unverified background task.*invalid JSON/);
    assert.equal(model.snapshot(scope).status, "degraded", "partial metadata is never published ready");
    const incompleteReason = background.reason;
    background.refresh();
    assert.equal(background.status, "degraded");
    assert.equal(background.reason, incompleteReason, "unrepaired source remains a real error, not a recursively wrapped stale error");
    if (historyActive) assert.throws(() => background.history.source(), /Unverified background task/,
      "history consumers still reject actually unverified source state");
    registry.writeMeta({ ...running, status: "succeeded", endedAt: Date.now() });
    background.refresh();
    const recovered = model.snapshot(scope);
    t.diagnostic(JSON.stringify({ historyActive, status: recovered.status, reason: recovered.reason }));
    assert.equal(recovered.status, "ready", "the repaired actual source must not be blocked by the prior degraded reason");
    assert.equal(recovered.rows.find((row: any) => row.meta.id === id)?.meta.status, "succeeded");
    assert.equal(background.historyMetrics.inventories, beforeInventories, "recovery does not start another history inventory");
  } finally { await model.close(); lease.release(); rmSync(registry.taskDir(id), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("cached parent and headless child factories list the parent's newly registered durable operation", { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "cached-factory-component-"));
  const lease = acquireMutationStore(root);
  const executor = new WorkQueryExecutor(root, "cached-factory-component", { modelOptions: {
    baseDir: join(root, "raw"), durableDir: join(root, "archive"), supervisorDirectory: join(root, "supervisor"), intervalMs: 60000 } });
  const clients: any[] = [], scopes: any[] = [];
  const serviceTools = new Map<string, any>();
  const { registerTools } = await load("tools");
  const events = new EventEmitter();
  events.on("pi-better-runtime:connect", request => {
    const client = createLocalWorkClient(executor, root); clients.push(client);
    const get = client.get.bind(client); client.get = (scope: any) => { scopes.push(scope); return get(scope); };
    request.accept(client);
  });
  registerTools({ events, on() {}, registerTool(tool: any) { serviceTools.set(tool.name, tool); } }, undefined, () => {}, { resumeLocal: false });
  const transportKey = Symbol.for("803.component.command-transport");
  const id = "bgs_00000000000000000312";
  const calls: any[] = [];
  (globalThis as any)[transportKey] = async (_pi: any, ctx: any, key: string, tool: string, params: any) => {
    calls.push({ tool, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd });
    if (tool === "__background_poll") return { tasks: [], legacyRows: [], deliveries: [] };
    if (tool === "bg_task_spawn") {
      const owner = { kind: "parent-session", workspace: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
      lease.store.registerOperation({ operationId: "cached-parent-operation", taskId: id, launchToken: "cached-parent-token", owner,
        observer: { kind: "local-supervisor", version: "1" } });
      mkdirSync(join(root, "supervisor", "observed"), { recursive: true });
      writeFileSync(join(root, "supervisor", "observed", `${id}.json`), JSON.stringify({ name: params.name }));
      return { content: [{ type: "text", text: `Started ${id}` }] };
    }
    return serviceTools.get(tool).execute(key, params, undefined, undefined, ctx);
  };
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (/\/managed-client\.(js|ts)$/.test(specifier) && context.parentURL?.includes("pi-better-background-tasks"))
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export const requestBackgroundTool=(...args)=>globalThis[Symbol.for('803.component.command-transport')](...args);") };
    return nextResolve(specifier, context);
  } });
  const backgroundModule = new URL("../../pi-better-background-tasks/src/index.ts", import.meta.url).href;
  const { default: background } = await import(backgroundModule);
  const subagentsModule = new URL("../../pi-better-subagents/index.ts", import.meta.url).href;
  const { default: subagents } = await import(subagentsModule);
  const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme("dark", false);
  const make = (sessionId: string, tui: boolean) => {
    const handlers = new Map<string, any[]>(), tools = new Map<string, any>();
    const pi: any = { events: { emit: (name: string, value: any) => events.emit(name, value),
      on(name: string, fn: any) { events.on(name, fn); return () => events.off(name, fn); } },
      on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
      registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, registerFlag() {}, appendEntry() {},
      getSessionEntries: () => [], getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {} };
    const ui: any = { setStatus() {}, setWidget() {}, setEditorComponent(factory: any) { this.factory = factory; }, getEditorComponent() { return this.factory; }, notify() {}, theme: { fg: (_c: any, value: any) => value } };
    const ctx: any = { cwd: root, mode: tui ? "tui" : "print", hasUI: tui, ui, isIdle: () => true,
      sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] } };
    subagents(pi, { supervised: () => [], owner: { start: "component" }, identity: { root, instance: "component" } } as any); background(pi);
    return { ctx, tools, async emit(name: string) {
      let failure: any;
      for (const fn of handlers.get(name) ?? []) { try { await fn({}, ctx); } catch (error) { failure ??= error; } }
      if (failure) throw failure;
    } };
  };
  let parent: any, child: any;
  try {
    parent = make("cached-parent", true); await parent.emit("session_start");
    const state = (globalThis as any)[Symbol.for("pi-better-harness.navigator.state")];
    const owner = state.uiCtx;
    child = make("cached-child", false); await child.emit("session_start");
    await child.emit("session_before_switch"); await child.emit("session_shutdown"); child = undefined;
    assert.equal(state.uiCtx, owner, "headless lifecycle preserves the actual parent navigator owner");
    assert.deepEqual([...state.providers.keys()].sort(), ["background-tasks", "subagents"]);
    const run = (name: string, params: any) => parent.tools.get(name).execute(name, params, undefined, undefined, parent.ctx);
    await run("bg_task_list", {});
    await run("bg_task_spawn", { name: "parent-still-running", shell: false, argv: [process.execPath, "-e", "setTimeout(() => {}, 5_000)"], callback: false });
    const registry = await load("registry"), unknownId = "bg_headless_unknown";
    registry.writeMeta({ id: unknownId, kind: "process", status: "succeeded", startedAt: 1, endedAt: 2,
      cwd: root, logPath: registry.logPathFor(unknownId), callback: false, spawnPid: process.pid });
    lease.store.registerOperation({ operationId: "cached-child-operation", taskId: "bgs_00000000000000000313", launchToken: "cached-child-token",
      owner: { kind: "parent-session", workspace: root, sessionId: "cached-child" }, observer: { kind: "local-supervisor", version: "1" } });
    const listed = (await run("bg_task_list", {})).content[0].text;
    const cold = await clients[0].get({ background: true, cwd: root, sessionId: "cached-parent", limit: 51 });
    t.diagnostic(JSON.stringify({ listed, coldIds: cold.rows.map((row: any) => row.meta.id), calls, scopes, operation: lease.store.getOperation("cached-parent-operation") }));
    assert.match(listed, /parent-still-running/, "the parent's own list still reports its task");
    assert.doesNotMatch(listed, /bgs_00000000000000000313/);
    assert.match(listed, /unavailable ownership/);
    const childList = await serviceTools.get("bg_task_list").execute("child-isolation", {}, undefined, undefined,
      { ...parent.ctx, sessionManager: { ...parent.ctx.sessionManager, getSessionId: () => "cached-child" } });
    assert.doesNotMatch(childList.content[0].text, /parent-still-running/);
    assert.match(childList.content[0].text, /bgs_00000000000000000313/);
    assert.equal((await clients[0].request("runtime_get_metrics")).background.history.inventories, 0);
    rmSync(registry.taskDir(unknownId), { recursive: true, force: true });
  } finally {
    await child?.emit("session_shutdown"); await parent?.emit("session_shutdown"); hook.deregister();
    delete (globalThis as any)[transportKey];
    for (const client of clients) client.close(); await executor.close(); lease.release(); rmSync(root, { recursive: true, force: true });
  }
});

for (const legacyCount of [0, 160]) test(`public list settles after durable dismissal with ${legacyCount} retained legacy rows`, { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "dismissed-history-"));
  const lease = acquireMutationStore(root);
  const owner = { kind: "parent-session", workspace: root, sessionId: "component-parent" };
  const id = "bgs_00000000000000000001";
  lease.store.registerOperation({ operationId: "component-op", taskId: id, launchToken: "component-token", owner,
    observer: { kind: "local-supervisor", version: "1" } });
  lease.store.recordTerminalOutcome({ operationId: "component-op", eventId: "component-terminal", owner,
    outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: join(root, "terminal") }] });
  if (legacyCount === 0) for (let i = 0; i < 104; i++) {
    const operationId = `foreign-${i}`, recipient = { ...owner, sessionId: "foreign" };
    lease.store.registerOperation({ operationId, taskId: `bgs_${String(i + 2).padStart(20, "0")}`,
      launchToken: operationId, owner: recipient, observer: { kind: "local-supervisor", version: "1" } });
    if (i >= 4) lease.store.recordTerminalOutcome({ operationId, eventId: operationId, owner: recipient,
      outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: operationId }] });
  }
  const [{ registerTools }, { createObservedWaitHost }, { closeBackgroundObservation }, registry, { registerBackgroundTasksGoalProvider }, { recordFailure }] = await Promise.all([
    load("tools"), load("observed-waits"), load("work-observation"), load("registry"), load("goal-provider"), load("failures"),
  ]);
  const legacyIds = Array.from({ length: legacyCount }, (_, i) => `bg_history_retained_${i}`);
  legacyIds.forEach((task, i) => registry.writeMeta({ id: task, kind: "process", status: "succeeded", startedAt: i + 1,
    endedAt: i + 2, cwd: root, logPath: join(root, `log-${i}`), spawnPid: process.pid, callback: false,
    callbackOrigin: { cwd: root, sessionId: owner.sessionId } }));
  const capturedIds = ["bg_output_owned", "bg_output_foreign", "bg_output_unknown"];
  const budgetId = "bg_output_previous_budget";
  const budget = { id: budgetId, name: "budget", kind: "command_watch", status: "succeeded", startedAt: 1, endedAt: 2,
    cwd: root, logPath: registry.logPathFor(budgetId), spawnPid: process.pid, callback: false,
    callbackOrigin: { cwd: root, sessionId: owner.sessionId } };
  registry.writeMeta(budget); writeFileSync(budget.logPath, "");
  recordFailure(budget, "failure_when", "failure condition matched", "poll", { category: "condition" });
  const executor = new WorkQueryExecutor(root, "history-component", {
    modelOptions: { baseDir: join(root, "raw"), durableDir: join(root, "archive"), supervisorDirectory: join(root, "supervisor"), intervalMs: 60000 } });
  const events = new EventEmitter(), tools = new Map<string, any>();
  const pi: any = { events, on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } };
  let provider: any;
  events.on("pi-better-goal:register-provider", value => { provider = value; });
  registerBackgroundTasksGoalProvider(pi);
  const client = createLocalWorkClient(executor, root), scopes: any[] = [], get = client.get.bind(client);
  client.get = (scope: any) => { scopes.push(scope); return get(scope); };
  events.on("pi-better-runtime:connect", request => request.accept(client));
  const host = createObservedWaitHost(pi, { sharedStore: lease.store, storePath: join(root, "operation-coordinator.sqlite"),
    supervisorDirectory: join(root, "supervisor"), serverOwnedResults: true, pollMs: 0 });
  const ctx: any = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => owner.sessionId,
    getBranch: () => [], getEntries: () => [] }, isIdle: () => true };
  registerTools(pi, undefined, () => undefined, { resumeLocal: false });
  host.start(ctx);
  const started = Date.now();
  const run = (name: string) => tools.get(name).execute("history-component", name === "bg_task_status" ? { id } : {}, undefined, undefined, ctx);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => {
      const cachedList = (await run("bg_task_list")).content[0].text;
      assert.match(cachedList, new RegExp(budgetId));
      // Original output.test.ts afterEach removes files without registry removal.
      rmSync(registry.taskDir(budgetId), { recursive: true, force: true });
      capturedIds.forEach((task, i) => {
        registry.writeMeta({ id: task, name: ["ours", "foreign", "unknown"][i], kind: "command_watch", status: "succeeded",
          startedAt: Date.now() + 50000, endedAt: 2, cwd: root, logPath: registry.logPathFor(task), spawnPid: process.pid, callback: false,
          callbackOrigin: i === 2 ? undefined : { cwd: root, sessionId: i === 0 ? owner.sessionId : "foreign" } });
        writeFileSync(registry.logPathFor(task), "");
      });
      const immediate = (await run("bg_task_list")).content[0].text;
      const freshKey = await client.get({ background: true, cwd: root, sessionId: owner.sessionId, processId: process.pid,
        backgroundHistory: false, limit: 51 });
      t.diagnostic(JSON.stringify({ cachedList, immediate, freshKeyIds: freshKey.rows.map((row: any) => row.meta.id),
        freshKeyStatus: freshKey.status, inputs: capturedIds.map(task => registry.readMeta(task)) }));
      assert.ok(freshKey.rows.some((row: any) => row.meta.id === capturedIds[0]), "same source is visible when the query cache is cold");
      assert.match(immediate, /bg_output_owned/);
      assert.doesNotMatch(immediate, /bg_output_foreign/);
      assert.match(immediate, /unavailable ownership/);
      const updated = { ...registry.readMeta(capturedIds[0]), name: "current-row-rewritten" };
      registry.writeMeta(updated);
      // A real missing observed journal remains an error on the current row,
      // but must not suppress that row or the separate unknown-owner warning.
      writeFileSync(join(registry.taskDir(capturedIds[0]), "failures.jsonl.observed"), "");
      const withGap = (await run("bg_task_list")).content[0].text;
      assert.match(withGap, /bg_output_owned/);
      assert.match(withGap, /current-row-rewritten/);
      assert.match(withGap, /Failure journal could not be read/);
      assert.match(withGap, /unavailable ownership/);
      assert.doesNotMatch(withGap, /bg_output_foreign/);
      const beforeRepeat = await client.request("runtime_get_metrics");
      const repeated = (await run("bg_task_list")).content[0].text;
      assert.match(repeated, /bg_output_owned/);
      assert.match(repeated, /Failure journal could not be read/);
      assert.equal(/statusCursor=(\S+)/.exec(repeated)?.[1], /statusCursor=(\S+)/.exec(withGap)?.[1]);
      const afterRepeat = await client.request("runtime_get_metrics");
      assert.equal(afterRepeat.queryCount, beforeRepeat.queryCount, "unchanged scope reuses its cached projection");
      assert.equal(afterRepeat.background.registry.metadataFileReads, beforeRepeat.background.registry.metadataFileReads,
        "unchanged cache validation does not read metadata");
      assert.equal(afterRepeat.background.registry.indexDirectoryReads, beforeRepeat.background.registry.indexDirectoryReads,
        "unchanged cache validation does not enumerate indexes");
      assert.ok(Number.isFinite(freshKey.nextDeadline), "cached recent rows carry their actual source expiry");
      t.diagnostic(JSON.stringify({ repeat: { queries: afterRepeat.queryCount - beforeRepeat.queryCount,
        registry: afterRepeat.background.registry, priorRegistry: beforeRepeat.background.registry } }));
      const fullDirectoryReads = registry.getRegistryIoMetrics().fullDirectoryReads;
      for (const scope of [{ cwd: root, sessionId: owner.sessionId }, { cwd: root + "-other", sessionId: owner.sessionId },
        { cwd: root, sessionId: "other" }]) await client.get({ background: true, ...scope });
      assert.match((await run("bg_task_status")).content[0].text, /succeeded/);
      const activity = await provider.getActivity(ctx);
      assert.equal(activity.items.find((item: any) => item.id === id)?.status, "succeeded");
      assert.ok(activity.items.every((item: any) => !item.active));
      const listed = (await run("bg_task_list")).content[0].text;
      assert.match(listed, new RegExp(id));
      assert.match(listed, /bg_output_owned/);
      assert.doesNotMatch(listed, /bg_output_foreign/);
      assert.match(listed, /unavailable ownership/);
      assert.doesNotMatch(listed, /^bg_output_unknown /m);
      const cursor = /statusCursor=(\S+)/.exec(listed)?.[1];
      assert.ok(cursor);
      await tools.get("bg_task_list").execute("unchanged-list", { cursor }, undefined, undefined, ctx);
      assert.equal((await client.request("runtime_get_metrics")).background.history.inventories, 0,
        "default list preserves recent completed visibility without activating history");
      assert.ok(scopes.every(scope => !scope.backgroundHistory), "prior scope queries and default lists never request history");
      assert.equal(registry.getRegistryIoMetrics().fullDirectoryReads, fullDirectoryReads,
        "default visibility does not fall back to a full registry scan");
      const foreignList = await tools.get("bg_task_list").execute("foreign-list", {}, undefined, undefined,
        { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "foreign" } });
      assert.match(foreignList.content[0].text, /bg_output_foreign/);
      assert.doesNotMatch(foreignList.content[0].text, /bg_output_owned/);
      for (const task of capturedIds) registry.removeMeta(registry.readMeta(task));
      await tools.get("bg_task_list").execute("explicit-history", { all: true }, undefined, undefined, ctx);
      assert.ok((await client.request("runtime_get_metrics")).background.history.inventories > 0,
        "explicit cross-session history still builds the archive");
      if (legacyCount) {
        const historical = await tools.get("bg_task_list").execute("filtered-history", { status: ["succeeded"], limit: 2, max_bytes: 4096 }, undefined, undefined, ctx);
        assert.match(historical.content[0].text, new RegExp(legacyIds.at(-1)!));
      }
      t.diagnostic(JSON.stringify({ firstHistoryRequest: scopes.find(scope => scope.backgroundHistory) }));
      assert.equal(host.dismissDurableTask({ cwd: root, sessionId: owner.sessionId }, id), true);
      assert.doesNotMatch((await run("bg_task_list")).content[0].text, new RegExp(id));
      assert.match((await run("bg_task_status")).content[0].text, /succeeded/);
      assert.ok(host.readDurableTask({ cwd: root, sessionId: owner.sessionId }, id).terminalRevision > 0);
      t.diagnostic(JSON.stringify({ legacyCount, elapsedMs: Date.now() - started }));
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("public component read exceeded original 5000ms boundary")), 5000); })]);
  } finally {
    if (timer) clearTimeout(timer);
    closeBackgroundObservation(pi); client.close(); host.close(); await executor.close(); lease.release();
    for (const task of [...legacyIds, ...capturedIds, budgetId]) rmSync(registry.taskDir(task), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

for (const historyMode of [false, true]) test(historyMode ? "active and incremental history share one snapshot for identical wait inputs" : "one wait changes exactly its Background projection after context repair", async t => {
  const root = mkdtempSync(join(tmpdir(), "background-wait-family-")), directory = join(root, "supervisor");
  const lease = acquireMutationStore(root);
  const model = historyMode ? new WorkReadModel(root, "shared-projection", { supervisorDirectory: directory,
    baseDir: join(root, "raw"), durableDir: join(root, "archive"), intervalMs: 60000 }) : undefined;
  const observation: BackgroundObservation = model ? (model as any).background : new BackgroundObservation(root, directory);
  const owner = { kind: "parent-session", sessionId: "parent", workspace: root };
  const taskId = (id: string) => `bgs_${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
  const add = (operationId: string, recipient: any) => lease.store.registerOperation({ operationId, taskId: taskId(operationId),
    launchToken: operationId, owner: recipient, observer: { kind: "local-supervisor", version: "1" } });
  try {
    add("754-operation", owner);
    add("other-workspace", { ...owner, workspace: root + "-other" });
    add("other-session", { ...owner, sessionId: "other" });
    add("worker", { ...owner, kind: "worker-conversation" });
    for (let i = 0; i < 100; i++) {
      const operationId = `history-${i}`, recipient = { ...owner, sessionId: "foreign" };
      add(operationId, recipient);
      lease.store.recordTerminalOutcome({ operationId, eventId: operationId, owner: recipient, outcome: "succeeded",
        evidence: [{ kind: "terminal-record", ref: operationId }] });
    }
    const scope = { background: true, cwd: root, sessionId: owner.sessionId };
    observation.read(scope); observation.refresh();
    mkdirSync(join(directory, "observed"), { recursive: true });
    const path = join(directory, "observed", `${taskId("754-operation")}.json`);
    writeFileSync(path, "{"); observation.refresh(); assert.equal(observation.status, "degraded");
    unlinkSync(path); observation.refresh(); assert.equal(observation.status, "ready");
    const history = (observation as any).history;
    if (historyMode) {
      history.read(scope);
      const deadline = Date.now() + 5000;
      while (history.queryStatus !== "ready" || history.pending) {
        assert.ok(Date.now() < deadline, "controlled history baseline did not settle");
        if (history.pending) await history.pending;
        else await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    const before = observation.metrics.runnerSnapshots;
    const cached = new Map([...(observation as any).terminalProjections].map(([id, value]: any) => [id, value.version]));
    lease.store.registerWait({ waitId: "754-wait", owner, dependencies: [{ operationId: "754-operation" }], continuationNote: "Interpret the exact runner result" });
    let active: any;
    const modes: any[] = [];
    if (historyMode) {
      const kernel = observation as any, project = kernel.project;
      kernel.project = function(operations: any[], useCache = true) {
        const count = this.metrics.runnerSnapshots;
        try { return project.call(this, operations, useCache); }
        finally { modes.push({ useCache, snapshots: this.metrics.runnerSnapshots - count }); }
      };
      try {
        const op = kernel.db.prepare("SELECT * FROM operations WHERE operation_id=?").get("754-operation");
        active = kernel.project([op], true)[0];
        history.startRefresh(); await history.pending;
        assert.equal(history.read(scope).records[0].meta.waits[0].waitId, "754-wait");
      } finally { kernel.project = project; }
      assert.ok(modes.some(value => value.useCache) && modes.some(value => !value.useCache));
    } else observation.refresh();
    const changed = [...(observation as any).terminalProjections].filter(([id, value]: any) => cached.get(id) !== value.version).map(([id]: any) => id);
    t.diagnostic(JSON.stringify({ changed, modes, runnerSnapshots: observation.metrics.runnerSnapshots - before }));
    assert.deepEqual(changed, ["754-operation"]);
    assert.equal(observation.metrics.runnerSnapshots - before, 1, "unrelated active and terminal tasks retain their projections");
    assert.equal((active ?? observation.read(scope)[0]).waits[0].waitId, "754-wait");
    if (historyMode) {
      const kernel = observation as any;
      const project = (mode: boolean) => kernel.project([kernel.db.prepare("SELECT * FROM operations WHERE operation_id=?").get("754-operation")], mode)[0];
      for (const name of ["created context", "replaced context"]) {
        const beforeFile = observation.metrics.runnerSnapshots;
        writeFileSync(path + ".next", JSON.stringify({ name }));
        renameSync(path + ".next", path);
        assert.equal(project(false).name, name, "history verifies atomic file publication/replacement");
        assert.equal(project(true).name, name, "active reuses the freshly verified history projection");
        assert.equal(observation.metrics.runnerSnapshots - beforeFile, 1);
      }
      lease.store.recordTerminalOutcome({ operationId: "754-operation", eventId: "finished", owner, outcome: "succeeded",
        evidence: [{ kind: "terminal-record", ref: "finished" }] });
      const beforeTerminal = observation.metrics.runnerSnapshots;
      assert.equal(project(false).terminal, true);
      assert.equal(project(true).active, false);
      assert.equal(project(true).status, "succeeded", "canonical terminal authority overrides the earlier active projection");
      assert.equal(observation.metrics.runnerSnapshots - beforeTerminal, 1);
    }
  } finally { if (model) await model.close(); else await observation.close(); lease.release(); rmSync(root, { recursive: true, force: true }); }
});
