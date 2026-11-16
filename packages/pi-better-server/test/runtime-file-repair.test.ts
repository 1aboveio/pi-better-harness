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

test("precise hints coalesce; bounded repair resumes despite hot writes and repairs missing sources", async t => {
  const f = fixture();
  for (let i = 0; i < 160; i++) f.put(`sa_${i}`);
  const model = new WorkReadModel(f.agent, "repair-test", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  const disconnect = () => { for (const watcher of (model as any).watchers.values()) watcher.close(); (model as any).watchers.clear(); };
  try {
    await model.reconcile(); disconnect();
    const before = model.metrics;
    f.put("sa_0", { name: "atomic" });
    for (let n = 0; n < 20; n++) model.fileHint(join(f.runs, "sa_0"), "meta.json");
    await (model as any).pending;
    assert.equal(model.snapshot({ id: "sa_0" }).rows[0]!.meta.name, "atomic");
    assert.equal(model.metrics.scheduling.repairEntries, before.scheduling.repairEntries);
    assert.ok(model.metrics.scheduling.entityBatches - before.scheduling.entityBatches <= 2);
    const ignored = model.metrics.inventories;
    model.fileHint(f.runs, ".writer.lock"); model.fileHint(join(f.runs, "sa_0"), "output.log.lock");
    assert.equal(model.metrics.inventories, ignored);
    disconnect(); f.put("sa_missed", { name: "missed hint" });
    const progress = model.metrics.scheduling.repairEntries;
    for (let n = 0; n < 20; n++) {
      appendFileSync(join(f.runs, "sa_0", "output.log"), JSON.stringify({ type: "agent_settled", at: n }) + "\n");
      model.fileHint(join(f.runs, "sa_0"), "output.log"); await (model as any).pending;
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
    await (model as any).pending; await (model as any).repairWrite;
    assert.ok(model.metrics.scheduling.overflows > 0);
    assert.ok(model.metrics.scheduling.queued <= 256);
    assert.deepEqual(JSON.parse(readFileSync(join(f.agent, "runtime-read-repair/subagents.json"), "utf8")).roots, [model.runs, model.archives, model.markers]);
    t.diagnostic(JSON.stringify(model.metrics));
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
