import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { cleanupHarnesses, createHarness, registerOperation, workerOwner, parentOwner } from './support.ts';
afterEach(cleanupHarnesses);
test('upgrade fence rejects new foreground and unaccepted worker operations but preserves accepted dependencies', () => {
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
    const db = new DatabaseSync(h.path);
    try { db.prepare('INSERT INTO assignment_outcomes VALUES (?, ?, ?)').run('accepted', 'terminal', '{}'); }
    finally { db.close(); }
    assert.throws(() => registerOperation(h.store, { operationId: 'stale-worker' }), /runtime-draining/);
    h.store.setUpgradeFence(null);
    registerOperation(h.store, { operationId: 'after', owner: parentOwner });
  } finally { h.closeStore(); }
});
