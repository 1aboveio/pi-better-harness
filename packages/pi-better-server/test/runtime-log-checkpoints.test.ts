import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { LogCheckpoints, LOG_CHECKPOINT_ENTRY_BUDGET, LOG_CHECKPOINT_BUDGET } from "../src/runtime/log-checkpoints.ts";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { openDatabase, createContext } from "../../operation-coordinator/src/sqlite.ts";
import { ensureSchema } from "../../operation-coordinator/src/schema.ts";

const fixturePath = "../../pi-better-subagents/tests/work-runtime-fixture.mjs";
const { startWorkRuntimeFixture } = await import(fixturePath);
const event = (value: any) => JSON.stringify(value) + "\n";
const usage = event({ type: "message_end", message: { role: "assistant", usage: { input: 3, output: 2, cost: { total: 0.01 } } } });
const tool = event({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash", at: 100 });
const padding = event({ type: "message_update", message: { role: "assistant", content: "x".repeat(67000) } });

test("checkpoint readers open under another derived owner's reservation without hiding write contention", () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-lock-"));
  const path = join(root, "checkpoints.sqlite");
  const firstOwner = new DatabaseSync(":memory:"), secondOwner = new DatabaseSync(":memory:");
  const first = new LogCheckpoints(path, firstOwner);
  let second: LogCheckpoints | undefined;
  try {
    first.save("log", { offset: 10, usage: 1 });
    firstOwner.exec("BEGIN IMMEDIATE");
    assert.doesNotThrow(() => { second = new LogCheckpoints(path, secondOwner); });
    assert.deepEqual(second!.load("log"), { offset: 10, usage: 1 });
    assert.throws(() => second!.save("log", { offset: 20, usage: 2 }), /database is locked/);
    firstOwner.exec("ROLLBACK");
    second!.save("log", { offset: 20, usage: 2 });
    assert.deepEqual(first.load("log"), { offset: 20, usage: 2 });
    second!.close(); second = undefined;
    firstOwner.exec("DROP TABLE log_checkpoints.checkpoints; BEGIN IMMEDIATE");
    assert.throws(() => new LogCheckpoints(path, secondOwner), /database is locked/,
      "missing schema still requires initialization and cannot be treated as available under a writer");
  } finally {
    if (firstOwner.isTransaction) firstOwner.exec("ROLLBACK");
    second?.close(); first.close(); secondOwner.close(); firstOwner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual checkpoint read models open under a derived reservation and refresh under a coordinator WAL writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-lock-"));
  const source = openDatabase(join(root, "operation-coordinator.sqlite"), { busyTimeoutMs: 0 });
  ensureSchema(createContext(source));
  const options = { baseDir: join(root, "runs"), durableDir: join(root, "archive"), intervalMs: 60000 };
  const first = new WorkReadModel(root, "sql-first", options);
  let second: WorkReadModel | undefined;
  let writerHeld = false;
  try {
    (first as any).db.exec("BEGIN IMMEDIATE");
    assert.doesNotThrow(() => { second = new WorkReadModel(root, "sql-second", options); });
    (first as any).db.exec("ROLLBACK");
    await first.reconcile(); await second!.reconcile();
    source.exec("BEGIN IMMEDIATE"); writerHeld = true;
    source.exec("INSERT INTO coordinator_state VALUES('held-writer','uncommitted')");
    await first.reconcile(); await second!.reconcile();
    for (const model of [first, second!]) {
      const snapshot = model.snapshot({ background: true, cwd: root, sessionId: "sql-parent" });
      assert.equal(snapshot.status, "ready", snapshot.reason);
      assert.equal(model.metrics.indexConnections, 1);
    }
    source.exec("ROLLBACK"); writerHeld = false;
  } finally {
    if ((first as any).db.isTransaction) (first as any).db.exec("ROLLBACK");
    if (writerHeld) source.exec("ROLLBACK");
    await second?.close(); await first.close(); source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archiving a checkpointed raw run preserves a ready terminal observation", async () => {
  const parent = resolve("../../.work/801"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "archive-checkpoint-"));
  const id = "sa_archived_checkpoint", directory = join(root, "runs", id);
  const meta = { id, cwd: root, sessionId: "worker", status: "completed", startedAt: 1, endedAt: 2,
    recipe: { version: 1, sessionId: "worker", sessionDir: join(root, "durable", "sessions"), cwd: root } };
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(directory, "output.log"), usage + tool);
  const model = new WorkReadModel(root, "archive-checkpoint", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    assert.equal(model.snapshot().status, "ready");
    assert.equal((model.snapshot().rows[0] as any).health.facts.activeTools.length, 1);
    mkdirSync(join(root, "durable", "attempts"), { recursive: true });
    writeFileSync(join(root, "durable", "attempts", `${id}.json`), JSON.stringify({ version: 1, meta }));
    rmSync(directory, { recursive: true });
    await model.reconcile();
    const archived = model.snapshot();
    assert.equal(archived.status, "ready", archived.reason);
    assert.equal(archived.rows[0]?.meta.id, id);
    assert.equal(archived.rows[0]?.meta.status, "completed");
    assert.equal((archived.rows[0] as any).health, undefined, "archive-only rows have no raw-log health facts");
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const count of [48, 96, 144]) test(`${count} tasks recover socket summaries after eviction and restart`, { timeout: 30000 }, async t => {
  const parent = resolve("../../.work/801"); mkdirSync(parent, { recursive: true });
  const root = realpathSync(mkdtempSync(join(parent, "recovery-"))), agent = join(root, "agent"), runs = join(root, "pi-better-subagents/runs");
  mkdirSync(agent); mkdirSync(runs, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `sa_checkpoint_${i}`; mkdirSync(join(runs, id));
    writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, cwd: root, sessionId: "child", status: "running", pid: process.pid,
      startedAt: i, callback: false, callbackOrigin: { cwd: root, sessionId: "parent" } }));
    writeFileSync(join(runs, id, "output.log"), usage + tool + padding.repeat(count === 48 && i === 0 ? 40 : 1));
  }
  const daemon = await startWorkRuntimeFixture({ ...process.env, PI_CODING_AGENT_DIR: agent, TMPDIR: root });
  let navigator = new WorkClient(daemon.socketPath, agent), activity = new WorkClient(daemon.socketPath, agent);
  const scope = { cwd: root, sessionId: "parent", limit: 200 };
  const ready = async () => {
    await navigator.subscribe(scope); await activity.subscribe({ ...scope, active: true });
    for (let n = 0; n < 400; n++) {
      if (navigator.snapshot?.status === "ready" && navigator.snapshot.rows.length === count && activity.snapshot?.rows.length === count
          && navigator.snapshot.rows.every((row: any) => row.display.coverage?.complete)) return;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail(JSON.stringify(daemon.diagnostics()));
  };
  const verify = async (spend: string) => {
    for (const client of [navigator, activity]) {
      const snapshot = await client.get(scope);
      assert.equal(snapshot.rows.length, count);
      for (const row of snapshot.rows as any[]) { assert.ok(row.display.spend.includes(spend), JSON.stringify(row.display)); assert.equal(row.health.facts.activeTools.length, 1); }
    }
  };
  try {
    await ready(); await verify("0.01");
    for (let round = 0; round < 2; round++) {
      const before = await navigator.request("runtime_get_metrics");
      for (let i = 0; i < count; i++) appendFileSync(join(runs, `sa_checkpoint_${i}`, "output.log"), usage);
      for (let n = 0; n < 400; n++) {
        const rows = (await navigator.get(scope)).rows;
        if (rows.every((r: any) => r.display.spend.includes(round === 0 ? "0.02" : "0.03"))) break;
        await new Promise(r => setTimeout(r, 20));
      }
      await verify(round === 0 ? "0.02" : "0.03");
      const after = await navigator.request("runtime_get_metrics");
      assert.ok(after.logReads.bytes - before.logReads.bytes <= count * (Buffer.byteLength(usage) + 512), JSON.stringify({ before, after }));
    }
    navigator.close(); activity.close(); await daemon.restart();
    navigator = new WorkClient(daemon.socketPath, agent); activity = new WorkClient(daemon.socketPath, agent);
    await ready(); await verify("0.03");
    const recovered = await navigator.request("runtime_get_metrics");
    assert.ok(recovered.sqlite.active <= 2, "read worker must retain the original root database budget");
    assert.equal(recovered.indexConnections, 1);
    assert.equal(recovered.sqlite.active - recovered.indexConnections, recovered.coordinatorConnections,
      "every retained handle is either the real derived owner or the real coordinator reader");
    t.diagnostic(JSON.stringify({ tasks: count, sqlite: recovered.sqlite, derived: recovered.indexConnections,
      coordinator: recovered.coordinatorConnections, restored: recovered.checkpoints.restores, bytes: recovered.logReads.bytes }));
    assert.ok(recovered.logReads.bytes <= count * 512, JSON.stringify(recovered));
    assert.ok(recovered.checkpoints.hotDisplay <= 64); assert.ok(recovered.checkpoints.hotHealth <= 64);
    assert.equal(recovered.checkpoints.restores, count);
    navigator.close(); activity.close(); await daemon.pause();
    rmSync(join(agent, "runtime-log-checkpoints.sqlite"));
    await daemon.resume(); navigator = new WorkClient(daemon.socketPath, agent); activity = new WorkClient(daemon.socketPath, agent);
    await ready(); await verify("0.03");
  } finally { navigator.close(); activity.close(); await daemon(); rmSync(root, { recursive: true, force: true }); }
});

test("checkpoint transaction rolls back, versions invalidate, and oversized folds are not retained", () => {
  const parent = resolve("../../.work/801"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "transaction-")), path = join(root, "index.sqlite");
  const store = new LogCheckpoints(path);
  try {
    store.save("log", { offset: 10, usage: 2 });
    const db = new DatabaseSync(path);
    db.exec("BEGIN IMMEDIATE; UPDATE checkpoints SET payload='{}'; ROLLBACK");
    assert.deepEqual(store.load("log"), { offset: 10, usage: 2 });
    db.exec("UPDATE checkpoints SET version=-1"); assert.equal(store.load("log"), undefined);
    db.close();
    store.save("log", "x".repeat(LOG_CHECKPOINT_ENTRY_BUDGET + 1)); assert.equal(store.load("log"), undefined);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["standalone", "shared"]) for (const phase of ["before", "after"]) test(`process death ${phase} ${mode} checkpoint commit preserves one matching fold and offset`, () => {
  const parent = resolve("../../.work/801"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "crash-")), path = join(root, "index.sqlite");
  const before = { display: { offset: 10, usage: 1 }, health: { offset: 10, tools: 1 } };
  let store = new LogCheckpoints(path); store.save("log", before); store.close();
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", new URL("./support/log-checkpoint-crash.ts", import.meta.url).pathname, path, mode],
      { env: { ...process.env, CHECKPOINT_CRASH: phase }, encoding: "utf8", timeout: 10000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    store = new LogCheckpoints(path);
    assert.deepEqual(store.load("log"), phase === "before" ? before : { display: { offset: 20, usage: 2 }, health: { offset: 20, tools: 0 } });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("borrowed derived owner keeps query tables transient and independent durable attachments atomic", () => {
  const parent = resolve("../../.work/801"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "shared-owner-")), path = join(root, "checkpoints.sqlite");
  const owner = new DatabaseSync(":memory:");
  owner.prepare("ATTACH DATABASE ? AS assignment_inbox").run(join(root, "inbox.sqlite"));
  owner.exec("CREATE TABLE query_rows(id TEXT); CREATE TABLE assignment_inbox.pending(id TEXT)");
  const store = new LogCheckpoints(path, owner);
  try {
    owner.exec("BEGIN IMMEDIATE; INSERT INTO assignment_inbox.pending VALUES('pending'); COMMIT");
    store.save("log", { display: { offset: 10, usage: 1 }, health: { offset: 10 } });
    assert.equal(owner.prepare("SELECT count(*) AS n FROM assignment_inbox.pending").get()!.n, 1);
    store.close();
    assert.equal(owner.prepare("SELECT count(*) AS n FROM query_rows").get()!.n, 0, "borrower must not close the owner");
    const reopened = new LogCheckpoints(path, owner);
    assert.equal(reopened.load("log").display.usage, 1);
    reopened.close();
    const disk = new DatabaseSync(path, { readOnly: true });
    assert.equal(disk.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='query_rows'").get()!.n, 0);
    disk.close();
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("disk payload eviction keeps the physical derived working set bounded", () => {
  const parent = resolve("../../.work/801"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "budget-")), path = join(root, "index.sqlite");
  const store = new LogCheckpoints(path);
  try {
    for (let n = 0; n < 150; n++) store.save(`log-${String(n).padStart(3, "0")}`, { body: "x".repeat(240000) });
    const db = new DatabaseSync(path, { readOnly: true });
    assert.ok(Number(db.prepare("SELECT sum(bytes) AS n FROM checkpoints").get()!.n) <= LOG_CHECKPOINT_BUDGET);
    db.close();
    assert.equal(store.load("log-000"), undefined);
    assert.ok(store.load("log-149"));
    assert.ok(statSync(path).size < LOG_CHECKPOINT_BUDGET + 1024 * 1024);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
