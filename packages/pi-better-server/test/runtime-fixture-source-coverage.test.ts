import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkReadModel } from '../src/runtime/read-model.ts';

test('metadata-only publication fixture requires a real log source before ready subscription coverage', async () => {
  const root = mkdtempSync(join(tmpdir(), '808-fixture-coverage-'));
  const id = 'sa_event_publication', run = join(root, 'runs', id);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'meta.json'), JSON.stringify({ id, cwd: root, status: 'completed', startedAt: 1, endedAt: 2,
    sessionId: 'worker', callbackOrigin: { cwd: root, sessionId: 'parent' }, name: 'original' }));
  const watch = (() => Object.assign(new EventEmitter(), { close() {}, ready: Promise.resolve() })) as any;
  const model = new WorkReadModel(root, 'fixture-coverage', { baseDir: root, durableDir: join(root, 'archive'), intervalMs: 60000, watch });
  const scope = { cwd: root, sessionId: 'parent', limit: 10 };
  try {
    await model.reconcile();
    assert.equal(model.snapshot(scope).status, 'degraded');
    assert.match(model.snapshot(scope).reason!, /Log source unavailable/);
    const incomplete = model.snapshot(scope).rows[0] as any;
    assert.equal(incomplete.display!.coverage.complete, false);
    writeFileSync(join(run, 'output.log'), '');
    model.fileHint(run, 'output.log'); await model.reconcile();
    const verified = model.snapshot(scope);
    assert.equal(verified.status, 'ready', verified.reason);
    assert.equal(verified.rows[0]!.meta.name, 'original');
    const coverage = (verified.rows[0] as any).display.coverage;
    assert.equal(coverage.complete, true);
    assert.equal(coverage.totalBytes, 0);
    assert.equal(coverage.offset, 0);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});
