import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkReadModel } from '../src/runtime/read-model.ts';
import { acquireMutationStore } from '../src/runtime/mutation-store.ts';
import { EventEmitter } from 'node:events';

test('control and query owners retain distinct real physical SQLite handles', async () => {
  const root = mkdtempSync(join(tmpdir(), '808-physical-'));
  const sqlite = createRequire(import.meta.url)('node:sqlite'), Original = sqlite.DatabaseSync;
  const handles: any[] = [];
  sqlite.DatabaseSync = class extends Original { constructor(...args: any[]) { super(...args); handles.push(this); } };
  const control = acquireMutationStore(root);
  const mainCount = handles.length;
  const watch = (_path: string, listener: (...args: any[]) => void) => {
    const value: any = new EventEmitter(); value.on('change', listener); value.ready = Promise.resolve(); value.close = () => {}; return value;
  };
  const model = new WorkReadModel(root, 'query-owner', { baseDir: root, durableDir: join(root, 'durable'), intervalMs: 60000, watch });
  try {
    await model.reconcile();
    assert.equal(mainCount, 1);
    assert.notEqual((model as any).db, (model as any).reader.connection(false));
    const query = handles.slice(mainCount);
    assert.equal(query.length, 1, 'query opens only its shared derived owner; canonical reads use its readonly attachment');
    assert.ok(query.includes((model as any).db));
    assert.equal(query.includes((model as any).reader.connection(false)), false, 'the source facade is not a hidden DatabaseSync');
    const attachments = (model as any).db.prepare('PRAGMA database_list').all();
    assert.equal(attachments.find((row: any) => row.name === 'coordinator_source').file, join(root, 'operation-coordinator.sqlite'));
    assert.equal(handles.length, mainCount + query.length, 'every main/query physical handle remains accounted');
    assert.equal(handles.length, 2, 'the actual mutation owner and derived source owner compose on exactly two physical handles');
  } finally { await model.close(); control.release(); sqlite.DatabaseSync = Original; rmSync(root, { recursive: true, force: true }); }
});
