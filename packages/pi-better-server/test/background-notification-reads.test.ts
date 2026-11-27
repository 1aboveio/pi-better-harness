import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalWorkClient } from "../src/runtime/local-client.ts";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { WorkReadModel, type WorkSnapshot } from "../src/runtime/read-model.ts";

const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

type SnapshotFrame = { snapshot: WorkSnapshot; previousSeq: number };

for (const unrelatedSessions of [1, 16]) test(`publishing one Background change with ${unrelatedSessions} unrelated sessions`, async t => {
  const root = mkdtempSync(join(tmpdir(), "background-notifications-"));
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const model = new WorkReadModel(root, "notifications", { baseDir: join(root, "raw"), durableDir: join(root, "archive"),
    supervisorDirectory: join(root, "supervisor"), intervalMs: 60_000 });
  const queries: WorkQueries[] = [];
  const listeners: Array<{ frames: SnapshotFrame[]; initial: WorkSnapshot }> = [];
  const owner = { kind: "parent-session", workspace: root, sessionId: "owner-0" };
  const scope = { background: true, cwd: root, sessionId: owner.sessionId };
  try {
    await model.reconcile();
    for (let i = 0; i <= unrelatedSessions; i++) {
      const frames: SnapshotFrame[] = [];
      const socket = Object.assign(new EventEmitter(), { writableLength: 0, write(line: string) { frames.push(JSON.parse(line).event); } });
      const query = new WorkQueries(model, socket as unknown as Socket);
      queries.push(query);
      const initial = query.handle({ type: "runtime_subscribe", scope: { ...scope, sessionId: `owner-${i}` } }) as WorkSnapshot;
      assert.equal(initial.status, "ready");
      listeners.push({ frames, initial });
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
    const recent = t.mock.method(background, "refreshRecent");
    const legacy = t.mock.method(background, "visibleLegacy");
    const signatures = t.mock.method(background, "scopeSignature");
    const snapshots = t.mock.method(model, "snapshot");
    store.recordTerminalOutcome({ operationId: "one", eventId: "terminal", owner, outcome: "succeeded",
      evidence: [{ kind: "terminal-record", ref: "one" }] });
    const initialStampChecks = background.registryMetrics.indexRevisionChecks;
    model.prepareBackgroundQuery();
    const work = { recent: recent.mock.callCount(), legacy: legacy.mock.callCount(),
      signatures: signatures.mock.callCount(), snapshots: snapshots.mock.callCount() };
    t.diagnostic(JSON.stringify({ unrelatedSessions, terminalPublication: work,
      indexRevisionChecks: background.registryMetrics.indexRevisionChecks - initialStampChecks }));
    assert.deepEqual(work, { recent: 2, legacy: 1, signatures: 1, snapshots: 1 });
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
    assert.equal(secondOwner.frames[0]!.snapshot.rows[0]!.meta.operationId, "two");
    assert.equal(secondOwner.frames[0]!.previousSeq, secondOwner.initial.seq, "skipped updates cannot create a sequence gap");
  } finally {
    queries.forEach(query => query.close());
    await model.close(); store.close(); rmSync(root, { recursive: true, force: true });
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
