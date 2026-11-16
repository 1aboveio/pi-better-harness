import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";

test("A staged source race degrades A but preserves verified B frames and cursor", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-source-race-"));
  const write = (id: string, cwd: string, name: string) => {
    mkdirSync(join(root, "runs", id), { recursive: true });
    writeFileSync(join(root, "runs", id, "meta.json"), JSON.stringify({ id, cwd, name, status: "completed", startedAt: 1 }));
  };
  const a = join(root, "a"), b = join(root, "b");
  write("sa_a", a, "old"); write("sa_b1", b, "b1"); write("sa_b2", b, "b2");
  const model = new WorkReadModel(root, "scope-race", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    for (const watcher of (model as any).watchers.values()) watcher.close();
    for (const entry of (model as any).rootParents.values()) entry.watcher.close();
    const scope = { cwd: b, limit: 1 }, first = model.snapshot(scope);
    let bFrames = 0;
    const aFrames: any[] = [];
    model.onChange(() => bFrames++, scope);
    model.onChange(() => aFrames.push(model.snapshot({ cwd: a })), { cwd: a });
    write("sa_a", a, "staged");
    const reader = (model as any).reader, revision = reader.revision.bind(reader);
    reader.revision = () => { write("sa_a", a, "committed-during-verification"); reader.revision = revision; return revision(); };
    await (model as any).scan([join(root, "runs/sa_a/meta.json")]);
    assert.equal(model.observation().status, "degraded", "aggregate observation retains the failure");
    assert.match(aFrames[0]?.reason, /Source changed during observation/);
    assert.equal(aFrames[0]?.rows[0].meta.name, "old", "unpublished staging is not visible");
    assert.equal(bFrames, 0, "unrelated content sends no scoped frames");
    assert.equal(model.snapshot(scope).status, "ready");
    assert.equal(model.snapshot(scope).scopeRevision, first.scopeRevision);
    assert.equal(model.snapshot({ ...scope, cursor: first.nextCursor }).rows.length, 1);
    await model.reconcile();
    assert.equal(model.snapshot({ cwd: a }).status, "ready");
    assert.equal(model.snapshot({ cwd: a }).rows[0]!.meta.name, "committed-during-verification");
    assert.equal(bFrames, 0);
    assert.equal(model.snapshot({ ...scope, cursor: first.nextCursor }).rows.length, 1);
    write("sa_a", a, "staged-move");
    reader.revision = () => { write("sa_a", b, "moved-into-B-during-verification"); reader.revision = revision; return revision(); };
    await (model as any).scan([join(root, "runs/sa_a/meta.json")]);
    assert.equal(model.snapshot(scope).status, "degraded", "concurrent destination membership affects B");
    assert.ok(bFrames > 0);
    await model.reconcile();
    model.invalidate("Source root unavailable");
    assert.equal(model.snapshot(scope).status, "degraded", "unknown root failures still affect B");
    assert.ok(bFrames > 0);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("A health deadlines advance without invalidating B subscription or cursor", async t => {
  const root = mkdtempSync(join(tmpdir(), "scope-deadlines-"));
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const a = join(root, "a"), b = join(root, "b");
  writeFileSync(join(root, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { healthQuietMs: 1000, healthStaleMs: 5000 } } }));
  for (const [id, cwd, status] of [["sa_a", a, "running"], ["sa_b1", b, "completed"], ["sa_b2", b, "completed"]]) {
    const dir = join(root, "runs", id!); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, cwd, status, pid: process.pid, spawnPid: process.pid, startedAt: 1000 }));
    writeFileSync(join(dir, "output.log"), "{}\n");
  }
  const model = new WorkReadModel(root, "deadline-scopes", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    const scope = { cwd: b, limit: 1 }, page = model.snapshot(scope), before = model.metrics;
    let changes = 0;
    model.onChange(() => changes++, scope);
    assert.equal(model.snapshot({ cwd: a }).nextDeadline, 2000);
    for (const [time, expected] of [[2000, 6000], [6000, null]] as const) {
      now = time; await model.reconcile();
      assert.equal(model.snapshot({ cwd: a }).nextDeadline, expected);
      assert.equal(changes, 0);
      assert.equal(model.snapshot(scope).scopeRevision, page.scopeRevision);
      assert.equal(model.snapshot({ ...scope, cursor: page.nextCursor }).rows.length, 1);
    }
    assert.equal(model.metrics.logProjections, before.logProjections);
    assert.equal(model.metrics.assignmentProjections, before.assignmentProjections);
    assert.equal(model.metrics.healthRecomputations - before.healthRecomputations, 2);
  } finally { await model.close(); t.mock.restoreAll(); rmSync(root, { recursive: true, force: true }); }
});

test("content revisions route old and new scopes while unrelated cursors survive", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-revisions-"));
  const a = join(root, "a"), b = join(root, "b"), c = join(root, "c");
  const write = (id: string, cwd: string, name = id, status = "completed") => {
    mkdirSync(join(root, "runs", id), { recursive: true });
    writeFileSync(join(root, "runs", id, "meta.json"), JSON.stringify({ id, cwd, name, status,
      callbackOrigin: { cwd, sessionId: "parent" }, startedAt: 1 }));
  };
  write("sa_a", a); write("sa_b1", b); write("sa_b2", b); write("sa_c", c);
  const model = new WorkReadModel(root, "scope-revisions", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  const changes = { a: 0, b: 0, c: 0 };
  try {
    await model.reconcile();
    for (const [key, cwd] of Object.entries({ a, b, c })) model.onChange(() => changes[key as keyof typeof changes]++, { cwd });
    const scope = { cwd: b, limit: 1 }, first = model.snapshot(scope);
    const unchanged = () => {
      assert.equal(changes.b, 0);
      assert.equal(model.snapshot(scope).scopeRevision, first.scopeRevision);
      assert.equal(model.snapshot({ ...scope, cursor: first.nextCursor }).rows.length, 1);
    };
    appendFileSync(join(root, "runs/sa_a/output.log"), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "progress" }] } }) + "\n");
    await model.reconcile(); unchanged();
    write("sa_a", c, "moved"); await model.reconcile(); unchanged();
    assert.ok(changes.a > 0); assert.ok(changes.c > 0);
    write("sa_a", c, "terminal", "failed"); await model.reconcile(); unchanged();
    rmSync(join(root, "runs/sa_a"), { recursive: true }); await model.reconcile(); unchanged();
    assert.throws(() => model.snapshot({ ...scope, sessionId: "other", cursor: first.nextCursor }), /resync_required/);
    write("sa_b1", b, "changed"); await model.reconcile();
    assert.ok(changes.b > 0);
    assert.throws(() => model.snapshot({ ...scope, cursor: first.nextCursor }), /resync_required/);
    const fresh = model.snapshot(scope);
    assert.equal(model.snapshot({ ...scope, cursor: fresh.nextCursor }).rows.length, 1);
    const entries = (model as any).scopes as Map<string, { used: number }>;
    for (const entry of entries.values()) entry.used = Date.now() - 300000;
    assert.throws(() => model.snapshot({ ...scope, cursor: fresh.nextCursor }), /retention expired/);
    assert.equal(model.snapshot(scope).rows.length, 1, "an expired page can restart from a fresh bounded page");
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("activity stays within workspace, origin session and exact run scopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-scopes-"));
  const workspace = join(root, "project");
  const runs = join(root, "runs");
  const records = [
    { id: "sa_own", cwd: workspace, sessionId: "parent", status: "running" },
    { id: "sa_child", cwd: join(workspace, "nested"), sessionId: "parent", status: "running" },
    { id: "sa_other_session", cwd: workspace, sessionId: "other", status: "running" },
    { id: "sa_other_workspace", cwd: workspace + "-other", sessionId: "parent", status: "running" },
    { id: "sa_done", cwd: workspace, sessionId: "parent", status: "completed" },
  ];
  for (const record of records) {
    mkdirSync(join(runs, record.id), { recursive: true });
    writeFileSync(join(runs, record.id, "meta.json"), JSON.stringify({ ...record,
      sessionId: `worker-${record.id}`, callbackOrigin: { cwd: record.cwd, sessionId: record.sessionId },
      pid: process.pid, spawnPid: process.pid, startedAt: 1 }));
  }
  const model = new WorkReadModel(root, "scope-instance", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    assert.equal(model.snapshot().activity.active, 4);
    assert.equal(model.snapshot({ cwd: workspace, limit: 1 }).activity.active, 3);
    assert.equal(model.snapshot({ cwd: workspace, sessionId: "parent" }).activity.active, 1);
    const history = model.snapshot({ cwd: workspace, sessionId: "parent", active: false });
    assert.equal(history.rows.length, 1);
    assert.equal(history.activity.active, 1, "history filters cannot hide the scope's live activity");
    assert.equal(model.snapshot({ cwd: workspace, sessionId: "missing" }).activity.active, 0);
    assert.equal(model.snapshot({ id: "sa_own" }).activity.active, 1);
    assert.equal(model.snapshot({ id: "sa_done" }).activity.active, 0);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failing detail subscriber requests resync without failing shared publication", () => {
  const callbacks = new Set<() => void>();
  let failDetail = false;
  const model = {
    instanceId: "subscription-instance",
    snapshot(scope: { detail?: boolean }) {
      if (failDetail && scope.detail) throw new Error("state-degraded: log changed during observation");
      return { instanceId: "subscription-instance", seq: 1, rows: [] };
    },
    onChange(callback: () => void) { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
  } as unknown as WorkReadModel;
  const socket = () => {
    const stream = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
      writes: [] as string[], write(line: string) { this.writes.push(line); return true; } });
    return stream;
  };
  const detailSocket = socket(), listSocket = socket();
  const detail = new WorkQueries(model, detailSocket as unknown as Socket);
  const list = new WorkQueries(model, listSocket as unknown as Socket);
  try {
    detail.handle({ type: "runtime_subscribe", scope: { id: "sa_detail", detail: true } });
    list.handle({ type: "runtime_subscribe", scope: {} });
    failDetail = true;
    assert.doesNotThrow(() => { for (const callback of callbacks) callback(); });
    assert.equal(callbacks.size, 1, "only the failed subscription is detached");
    const failure = JSON.parse(detailSocket.writes[0]!).event;
    assert.equal(failure.type, "resync_required");
    assert.match(failure.reason, /log changed/);
    assert.equal(JSON.parse(listSocket.writes[0]!).event.type, "runtime_snapshot");
    failDetail = false;
    detail.handle({ type: "runtime_subscribe", scope: { id: "sa_detail", detail: true } });
    assert.equal(callbacks.size, 2, "the detail reader can subscribe again after resync");
  } finally { detail.close(); list.close(); }
});
