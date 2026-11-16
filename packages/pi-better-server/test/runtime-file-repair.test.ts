import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";

const fixturePath = "../../pi-better-subagents/tests/work-runtime-fixture.mjs";
const { startWorkRuntimeFixture } = await import(fixturePath);
const coordinatorPath = "../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs";
const { openStore } = await import(coordinatorPath);
function fixture() {
  const parent = resolve("../../.work/799"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "repair-")), agent = join(root, "agent"), base = join(root, "pi-better-subagents"), runs = join(base, "runs");
  mkdirSync(agent); mkdirSync(runs, { recursive: true });
  openStore({ path: join(agent, "operation-coordinator.sqlite") }).close();
  const put = (id: string, extra = {}) => {
    mkdirSync(join(runs, id), { recursive: true });
    const meta = { id, cwd: root, sessionId: id, callback: false, status: "running", pid: process.pid, startedAt: 1, callbackOrigin: { cwd: root, sessionId: "parent" }, ...extra };
    writeFileSync(join(runs, id, "meta.json"), JSON.stringify(meta)); return meta;
  };
  return { root, agent, base, runs, put };
}

async function settleHints(model: WorkReadModel) {
  // A completed turn can schedule another turn before its waiter resumes.
  let pending: Promise<void> | undefined;
  while ((pending = (model as any).pending)) await pending;
  assert.equal(model.metrics.scheduling.queued, 0, "hint obligations must be drained");
}

test("precise hints coalesce; bounded repair resumes despite hot writes and repairs missing sources", async t => {
  const f = fixture();
  for (let i = 0; i < 160; i++) f.put(`sa_${i}`);
  const model = new WorkReadModel(f.agent, "repair-test", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  const disconnect = () => { for (const watcher of (model as any).watchers.values()) watcher.close(); (model as any).watchers.clear(); };
  try {
    await model.reconcile(); disconnect();
    const before = model.metrics;
    const unrelatedScope = model.snapshot({ id: "sa_1" }).scopeRevision;
    let unrelatedPublications = 0;
    const off = model.onChange(() => { unrelatedPublications++; }, { id: "sa_1" });
    f.put("sa_0", { name: "atomic" });
    for (let n = 0; n < 20; n++) model.fileHint(join(f.runs, "sa_0"), "meta.json");
    await settleHints(model);
    assert.equal(model.snapshot({ id: "sa_0" }).rows[0]!.meta.name, "atomic");
    assert.equal(model.metrics.scheduling.repairEntries, before.scheduling.repairEntries);
    assert.ok(model.metrics.scheduling.entityBatches - before.scheduling.entityBatches <= 2);
    assert.equal(model.snapshot({ id: "sa_1" }).scopeRevision, unrelatedScope);
    assert.equal(unrelatedPublications, 0);
    off();
    const ignored = model.metrics.inventories;
    model.fileHint(f.runs, ".writer.lock"); model.fileHint(join(f.runs, "sa_0"), "output.log.lock");
    assert.equal(model.metrics.inventories, ignored);
    disconnect(); f.put("sa_missed", { name: "missed hint" });
    const progress = model.metrics.scheduling.repairEntries;
    for (let n = 0; n < 20; n++) {
      appendFileSync(join(f.runs, "sa_0", "output.log"), JSON.stringify({ type: "agent_settled", at: n }) + "\n");
      model.fileHint(join(f.runs, "sa_0"), "output.log"); await settleHints(model);
      (model as any).repairOwed = true; await model.reconcile(false); disconnect();
      if (model.snapshot({ id: "sa_missed" }).rows.length) break;
    }
    assert.equal(model.snapshot({ id: "sa_missed" }).rows.length, 1);
    assert.ok(model.metrics.scheduling.repairEntries > progress);
    renameSync(f.runs, f.runs + "-away"); await model.reconcile();
    assert.equal(model.snapshot({ id: "sa_0" }).rows.length, 1);
    assert.equal(model.observation().status, "degraded");
    renameSync(f.runs + "-away", f.runs); await model.reconcile();
    assert.equal(model.observation().status, "ready");
    rmSync(join(f.runs, "sa_missed"), { recursive: true }); await model.reconcile();
    assert.equal(model.snapshot({ id: "sa_missed" }).rows.length, 0);
    const watcher = (model as any).watchers.values().next().value;
    watcher.emit("error", new Error("injected watcher failure"));
    assert.equal(model.observation().status, "degraded");
    await model.reconcile();
    renameSync(f.runs, f.runs + "-old"); mkdirSync(f.runs); f.put("sa_replacement");
    await model.reconcile();
    assert.equal(model.snapshot({ id: "sa_replacement" }).rows.length, 1);
    assert.equal(model.snapshot({ id: "sa_0" }).rows.length, 0);
    for (let n = 0; n < 320; n++) model.fileHint(f.runs, `sa_overflow_${n}`);
    await (model as any).repairWrite; await settleHints(model);
    assert.ok(model.metrics.scheduling.overflows > 0);
    assert.ok(model.metrics.scheduling.queued <= 256);
    assert.deepEqual(JSON.parse(readFileSync(join(f.agent, "runtime-read-repair/subagents.json"), "utf8")).roots, [model.runs, model.archives, model.markers]);
    t.diagnostic(JSON.stringify(model.metrics));
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const source of ["metadata", "archive", "marker"] as const) test(`repair verifies missed deletion of never-imported invalid ${source}, retaining errors while its root is missing`, async () => {
  const f = fixture();
  const model = new WorkReadModel(f.agent, `failed-${source}`, { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  const directory = source === "metadata" ? model.runs : source === "archive" ? model.archives : model.markers;
  const path = source === "metadata" ? join(directory, "sa_bad", "meta.json") : join(directory, "sa_bad.json");
  const dropHints = () => { for (const watcher of (model as any).watchers.values()) watcher.close(); (model as any).watchers.clear(); };
  const writeBroken = () => {
    mkdirSync(source === "metadata" ? join(directory, "sa_bad") : directory, { recursive: true });
    writeFileSync(path, "broken");
  };
  try {
    await model.reconcile(); assert.equal(model.observation().status, "ready"); dropHints();
    writeBroken(); await model.reconcile();
    assert.equal(model.observation().status, "degraded");
    assert.equal(model.snapshot().rows.length, 0, "failed first observation must not publish a record");
    dropHints();
    rmSync(source === "metadata" ? join(directory, "sa_bad") : path, { recursive: true });
    await model.reconcile(); await model.reconcile();
    assert.equal(model.observation().status, "ready", "repair must verify deletion without a delivered hint");

    writeBroken(); await model.reconcile(); dropHints();
    renameSync(directory, directory + "-away");
    await model.reconcile(); await model.reconcile();
    assert.equal(model.observation().status, "degraded", "unavailable root cannot verify deletion");
    assert.match(model.observation().reason!, /Source directory unavailable/);
    rmSync(directory + "-away", { recursive: true }); mkdirSync(directory);
    await model.reconcile();
    assert.equal(model.observation().status, "ready", "available empty root verifies the failed path is gone");

    writeBroken(); await model.reconcile(); dropHints();
    rmSync(source === "metadata" ? join(directory, "sa_bad") : path, { recursive: true });
    const repairs = model.metrics.scheduling.repairEntries;
    model.fileHint(source === "metadata" ? join(directory, "sa_bad") : directory, source === "metadata" ? "meta.json" : "sa_bad.json");
    await settleHints(model);
    assert.equal(model.observation().status, "ready", "exact deletion hint must still clear the error");
    assert.equal(model.metrics.scheduling.repairEntries, repairs, "exact deletion hint needs no inventory");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("exact deletion hints settle a follow-up turn scheduled when the first turn completes", async () => {
  const f = fixture();
  const model = new WorkReadModel(f.agent, "follow-up-hint", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    for (const id of ["sa_first", "sa_second"]) {
      f.put(id); writeFileSync(join(f.runs, id, "meta.json"), "broken");
    }
    await model.reconcile();
    assert.equal(model.observation().status, "degraded");
    for (const watcher of (model as any).watchers.values()) watcher.close();
    (model as any).watchers.clear();
    for (const id of ["sa_first", "sa_second"]) rmSync(join(f.runs, id), { recursive: true });
    const repairs = model.metrics.scheduling.repairEntries;
    model.fileHint(join(f.runs, "sa_first"), "meta.json");
    const firstTurn: Promise<void> = (model as any).pending;
    const followUp = firstTurn.then(() => {
      assert.equal(model.observation().status, "degraded", "the second failed path still owes its hint");
      model.fileHint(join(f.runs, "sa_second"), "meta.json");
    });
    await Promise.all([settleHints(model), followUp]);
    assert.equal(model.observation().status, "ready");
    assert.equal(model.metrics.scheduling.repairEntries, repairs, "follow-up exact hint needs no inventory");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("failed-source deletion repair keeps its 128-path budget and does not clear unverified errors early", async () => {
  const f = fixture();
  const model = new WorkReadModel(f.agent, "failed-batches", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  const dropHints = () => { for (const watcher of (model as any).watchers.values()) watcher.close(); (model as any).watchers.clear(); };
  try {
    await model.reconcile(); dropHints();
    for (let i = 0; i < 130; i++) {
      mkdirSync(join(f.runs, `sa_bad_${i}`));
      writeFileSync(join(f.runs, `sa_bad_${i}`, "meta.json"), "broken");
    }
    await model.reconcile(); assert.equal(model.observation().status, "degraded"); dropHints();
    for (let i = 0; i < 130; i++) rmSync(join(f.runs, `sa_bad_${i}`), { recursive: true });
    const before = model.metrics.scheduling.repairEntries;
    (model as any).repairOwed = true;
    await model.reconcile(false);
    assert.equal(model.metrics.scheduling.repairEntries - before, 128);
    assert.equal(model.observation().status, "degraded", "remaining failed paths still owe verified observations");
    await model.reconcile(false);
    assert.equal(model.metrics.scheduling.repairEntries - before, 130);
    assert.equal(model.observation().status, "ready");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("empty Subagent repair still publishes independent Background coordinator progress", async () => {
  const f = fixture();
  const model = new WorkReadModel(f.agent, "empty-background", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  const store = openStore({ path: join(f.agent, "operation-coordinator.sqlite") });
  const owner = { kind: "parent-session", sessionId: "parent", workspace: f.root };
  const scope = { background: true, cwd: f.root, sessionId: "parent" };
  const published: any[] = [];
  const off = model.onChange(() => published.push(model.snapshot(scope)), scope);
  const logBytes = model.metrics.logReads.bytes;
  try {
    await model.reconcile(); assert.equal(model.snapshot(scope).rows.length, 0);
    published.length = 0;
    store.registerOperation({ operationId: "empty-background-operation", taskId: "bgs_00000000000000000799", launchToken: "empty-background-token", owner,
      observer: { kind: "local-supervisor", version: "1" } });
    await model.reconcile();
    assert.equal(published.at(-1)?.activity.active, 1, "coordinator progress must publish even with no Subagent candidates");
    store.recordTerminalOutcome({ operationId: "empty-background-operation", eventId: "empty-background-result", outcome: "succeeded", owner,
      evidence: [{ kind: "terminal-record", ref: "empty-background-evidence" }] });
    await model.reconcile();
    assert.equal(published.at(-1)?.rows[0]?.meta.status, "succeeded");
    assert.equal(published.at(-1)?.activity.active, 0);
    assert.equal(model.metrics.inventories, 0, "Background refresh does not require a Subagent batch");
    assert.equal(model.metrics.scheduling.repairEntries, 0);
    assert.equal(model.metrics.logReads.bytes, logBytes);
  } finally { off(); await model.close(); store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("initial repair retains health configuration degradation until valid settings recover", async () => {
  const f = fixture(); f.put("sa_health_import");
  writeFileSync(join(f.agent, "settings.json"), "invalid json");
  const model = new WorkReadModel(f.agent, "health-import", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    assert.equal(model.observation().status, "degraded");
    assert.match(model.observation().reason!, /Health configuration unavailable/);
    writeFileSync(join(f.agent, "settings.json"), "{}");
    await model.reconcile();
    assert.equal(model.observation().status, "ready");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("real daemon publishes task appearance, atomic terminal replacement, deletion and degraded input to multiple clients", { timeout: 30000 }, async t => {
  const f = fixture(); f.put("sa_original");
  const daemon = await startWorkRuntimeFixture({ ...process.env, PI_CODING_AGENT_DIR: f.agent, TMPDIR: f.root });
  const clients = Array.from({ length: 5 }, () => new WorkClient(daemon.socketPath, f.agent));
  const wait = async (check: () => boolean) => {
    const end = Date.now() + 10000;
    while (!check()) { assert.ok(Date.now() < end, JSON.stringify(daemon.diagnostics())); await new Promise(r => setTimeout(r, 20)); }
  };
  try {
    await Promise.all(clients.map(client => client.subscribe({ cwd: f.root, sessionId: "parent", limit: 100 })));
    await wait(() => clients.every(client => client.snapshot?.status === "ready"));
    f.put("sa_new"); await wait(() => clients.every(client => client.snapshot?.rows.some((row: any) => row.meta.id === "sa_new")));
    const meta = f.put("sa_new", { status: "completed", endedAt: Date.now() });
    writeFileSync(join(f.runs, "sa_new", "replacement"), JSON.stringify({ ...meta, name: "replaced" }));
    renameSync(join(f.runs, "sa_new", "replacement"), join(f.runs, "sa_new", "meta.json"));
    await wait(() => clients.every(client => client.snapshot?.rows.some((row: any) => row.meta.name === "replaced" && row.assignment.state === "completed")));
    writeFileSync(join(f.runs, "sa_new", "meta.json"), "broken json");
    await wait(() => clients.every(client => client.snapshot?.status === "degraded"));
    assert.ok(clients.every(client => client.snapshot?.rows.some((row: any) => row.meta.name === "replaced")));
    f.put("sa_original", { name: "unrelated update" });
    await wait(() => clients.every(client => client.snapshot?.rows.some((row: any) => row.meta.name === "unrelated update")));
    assert.ok(clients.every(client => client.snapshot?.status === "degraded"));
    f.put("sa_new", { status: "completed" }); await wait(() => clients.every(client => client.snapshot?.status === "ready"));
    rmSync(join(f.runs, "sa_new"), { recursive: true });
    await wait(() => clients.every(client => !client.snapshot?.rows.some((row: any) => row.meta.id === "sa_new")));
    t.diagnostic(JSON.stringify(await clients[0]!.request("runtime_get_metrics")));
  } finally { clients.forEach(client => client.close()); await daemon(); rmSync(f.root, { recursive: true, force: true }); }
});
