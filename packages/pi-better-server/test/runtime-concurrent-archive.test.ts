import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkReadModel } from '../src/runtime/read-model.ts';
import { seedWorkload } from '../scripts/measure-full-runtime/incremental-workload.mjs';
const { openStore } = await import(new URL('../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs', import.meta.url).href);

function stopHints(model: WorkReadModel) {
  // Dropped hints are intentional fault input. No fake source revisions or rows.
  for (const watcher of (model as any).watchers.values()) watcher.close();
  (model as any).watchers.clear();
  for (const entry of (model as any).rootParents.values()) entry.watcher.close();
  (model as any).rootParents.clear();
}

for (const { rootUnavailable, activeRepair } of [
  { rootUnavailable: false, activeRepair: false }, { rootUnavailable: true, activeRepair: false }, { rootUnavailable: false, activeRepair: true },
]) test(`archive publication during raw metadata observation recovers with dropped hints; rootUnavailable=${rootUnavailable}, activeRepair=${activeRepair}`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'p808-concurrent-archive-'));
  const group = activeRepair ? 260 : 2;
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group, clients: 1, durationMs: 600000, baseline: '' } });
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  const model = new WorkReadModel(manifest.agent, 'archive-race-component', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  const id = manifest.tasks[0]!.id, raw = join(manifest.runs, id), metaPath = join(raw, 'meta.json');
  const siblingId = manifest.tasks[1]!.id, siblingPath = join(manifest.runs, siblingId, 'meta.json');
  const observations: any[] = [];
  let injections = 0;
  try {
    await model.reconcile();
    if (activeRepair) {
      model.fileHint(manifest.runs); await model.reconcile(false);
      while ((model as any).pending) await (model as any).pending;
      assert.ok((model as any).repair, 'fixture must have an actual incomplete bounded repair iterator');
    }
    const repairCursor = (model as any).repair;
    stopHints(model);
    const original = JSON.parse(readFileSync(metaPath, 'utf8'));
    const sibling = JSON.parse(readFileSync(siblingPath, 'utf8'));
    writeFileSync(metaPath, JSON.stringify({ ...original, name: 'unpublished-raw' }));
    writeFileSync(siblingPath, JSON.stringify({ ...sibling, name: 'sibling-progress' }));
    const reader = (model as any).reader, begin = reader.beginSnapshot.bind(reader);
    reader.beginSnapshot = () => {
      const snapshot = begin();
      reader.beginSnapshot = begin; injections++;
      stopHints(model);
      // Real atomic archive publication and source retirement AFTER metadata
      // reads, BEFORE publication verification. The captured SQLite view is real.
      const archive = join(model.archives, `${id}.json`);
      writeFileSync(archive + '.staged', JSON.stringify({ version: 1, meta: { ...original, name: 'verified-archive' } }));
      renameSync(archive + '.staged', archive);
      if (rootUnavailable) renameSync(manifest.runs, manifest.runs + '-away');
      else rmSync(raw, { recursive: true });
      return snapshot;
    };
    const before = model.metrics;
    const release = model.onChange(() => observations.push({ status: model.snapshot().status, targetName: model.snapshot({ id }).rows[0]?.meta.name }));
    // Isolate one actual source observation. Public reconcile also captures a
    // coordinator snapshot before reading files, which is not this fault boundary.
    await (model as any).scan([metaPath, siblingPath]);
    assert.equal((model as any).repair, repairCursor, 'publication invalidation must not restart existing historical repair');
    assert.equal((model as any).imported, true, 'previously imported history must not be reset');
    assert.equal(injections, 1);
    assert.ok(observations.some(value => value.status === 'degraded'), 'invalidated publication must expose degradation');
    assert.ok(observations.every(value => value.targetName !== 'unpublished-raw'), 'unverified staged metadata must never publish');
    if (rootUnavailable) {
      const retained = model.snapshot({ id }).rows[0];
      assert.ok(retained, 'unavailable root must retain the last verified row');
      assert.equal(retained.meta.name, original.name);
      assert.equal(model.snapshot().status, 'degraded');
      renameSync(manifest.runs + '-away', manifest.runs);
      rmSync(raw, { recursive: true });
      // Existing bounded source repair, not a fabricated verification receipt.
      model.fileHint(manifest.runs);
    }
    let turns = 0;
    for (; turns < 8 && model.snapshot({ id }).rows[0]?.meta.name !== 'verified-archive'; turns++) await model.reconcile(false);
    while ((model as any).pending) await (model as any).pending;
    const final = model.snapshot({ cwd: root, limit: 10 });
    const target = model.snapshot({ id }).rows[0], progressedSibling = model.snapshot({ id: siblingId }).rows[0];
    t.diagnostic(JSON.stringify({ rootUnavailable, activeRepair, turns, status: final.status, reason: final.reason, inventories: model.metrics.inventories - before.inventories, repairEntries: model.metrics.scheduling.repairEntries - before.scheduling.repairEntries, target: target?.meta.name, sibling: progressedSibling?.meta.name, total: final.totalMatching }));
    assert.equal(final.status, 'ready', final.reason);
    assert.equal(target?.meta.name, 'verified-archive', 'lost archive hint must not strand the invalidated publication');
    assert.equal(progressedSibling?.meta.name, 'sibling-progress');
    assert.equal(final.totalMatching, group);
    assert.ok(model.metrics.scheduling.repairEntries - before.scheduling.repairEntries <= 8 * 128, 'recovery retains existing per-turn repair budget');
    assert.ok(model.metrics.scheduling.repairEntries - before.scheduling.repairEntries <= (model.metrics.scheduling.repairBatches - before.scheduling.repairBatches) * 128);
    release();
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});
