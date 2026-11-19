import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('exact owned query worker entry and asynchronous fixture loader bootstrap and answer the real subscribe', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'owned-worker-bootstrap-'));
  const samples = join(root, 'samples'), agent = join(root, 'agent'), marker = join(root, 'hook.json');
  mkdirSync(samples); mkdirSync(agent);
  const source = new URL('../src/runtime/query-worker.mjs', import.meta.url);
  const entry = new URL('../scripts/measure-full-runtime/owned-query-worker.mjs', import.meta.url);
  const probe = new URL('../scripts/measure-full-runtime/probe.mjs', import.meta.url).href;
  const worker = new Worker(entry, { execArgv: [], env: { ...process.env, PI_RESOURCE_REPORT_DIR: samples,
    PI_FULL_RUNTIME_CREATION_REPORT: marker, NODE_OPTIONS: `--import ${probe}` },
    workerData: { agentDir: agent, instanceId: 'owned-native-equivalent', resourceFixtureSource: source.href,
      modelOptions: { baseDir: join(root, 'raw'), durableDir: join(root, 'archive') } } });
  const messages: any[] = [];
  let timer: ReturnType<typeof setTimeout>;
  try {
    const reply = await new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('owned worker did not answer within existing 5000ms client bound')), 5000);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`owned worker exited before reply: ${code}`)));
      let sent = false;
      worker.on('message', message => {
        messages.push(message.type);
        if (message.type === 'heartbeat' && !sent) {
          sent = true;
          worker.postMessage({ type: 'query', id: 1, connection: 1, generation: 1,
            command: { type: 'runtime_subscribe', scope: { cwd: root, sessionId: 'hosted-owner', limit: 200 } } });
        }
        if (message.type === 'reply' && message.id === 1) resolve(message);
      });
    }).finally(() => clearTimeout(timer));
    assert.equal(reply.error, undefined);
    const snapshot = JSON.parse(reply.json);
    assert.equal(snapshot.instanceId, 'owned-native-equivalent');
    assert.ok(['ready', 'rebuilding'].includes(snapshot.status));
    assert.deepEqual(snapshot.rows, []);
    const sidecar = JSON.parse(readFileSync(marker + '.worker.json', 'utf8'));
    assert.equal(sidecar.phase, 'reply-posted');
    assert.ok(sidecar.threadId > 0);
    t.diagnostic(JSON.stringify({ entry: entry.href, source: source.href, messages,
      workerPhase: sidecar.phase, snapshotStatus: snapshot.status, execArgv: [] }));
  } finally {
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  }
});
