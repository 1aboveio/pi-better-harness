import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkReadModel } from '../src/runtime/read-model.ts';
import { workloadCounterDelta } from '../scripts/measure-full-runtime/incremental-workload.mjs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

test('detail reads belong to candidate TOTAL exactly once, including warm cache reuse', async t => {
  const root = mkdtempSync(join(tmpdir(), '808-accounting-'));
  const dir = join(root, 'runs', 'task'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: 'task', cwd: root, sessionId: 'worker', status: 'completed', startedAt: 1, callback: false }));
  writeFileSync(join(dir, 'output.log'), JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'actual detail bytes' }] } }) + '\n');
  const sibling = join(root, 'runs', 'sibling'); mkdirSync(sibling);
  writeFileSync(join(sibling, 'meta.json'), JSON.stringify({ id: 'sibling', cwd: root, sessionId: 'worker', status: 'completed', startedAt: 1, callback: false }));
  writeFileSync(join(sibling, 'output.log'), JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'interleaved detail' }] } }) + '\n');
  const watch = (_path: string, listener: (...args: any[]) => void) => {
    const value: any = new EventEmitter(); value.on('change', listener); value.ready = Promise.resolve(); value.close = () => {}; return value;
  };
  const model = new WorkReadModel(root, 'accounting', { baseDir: root, durableDir: join(root, 'durable'), intervalMs: 60000, watch });
  try {
    await model.reconcile();
    const before = model.metrics;
    assert.equal((model.snapshot({ id: 'task', detail: true }).rows[0] as any).detail.parsed.finalText, 'actual detail bytes');
    const after = model.metrics, delta = workloadCounterDelta(before, after);
    assert.ok(delta.logs.bytes > 0);
    assert.equal(delta.total.logBytes, delta.logs.bytes);
    assert.equal(delta.total.logReads, delta.logs.reads);
    model.snapshot({ id: 'task', detail: true });
    assert.equal(workloadCounterDelta(after, model.metrics).total.logBytes, 0);
    const missing = structuredClone(after); missing.sourceWork.entity.logBytes--;
    assert.throws(() => workloadCounterDelta(before, missing), /account|counter/i);
    const missingRead = structuredClone(after); missingRead.sourceWork.entity.logReads--;
    assert.throws(() => workloadCounterDelta(before, missingRead), /Unaccounted candidate log reads/);
    const io = createRequire(import.meta.url)('node:fs/promises'), stat = io.stat;
    let held!: () => void, release!: () => void, armed = true;
    const entered = new Promise<void>(resolve => { held = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(io, 'stat', async (...args: any[]) => {
      if (armed && String(args[0]).endsWith('meta.json')) { armed = false; held(); await gate; }
      return stat(...args);
    });
    syncBuiltinESMExports();
    const scan = model.reconcile(); await entered;
    const interleavedBefore = model.metrics;
    try { assert.equal((model.snapshot({ id: 'sibling', detail: true }).rows[0] as any).detail.parsed.finalText, 'interleaved detail'); }
    finally { release(); }
    await scan;
    const interleaved = workloadCounterDelta(interleavedBefore, model.metrics);
    assert.ok(interleaved.logs.bytes > 0);
    assert.equal(interleaved.total.logBytes, interleaved.logs.bytes, 'async repair cannot double-count an interleaved detail read');
    assert.equal(interleaved.total.logReads, interleaved.logs.reads);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await model.close(); rmSync(root, { recursive: true, force: true }); }
});
