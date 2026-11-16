import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";

const fixturePath = "../../pi-better-subagents/tests/work-runtime-fixture.mjs";
const { startWorkRuntimeFixture } = await import(fixturePath);
const coordinatorPath = "../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs";
const { openStore } = await import(coordinatorPath);
function fixture() {
  const parent = tmpdir();
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

test("retired root and child watcher callbacks cannot schedule repair", async () => {
  const f = fixture(); f.put("sa_retired");
  const model = new WorkReadModel(f.agent, "retired-watchers", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    const retired = [...(model as any).watchers.values()];
    renameSync(f.runs, f.runs + "-away");
    await model.reconcile(); await settleHints(model);
    assert.equal(model.metrics.sourceWatchers, 0);
    assert.equal(model.snapshot().status, "degraded");
    assert.equal(model.snapshot().rows.length, 1);
    mkdirSync(f.runs); f.put("sa_retired", { name: "new-root" });
    await model.reconcile(); await settleHints(model);
    const parentWatchers = (model as any).rootParents as Map<string, { watcher: import("node:fs").FSWatcher }>;
    const oldParents = [...parentWatchers.values()].map(entry => entry.watcher);
    oldParents.forEach(watcher => watcher.close()); parentWatchers.clear();
    for (const root of [model.runs, model.archives, model.markers]) (model as any).watchRootParent(root);
    await settleHints(model);
    const before = model.metrics;
    for (const watcher of retired) watcher.emit("change", "change", "meta.json");
    for (const watcher of oldParents) watcher.emit("change", "rename", "runs");
    assert.equal((model as any).pending, undefined, "retired callbacks cannot start a new pass");
    assert.equal(model.metrics.scheduling.queued, 0);
    assert.equal(model.metrics.inventories, before.inventories);
    assert.equal(model.snapshot().rows[0]?.meta.name, "new-root");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("late compact archives cannot replace live recipient markers or reset its cursor", async () => {
  const f = fixture();
  const model = new WorkReadModel(f.agent, "source-precedence", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  const id = "sa_pending";
  const meta = f.put(id, { status: "completed", callback: true, completionCallbackPendingAt: 1,
    recipe: { version: 1, sessionId: id, sessionDir: join(f.root, "durable/sessions"), cwd: f.root } });
  f.put("sa_other", { status: "completed" });
  const scope = { cwd: f.root, sessionId: "parent", limit: 1 };
  try {
    await model.reconcile();
    const first = model.snapshot(scope);
    assert.equal(model.snapshot({ ...scope, pendingRecipient: true }).rows[0]!.meta.id, id);
    // Completed archives omit the volatile completion markers by design.
    const compact: Record<string, unknown> = { ...meta };
    delete compact.completionCallbackPendingAt;
    delete compact.callbackOrigin;
    mkdirSync(model.archives, { recursive: true });
    writeFileSync(join(model.archives, `${id}.json`), JSON.stringify({ version: 1, meta: compact }));
    model.fileHint(model.archives, `${id}.json`);
    await settleHints(model);
    assert.equal(model.snapshot({ id }).rows[0]!.meta.completionCallbackPendingAt, 1);
    assert.equal(model.snapshot({ ...scope, pendingRecipient: true }).rows[0]!.meta.id, id);
    assert.equal(model.snapshot(scope).scopeRevision, first.scopeRevision);
    assert.equal(model.snapshot({ ...scope, cursor: first.nextCursor }).rows.length, 1);
    writeFileSync(join(f.runs, id, "meta.json"), JSON.stringify({ ...meta, completionCallbackSentAt: 2 }));
    model.fileHint(join(f.runs, id), "meta.json"); await settleHints(model);
    assert.equal(model.snapshot({ ...scope, pendingRecipient: true }).rows.length, 0);
    assert.throws(() => model.snapshot({ ...scope, cursor: first.nextCursor }), /resync_required/);
    // Losing volatile storage still exposes the verified archive for history.
    rmSync(join(f.runs, id), { recursive: true });
    model.fileHint(f.runs, id); await settleHints(model);
    assert.equal(model.snapshot({ id }).rows[0]!.meta.id, id);
    assert.equal(model.snapshot({ id }).rows[0]!.meta.completionCallbackPendingAt, undefined);
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const successor of ["parent", "another-session"]) test(`late archive preserves saved-conversation recipient obligations for ${successor}`, async () => {
  const f = fixture(), durable = join(f.root, "durable");
  const saved = process.env.PI_SUBAGENT_DURABLE_DIR;
  process.env.PI_SUBAGENT_DURABLE_DIR = durable;
  const { archiveCompletedAttempt } = await import(new URL("../../pi-better-subagents/session-store.ts", import.meta.url).href);
  const store = openStore({ path: join(f.agent, "operation-coordinator.sqlite") });
  const model = new WorkReadModel(f.agent, "continued-recipient", { baseDir: f.base, durableDir: durable, intervalMs: 60000 });
  const owner = { kind: "worker-conversation" as const, sessionId: "sa_original", workspace: f.root };
  const pending = (sessionId: string) => model.snapshot({ cwd: f.root, sessionId, pendingRecipient: true });
  try {
    let originalRevision: string | undefined;
    for (const [id, sessionId] of [["sa_original", "parent"], ["sa_continued", successor]]) {
      const recipient = { kind: "parent-session" as const, sessionId, workspace: f.root };
      const assignment = { version: 1, assignmentId: id, owner, recipient };
      store.registerAssignment(assignment);
      store.recordAssignmentOutcome({ ...assignment, revision: 1, outcome: "succeeded", reason: "Completed", evidence: [], waits: [], processUncertain: false });
      const meta = f.put(id!, { sessionId: owner.sessionId, status: "completed", endedAt: 2, callback: true,
        completionCallbackPendingAt: 1, callbackOrigin: { cwd: f.root, sessionId }, assignment,
        ...(id === "sa_continued" ? { resumedFrom: "sa_original", rootRunId: "sa_original" } : {}),
        recipe: { version: 1, sessionId: owner.sessionId, sessionDir: join(durable, "sessions"), cwd: f.root } });
      model.fileHint(join(f.runs, id!), "meta.json"); await model.reconcile(); await settleHints(model);
      assert.deepEqual(pending(sessionId!).rows.map(row => row.meta.id), [id]);
      assert.equal(archiveCompletedAttempt(meta as never), true);
      model.fileHint(model.archives, `${id}.json`); await settleHints(model);
      const row = pending(sessionId!).rows[0];
      assert.ok(row, "the actual compact writer must not remove the live recipient obligation");
      assert.equal(row.meta.id, id);
      assert.equal(row.meta.completionCallbackPendingAt, 1);
      assert.equal(row.meta.callbackOrigin.sessionId, sessionId);
      assert.equal(row.assignment.verified, true);
      if (successor !== "parent") assert.equal(pending(sessionId === "parent" ? successor : "parent").rows.length, 0);
      store.receiptAssignmentOutcome({ assignmentId: id, recipient, revision: 1, entryId: `receipt-${id}` });
      f.put(id!, { ...meta, completionCallbackSentAt: 3 });
      model.fileHint(join(f.runs, id!), "meta.json"); await model.reconcile(); await settleHints(model);
      assert.equal(pending(sessionId!).rows.length, 0, "the durable receipt settles only its exact recipient obligation");
      assert.equal(model.snapshot({ id }).rows[0]!.meta.completionCallbackSentAt, 3);
      if (id === "sa_original") originalRevision = model.snapshot({ id }).rows[0]!.sourceRevision;
      else assert.equal(model.snapshot({ id: "sa_original" }).rows[0]!.sourceRevision, originalRevision, "continuation leaves the prior attempt observation unchanged");
    }
  } finally {
    await model.close(); store.close();
    if (saved === undefined) delete process.env.PI_SUBAGENT_DURABLE_DIR; else process.env.PI_SUBAGENT_DURABLE_DIR = saved;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("nullable and over-budget replacements retain verified rows until deletion is verified under an available root", async () => {
  const f = fixture(); f.put("sa_invalid", { name: "verified" }); f.put("sa_sibling", { name: "before" });
  const model = new WorkReadModel(f.agent, "invalid-root-union", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile(); await settleHints(model);
    for (const watcher of (model as any).watchers.values()) watcher.close();
    (model as any).watchers.clear();
    for (const [index, value] of ["null", "[]", "42", JSON.stringify("invalid"), "x".repeat(1024 * 1024 + 1)].entries()) {
      writeFileSync(join(f.runs, "sa_invalid/meta.json"), value);
      f.put("sa_sibling", { name: `after-${index}` });
      model.fileHint(join(f.runs, "sa_invalid"), "meta.json");
      model.fileHint(join(f.runs, "sa_sibling"), "meta.json");
      await settleHints(model);
      assert.equal(model.snapshot({ id: "sa_invalid" }).rows[0]!.meta.name, "verified");
      assert.equal(model.snapshot({ id: "sa_sibling" }).rows[0]!.meta.name, `after-${index}`);
      assert.equal(model.observation().status, "degraded");
    }
    renameSync(f.runs, f.runs + "-away");
    await model.reconcile();
    assert.equal(model.snapshot().rows.length, 2, "whole-root absence cannot verify individual deletion");
    assert.equal(model.observation().status, "degraded");
    mkdirSync(f.runs);
    await model.reconcile();
    assert.equal(model.snapshot().rows.length, 0, "available empty root verifies the known paths are gone");
    assert.equal(model.observation().status, "ready");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("compact display cursors do not discard independent detail text and tool history", async () => {
  const f = fixture(); f.put("sa_detail", { status: "completed", endedAt: 2 });
  const log = join(f.runs, "sa_detail/output.log");
  writeFileSync(log, [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "complete answer" }], usage: { cost: { total: 0.01 } } } },
    { type: "tool_execution_start", toolCallId: "first", toolName: "bash" },
    { type: "tool_execution_start", toolCallId: "second", toolName: "read" },
  ].map(event => JSON.stringify(event) + "\n").join(""));
  const model = new WorkReadModel(f.agent, "detail-cursor-union", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    assert.equal((model as any).parseStates.get(log).finalText, "");
    const detail = model.snapshot({ id: "sa_detail", detail: true }).rows[0] as any;
    assert.equal(detail.detail.parsed.finalText, "complete answer");
    assert.deepEqual(detail.detail.parsed.toolCalls, ["bash", "read"]);
    assert.equal((model as any).parseStates.get(log).toolCalls.length, 1);
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("idle timer repair stays bounded as unchanged task history grows", async t => {
  const f = fixture();
  for (let i = 0; i < 512; i++) f.put(`sa_idle_${i}`, { status: "completed", endedAt: 2 });
  const model = new WorkReadModel(f.agent, "idle-history", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 50 });
  try {
    await model.reconcile(); await settleHints(model);
    const before = model.metrics;
    const deadline = Date.now() + 3000;
    while (model.metrics.sourceWork.repair.batches - before.sourceWork.repair.batches < 3) {
      assert.ok(Date.now() < deadline, "idle timer must keep advancing repair");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await settleHints(model);
    const after = model.metrics;
    const batches = after.sourceWork.repair.batches - before.sourceWork.repair.batches;
    const paths = after.sourceWork.repair.paths - before.sourceWork.repair.paths;
    const stats = after.sourceWork.repair.stats - before.sourceWork.repair.stats;
    assert.ok(paths <= batches * 128, `idle repair examined ${paths} paths in ${batches} batches`);
    assert.ok(stats <= paths * 5, `idle repair performed ${stats} stats for ${paths} paths`);
    assert.equal(after.metadataReads, before.metadataReads, "unchanged history must not be reread");
    assert.equal(after.sourceWork.entity.batches, before.sourceWork.entity.batches);
    t.diagnostic(JSON.stringify({ batches, paths, stats }));
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("display cursors retain usage and the latest tool without historical response payloads", async () => {
  const f = fixture(); f.put("sa_display", { status: "completed", endedAt: 2 });
  const log = join(f.runs, "sa_display/output.log");
  const event = (value: any) => JSON.stringify(value) + "\n";
  writeFileSync(log, event({ type: "message_end", message: { role: "assistant", content: "x".repeat(100000), usage: { cost: { total: 0.01 } } } })
    + Array.from({ length: 100 }, (_, i) => event({ type: "tool_execution_start", toolCallId: String(i), toolName: i % 2 ? "read" : "bash" })).join(""));
  const model = new WorkReadModel(f.agent, "compact-display", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    const state = (model as any).parseStates.get(log);
    assert.equal(state.finalText.length, 0);
    assert.equal(state.lastActivity.length, 0);
    assert.equal(state.toolCalls.length, 1);
    assert.equal(state.openToolCalls.size, 0);
    appendFileSync(log, event({ type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.02 } } } }));
    model.fileHint(join(f.runs, "sa_display"), "output.log"); await settleHints(model);
    const row = model.snapshot().rows[0] as any;
    assert.match(row.display.spend, /0\.03/);
    assert.equal(row.display.tool, "read");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a malformed task does not block verified siblings in the same repair batch", async () => {
  const f = fixture(); f.put("sa_bad"); f.put("sa_good", { status: "completed", endedAt: 2 });
  writeFileSync(join(f.runs, "sa_bad/meta.json"), "broken");
  const model = new WorkReadModel(f.agent, "bad-sibling", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    assert.equal(model.snapshot({ id: "sa_good" }).rows.length, 1);
    assert.equal(model.snapshot({ id: "sa_bad" }).rows.length, 0);
    assert.equal(model.observation().status, "degraded");
    f.put("sa_bad", { status: "completed", endedAt: 2 });
    model.fileHint(join(f.runs, "sa_bad"), "meta.json"); await settleHints(model);
    assert.equal(model.snapshot().rows.length, 2);
    assert.equal(model.observation().status, "ready");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a later archive never overrides its live raw task, and raw deletion reveals the archive", async () => {
  const f = fixture();
  const meta = f.put("sa_duplicate", { status: "completed", endedAt: 2, name: "raw", completionCallbackPendingAt: 2 });
  const durable = join(f.root, "durable");
  const model = new WorkReadModel(f.agent, "source-precedence", { baseDir: f.base, durableDir: durable, intervalMs: 60000 });
  try {
    await model.reconcile();
    mkdirSync(model.archives, { recursive: true });
    const archived = { ...meta, name: "archive", recipe: { version: 1, sessionId: meta.sessionId, sessionDir: join(durable, "sessions"), cwd: f.root } };
    writeFileSync(join(model.archives, "sa_duplicate.json"), JSON.stringify({ version: 1, meta: archived }));
    model.fileHint(model.archives, "sa_duplicate.json"); await settleHints(model);
    assert.equal(model.snapshot().rows[0]!.meta.name, "raw");
    f.put("sa_duplicate", { ...meta, name: "raw-new" });
    model.fileHint(join(f.runs, "sa_duplicate"), "meta.json"); await settleHints(model);
    assert.equal(model.snapshot().rows[0]!.meta.name, "raw-new");
    rmSync(join(f.runs, "sa_duplicate"), { recursive: true });
    model.fileHint(f.runs, "sa_duplicate"); await settleHints(model);
    assert.equal(model.snapshot().rows[0]!.meta.name, "archive");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("an exact task hint fences a genuinely changed source before publication and retries", async () => {
  const f = fixture(); f.put("sa_race", { name: "before" });
  const model = new WorkReadModel(f.agent, "coordinator-race", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    for (const watcher of (model as any).watchers.values()) watcher.close();
    (model as any).watchers.clear();
    const reader = (model as any).reader;
    const beginSnapshot = reader.beginSnapshot.bind(reader);
    let races = 0;
    reader.beginSnapshot = () => {
      const snapshot = beginSnapshot();
      if (races++ === 0) f.put("sa_race", { name: "winning-source" });
      return snapshot;
    };
    f.put("sa_race", { name: "after" });
    model.fileHint(join(f.runs, "sa_race"), "meta.json"); await settleHints(model);
    assert.ok(races >= 2, "the failed validation must trigger another entity observation");
    assert.equal(model.snapshot().rows[0]!.meta.name, "winning-source");
    assert.equal(model.observation().status, "ready");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a malformed replacement discards unpublished staging without blocking its sibling", async () => {
  const f = fixture(); f.put("sa_racy", { name: "old" }); f.put("sa_sibling", { name: "old" });
  const model = new WorkReadModel(f.agent, "staged-malformed", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile(); await settleHints(model);
    for (const watcher of (model as any).watchers.values()) watcher.close();
    (model as any).watchers.clear();
    const paths = ["sa_racy", "sa_sibling"].map(id => join(f.runs, id, "meta.json"));
    f.put("sa_racy", { name: "unpublished" }); f.put("sa_sibling", { name: "new" });
    const reader = (model as any).reader, beginSnapshot = reader.beginSnapshot.bind(reader);
    reader.beginSnapshot = () => {
      const snapshot = beginSnapshot();
      // Metadata has been read; publication still must validate its exact bytes.
      writeFileSync(paths[0]!, "broken");
      reader.beginSnapshot = beginSnapshot;
      return snapshot;
    };
    await (model as any).scan(paths);
    assert.equal(model.snapshot({ id: "sa_racy" }).rows[0]!.meta.name, "old");
    for (let n = 0; n < 3; n++) await (model as any).scan(paths);
    assert.equal(model.snapshot({ id: "sa_racy" }).rows[0]!.meta.name, "old");
    assert.equal(model.snapshot({ id: "sa_sibling" }).rows[0]!.meta.name, "new");
    assert.equal(model.observation().status, "degraded");
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

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

test("retired root watcher callbacks cannot act on replacement descriptors", async () => {
  const f = fixture(); f.put("sa_retired");
  const model = new WorkReadModel(f.agent, "retired-watch", { baseDir: f.base, durableDir: join(f.root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    const watchers = (model as any).watchers;
    const retired = watchers.get(model.runs);
    const retiredParent = (model as any).rootParents.get(model.runs).watcher;
    renameSync(f.base, f.base + "-old"); f.put("sa_replacement");
    await model.reconcile(); await settleHints(model);
    const replacement = watchers.get(model.runs);
    const child = watchers.get(join(model.runs, "sa_replacement"));
    const parent = (model as any).rootParents.get(model.runs).watcher;
    assert.notEqual(replacement, retired); assert.notEqual(parent, retiredParent);
    const before = model.metrics.inventories;
    retired.emit("change", "rename", "sa_replacement");
    retiredParent.emit("change", "rename", "runs");
    assert.equal(watchers.get(model.runs), replacement);
    assert.equal(watchers.get(join(model.runs, "sa_replacement")), child);
    assert.equal((model as any).rootParents.get(model.runs).watcher, parent);
    assert.equal(model.metrics.inventories, before);
    assert.equal(model.metrics.scheduling.queued, 0);
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
