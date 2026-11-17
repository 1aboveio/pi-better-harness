import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { seedWorkload, mutateWorkload, workloadCounterDelta, reconcileWorkload } from '../scripts/measure-full-runtime/incremental-workload.mjs';
import { parseRun, encodeParseLogState, decodeParseLogState } from '../src/runtime/domain/parse.mjs';
import { LogCheckpoints } from '../src/runtime/log-checkpoints.ts';
import { WorkReadModel } from '../src/runtime/read-model.ts';
const { openStore } = await import(new URL('../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs', import.meta.url).href);

test('existing external file writer returns source-byte receipts and preserves its legacy metadata path', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-writer-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group: 48, clients: 1, durationMs: 600000, baseline: '' } });
  const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
  const children: ReturnType<typeof fork>[] = [];
  const start = async (args: string[]) => {
    const child = fork(new URL('../scripts/event-publication/writer.mjs', import.meta.url), args,
      { execArgv: ['--import', 'tsx'], env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    assert.equal((await once(child, 'message'))[0].ready, true);
    return child;
  };
  try {
    const child = await start([manifestPath, '--incremental-workload']);
    const pending = once(child, 'message');
    child.send({ id: 7, mutation: { kind: 'append', id: manifest.tasks[0]!.id, cents: 2, text: 'external writer bytes' } });
    const [receipt] = await pending;
    assert.equal(receipt.id, 7); assert.equal(receipt.error, undefined);
    assert.ok(receipt.result.afterBytes > receipt.result.beforeBytes);
    const parsed = parseRun(manifest.tasks[0]!.id, { logPath: join(manifest.runs, manifest.tasks[0]!.id, 'output.log') });
    assert.equal(parsed.finalText, 'external writer bytes'); assert.equal(parsed.usage.costUSD, 0.03);
    const metaPath = join(manifest.runs, manifest.tasks[1]!.id, 'meta.json');
    const legacy = await start([metaPath]);
    const committed = once(legacy, 'message'); legacy.send({ marker: 'legacy-still-works' });
    assert.equal((await committed)[0].marker, 'legacy-still-works');
    assert.equal(JSON.parse(readFileSync(metaPath, 'utf8')).name, 'legacy-still-works');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

for (const group of [48, 96, 192]) test(`${group} workload logs preserve real usage through append, checkpoint restore and source faults`, () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-mutations-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group, clients: 1, durationMs: 600000, baseline: '' } });
  const states = new Map();
  const checkpoints = new LogCheckpoints(join(root, 'checkpoint.sqlite'));
  try {
    for (const task of manifest.tasks) {
      const path = join(manifest.runs, task.id, 'output.log');
      const parsed = parseRun(task.id, { logPath: path, states, summaryOnly: true });
      assert.equal(parsed.usage.costUSD, 0.01);
      checkpoints.save(path, encodeParseLogState(states.get(path)));
    }
    states.clear();
    const task = manifest.tasks[0]!, path = join(manifest.runs, task.id, 'output.log');
    states.set(path, decodeParseLogState(checkpoints.load(path)));
    const before = readFileSync(path);
    const receipt = mutateWorkload(manifest, { kind: 'append', id: task.id, cents: 2, text: 'actual appended event' });
    assert.equal(receipt.afterBytes - receipt.beforeBytes, receipt.appendedBytes);
    assert.deepEqual(readFileSync(path).subarray(0, before.length), before);
    let parsed = parseRun(task.id, { logPath: path, states, summaryOnly: true });
    assert.equal(parsed.usage.costUSD, 0.03); assert.equal(parsed.usage.input, 14); assert.equal(parsed.usage.output, 20);
    assert.equal(parseRun(task.id, { logPath: path }).finalText, 'actual appended event');
    assert.equal(parseRun(task.id, { logPath: path, states, summaryOnly: true }).usage.costUSD, 0.03, 'unchanged access must not bill twice');
    mutateWorkload(manifest, { kind: 'replace-log', id: task.id, cents: 5, text: 'replacement generation' });
    parsed = parseRun(task.id, { logPath: path, states, summaryOnly: true });
    assert.equal(parsed.usage.costUSD, 0.05); assert.equal(parsed.usage.input, 11);
    assert.equal(parseRun(task.id, { logPath: path }).finalText, 'replacement generation');
    mutateWorkload(manifest, { kind: 'truncate-log', id: task.id });
    assert.equal(parseRun(task.id, { logPath: path, states, summaryOnly: true }).usage.costUSD, 0);
    mutateWorkload(manifest, { kind: 'delete-log', id: task.id });
    assert.equal(parseRun(task.id, { logPath: path, states, summaryOnly: true }).usage.costUSD, 0);
    for (const sibling of manifest.tasks.slice(1)) {
      const logPath = join(manifest.runs, sibling.id, 'output.log');
      states.set(logPath, decodeParseLogState(checkpoints.load(logPath)));
      assert.equal(parseRun(sibling.id, { logPath, states, summaryOnly: true }).usage.costUSD, 0.01);
    }
  } finally { checkpoints.close(); rmSync(root, { recursive: true, force: true }); }
});

test('settings mutations and exact task identity retain separate actual ordinary/repair counters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-counts-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group: 48, clients: 1, durationMs: 600000, baseline: '' } });
  const settingsPath = join(manifest.agent, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ theme: 'light' }));
  const model = new WorkReadModel(manifest.agent, 'component-counts', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  try {
    await model.reconcile();
    const before = model.metrics;
    const rewrite = mutateWorkload(manifest, { kind: 'same-settings' });
    assert.equal(rewrite.beforeDigest, rewrite.afterDigest);
    mutateWorkload(manifest, { kind: 'theme', theme: 'dark' });
    await model.reconcile();
    const delta = workloadCounterDelta(before, model.metrics);
    assert.equal(delta.logs.bytes, 0); assert.equal(delta.projections.logProjections, 0);
    assert.ok(delta.repair.batches > 0, 'explicit source reconciliation remains separately measured repair work');
    for (const key of ['batches', 'paths', 'stats', 'metadataReads', 'logBytes', 'logReads']) {
      const afterWork = model.metrics.sourceWork as any, beforeWork = before.sourceWork as any;
      assert.equal(delta.total[key], afterWork.entity[key] + afterWork.repair[key] - beforeWork.entity[key] - beforeWork.repair[key]);
    }
    assert.throws(() => workloadCounterDelta({}, model.metrics), /Missing\/reset counter/);
    assert.throws(() => mutateWorkload(manifest, { kind: 'append', id: 'foreign-task', cents: 1, text: 'no' }), /exact fixture task/);
    assert.throws(() => mutateWorkload(manifest, { kind: 'append', id: manifest.tasks[0]!.id, cents: -1, text: 'no' }), /positive integer cents/);
    const task = manifest.tasks[0]!, metaPath = join(manifest.runs, task.id, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    writeFileSync(metaPath, JSON.stringify({ ...meta, cwd: root + '/foreign' }));
    const beforeLog = readFileSync(join(manifest.runs, task.id, 'output.log'));
    assert.throws(() => mutateWorkload(manifest, { kind: 'append', id: task.id, cents: 1, text: 'no' }));
    assert.deepEqual(readFileSync(join(manifest.runs, task.id, 'output.log')), beforeLog);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test('component reconciliation checks real projected identities, complete history pages and final usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-reconcile-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 17, group: 48, clients: 1, durationMs: 600000, baseline: '' } });
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  const model = new WorkReadModel(manifest.agent, 'reconcile-component', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  // This adapter executes actual in-process projections; it is not a socket or native-session proof.
  const source = { get: async (scope: any) => model.snapshot(scope) };
  try {
    await model.reconcile();
    const result = await reconcileWorkload(source, root, manifest) as any;
    assert.equal(result.history, 17); assert.equal(result.results.length, 48);
    await assert.rejects(reconcileWorkload(source, root, { ...manifest, tasks: [{ ...manifest.tasks[0]!, id: manifest.tasks[1]!.id }] }), /final result/);
    await assert.rejects(reconcileWorkload(source, root, { ...manifest, history: 18 }));
    await assert.rejects(reconcileWorkload(source, root, { ...manifest, tasks: [{ ...manifest.tasks[0]!, input: 4 }] }));
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test('component source changes preserve unrelated scope revisions and historical cursors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-scopes-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group: 48, clients: 1, durationMs: 600000, baseline: '' } });
  const a = join(root, 'scope-a'), b = join(root, 'scope-b');
  for (const [i, task] of manifest.tasks.entries()) {
    const path = join(manifest.runs, task.id, 'meta.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), cwd: i < 24 ? a : b }));
  }
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  const model = new WorkReadModel(manifest.agent, 'scope-component', { baseDir: join(root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  try {
    await model.reconcile();
    const scopeA = { cwd: a, active: false, limit: 5 }, scopeB = { cwd: b, active: false, limit: 5 };
    const firstA = model.snapshot(scopeA), firstB = model.snapshot(scopeB);
    assert.equal(firstA.totalMatching, 24); assert.equal(firstB.totalMatching, 24);
    const pageB = model.snapshot({ ...scopeB, cursor: firstB.nextCursor });
    const before = model.metrics;
    const task = manifest.tasks[0]!;
    mutateWorkload({ ...manifest, cwd: a }, { kind: 'append', id: task.id, cents: 2, text: 'scope-a-only' });
    model.fileHint(join(manifest.runs, task.id), 'output.log');
    await model.reconcile(false);
    const after = model.metrics;
    assert.equal(model.snapshot(scopeB).scopeRevision, firstB.scopeRevision);
    assert.deepEqual(model.snapshot({ ...scopeB, cursor: firstB.nextCursor }).rows, pageB.rows);
    assert.notEqual(model.snapshot(scopeA).scopeRevision, firstA.scopeRevision);
    const delta = workloadCounterDelta(before, after);
    assert.equal(delta.projections.logProjections, 1); assert.equal(delta.logs.displayFolded, 1); assert.equal(delta.logs.healthFolded, 1);
    assert.equal((model.snapshot({ id: task.id, detail: true }).rows[0] as any).detail.parsed.finalText, 'scope-a-only');
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});
