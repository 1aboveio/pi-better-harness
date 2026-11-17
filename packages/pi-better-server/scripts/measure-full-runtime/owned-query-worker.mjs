import { registerOwnedLoader, observeGcThread } from './owned-fixture.mjs';
import { workerData } from 'node:worker_threads';
import assert from 'node:assert/strict';
observeGcThread(); registerOwnedLoader();
const source = new URL(workerData.resourceFixtureSource);
assert.ok(source.protocol === 'file:' && source.pathname.endsWith('/src/runtime/query-worker.mjs'), 'Missing captured fixture worker source');
await import(source.href);
