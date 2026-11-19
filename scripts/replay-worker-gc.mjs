import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [driver, dependencies, subject] = process.argv.slice(2).map(path => resolve(path));
const root = mkdtempSync('/tmp/p808-worker-gc-');
const fixture = pathToFileURL(join(driver, 'packages/pi-better-server/scripts/measure-full-runtime/owned-fixture.mjs'));
process.env.PI_RESOURCE_REPORT_DIR = root;
const require = createRequire(import.meta.url);
const helpers = await import(fixture);
helpers.installOwnedRouter();
const threads = require('node:worker_threads');
const agent = join(root, 'agent');
mkdirSync(agent);
Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, TMPDIR: root, PI_SUBAGENT_DURABLE_DIR: join(agent, 'subagents') });
// Assign thread 1 to the actual fixture loader, as in the campaign.
helpers.registerOwnedLoader();
const esbuild = require(join(dependencies, 'esbuild'));
assert.match(esbuild.transformSync('const n: number = 1', { loader: 'ts' }).code, /const n = 1/);
const worker = new threads.Worker('const { parentPort, threadId } = require("node:worker_threads"); parentPort.postMessage(threadId); parentPort.on("message", () => {});', {
  eval: true, execArgv: [],
});
const workerId = worker.threadId;
let fold, executor;
try {
  const [actualId] = await once(worker, 'message');
  assert.equal(actualId, workerId);
  if (subject) {
    const failureFold = pathToFileURL(join(subject, 'packages/pi-better-server/src/runtime/domain/subagents/managed-failure-worker.mjs'));
    fold = new threads.Worker(failureFold, { execArgv: [], workerData: { root: agent, epoch: 1, revocation: new SharedArrayBuffer(4) } });
    const result = once(fold, 'message');
    fold.postMessage({ ids: [] });
    assert.deepEqual(await result, [{ complete: true }]);
    const { WorkQueryExecutor } = await import(pathToFileURL(join(subject, 'packages/pi-better-server/src/runtime/query-executor.ts')));
    executor = new WorkQueryExecutor(agent, 'gc-replay', { modelOptions: { baseDir: join(root, 'raw'), durableDir: join(agent, 'subagents') } });
    const snapshot = await executor.snapshot({ limit: 1 });
    assert.deepEqual(snapshot.rows, []);
    assert.equal(executor.metrics().workerGc?.observed, true);
  }
  // Sample a whole reporting tick after both workers start.
  await delay(260);
  const expected = readdirSync(root).filter(name => /worker-\d+\.expected$/.test(name))
    .map(name => JSON.parse(readFileSync(join(root, name), 'utf8')));
  const observed = helpers.gcThreads();
  console.log(JSON.stringify({ node: process.version, esbuild: esbuild.version, realWorkerId: workerId, expected, observed }));
  assert.equal(expected.length, subject ? 4 : 2);
  assert.equal(observed.complete, true, 'A live worker never published actual GC coverage');
  const records = observed.records.filter(record => record.thread.startsWith('worker-'));
  assert.equal(records.length, expected.length);
  assert.ok(records.every(record => record.observed && record.thread === `worker-${record.physicalThreadId}`));
  assert.ok(observed.records.every(record => record.observedAt > record.startedAt));
  const esbuildThread = expected.find(value => value.entry?.endsWith('esbuild/lib/main.js'));
  assert.equal(esbuildThread?.physicalThreadId, 2);
  const recordPath = join(root, `${process.pid}-${esbuildThread.thread}.gc`);
  const record = records.find(value => value.thread === esbuildThread.thread);
  writeFileSync(recordPath, JSON.stringify({ ...record, physicalThreadId: 99999 }));
  assert.equal(helpers.gcThreads().complete, false, 'Wrong physical thread must not count');
  console.log('Real worker response and GC sampling passed; a mismatched physical identity failed coverage.');
} finally {
  await executor?.close();
  await fold?.terminate();
  await worker.terminate();
  // esbuild's idle service is unreferenced and exits with the process.
  rmSync(root, { recursive: true, force: true });
}
