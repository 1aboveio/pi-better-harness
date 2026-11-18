import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundObservation } from "../src/runtime/background.ts";
import { WorkReadModel } from "../src/runtime/read-model.ts";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

test("Background constructor attaches its inbox and repair state to the query owner's handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "background-connection-"));
  const model = new WorkReadModel(root, "shared-inboxes", { baseDir: join(root, "runs"), durableDir: join(root, "archive"), intervalMs: 60000 });
  try {
    const derived = (model as any).db;
    assert.equal(model.metrics.checkpoints.acquisitionAttempts, 0, "construction must not acquire deferred checkpoints");
    await model.reconcile();
    assert.equal((model as any).db, derived, "initialization retains the same query owner");
    const inbox = (model as any).background.inbox;
    assert.equal(inbox.db, derived);
    assert.equal(inbox.prefix, "background_inbox.");
    assert.deepEqual(new Set(derived.prepare("PRAGMA database_list").all().map((row: any) => row.name)),
      new Set(["main", "log_checkpoints", "assignment_inbox", "background_inbox"]));
    assert.ok(derived.prepare("SELECT name FROM log_checkpoints.sqlite_master WHERE name='checkpoints'").get());
    assert.ok(derived.prepare("SELECT name FROM background_inbox.sqlite_master WHERE name='background_file_repair'").get());
    assert.equal(derived.prepare("SELECT name FROM main.sqlite_master WHERE name='background_file_repair'").get(), undefined);
    assert.equal(derived.prepare("SELECT name FROM assignment_inbox.sqlite_master WHERE name='background_file_repair'").get(), undefined);
    assert.equal(derived.prepare("SELECT name FROM log_checkpoints.sqlite_master WHERE name='background_file_repair'").get(), undefined);
    assert.equal(model.metrics.indexConnections, 1);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("one Background task input changes only its projection and dependent wait query", async () => {
  const root = mkdtempSync(join(tmpdir(), "background-inputs-"));
  const directory = join(root, "supervisor");
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const observation = new BackgroundObservation(root, directory);
  const owner = { kind: "parent-session" as const, workspace: root, sessionId: "parent" };
  const scope = { background: true, cwd: root, sessionId: "parent" };
  const ids = Array.from({ length: 96 }, (_, i) => `bgs_${i.toString(16).padStart(20, "0")}`);
  mkdirSync(join(directory, "observed"), { recursive: true });
  try {
    for (const taskId of ids) {
      store.registerOperation({ operationId: taskId, taskId, launchToken: taskId, owner,
        observer: { kind: "local-supervisor", version: "1" } });
      store.recordTerminalOutcome({ operationId: taskId, eventId: taskId, owner, outcome: "succeeded",
        evidence: [{ kind: "terminal-record", ref: taskId }] });
    }
    assert.equal(observation.read(scope).length, 96);
    const before = { ...observation.metrics };
    store.registerOperation({ operationId: "unrelated", taskId: "unrelated", launchToken: "unrelated", owner,
      observer: { kind: "other", version: "1" } });
    observation.refresh();
    assert.equal(observation.metrics.runnerSnapshots, before.runnerSnapshots);
    assert.equal(observation.metrics.dependencyQueries, before.dependencyQueries);
    assert.ok(observation.metrics.inputStats > before.inputStats, "bounded file repair work remains explicitly counted");

    const path = join(directory, "observed", `${ids[0]}.json`);
    writeFileSync(path + ".tmp", JSON.stringify({ name: "changed" }));
    renameSync(path + ".tmp", path);
    for (let page = 0; page < 4; page++) observation.refresh();
    assert.equal(observation.metrics.runnerSnapshots, before.runnerSnapshots + 1);
    assert.equal(observation.read(scope).find(row => row.id === ids[0]).name, "changed");
    const dependencies = observation.metrics.dependencyQueries;
    const { wait } = store.registerWait({ waitId: "exact-wait", owner, dependencies: [{ operationId: ids[0]! }], continuationNote: "Read result" });
    observation.refresh();
    assert.equal(observation.metrics.runnerSnapshots, before.runnerSnapshots + 2);
    assert.equal(observation.metrics.dependencyQueries, dependencies + 1);
    assert.equal(observation.read(scope).find(row => row.id === ids[0]).waits[0].waitId, "exact-wait");
    const beforeCancel = { ...observation.metrics };
    store.cancelWait({ waitId: "exact-wait", generation: wait.generation, expectedCancelEpoch: 0, owner, reason: "no continuation needed" });
    observation.refresh();
    assert.equal(observation.read(scope).find(row => row.id === ids[0]).waits.length, 0);
    assert.equal(observation.metrics.dependencyQueries, beforeCancel.dependencyQueries + 1);
    assert.equal(observation.metrics.runnerSnapshots, beforeCancel.runnerSnapshots + 1);

    writeFileSync(path, "{");
    for (let page = 0; page < 4 && observation.status !== "degraded"; page++) observation.refresh();
    assert.equal(observation.status, "degraded");
    assert.equal(observation.read(scope).find(row => row.id === ids[0]).name, "changed");
    writeFileSync(path, JSON.stringify({ name: "recovered" }));
    for (let page = 0; page < 4; page++) observation.refresh();
    assert.equal(observation.status, "ready");
    assert.equal(observation.read(scope).find(row => row.id === ids[0]).name, "recovered");
  } finally { await observation.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("unchanged Background repair positions do not write the shared derived handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "background-idle-writes-"));
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const model = new WorkReadModel(root, "idle-repair", { baseDir: root, durableDir: join(root, "archive"), intervalMs: 60000 });
  const observation = (model as any).background;
  try {
    observation.read({ background: true, cwd: root, sessionId: "parent" });
    observation.refresh();
    const db = (model as any).db;
    db.exec("CREATE TEMP TRIGGER reject_idle_repair BEFORE INSERT ON background_inbox.background_file_repair BEGIN SELECT RAISE(ABORT,'unchanged repair attempted a write'); END");
    const before = db.prepare("SELECT total_changes() AS n").get().n;
    for (let i = 0; i < 3; i++) assert.equal(observation.refresh(), false);
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
  } finally { await model.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recent Background terminals expire through deadline work without a caller refresh", async t => {
  const root = mkdtempSync(join(tmpdir(), "background-expiry-"));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 200000 });
  const store = openStore({ path: join(root, "operation-coordinator.sqlite"), now: () => Date.now() });
  const observation = new BackgroundObservation(root, join(root, "supervisor"));
  const owner = { kind: "parent-session" as const, workspace: root, sessionId: "parent" };
  const scope = { background: true, cwd: root, sessionId: "parent" };
  try {
    store.registerOperation({ operationId: "expiry", taskId: "bgs_00000000000000000001", launchToken: "expiry", owner,
      observer: { kind: "local-supervisor", version: "1" } });
    store.recordTerminalOutcome({ operationId: "expiry", eventId: "expiry", owner, outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: "expiry" }] });
    store.setParentCallbackPending("bgs_00000000000000000001", false);
    assert.equal(observation.read(scope).length, 1);
    observation.refresh();
    t.mock.timers.tick(30001);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(observation.read(scope).length, 0);
  } finally { await observation.close(); store.close(); t.mock.timers.reset(); rmSync(root, { recursive: true, force: true }); }
});
