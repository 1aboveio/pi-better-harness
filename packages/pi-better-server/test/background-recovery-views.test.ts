import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { ObservedWaitHost } = await import(String('../src/runtime/domain/background-service/observed-waits.domain.mjs'));
const { openStore } = await import(String('../src/runtime/domain/background-service/shared-operation-coordinator/index.domain.mjs'));

// Exercise the production context/recovery methods without constructing a
// process supervisor or providing any execution/host-identity proof.
function contextHost() {
  return Object.assign(Object.create(ObservedWaitHost.prototype), {
    callbackRecoveryScopes: new Map(), unscopedCallbackRecovery: { revision: -1, branch: '' },
  });
}
const branch = ['095bb1a8', 'a451842c', '37c74f76', '81b8bbb5', '8dec15e5', '996b26ad', '180870f1', '4307c05d', '4fced96b', 'a9285002', '0f7ab8ee', '6b3fac7b', '07d37e07', 'ac4dce42', '79701635', '9b7c0bb4', 'e059cbf6', '334f713e', 'a7177f39', 'cfa7e5e7'];
const ctx = (ids: string[], sessionId = '4edc1498-cbc9-481b-831a-ca3da05c99c1') => ({ cwd: '/fixture', sessionManager: {
  getSessionId: () => sessionId, getBranch: () => ids.map(id => ({ id })),
} });

test('stable revision retains recovery progress across the actual alternating foreground branch views', t => {
  const host = contextHost();
  const parent = resolve('.work/797'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'recovery-views-'));
  const store = openStore({ path: join(root, 'operations.sqlite') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const register = (index: number) => store.registerOperation({ operationId: `trace-operation-${index}`, taskId: `trace-task-${index}`, launchToken: `trace-token-${index}`,
    owner: { kind: 'parent-session', sessionId: '4edc1498-cbc9-481b-831a-ca3da05c99c1', workspace: '/fixture' }, observer: { kind: 'fixture', version: '1' } });
  for (let index = 0; index < 4; index++) register(index);
  assert.equal(store.getChangeRevision(), 4);
  host.store = store;
  let reads = 0;
  const read = store.listPendingParentCallbacks.bind(store);
  store.listPendingParentCallbacks = (...args: any[]) => { reads++; return read(...args); };
  const views = [2, 4, 10, 6, 20, 8, 14, 12, 16, 18].map(size => ctx(branch.slice(0, size)));
  for (const view of views) {
    host.noteParentContext(view, { recover: false });
    assert.equal(host.hasPendingParentCallbackRecovery(), true, 'new exact view must recover');
    host.reconcileOwnerChanges();
    assert.equal(host.lastChangeRevision, 4);
  }
  const warmReads = reads;
  let repeated = 0;
  for (let round = 0; round < 3; round++) for (const view of views) {
    host.noteParentContext(view, { recover: false });
    if (host.hasPendingParentCallbackRecovery()) { repeated++; host.reconcileOwnerChanges(); }
  }
  assert.equal(repeated, 0, 'warmed alternate views at coordinator revision 4 must not restart recovery');
  assert.equal(reads, warmReads, 'unchanged views do not query the pending-callback index again');
  register(4);
  for (const view of views) {
    host.noteParentContext(view, { recover: false }); host.reconcileOwnerChanges();
    assert.equal(host.lastChangeRevision, 5, 'new coordinator revision still refreshes each exact view');
  }
  assert.equal(reads - warmReads, views.length);
});

test('separate branch and recipient recovery, paging progress and eviction remain bounded', () => {
  const host = contextHost(), first = ctx(['anchor']), fork = ctx(['fork']), other = ctx(['anchor'], 'other-recipient');
  host.noteParentContext(first, { recover: false }); host.lastChangeRevision = 4; host.pendingCallbackCursor = 'delivery-page';
  host.noteParentContext(fork, { recover: false });
  assert.equal(host.hasPendingParentCallbackRecovery(), true);
  assert.equal(host.isParentOriginActive({ cwd: '/fixture', sessionId: first.sessionManager.getSessionId() }, 'anchor'), false);
  host.lastChangeRevision = 4;
  host.noteParentContext(other, { recover: false });
  assert.equal(host.hasPendingParentCallbackRecovery(), true);
  assert.equal(host.isParentOriginActive({ cwd: '/fixture', sessionId: first.sessionManager.getSessionId() }), false);
  host.lastChangeRevision = 4;
  host.noteParentContext(first, { recover: false });
  assert.equal(host.pendingCallbackCursor, 'delivery-page', 'another view cannot reset an unfinished page');
  assert.equal(host.hasPendingParentCallbackRecovery(), true);
  host.pendingCallbackCursor = undefined;
  assert.equal(host.hasPendingParentCallbackRecovery(), false);
  for (let index = 0; index < 130; index++) host.noteParentContext(ctx([`view-${index}`]), { recover: false });
  assert.ok(host.callbackRecoveryScopes.size <= 128);
  host.noteParentContext(first, { recover: false });
  assert.equal(host.hasPendingParentCallbackRecovery(), true, 'evicted view must recover again');
});
