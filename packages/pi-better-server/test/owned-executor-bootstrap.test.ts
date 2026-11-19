import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { installOwnedRouter, registerOwnedLoader } from '../scripts/measure-full-runtime/owned-fixture.mjs';

test('owned fixture loader bootstraps the real executor worker and settles its subscription', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'owned-executor-'));
  const agent = join(root, 'agent'), samples = join(root, 'samples');
  mkdirSync(agent); mkdirSync(samples);
  const saved = { PI_RESOURCE_REPORT_DIR: process.env.PI_RESOURCE_REPORT_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  Object.assign(process.env, { PI_RESOURCE_REPORT_DIR: samples, PI_CODING_AGENT_DIR: agent });
  let executor: any, connection: any;
  try {
    // Exercise the same router, async loader and owned worker entry as the native
    // fixture, without starting a daemon or replacing the worker message loop.
    installOwnedRouter(); registerOwnedLoader();
    const { WorkQueryExecutor } = await import('../src/runtime/query-executor.ts');
    executor = new WorkQueryExecutor(agent, 'owned-executor', {
      modelOptions: { baseDir: join(root, 'raw'), durableDir: join(root, 'archive') },
    });
    const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write() { return true; } });
    connection = executor.connect(socket);
    const result = await connection.handle({ type: 'runtime_subscribe', scope: { cwd: root, sessionId: 'hosted-owner', limit: 200 } });
    const snapshot = JSON.parse(result.json);
    assert.equal(snapshot.instanceId, 'owned-executor');
    assert.ok(['ready', 'rebuilding'].includes(snapshot.status), 'bootstrap must not invent source readiness');
    assert.deepEqual(snapshot.rows, []);
    const metrics = executor.metrics();
    assert.equal(metrics.workerGc.observed, true, 'actual owned worker instrumentation must be installed');
    assert.equal(metrics.executor.completed, 1);
    assert.equal(metrics.executor.callerTimeouts, 0);
    assert.equal(metrics.executor.restarts, 0);
    assert.ok(executor.worker.threadId > 0);
  } finally {
    connection?.close(); await executor?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
