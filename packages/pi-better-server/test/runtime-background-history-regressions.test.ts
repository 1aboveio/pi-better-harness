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
const load = (name: string) => import(new URL(`../src/runtime/domain/background-service/${name}.domain.mjs`, import.meta.url).href);

for (const legacyCount of [0, 160]) test(`public list settles after durable dismissal with ${legacyCount} retained legacy rows`, { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "dismissed-history-"));
  const lease = acquireMutationStore(root);
  const owner = { kind: "parent-session", workspace: root, sessionId: "component-parent" };
  const id = "bgs_00000000000000000001";
  lease.store.registerOperation({ operationId: "component-op", taskId: id, launchToken: "component-token", owner,
    observer: { kind: "local-supervisor", version: "1" } });
  lease.store.recordTerminalOutcome({ operationId: "component-op", eventId: "component-terminal", owner,
    outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: join(root, "terminal") }] });
  const [{ registerTools }, { createObservedWaitHost }, { closeBackgroundObservation }, registry] = await Promise.all([
    load("tools"), load("observed-waits"), load("work-observation"), load("registry"),
  ]);
  const legacyIds = Array.from({ length: legacyCount }, (_, i) => `bg_history_retained_${i}`);
  legacyIds.forEach((task, i) => registry.writeMeta({ id: task, kind: "process", status: "succeeded", startedAt: i + 1,
    endedAt: i + 2, cwd: root, logPath: join(root, `log-${i}`), spawnPid: process.pid, callback: false,
    callbackOrigin: { cwd: root, sessionId: owner.sessionId } }));
  const executor = new WorkQueryExecutor(root, "history-component", {
    modelOptions: { baseDir: join(root, "raw"), durableDir: join(root, "archive"), supervisorDirectory: join(root, "supervisor"), intervalMs: 60000 } });
  const events = new EventEmitter(), tools = new Map<string, any>();
  const pi: any = { events, on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } };
  events.on("pi-better-runtime:connect", request => request.accept(createLocalWorkClient(executor, root)));
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
      assert.match((await run("bg_task_status")).content[0].text, /succeeded/);
      assert.match((await run("bg_task_list")).content[0].text, new RegExp(id));
      assert.equal(host.dismissDurableTask({ cwd: root, sessionId: owner.sessionId }, id), true);
      assert.doesNotMatch((await run("bg_task_list")).content[0].text, new RegExp(id));
      assert.match((await run("bg_task_status")).content[0].text, /succeeded/);
      assert.ok(host.readDurableTask({ cwd: root, sessionId: owner.sessionId }, id).terminalRevision > 0);
      t.diagnostic(JSON.stringify({ legacyCount, elapsedMs: Date.now() - started }));
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("public component read exceeded original 5000ms boundary")), 5000); })]);
  } finally {
    if (timer) clearTimeout(timer);
    closeBackgroundObservation(pi); host.close(); await executor.close(); lease.release();
    for (const task of legacyIds) rmSync(registry.taskDir(task), { recursive: true, force: true });
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
