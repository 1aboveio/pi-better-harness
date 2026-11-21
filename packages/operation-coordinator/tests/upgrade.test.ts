import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { cleanupHarnesses, createHarness, registerOperation, workerOwner, parentOwner } from './support.ts';
afterEach(cleanupHarnesses);
for (const writer of ['domain', 'legacy-sql']) test(`upgrade fence rejects new foreground and unaccepted worker operations but preserves accepted dependencies (${writer})`, () => {
  const h = createHarness();
  try {
    registerOperation(h.store, { operationId: 'before', owner: parentOwner });
    h.store.setUpgradeFence('epoch');
    registerOperation(h.store, { operationId: 'before', owner: parentOwner });
    assert.throws(() => registerOperation(h.store, { operationId: 'new-parent', owner: parentOwner }), /runtime-draining/);
    assert.throws(() => registerOperation(h.store, { operationId: 'unknown-worker' }), /runtime-draining/);
    h.store.registerAssignment({ assignmentId: 'accepted', attemptId: 'attempt', owner: workerOwner, recipient: parentOwner });
    registerOperation(h.store, { operationId: 'accepted-dependency' });
    assert.throws(() => registerOperation(h.store, { operationId: 'forged-workspace', owner: { ...workerOwner, workspace: '/different' } }), /runtime-draining/);
    assert.throws(() => registerOperation(h.store, { operationId: 'forged-branch', owner: { ...workerOwner, branchId: 'different' } }), /runtime-draining/);
    assert.throws(() => registerOperation(h.store, { operationId: 'forged-goal', owner: { ...workerOwner, goalId: 'different' } }), /runtime-draining/);
    const outcome = { assignmentId: 'accepted', owner: workerOwner, recipient: parentOwner,
      revision: 1, outcome: 'failed' as const, reason: 'Accepted assignment finished before upgrade',
      evidence: [], waits: [], processUncertain: false };
    if (writer === 'domain') h.store.recordAssignmentOutcome(outcome);
    else {
      // Legacy writers still persist a complete domain record, not an empty object.
      const db = new DatabaseSync(h.path);
      try { db.prepare('INSERT INTO assignment_outcomes VALUES (?, ?, ?)').run('accepted', 'terminal',
        JSON.stringify({ ...outcome, eventId: 'terminal', inspectedAt: null, disposition: null, deliveryReceipt: null })); }
      finally { db.close(); }
    }
    assert.equal(h.store.getAssignmentOutcome('accepted')?.outcome, 'failed');
    assert.throws(() => registerOperation(h.store, { operationId: 'stale-worker' }), /runtime-draining/);
    h.store.setUpgradeFence(null);
    registerOperation(h.store, { operationId: 'after', owner: parentOwner });
  } finally { h.closeStore(); }
});
