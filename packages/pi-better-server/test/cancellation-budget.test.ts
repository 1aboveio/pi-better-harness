import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireMutationStore } from '../src/runtime/mutation-store.ts';
import { RuntimeCancellation } from '../src/runtime/cancellation.ts';
const { cancellationCredential } = await import(new URL('../../operation-coordinator/index.ts', import.meta.url).href);

test('durable cancellation recovery waits for root control capacity and accounts each exact intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cancellation-budget-'));
  const lease = acquireMutationStore(root);
  const held = Array.from({ length: 16 }, () => lease.budget.enter('control')!);
  const epoch = lease.store.cancellationRuntimeEpoch('old-manager');
  const owner = { kind: 'parent-session' as const, workspace: root, sessionId: 'parent' };
  const requests = Array.from({ length: 20 }, (_, i) => {
    const operationId = `op-${i}`, proof = cancellationCredential();
    lease.store.registerOperation({ operationId, taskId: `task-${i}`, launchToken: `launch-${i}`, owner,
      observer: { kind: 'local-supervisor', version: '1' }, supervision: { hostId: 'host' } });
    const request = { owner, operationId, idempotencyKey: `stop-${i}`, expectedLaunchToken: `launch-${i}`,
      expectedTerminalRevision: 0, expectedHostId: 'host', reason: 'explicit stop' };
    // Missing runner evidence must resolve conservatively, without any process action.
    lease.store.admitTaskCancellation({ credentialHash: proof.hash, request, directory: join(root, 'absent-runner') });
    lease.store.acceptAuthorizedTaskCancellation({ credential: proof.credential, runtimeEpoch: epoch });
    return request;
  });
  let runtime: RuntimeCancellation | undefined;
  try {
    runtime = new RuntimeCancellation(root, 'new-manager');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(lease.budget.metrics().lanes.control!.active, 16);
    assert.equal(lease.budget.metrics().lanes.control!.admitted, 16);
    assert.equal(lease.budget.metrics().lanes.control!.completed, 0);
    assert.equal(lease.store.pendingTaskCancellations().length, 20, 'accepted intents remain durable while queued');
    assert.equal(runtime.busy, true);
    // One free slot is sufficient for the entire recovery backlog to advance.
    held[0]!();
    const keepAlive = setTimeout(() => {}, 2000);
    try { await runtime.close(); runtime = undefined; } finally { clearTimeout(keepAlive); }
    assert.equal(lease.budget.metrics().lanes.control!.active, 15);
    assert.equal(lease.budget.metrics().lanes.control!.admitted, 36);
    assert.equal(lease.budget.metrics().lanes.control!.completed, 21);
    for (const request of requests) assert.equal(lease.store.getTaskCancellation(request)?.result?.status, 'outcome_unknown');
  } finally {
    held.forEach(release => release()); await runtime?.close(); lease.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a socket retry joining queued accepted cancellation releases its unused credit without a second dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cancellation-retry-'));
  const lease = acquireMutationStore(root), runtime = new RuntimeCancellation(root, 'manager');
  const held = Array.from({ length: 16 }, () => lease.budget.enter('control')!);
  const owner = { kind: 'parent-session' as const, workspace: root, sessionId: 'parent' };
  const proof = cancellationCredential();
  lease.store.registerOperation({ operationId: 'op', taskId: 'task', launchToken: 'token', owner,
    observer: { kind: 'local-supervisor', version: '1' }, supervision: { hostId: 'host' } });
  const request = { owner, operationId: 'op', idempotencyKey: 'stop', expectedLaunchToken: 'token',
    expectedTerminalRevision: 0, expectedHostId: 'host', reason: 'explicit stop' };
  lease.store.admitTaskCancellation({ credentialHash: proof.hash, request, directory: join(root, 'absent-runner') });
  try {
    const command = { type: 'runtime_cancel_task', credential: proof.credential };
    const first = runtime.handle(command);
    assert.equal(lease.budget.metrics().queuedSources, 1);
    held[0]!();
    const socketCredit = lease.budget.enter('control')!;
    assert.equal(typeof socketCredit, 'function');
    const retry = runtime.handle(command, undefined, socketCredit);
    assert.equal(lease.budget.metrics().lanes.control!.active, 15, 'retry does not hold the credit needed by recovery');
    const keepAlive = setTimeout(() => {}, 2000);
    try { const [one, two] = await Promise.all([first, retry]); assert.deepEqual(one, two); }
    finally { clearTimeout(keepAlive); }
    assert.equal(lease.budget.metrics().sources.cancellation!.completed, 1);
    assert.equal(lease.budget.metrics().lanes.control!.admitted, 18);
    assert.equal(lease.budget.metrics().lanes.control!.completed, 3);
    const fresh = cancellationCredential();
    lease.store.registerOperation({ operationId: 'op-2', taskId: 'task-2', launchToken: 'token-2', owner,
      observer: { kind: 'local-supervisor', version: '1' }, supervision: { hostId: 'host' } });
    lease.store.admitTaskCancellation({ credentialHash: fresh.hash, request: { ...request, operationId: 'op-2',
      idempotencyKey: 'stop-2', expectedLaunchToken: 'token-2' }, directory: join(root, 'absent-runner') });
    const provided = lease.budget.enter('control')!;
    const socketWork = runtime.handle({ type: 'runtime_cancel_task', credential: fresh.credential }, undefined, provided);
    assert.equal(lease.budget.metrics().queuedSources, 0, 'new socket work uses its transferred lease rather than waiting for a second slot');
    await socketWork;
    provided();
    assert.equal(lease.budget.metrics().lanes.control!.active, 15);
    assert.equal(lease.budget.metrics().lanes.control!.admitted, 19);
    assert.equal(lease.budget.metrics().lanes.control!.completed, 4);
    assert.equal(lease.budget.metrics().sources.cancellation!.completed, 1, 'fresh socket work does not reserve a second credit');
  } finally {
    held.forEach(release => release()); await runtime.close(); lease.release();
    rmSync(root, { recursive: true, force: true });
  }
});
