import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workloadCounterDelta } from '../scripts/measure-full-runtime/incremental-workload.mjs';
import { threadId } from 'node:worker_threads';

test('approved baseline real parser modules reread and refold after eviction of their exact loaded caches', async () => {
  const adapter = await import('../scripts/measure-full-runtime/baseline-observation.mjs');
  const root = mkdtempSync(join(tmpdir(), '808-baseline-observation-'));
  const log = join(root, 'output.log');
  writeFileSync(log, JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'actual baseline' }] } }) + '\n');
  const urls: Record<string, string> = {};
  const load = async (name: string) => {
    let source = execFileSync('git', ['show', `eec7b3e256a7548bbf67f69cd468f12eb3b91dc8:packages/pi-better-server/src/runtime/domain/${name}.mjs`], { encoding: 'utf8' });
    source = adapter.instrumentBaselineModule(source, name);
    source = source.replace(/from "(\.\/[^\"]+)"/g, (_: string, path: string) => {
      const dependency = path.slice(2, -4);
      return `from ${JSON.stringify(urls[dependency] ?? new URL(`../src/runtime/domain/${path.slice(2)}`, import.meta.url).href)}`;
    });
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    urls[name] = url;
    return import(url);
  };
  try {
    await load('shared-log-utils'); await load('log-cursor');
    const parse = await load('parse'), health = await load('health-observation');
    const expected = Object.values(urls);
    const observe = () => adapter.baselineObservation(expected);
    parse.parseRun('baseline', { logPath: log }); health.extractChildEventFactsFromLog('baseline', { logPath: log });
    const cold = observe();
    assert.equal(cold.complete, true); assert.equal(cold.durableCheckpoints, false);
    assert.equal(cold.threadId, threadId); assert.deepEqual(cold.moduleUrls, expected);
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
    const delta: any = workloadCounterDelta({ projections: 1, baselineObservation: evicted, logReads: evicted.logReads }, { projections: 2, baselineObservation: restored, logReads: restored.logReads });
    assert.ok(delta.logs.bytes > 0); assert.ok(delta.logs.displayFolded > 0); assert.ok(delta.logs.healthFolded > 0);
    assert.equal(delta.ordinary, null); assert.equal(delta.repair, null); assert.equal(delta.complete, false);
    assert.throws(() => adapter.evictBaselineParsers([pathToFileURL(join(root, 'wrong-copy.mjs')).href], { details }), /exact loaded/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
