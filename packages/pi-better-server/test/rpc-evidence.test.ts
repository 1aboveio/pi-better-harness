import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpcEvidence } from './support/rpc-evidence.ts';
import { EventEmitter } from 'node:events';
const { readRpcEvidence } = await import(new URL('../../pi-better-background-tasks/src/test-support/work-runtime.ts', import.meta.url).href);

test('failure artifact IPC reads the private snapshot without tool submissions and removes its listener', async () => {
  const evidence = createRpcEvidence(), peer = new EventEmitter();
  evidence.event('adapter', 1, 'tool-pending');
  evidence.event('cancel', 2, 'request-pending');
  const sent: unknown[] = [];
  Object.assign(peer, { send(command: { rpcEvidence: number }) {
    sent.push(command);
    queueMicrotask(() => peer.emit('message', { rpcEvidence: command.rpcEvidence, snapshot: evidence.snapshot() }));
  } });
  const snapshot = await readRpcEvidence(peer, 1);
  assert.deepEqual(sent, [{ rpcEvidence: 1 }]);
  assert.equal(peer.listenerCount('message'), 0);
  assert.match(JSON.stringify(snapshot), /tool-pending/);
  assert.match(JSON.stringify(snapshot), /request-pending/);
  assert.doesNotMatch(JSON.stringify(sent), /watch|stop|runtime_background_tool/);
});

test('private RPC failure snapshot bounds phase history and excludes every non-whitelisted field', () => {
  const evidence = createRpcEvidence();
  evidence.bind(() => ({
    lanes: { control: { capacity: 16, active: 2, admitted: 7, completed: 5, token: 'SECRET' },
      query: { capacity: 8, active: 1, admitted: 3, completed: 2 }, repair: { capacity: 8, active: 0, admitted: 1, completed: 1 } },
    read: { active: 1, queued: 4, worker: 'running', params: { secret: 'SECRET' }, error: 'SECRET' },
    observation: 'rebuilding', authority: 'SECRET', path: '/SECRET', owner: 'SECRET', grants: ['SECRET'],
  }));
  for (let slot = 0; slot < 1000; slot++) evidence.event('adapter', slot, 'queued');
  evidence.event('adapter', 1000, 'tool-pending');
  evidence.event('cancel', 1001, 'request-pending');
  evidence.event('SECRET', 1, 'SECRET');
  const snapshot = evidence.snapshot();
  assert.equal(snapshot.events.length, 32);
  assert.equal(snapshot.events.at(-2)?.phase, 'tool-pending');
  assert.equal(snapshot.events.at(-1)?.plane, 'cancel');
  assert.deepEqual(snapshot.lanes.control, { capacity: 16, active: 2, admitted: 7, completed: 5 });
  assert.deepEqual(snapshot.read, { active: 1, queued: 4, worker: 'running', observation: 'rebuilding' });
  const text = JSON.stringify(snapshot);
  assert.doesNotMatch(text, /SECRET|params|authority|grants|owner|token/);
  assert.ok(snapshot.active.length <= 32);
  assert.ok(Buffer.byteLength(text) < 16384);
  snapshot.events.length = 0;
  assert.equal(evidence.snapshot().events.length, 32, 'artifact reads cannot mutate retained phase evidence');
});

test('a blocked private read or cancellation retains pending evidence without issuing recovery work', async () => {
  const evidence = createRpcEvidence();
  let settle!: () => void;
  const pending = new Promise<void>(resolve => { settle = resolve; });
  evidence.bind(() => ({ lanes: {}, read: { active: 1, queued: 2, worker: 'running' }, observation: 'ready' }));
  evidence.event('background', 0, 'init-pending');
  evidence.event('background', 0, 'init-returned');
  evidence.event('adapter', 1, 'queued');
  evidence.event('adapter', 1, 'executing');
  evidence.event('adapter', 1, 'tool-pending');
  evidence.event('read', 2, 'request-pending');
  evidence.event('cancel', 3, 'request-pending');
  const response = pending.then(() => {
    evidence.event('read', 2, 'request-returned');
    evidence.event('cancel', 3, 'request-failed');
  });
  assert.equal(evidence.snapshot().events.at(-1)?.phase, 'request-pending');
  settle(); await response;
  assert.equal(evidence.snapshot().events.at(-1)?.phase, 'request-failed');
  evidence.bind(() => { throw new Error('SECRET'); });
  assert.equal(evidence.snapshot().read.worker, 'unknown');
  assert.doesNotMatch(JSON.stringify(evidence.snapshot()), /SECRET/);
});

test('closed diagnostic IPC reports unavailable without replacing the original test failure', async () => {
  const peer = new EventEmitter();
  Object.assign(peer, { send() { throw new Error('SECRET'); } });
  assert.deepEqual(await readRpcEvidence(peer, 2), { unavailable: true });
  assert.equal(peer.listenerCount('message'), 0);
});
