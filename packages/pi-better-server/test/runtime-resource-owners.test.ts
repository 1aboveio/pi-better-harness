import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkReadModel } from '../src/runtime/read-model.ts';
import { acquireMutationStore } from '../src/runtime/mutation-store.ts';

test('control and query owners retain distinct real physical SQLite handles', async () => {
  const root = mkdtempSync(join(tmpdir(), '808-physical-'));
  const sqlite = createRequire(import.meta.url)('node:sqlite'), Original = sqlite.DatabaseSync;
  const handles: any[] = [];
  sqlite.DatabaseSync = class extends Original { constructor(...args: any[]) { super(...args); handles.push(this); } };
  const control = acquireMutationStore(root);
  const mainCount = handles.length;
  const model = new WorkReadModel(root, 'query-owner', { baseDir: root, durableDir: join(root, 'durable'), intervalMs: 60000 });
  try {
    await model.reconcile();
    assert.equal(mainCount, 1);
    assert.notEqual((model as any).db, (model as any).reader.connection(false));
    const query = handles.slice(mainCount);
    assert.equal(query.length, 2, 'query retains its coordinator reader and one shared derived handle');
    assert.ok(query.includes((model as any).db));
    assert.ok(query.includes((model as any).reader.connection(false)));
    assert.equal(handles.length, mainCount + query.length, 'every main/query physical handle remains accounted');
  } finally { await model.close(); control.release(); sqlite.DatabaseSync = Original; rmSync(root, { recursive: true, force: true }); }
});
