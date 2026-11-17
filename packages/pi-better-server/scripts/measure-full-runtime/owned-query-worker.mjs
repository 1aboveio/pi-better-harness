import { registerOwnedLoader, observeGcThread } from './owned-fixture.mjs';
observeGcThread(); registerOwnedLoader();
await import('../../src/runtime/query-worker.mjs');
