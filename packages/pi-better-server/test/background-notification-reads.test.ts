import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalWorkClient } from "../src/runtime/local-client.ts";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { WorkReadModel, type WorkSnapshot } from "../src/runtime/read-model.ts";

const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

const legacyRegistry = await import(new URL("../src/runtime/domain/background/registry.mjs", import.meta.url).href);

function legacyTask(cwd: string, sessionId: string) {
  const id = legacyRegistry.nextTaskId();
  return { id, kind: "process", status: "running", startedAt: Date.now(), cwd, callbackOrigin: { cwd, sessionId },
    logPath: legacyRegistry.logPathFor(id), spawnPid: process.pid };
}

const observer = { kind: "local-supervisor", version: "1" };
const taskId = (n: number) => "bgs_" + n.toString(16).padStart(20, "0");
function frameCollector(model: WorkReadModel, frames: SnapshotFrame[]) {
  const socket = Object.assign(new EventEmitter(), { writableLength: 0, write(line: string) { frames.push(JSON.parse(line).event); } });
  return new WorkQueries(model, socket as unknown as Socket);
}

type SnapshotFrame = { snapshot: WorkSnapshot; previousSeq: number };

test("ending an assignment clears its wait from the parent's cached terminal task", async () => {
  const root = mkdtempSync(join(tmpdir(), "background-terminal-wait-"));
  const directory = join(root, "supervisor");
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const model = new WorkReadModel(root, "terminal-wait", { baseDir: join(root, "raw"), durableDir: join(root, "archive"),
    supervisorDirectory: directory, intervalMs: 60000 });
  const query = frameCollector(model, []);
  const recipient = { kind: "parent-session", workspace: root, sessionId: "parent" };
  const owner = { kind: "worker-conversation", workspace: root, sessionId: "worker" };
  const assignmentId = "assignment", attemptId = "attempt", id = taskId(1);
  const scope = { background: true, cwd: root, sessionId: recipient.sessionId, id };
  const get = () => (query.handle({ type: "runtime_get_snapshot", scope }) as WorkSnapshot).rows[0]!.meta;
  try {
    store.registerAssignment({ assignmentId, attemptId, owner, recipient });
    store.registerOperation({ operationId: id, taskId: id, launchToken: id, owner, observer, assignmentAttemptId: attemptId });
    mkdirSync(join(directory, "observed"), { recursive: true });
    writeFileSync(join(directory, "observed", id + ".json"), JSON.stringify({ workerAttemptId: attemptId }));
    const { wait } = store.registerWait({ owner, origin: { assignmentRef: assignmentId, attemptId },
      dependencies: [{ operationId: id }], continuationNote: "Interpret result" });
    store.recordTerminalOutcome({ operationId: id, eventId: "done", owner, outcome: "succeeded",
      evidence: [{ kind: "terminal-record", ref: "result.json" }] });
    await model.reconcile();
    const before = get();
    assert.equal(before.terminal, true);
    assert.equal(before.waits[0].waitId, wait.waitId);
    store.recordAssignmentOutcome({ assignmentId, owner, recipient, revision: 1, outcome: "failed",
      reason: "Assignment ended", processUncertain: false, evidence: [], waits: [wait] });
    assert.deepEqual(get().waits, []);
  } finally {
    query.close(); await model.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("an exact read sees a repaired dismissal before its watcher runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "background-repaired-dismissal-"));
  const directory = join(root, "supervisor");
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const model = new WorkReadModel(root, "repair", { supervisorDirectory: directory,
    baseDir: join(root, "raw"), durableDir: join(root, "archive"), intervalMs: 60000 });
  const owner = { kind: "parent-session", workspace: root, sessionId: "owner" };
  const id = taskId(0);
  const scope = { background: true, cwd: root, sessionId: owner.sessionId, id };
  const query = frameCollector(model, []);
  const get = () => query.handle({ type: "runtime_get_snapshot", scope }) as WorkSnapshot;
  try {
    mkdirSync(join(directory, "observed"), { recursive: true });
    store.registerOperation({ operationId: id, taskId: id, launchToken: id, owner, observer });
    await model.reconcile();
    assert.equal(get().rows.length, 1);
    const path = join(directory, "observed", id + ".json");
    writeFileSync(path, "{");
    await model.reconcile();
    assert.equal(get().status, "degraded");
    writeFileSync(path, JSON.stringify({ dismissedAt: Date.now() }));
    const repaired = get();
    assert.equal(repaired.status, "ready");
    assert.deepEqual(repaired.rows, []);
  } finally {
    query.close(); await model.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

for (const unrelatedSessions of [1, 16]) for (const hasLegacyTasks of [false, true]) test(
  `publishing with ${unrelatedSessions} unrelated sessions (legacy tasks: ${hasLegacyTasks})`, async t => {
  const root = mkdtempSync(join(tmpdir(), "background-notifications-"));
  let now = Date.now() - 100000;
  const store = openStore({ path: join(root, "operation-coordinator.sqlite"), now: () => now });
  const model = new WorkReadModel(root, "notifications", { baseDir: join(root, "raw"), durableDir: join(root, "archive"),
    supervisorDirectory: join(root, "supervisor"), intervalMs: 60_000 });
  const queries: WorkQueries[] = [];
  const listeners: Array<{ frames: SnapshotFrame[]; initial: WorkSnapshot }> = [];
  const owner = { kind: "parent-session", workspace: root, sessionId: "owner-0" };
  const scope = { background: true, cwd: root, sessionId: owner.sessionId };
  const legacyTasks = [];
  try {
    for (let i = 1; i <= unrelatedSessions; i++) {
      const other = { ...owner, sessionId: "owner-" + i };
      store.registerOperation({ operationId: "cold-" + i, taskId: taskId(100 + i), launchToken: "cold-" + i, owner: other, observer });
      store.recordTerminalOutcome({ operationId: "cold-" + i, eventId: "done-" + i, owner: other, outcome: "succeeded",
        evidence: [{ kind: "terminal-record", ref: "cold-" + i }] });
      store.registerOperation({ operationId: "running-" + i, taskId: taskId(200 + i), launchToken: "running-" + i, owner: other, observer });
    }
    now = Date.now();
    for (let i = 1; hasLegacyTasks && i <= unrelatedSessions; i++) {
      const task = legacyTask(root, "owner-" + i);
      legacyTasks.push(task);
      legacyRegistry.writeMeta(task);
    }
    await model.reconcile();
    for (let i = 0; i <= unrelatedSessions; i++) {
      const frames: SnapshotFrame[] = [];
      const query = frameCollector(model, frames);
      queries.push(query);
      const initial = query.handle({ type: "runtime_subscribe", scope: { ...scope, sessionId: `owner-${i}` } }) as WorkSnapshot;
      assert.equal(initial.status, "ready");
      listeners.push({ frames, initial });
      if (i) {
        const subagent = frameCollector(model, []);
        queries.push(subagent);
        subagent.handle({ type: "runtime_subscribe", scope: { cwd: root, sessionId: `owner-${i}` } });
      }
    }
    const inbox = (model as any).background.inbox;
    const receive = t.mock.method(inbox, "receive");
    store.registerOperation({ operationId: "one", taskId: "bgs_00000000000000000001", launchToken: "one", owner,
      observer: { kind: "local-supervisor", version: "1" } });
    await model.reconcile(false);
    const calls = receive.mock.callCount();
    const unrelated = listeners.slice(1).reduce((sum, entry) => sum + entry.frames.length, 0);
    t.diagnostic(`Background inbox reads: ${calls}, notifications to unrelated sessions: ${unrelated}`);
    assert.equal(calls, 1, "all subscribers share the completed reconciliation");
    assert.equal(unrelated, 0);
    const changed = listeners[0]!.frames;
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.snapshot.rows[0]!.meta.operationId, "one");
    assert.equal(changed[0]!.previousSeq, listeners[0]!.initial.seq);

    const diagnostics = t.mock.getter(inbox, "metrics");
    queries[0]!.handle({ type: "runtime_get_snapshot", scope });
    assert.equal(diagnostics.mock.callCount(), 0, "ordinary reads do not collect queue diagnostics");

    const background = (model as any).background;
    // Warm the independent legacy inventory, then count its next maintenance pass separately.
    background.refresh();
    const beforePoll = background.registryMetrics.indexRevisionChecks;
    background.refresh();
    const pollChecks = background.registryMetrics.indexRevisionChecks - beforePoll;
    assert.equal(pollChecks, 2 + (hasLegacyTasks ? 2 * unrelatedSessions : 0));
    const recent = t.mock.method(background, "refreshRecent");
    const legacy = t.mock.method(background, "observeOrigin");
    const signatures = t.mock.method(background, "scopeSignature");
    const snapshots = t.mock.method(model, "snapshot");
    store.recordTerminalOutcome({ operationId: "one", eventId: "terminal", owner, outcome: "succeeded",
      evidence: [{ kind: "terminal-record", ref: "one" }] });
    while (!background.changeMetrics.operationRepairComplete) background.refresh();
    const subagentScope = t.mock.method(model as any, "scopeEntry");
    const before = { ...background.metrics };
    const initialStampChecks = background.registryMetrics.indexRevisionChecks;
    model.prepareBackgroundQuery();
    const work = { recent: recent.mock.callCount(), legacy: legacy.mock.callCount(),
      signatures: signatures.mock.callCount(), snapshots: snapshots.mock.callCount() };
    const indexRevisionChecks = background.registryMetrics.indexRevisionChecks - initialStampChecks;
    t.diagnostic(JSON.stringify({ unrelatedSessions, hasLegacyTasks, terminalPublication: work, indexRevisionChecks, pollChecks }));
    assert.equal(background.metrics.inputStats - before.inputStats, 8, "only the completed task's runner paths");
    assert.equal(background.metrics.exactOperationQueries - before.exactOperationQueries, 1);
    assert.equal(background.metrics.repairEntries, before.repairEntries);
    assert.equal(subagentScope.mock.callCount(), 0, "Background publication skips every Subagent scope cache");
    for (let pass = 0; pass < 4; pass++) await model.reconcile(false);
    assert.equal(background.metrics.exactOperationQueries - before.exactOperationQueries, 1, "clean reconciliation does not restart cold repair");
    assert.equal(background.metrics.repairEntries, before.repairEntries);
    assert.equal(indexRevisionChecks, 0, "a coordinator publication does not poll legacy origin directories");
    assert.deepEqual(work, { recent: 1, legacy: 0, signatures: 1, snapshots: 1 });
    assert.equal(listeners.slice(1).flatMap(listener => listener.frames).length, 0);
    const current = queries[0]!.handle({ type: "runtime_get_snapshot", scope }) as WorkSnapshot;
    assert.equal(current.rows[0]!.meta.terminalOutcome, "succeeded", "an explicit read sees a new commit before the timer runs");
    assert.equal(changed.length, 2);
    assert.equal(changed[1]!.previousSeq, changed[0]!.snapshot.seq);

    store.registerOperation({ operationId: "two", taskId: "bgs_00000000000000000002", launchToken: "two",
      owner: { ...owner, sessionId: "owner-1" }, observer: { kind: "local-supervisor", version: "1" } });
    await model.reconcile(false);
    const secondOwner = listeners[1]!;
    assert.equal(secondOwner.frames.length, 1);
    assert.ok(secondOwner.frames[0]!.snapshot.rows.some(row => row.meta.operationId === "two"));
    assert.equal(secondOwner.frames[0]!.previousSeq, secondOwner.initial.seq, "skipped updates cannot create a sequence gap");
  } finally {
    queries.forEach(query => query.close());
    legacyTasks.forEach(task => legacyRegistry.removeMeta(task));
    await model.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("the maintenance timer discovers new legacy origins and in-place edits without a coordinator write", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "background-legacy-poll-"));
  const model = new WorkReadModel(root, "legacy", { baseDir: join(root, "raw"), durableDir: join(root, "archive"),
    supervisorDirectory: join(root, "supervisor"), intervalMs: 1000 });
  const scope = { background: true, cwd: root, sessionId: "legacy-owner" };
  const seeded = legacyTask(root, "other-owner");
  const task = legacyTask(root, scope.sessionId);
  const frames: SnapshotFrame[] = [];
  const socket = Object.assign(new EventEmitter(), { writableLength: 0, write(line: string) { frames.push(JSON.parse(line).event); } });
  const query = new WorkQueries(model, socket as unknown as Socket);
  const poll = async () => { t.mock.timers.tick(1000); await model.reconcile(false); };
  try {
    legacyRegistry.writeMeta(seeded);
    await model.reconcile();
    query.handle({ type: "runtime_subscribe", scope });
    await poll();
    await poll();
    assert.equal(frames.length, 0);
    legacyRegistry.writeMeta(task);
    await poll();
    assert.equal(frames.at(-1)?.snapshot.rows[0]?.meta.id, task.id);
    writeFileSync(legacyRegistry.metaPathFor(task.id), JSON.stringify({ ...task, name: "changed in place" }));
    await poll();
    assert.equal(frames.at(-1)?.snapshot.rows[0]?.meta.name, "changed in place");
    legacyRegistry.removeMeta(task);
    await poll();
    assert.deepEqual(frames.at(-1)?.snapshot.rows, []);
  } finally {
    query.close(); await model.close();
    legacyRegistry.removeMeta(task); legacyRegistry.removeMeta(seeded); rmSync(root, { recursive: true, force: true });
  }
});

test("switching back to a warm Background subscription accepts its cached lower sequence", async () => {
  const root = mkdtempSync(join(tmpdir(), "background-switch-"));
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const executor = new WorkQueryExecutor(root, "switch", { modelOptions: { baseDir: join(root, "raw"),
    durableDir: join(root, "archive"), supervisorDirectory: join(root, "supervisor"), intervalMs: 60000 } });
  const client = createLocalWorkClient(executor, root);
  const empty = { background: true, cwd: root, sessionId: "empty" };
  const owner = { kind: "parent-session", workspace: root, sessionId: "owner" };
  const scope = { ...empty, sessionId: owner.sessionId };
  try {
    await executor.livenessReasons();
    await client.subscribe(empty);
    const initial = await client.subscribe(empty);
    await client.subscribe(scope);
    store.registerOperation({ operationId: "one", taskId: "bgs_00000000000000000001", launchToken: "one", owner,
      observer: { kind: "local-supervisor", version: "1" } });
    await client.get(scope);
    assert.ok(client.snapshot!.seq > initial.seq);
    assert.equal(client.snapshot!.rows[0]!.meta.operationId, "one");
    const restored = await client.subscribe(empty);
    assert.equal(restored.seq, initial.seq, "the worker reused the unmodified session");
    assert.deepEqual(client.snapshot, restored);
    assert.deepEqual(restored.rows, []);
  } finally { client.close(); await executor.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const count of [1, 16]) {
  test(`one completion shares source checks across ${count} equivalent worker subscriptions`, async () => {
    const root = mkdtempSync(join(tmpdir(), "background-worker-publish-"));
    const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    const executor = new WorkQueryExecutor(root, "shared", { modelOptions: { baseDir: join(root, "raw"),
      durableDir: join(root, "archive"), supervisorDirectory: join(root, "supervisor"), intervalMs: 60000 } });
    const clients = Array.from({ length: count }, () => createLocalWorkClient(executor, root));
    const owner = { kind: "parent-session", workspace: root, sessionId: "owner" };
    const scope = { background: true, cwd: root, sessionId: owner.sessionId };
    try {
      store.registerOperation({ operationId: "one", taskId: taskId(1), launchToken: "one", owner, observer });
      await executor.livenessReasons();
      for (const client of clients) await client.subscribe(scope);
      const before = await clients[0]!.request("runtime_get_metrics");
      store.recordTerminalOutcome({ operationId: "one", eventId: "terminal", owner, outcome: "succeeded",
        evidence: [{ kind: "terminal-record", ref: "one" }] });
      await executor.livenessReasons();
      const after = await clients[0]!.request("runtime_get_metrics");
      for (const client of clients) assert.equal(client.snapshot?.rows[0]?.meta.terminalOutcome, "succeeded");
      assert.equal(after.eventEncoding.frames - before.eventEncoding.frames, count);
      assert.equal(after.queryCount - before.queryCount, 1, "one shared publication");
      assert.equal(after.background.registry.indexRevisionChecks, before.background.registry.indexRevisionChecks);
    } finally {
      clients.forEach(client => client.close()); await executor.close(); store.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  test(`exact worker reads with ${count} legacy and recent durable peers`, async () => {
    const root = mkdtempSync(join(tmpdir(), "background-exact-"));
    const directory = join(root, "supervisor");
    const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    const executor = new WorkQueryExecutor(root, "exact", { modelOptions: { baseDir: join(root, "raw"),
      durableDir: join(root, "archive"), supervisorDirectory: directory, intervalMs: 60000 } });
    const client = createLocalWorkClient(executor, root);
    const owner = { kind: "parent-session", workspace: root, sessionId: "owner" };
    const scope = { background: true, cwd: root, sessionId: owner.sessionId };
    const legacy = Array.from({ length: count + 1 }, () => legacyTask(root, owner.sessionId));
    try {
      mkdirSync(join(directory, "observed"), { recursive: true });
      legacy.forEach(task => legacyRegistry.writeMeta(task));
      for (let i = 0; i <= count; i++) {
        const id = taskId(i);
        store.registerOperation({ operationId: id, taskId: id, launchToken: id, owner, observer });
        store.recordTerminalOutcome({ operationId: id, eventId: id, owner, outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: id }] });
      }
      await executor.livenessReasons();
      await client.get(scope);
      const before = await client.request("runtime_get_metrics");
      const result = await client.get({ ...scope, id: taskId(0) });
      assert.deepEqual(result.rows.map(row => row.meta.terminalOutcome), ["succeeded"]);
      const task = legacy[0]!;
      writeFileSync(legacyRegistry.metaPathFor(task.id), JSON.stringify({ ...task, name: "fresh" }));
      const exact = await client.get({ ...scope, id: task.id });
      assert.deepEqual(exact.rows.map(row => row.meta.name), ["fresh"]);
      const after = await client.request("runtime_get_metrics");
      assert.equal(after.background.inputStats - before.background.inputStats, 8);
      assert.equal(after.background.registry.metadataFileReads - before.background.registry.metadataFileReads, 1);
      assert.equal(after.background.registry.indexDirectoryReads, before.background.registry.indexDirectoryReads);
      assert.equal(after.background.registry.indexRevisionChecks - before.background.registry.indexRevisionChecks, 8, "two origin pointers per scope and requested ID");
      for (const id of [taskId(0), task.id]) {
        assert.deepEqual((await client.get({ ...scope, id, sessionId: "other" })).rows, []);
        assert.deepEqual((await client.get({ ...scope, id, cwd: root + "-other" })).rows, []);
      }
      writeFileSync(join(directory, "observed", taskId(0) + ".json"), JSON.stringify({ dismissedAt: Date.now() }));
      writeFileSync(legacyRegistry.metaPathFor(task.id), JSON.stringify({ ...task, dismissedAt: Date.now() }));
      for (const id of [taskId(0), task.id]) assert.deepEqual((await client.get({ ...scope, id })).rows, []);
    } finally {
      client.close(); await executor.close(); store.close(); legacy.forEach(task => legacyRegistry.removeMeta(task));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`history shares one refresh across ${count} unrelated RPC subscriptions`, async t => {
    const root = mkdtempSync(join(tmpdir(), "background-history-publish-"));
    const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    const model = new WorkReadModel(root, "history", { baseDir: join(root, "raw"), durableDir: join(root, "archive"),
      supervisorDirectory: join(root, "supervisor"), intervalMs: 60000 });
    const owner = { kind: "parent-session", workspace: root, sessionId: "owner" };
    const scope = { background: true, backgroundHistory: true, cwd: root, sessionId: owner.sessionId };
    const queries: WorkQueries[] = [];
    const listeners: SnapshotFrame[][] = [];
    const settle = async () => {
      const deadline = Date.now() + 5000;
      while (listeners.some(frames => frames.at(-1)?.snapshot.status !== "ready")) {
        assert.ok(Date.now() < deadline, "history subscribers receive the verified index");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    try {
      store.registerOperation({ operationId: "one", taskId: taskId(1), launchToken: "one", owner, observer });
      await model.reconcile();
      for (let i = 0; i <= count; i++) {
        const frames: SnapshotFrame[] = [];
        const query = frameCollector(model, frames);
        queries.push(query);
        const initial = query.handle({ type: "runtime_subscribe", scope: { ...scope, sessionId: i ? "other-" + i : owner.sessionId } }) as WorkSnapshot;
        listeners.push(frames);
        frames.push({ snapshot: initial, previousSeq: initial.seq });
      }
      await settle();
      for (const frames of listeners) frames.length = 0;
      const refresh = t.mock.method((model as any).background, "refresh");
      const before = model.backgroundCounters.registry;
      store.recordTerminalOutcome({ operationId: "one", eventId: "terminal", owner, outcome: "succeeded",
        evidence: [{ kind: "terminal-record", ref: "one" }] });
      model.prepareBackgroundQuery();
      for (const frames of listeners) assert.equal(frames.at(-1)?.snapshot.status, "rebuilding");
      await settle();
      assert.equal(refresh.mock.callCount(), 1);
      assert.equal(model.backgroundCounters.registry.indexDirectoryReads, before.indexDirectoryReads);
      assert.equal(listeners[0]!.at(-1)?.snapshot.rows[0]?.meta.terminalOutcome, "succeeded");
      for (const frames of listeners.slice(1)) {
        const latest = frames.at(-1)!.snapshot;
        assert.deepEqual(latest.rows, []);
        assert.equal(latest.totalMatching, 0);
        assert.equal(latest.activity.active, 0);
      }
    } finally {
      queries.forEach(query => query.close()); await model.close(); store.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  test(`maintenance reads a workspace edit once with ${count} session subscriptions`, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const root = mkdtempSync(join(tmpdir(), "background-workspace-poll-"));
    const model = new WorkReadModel(root, "workspace", { baseDir: join(root, "raw"), durableDir: join(root, "archive"), intervalMs: 1000 });
    const task = { ...legacyTask(root, ""), callbackOrigin: { cwd: root } };
    const watch = (sessionId?: string) => {
      const frames: SnapshotFrame[] = [];
      const query = frameCollector(model, frames);
      query.handle({ type: "runtime_subscribe", scope: { background: true, cwd: root, sessionId, processId: process.pid } });
      return { query, frames };
    };
    const poll = async () => { t.mock.timers.tick(1000); await model.reconcile(false); };
    const listeners = [];
    try {
      legacyRegistry.writeMeta(task);
      await model.reconcile();
      listeners.push(watch());
      for (let i = 0; i < count; i++) listeners.push(watch("session-" + i));
      await poll();
      const before = model.backgroundCounters.registry;
      writeFileSync(legacyRegistry.metaPathFor(task.id), JSON.stringify({ ...task, name: "workspace edit" }));
      await poll();
      const after = model.backgroundCounters.registry;
      assert.equal(after.metadataFileReads - before.metadataFileReads, 1);
      assert.equal(after.indexDirectoryReads - before.indexDirectoryReads, 2, "one active and one recent workspace index");
      assert.equal(listeners[0]!.frames.at(-1)?.snapshot.rows[0]?.meta.name, "workspace edit");
      assert.equal(listeners.slice(1).flatMap(listener => listener.frames).length, 0);
    } finally {
      listeners.forEach(listener => listener.query.close()); await model.close(); legacyRegistry.removeMeta(task);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
