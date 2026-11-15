import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";

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
