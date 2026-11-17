import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workloadCounterDelta, reconcileWorkload } from '../scripts/measure-full-runtime/incremental-workload.mjs';
import { threadId } from 'node:worker_threads';
import { createRequire } from 'node:module';
import ts from 'typescript';

test('approved baseline real parser modules reread and refold after eviction of their exact loaded caches', async () => {
  const adapter = await import('../scripts/measure-full-runtime/baseline-observation.mjs');
  const restoreFs = adapter.installBaselineFsObservation();
  const root = mkdtempSync(join(tmpdir(), '808-baseline-observation-'));
  const log = join(root, 'output.log');
  writeFileSync(log, JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'actual baseline' }] } }) + '\n');
  const urls: Record<string, string> = {};
  let model: any;
  const load = async (name: string) => {
    const modelSource = name === 'read-model';
    let source = execFileSync('git', ['show', `eec7b3e256a7548bbf67f69cd468f12eb3b91dc8:packages/pi-better-server/src/runtime/${modelSource ? 'read-model.ts' : `domain/${name}.mjs`}`], { encoding: 'utf8' });
    source = adapter.instrumentBaselineModule(source, name);
    source = source.replace(/from "(\.\.?\/[^\"]+)"/g, (_: string, path: string) => {
      const dependency = path.split('/').at(-1)!.replace(/\.(mjs|ts)$/, '');
      return `from ${JSON.stringify(urls[dependency] ?? new URL(path, new URL(`../src/runtime/${modelSource ? '' : 'domain/'}`, import.meta.url)).href)}`;
    });
    if (modelSource) {
      // The component module uses a data URL; only Node's builtin require needs a file-backed resolution parent.
      source = source.replace('createRequire(import.meta.url)("node:sqlite")', `createRequire(${JSON.stringify(import.meta.url)})("node:sqlite")`);
      source = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    }
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    urls[name] = url;
    return import(url);
  };
  try {
    await load('shared-log-utils'); await load('log-cursor');
    const parse = await load('parse'), health = await load('health-observation');
    const { WorkReadModel } = await load('read-model');
    const run = join(root, 'runs', 'inventory'); mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'output.log'), '');
    writeFileSync(join(run, 'meta.json'), JSON.stringify({ id: 'inventory', cwd: root, sessionId: '808-group', status: 'completed', startedAt: 1, callback: false }));
    model = new WorkReadModel(root, 'baseline-component', { baseDir: root, durableDir: join(root, 'durable'), intervalMs: 60000 });
    await model.reconcile();
    const other = join(root, 'unattributed.json'); writeFileSync(other, 'uncategorized source work');
    readFileSync(other);
    const expected = Object.values(urls);
    const observe = () => adapter.baselineObservation(expected);
    parse.parseRun('baseline', { logPath: log }); health.extractChildEventFactsFromLog('baseline', { logPath: log });
    const cold = observe();
    assert.equal(cold.complete, true); assert.equal(cold.durableCheckpoints, false);
    assert.equal(cold.threadId, threadId); assert.deepEqual(cold.moduleUrls, expected);
    assert.ok(cold.sourceWork.sources.uncategorized.otherReadBytes >= Buffer.byteLength('uncategorized source work'));
    assert.ok(cold.logReads.bytes > 0); assert.ok(cold.logReads.displayFolded > 0); assert.ok(cold.logReads.healthFolded > 0);
    parse.parseRun('baseline', { logPath: log });
    const warm = observe(); assert.equal(warm.logReads.displayFolded, cold.logReads.displayFolded);
    const details = new Map([['baseline', { revision: 'same', value: {} }]]);
    adapter.evictBaselineParsers(expected, { details });
    assert.equal(details.size, 0);
    const evicted = observe(); assert.equal(evicted.hotDisplay, 0); assert.equal(evicted.hotHealth, 0);
    assert.equal(parse.parseRun('baseline', { logPath: log }).finalText, 'actual baseline');
    health.extractChildEventFactsFromLog('baseline', { logPath: log });
    const restored = observe();
    assert.ok(restored.logReads.bytes > evicted.logReads.bytes);
    assert.ok(restored.logReads.displayFolded > evicted.logReads.displayFolded);
    assert.ok(restored.logReads.healthFolded > evicted.logReads.healthFolded);
    assert.equal(restored.threadId, cold.threadId);
    const delta: any = workloadCounterDelta({ ...model.metrics, baselineObservation: evicted, logReads: evicted.logReads }, { ...model.metrics, baselineObservation: restored, logReads: restored.logReads });
    assert.ok(delta.logs.bytes > 0); assert.ok(delta.logs.displayFolded > 0); assert.ok(delta.logs.healthFolded > 0);
    assert.equal(delta.ordinary, null); assert.equal(delta.repair, null); assert.equal(delta.complete, true);
    assert.equal(delta.accounting, 'baseline-inventory');
    assert.ok(delta.total.stats >= 0); assert.ok(delta.total.metadataReads >= 0);
    assert.ok(restored.sourceWork.total.batches > 0); assert.ok(restored.sourceWork.total.metadataReads > 0);
    assert.ok(restored.sourceWork.total.stats > 0); assert.ok(restored.sourceWork.total.projections > 0);
    const hidden = structuredClone(restored); hidden.sourceWork.total.stats++;
    assert.throws(() => workloadCounterDelta({ ...model.metrics, baselineObservation: evicted, logReads: evicted.logReads }, { ...model.metrics, baselineObservation: hidden, logReads: hidden.logReads }), /Hidden baseline source work/);
    assert.throws(() => adapter.evictBaselineParsers([pathToFileURL(join(root, 'wrong-copy.mjs')).href], { details }), /exact loaded/);
    rmSync(join(run, 'output.log')); await model.reconcile();
    const missing: any = await reconcileWorkload({ get: async (scope: any) => model.snapshot(scope) }, root,
      { history: 0, tasks: [{ id: 'inventory', logState: 'missing', finalText: '', costUSD: 0, input: 0, output: 0 }] } as any, { baseline: true });
    assert.equal(missing.results[0].costUSD, null); assert.equal(missing.results[0].sourceCompleteness, 'unavailable');
    const { open } = await import('node:fs/promises');
    const handle = await open(other, 'r'); await handle.close();
    const incomplete = observe();
    assert.equal(incomplete.sourceWork.complete, false);
    assert.equal(incomplete.sourceWork.unavailable.open, 1);
    assert.throws(() => workloadCounterDelta({ ...model.metrics, baselineObservation: incomplete, logReads: incomplete.logReads }, { ...model.metrics, baselineObservation: incomplete, logReads: incomplete.logReads }), /Incomplete baseline inventory total/);
  } finally { await model?.close(); restoreFs(); rmSync(root, { recursive: true, force: true }); }
});

test('original executor queue observations use actual queued timestamps and observed empty membership', async () => {
  const { instrumentBaselineQueue } = await import('../scripts/measure-full-runtime/baseline-observation.mjs');
  const source = instrumentBaselineQueue(execFileSync('git', ['show', 'eec7b3e256a7548bbf67f69cd468f12eb3b91dc8:packages/pi-better-server/src/runtime/query-executor.ts'], { encoding: 'utf8' }));
  const tree = ts.createSourceFile('executor.ts', source, ts.ScriptTarget.Latest, true);
  let method = '';
  const visit = (node: ts.Node) => { if (ts.isMethodDeclaration(node) && node.name.getText(tree) === 'metrics') method = node.getText(tree); ts.forEachChild(node, visit); };
  visit(tree);
  const metrics = new Function('performance', `return function ${method}`)({ now: () => 1000 });
  const owner = { queue: [{ enqueued: 900 }, { enqueued: 700 }], options: {}, streams: new Map(), waits: [], durations: [], lag: { percentile: () => 0 } };
  assert.equal(metrics.call(owner).executor.oldestQueuedAgeMs, 300);
  owner.queue.length = 0; assert.equal(metrics.call(owner).executor.oldestQueuedAgeMs, 0);
});

test('retiring the baseline observer preserves filesystem aliases captured by existing readers', async () => {
  const { installBaselineFsObservation } = await import('../scripts/measure-full-runtime/baseline-observation.mjs');
  const root = mkdtempSync(join(tmpdir(), 'baseline-observer-alias-')), path = join(root, 'source.json');
  writeFileSync(path, 'actual reader');
  const restore = installBaselineFsObservation();
  const captured = createRequire(import.meta.url)('node:fs').readFileSync;
  restore();
  try { assert.equal(captured(path, 'utf8'), 'actual reader'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('a retired observer cannot unregister a newer bound observer', async () => {
  const { installBaselineFsObservation } = await import('../scripts/measure-full-runtime/baseline-observation.mjs');
  const fs = createRequire(import.meta.url)('node:fs');
  const first = installBaselineFsObservation(); first();
  const second = installBaselineFsObservation(), actualBoundRead = fs.readFileSync;
  try {
    first();
    assert.equal(fs.readFileSync, actualBoundRead, 'old cleanup must not replace the actual current observer');
    assert.throws(() => installBaselineFsObservation(), /already installed/, 'current instrumentation remains registered');
  } finally { second(); }
});
