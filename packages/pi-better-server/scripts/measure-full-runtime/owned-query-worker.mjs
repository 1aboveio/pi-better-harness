import { registerOwnedLoader, observeGcThread } from './owned-fixture.mjs';
import { workerData } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { installBaselineFsObservation } from './baseline-observation.mjs';
observeGcThread(); registerOwnedLoader();
const source = new URL(workerData.resourceFixtureSource);
assert.ok(source.protocol === 'file:' && source.pathname.endsWith('/src/runtime/query-worker.mjs'), 'Missing captured fixture worker source');
if (process.env.PI_FULL_RUNTIME_BASELINE_OBSERVER === 'eec7b3e256a7548bbf67f69cd468f12eb3b91dc8') installBaselineFsObservation();
await import(source.href);
