import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { WorkReadModel, type WorkSnapshot } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";

const sessionStorePath = new URL("../../pi-better-subagents/session-store.ts", import.meta.url).href;
const { archiveCompletedAttempt, readArchivedAttempt } = await import(sessionStorePath);

test("a redundant terminal publication during verification preserves the first verified exact assignment", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-window-"));
  const saved = process.env.PI_SUBAGENT_DURABLE_DIR;
  const durable = join(root, "durable");
  process.env.PI_SUBAGENT_DURABLE_DIR = durable;
  const agent = join(root, "agent");
  mkdirSync(agent);
  const coordinatorPath = new URL("../../pi-better-subagents/shared-operation-coordinator/index.ts", import.meta.url).href;
  const { openStore } = await import(coordinatorPath);
  openStore({ path: join(agent, "operation-coordinator.sqlite") }).close();
  const meta = { id: "sa_reviewer", cwd: root, sessionId: "reviewer", status: "completed" as const,
    startedAt: 1, endedAt: 2, model: "review-model", recipe: { version: 1 as const,
      sessionId: "reviewer", sessionDir: join(durable, "sessions"), cwd: root } };
  archiveCompletedAttempt(meta as never);
  const model = new WorkReadModel(agent, "archive-window", { baseDir: root, durableDir: durable, intervalMs: 60000 });
  // Notifications are not the proof: force the actual writer between inventory
  // and the unchanged source-signature guard, without a scheduling sleep.
  (model as any).watchers.forEach((watcher: any) => watcher.close());
  const reader = (model as any).reader;
  const revision = reader.revision.bind(reader);
  let calls = 0;
  let publication = meta;
  reader.revision = () => {
    if (++calls === 2) archiveCompletedAttempt(publication as never);
    return revision();
  };
  const socket = new Socket();
  const queries = new WorkQueries(model, socket);
  const observations: WorkSnapshot[] = [];
  const off = model.onChange(() => observations.push(queries.handle({ type: "runtime_get_scope", scope: { id: meta.id } }) as WorkSnapshot));
  try {
    await model.reconcile();
    assert.ok(calls >= 2, "the real publication must run within source verification");
    assert.ok(observations.length > 0);
    assert.deepEqual(observations.map(snapshot => snapshot.status), ["ready"], "no transient unverified first assignment may be published for unchanged terminal metadata");
    assert.equal(observations[0]!.rows[0]!.meta.id, meta.id);
    assert.equal(observations[0]!.rows[0]!.meta.model, "review-model");
    assert.equal(observations[0]!.rows[0]!.assignment.state, "completed");
    assert.equal(observations[0]!.rows[0]!.assignment.verified, true);
    assert.equal(observations[0]!.seq, 1);
    // A necessary finalization write in that SAME window must still fail closed,
    // retain the verified row, and recover only after a new verified inventory.
    archiveCompletedAttempt({ ...meta, endedAt: 3 } as never);
    publication = { ...meta, endedAt: 4 };
    calls = 0;
    observations.length = 0;
    await model.reconcile();
    assert.equal(observations[0]!.status, "degraded");
    assert.match(observations[0]!.reason!, /Source changed during observation/);
    assert.equal(observations[0]!.rows[0]!.meta.endedAt, 2);
    assert.equal(observations.at(-1)!.status, "ready");
    assert.equal(observations.at(-1)!.rows[0]!.meta.endedAt, 4);
    assert.ok(observations.at(-1)!.seq > observations[0]!.seq);
  } finally {
    off(); queries.close(); socket.destroy(); await model.close();
    if (saved === undefined) delete process.env.PI_SUBAGENT_DURABLE_DIR; else process.env.PI_SUBAGENT_DURABLE_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal publication still updates finalization and repairs corrupt or missing archives", () => {
  const root = mkdtempSync(join(tmpdir(), "archive-repair-"));
  const saved = process.env.PI_SUBAGENT_DURABLE_DIR;
  process.env.PI_SUBAGENT_DURABLE_DIR = root;
  const meta = { id: "sa_final", cwd: root, sessionId: "final", status: "completed" as const, startedAt: 1,
    recipe: { version: 1 as const, sessionId: "final", sessionDir: join(root, "sessions"), cwd: root } };
  const path = join(root, "attempts", `${meta.id}.json`);
  try {
    archiveCompletedAttempt(meta as never);
    const finalized = { ...meta, endedAt: 2, exitCode: 0, dismissedAt: 3 };
    archiveCompletedAttempt(finalized as never);
    assert.equal(readArchivedAttempt(meta.id)!.endedAt, 2);
    assert.equal(readArchivedAttempt(meta.id)!.dismissedAt, 3);
    // Object key order is not a new publication or a new source revision.
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ meta: record.meta, version: record.version }));
    const signature = () => {
      const info = statSync(path, { bigint: true });
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs];
    };
    const before = signature();
    archiveCompletedAttempt(finalized as never);
    assert.deepEqual(signature(), before);
    const marker = join(root, "session-state", "final.json");
    mkdirSync(join(root, "session-state"));
    writeFileSync(marker, JSON.stringify({ version: 1, sessionId: "final", attemptId: "sa_older", status: "failed", startedAt: 0 }));
    assert.equal(archiveCompletedAttempt(finalized as never), true, "verified publication must still recover a superseded failure marker");
    assert.equal(existsSync(marker), false);
    assert.equal(readArchivedAttempt(meta.id)!.id, meta.id);
    assert.deepEqual(signature(), before, "failure-marker recovery does not require archive replacement");
    for (const damage of ["not json", JSON.stringify({ ...record, version: 99 }), undefined]) {
      if (damage === undefined) unlinkSync(path); else writeFileSync(path, damage);
      assert.equal(readArchivedAttempt(meta.id), undefined);
      assert.equal(archiveCompletedAttempt(finalized as never), true);
      assert.equal(readArchivedAttempt(meta.id)!.endedAt, 2);
      assert.equal(readArchivedAttempt(meta.id)!.dismissedAt, 3);
    }
  } finally {
    if (saved === undefined) delete process.env.PI_SUBAGENT_DURABLE_DIR; else process.env.PI_SUBAGENT_DURABLE_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
