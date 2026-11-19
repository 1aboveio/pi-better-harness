import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { installOwnedRouter, registerOwnedLoader } from '../scripts/measure-full-runtime/owned-fixture.mjs';

test('native fixture executor loader selects the captured owned worker and settles subscribe through its real scheduler', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'owned-executor-')), agent = join(root, 'agent'), samples = join(root, 'samples');
  mkdirSync(agent); mkdirSync(samples);
  const saved = { PI_RESOURCE_REPORT_DIR: process.env.PI_RESOURCE_REPORT_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_FULL_RUNTIME_CREATION_REPORT: process.env.PI_FULL_RUNTIME_CREATION_REPORT };
  Object.assign(process.env, { PI_RESOURCE_REPORT_DIR: samples, PI_CODING_AGENT_DIR: agent, PI_FULL_RUNTIME_CREATION_REPORT: join(root, 'hook.json') });
  let executor: any, connection: any;
  try {
    // Same private router and async loader as the native probe; no process identity
    // probe, guardian, daemon startup or external child is required here.
    installOwnedRouter(); registerOwnedLoader();
    const { WorkQueryExecutor } = await import('../src/runtime/query-executor.ts');
    executor = new WorkQueryExecutor(agent, 'owned-executor', { modelOptions: { baseDir: join(root, 'raw'), durableDir: join(root, 'archive') } });
    const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write() { return true; } });
    connection = executor.connect(socket);
    const result = await connection.handle({ type: 'runtime_subscribe', scope: { cwd: root, sessionId: 'hosted-owner', limit: 200 } });
    const snapshot = JSON.parse(result.json);
    assert.equal(snapshot.instanceId, 'owned-executor');
    assert.ok(['ready', 'rebuilding'].includes(snapshot.status));
    const marker = JSON.parse(readFileSync(join(root, 'hook.json.worker.json'), 'utf8'));
    assert.equal(marker.phase, 'reply-posted');
    assert.equal(executor.metrics().executor.completed, 1);
    assert.equal(executor.metrics().executor.callerTimeouts, 0);
    assert.equal(executor.metrics().executor.restarts, 0);
    assert.ok(executor.worker.threadId > 0);
    t.diagnostic(JSON.stringify({ completed: 1, callerTimeouts: 0, workerPhase: marker.phase,
      snapshotStatus: snapshot.status, physicalWorkerThread: executor.worker.threadId }));
  } finally {
    connection?.close(); await executor?.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
