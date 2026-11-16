import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkReadModel } from '../src/runtime/read-model.ts';
import { seedWorkload, mutateWorkload, reconcileWorkload } from '../scripts/measure-full-runtime/incremental-workload.mjs';
const { openStore } = await import(new URL('../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs', import.meta.url).href);

for (const empty of [true, false]) test(`deleted ${empty ? 'empty' : 'nonempty'} log is unavailable, never complete; verified facts and recovery survive`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'p808-coverage-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group: 2, clients: 1, durationMs: 600000, baseline: '' } });
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  const id = manifest.tasks[0]!.id, directory = join(manifest.runs, id), log = join(directory, 'output.log');
  if (empty) writeFileSync(log, '');
  const original = readFileSync(log);
  const model = new WorkReadModel(manifest.agent, 'coverage-component', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  const row = () => model.snapshot({ id }).rows[0] as any;
  try {
    await model.reconcile();
    const verified = row(), counters = model.metrics;
    assert.equal(model.snapshot().status, 'ready'); assert.equal(verified.display.coverage.complete, true);
    const sibling = model.snapshot({ id: manifest.tasks[1]!.id }).rows[0]!.sourceRevision;
    unlinkSync(log); model.fileHint(directory, 'output.log'); await model.reconcile(false);
    const missing = row(), detail = model.snapshot({ id, detail: true }).rows[0] as any;
    t.diagnostic(JSON.stringify({ empty, complete: missing.display.coverage.complete, status: model.snapshot().status, detailDiagnostics: detail.detail.parsed.diagnostics }));
    assert.equal(missing.display.coverage.complete, false, 'ENOENT source cannot be complete even at offset0/total0');
    assert.equal(model.snapshot().status, 'degraded');
    assert.equal(missing.display.spend, verified.display.spend, 'do not replace last verified usage with invented zero');
    assert.deepEqual(missing.health.facts, verified.health.facts);
    assert.ok(missing.health.rawLog.error); assert.ok(missing.display.coverage.error);
    assert.ok(detail.detail.parsed.diagnostics.some((message: string) => message.includes('ENOENT')));
    assert.equal(model.metrics.checkpoints.commits, counters.checkpoints.commits, 'unavailable source cannot overwrite a verified checkpoint');
    assert.equal(model.metrics.logReads.bytes, counters.logReads.bytes, 'missing source does not read any sibling log');
    assert.equal(model.metrics.metadataReads, counters.metadataReads, 'unavailability does not reload unchanged metadata');
    assert.equal(model.metrics.logProjections - counters.logProjections, 1, 'only the changed log projection is touched');
    assert.equal(model.snapshot({ id: manifest.tasks[1]!.id }).rows[0]!.sourceRevision, sibling);
    writeFileSync(log, original); model.fileHint(directory, 'output.log'); await model.reconcile(false);
    assert.equal(model.snapshot().status, 'ready'); assert.equal(row().display.coverage.complete, true);
    assert.equal(row().display.spend, verified.display.spend);
    assert.equal((model.snapshot({ id, detail: true }).rows[0] as any).detail.parsed.usage.costUSD, empty ? 0 : 0.01);
    rmSync(directory, { recursive: true }); model.fileHint(manifest.runs, id); await model.reconcile(false);
    assert.equal(model.snapshot({ id }).rows.length, 0, 'verified task-directory deletion remains deletion');
    assert.equal(model.snapshot().status, 'ready');
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unreadable log retains last verified row, empty truncation and inode replacement still recover', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-unreadable-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group: 1, clients: 1, durationMs: 600000, baseline: '' } });
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  const id = manifest.tasks[0]!.id, directory = join(manifest.runs, id), log = join(directory, 'output.log');
  const original = readFileSync(log), model = new WorkReadModel(manifest.agent, 'read-error-component', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  const row = () => model.snapshot({ id }).rows[0] as any;
  try {
    await model.reconcile(); const spend = row().display.spend;
    renameSync(log, log + '.retained'); mkdirSync(log);
    model.fileHint(directory, 'output.log'); await model.reconcile(false);
    assert.equal(row().display.coverage.complete, false); assert.equal(model.snapshot().status, 'degraded');
    assert.equal(row().display.spend, spend);
    rmSync(log, { recursive: true }); writeFileSync(log, '');
    model.fileHint(directory, 'output.log'); await model.reconcile(false);
    assert.equal(model.snapshot().status, 'ready'); assert.equal(row().display.coverage.complete, true);
    assert.equal(row().display.coverage.totalBytes, 0); assert.equal(row().display.spend, '');
    writeFileSync(log + '.replacement', original); renameSync(log + '.replacement', log);
    model.fileHint(directory, 'output.log'); await model.reconcile(false);
    assert.equal(model.snapshot().status, 'ready'); assert.equal(row().display.coverage.complete, true);
    assert.equal((model.snapshot({ id, detail: true }).rows[0] as any).detail.parsed.usage.costUSD, 0.01);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unavailable source cannot rewrite a durable fold across derived-reader reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-checkpoint-source-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group: 1, clients: 1, durationMs: 600000, baseline: '' } });
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  const id = manifest.tasks[0]!.id, directory = join(manifest.runs, id), log = join(directory, 'output.log'), original = readFileSync(log);
  const create = () => new WorkReadModel(manifest.agent, 'checkpoint-source-component', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  let model = create();
  try {
    await model.reconcile(); const saved = (model as any).checkpoints.load(log);
    unlinkSync(log); model.fileHint(directory, 'output.log'); await model.reconcile(false);
    assert.deepEqual((model as any).checkpoints.load(log), saved);
    await model.close(); model = create(); await model.reconcile();
    assert.equal(model.snapshot().status, 'degraded');
    assert.equal((model.snapshot({ id }).rows[0] as any).display.coverage.complete, false);
    assert.equal(model.metrics.checkpoints.commits, 0);
    assert.deepEqual((model as any).checkpoints.load(log), saved);
    writeFileSync(log, original); model.fileHint(directory, 'output.log'); await model.reconcile(false);
    assert.equal(model.snapshot().status, 'ready');
    assert.equal((model.snapshot({ id, detail: true }).rows[0] as any).detail.parsed.usage.costUSD, 0.01);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test('never-observed missing source is degraded and does not create a complete checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-first-source-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group: 1, clients: 1, durationMs: 600000, baseline: '' } });
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  const id = manifest.tasks[0]!.id, log = join(manifest.runs, id, 'output.log');
  unlinkSync(log);
  const model = new WorkReadModel(manifest.agent, 'first-source-component', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  try {
    await model.reconcile();
    assert.equal(model.snapshot().status, 'degraded');
    assert.equal((model.snapshot({ id }).rows[0] as any).display.coverage.complete, false);
    assert.equal(model.metrics.checkpoints.commits, 0);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test('verified archive-only membership does not promise or require deleted raw-log coverage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-archive-source-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group: 1, clients: 1, durationMs: 600000, baseline: '' } });
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  const id = manifest.tasks[0]!.id, directory = join(manifest.runs, id);
  const model = new WorkReadModel(manifest.agent, 'archive-source-component', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  try {
    await model.reconcile();
    const meta = JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8'));
    writeFileSync(join(manifest.durable, 'attempts', `${id}.json`), JSON.stringify({ version: 1, meta }));
    model.fileHint(join(manifest.durable, 'attempts'), `${id}.json`);
    await model.reconcile(false);
    while ((model as any).pending) await (model as any).pending;
    assert.equal(model.snapshot().status, 'ready', model.snapshot().reason);
    rmSync(directory, { recursive: true });
    model.fileHint(manifest.runs, id);
    await model.reconcile(false);
    while ((model as any).pending) await (model as any).pending;
    assert.equal(model.snapshot().status, 'ready', model.snapshot().reason);
    const archived = model.snapshot({ id }).rows[0] as any;
    assert.equal(archived.meta.id, id); assert.equal(archived.health, undefined);
    assert.equal(archived.display.coverage, undefined);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test('missing-source reconciliation accepts only the expected degradation, never unrelated malformed metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-source-status-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group: 2, clients: 1, durationMs: 600000, baseline: '' } });
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  const model = new WorkReadModel(manifest.agent, 'source-status-component', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  const client = { get: async (scope: any) => model.snapshot(scope) };
  try {
    await model.reconcile(); const task = manifest.tasks[0]!;
    Object.assign(task, mutateWorkload(manifest, { kind: 'delete-log', id: task.id }).expected);
    model.fileHint(join(manifest.runs, task.id), 'output.log'); await model.reconcile(false);
    const observed = await reconcileWorkload(client, root, manifest) as any;
    assert.equal(observed.results[0].sourceCompleteness, 'unavailable'); assert.equal(observed.results[0].costUSD, null);
    const sibling = manifest.tasks[1]!, directory = join(manifest.runs, sibling.id);
    writeFileSync(join(directory, 'meta.json'), 'null'); model.fileHint(directory, 'meta.json'); await model.reconcile(false);
    await assert.rejects(reconcileWorkload(client, root, manifest), /Only the expected missing-log degradation/);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});
