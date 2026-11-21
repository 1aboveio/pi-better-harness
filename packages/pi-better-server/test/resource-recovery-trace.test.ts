import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const { instrumentRecoveryTrace, load } = await import(String('../scripts/measure-full-runtime/recovery-trace-loader.mjs'));
const { recordRecoveryTrace, recoveryTraceSnapshot } = await import(String('../scripts/measure-full-runtime/recovery-trace.mjs'));

test('resource fixture trace instruments the real recovery gate without replacing its conditions', async () => {
  const target = new URL('../src/runtime/background-tools.ts', import.meta.url);
  const source = readFileSync(target, 'utf8');
  const instrumented = instrumentRecoveryTrace(source);
  for (const gate of [
    'recoveryVersions.get(viewKey) !== recoveryVersion || service.hasPendingParentCallbackRecovery()',
    'projection?.revision !== revision',
    'Date.now() - item.createdAt >= deliveryLeaseMs',
    'isAttentionDelivery(item) && !sameNativeHost(item, record)',
    'record.params.delivered === true && !service.isParentOriginActive(item.notification.origin, item.notification.branchId)',
  ]) assert.ok(instrumented.includes(gate), gate);
  for (const field of ['coordinatorRevision', 'cachedRecoveryDigest', 'branchDigest', 'beforeContext', 'afterContext', 'snapshotSequence', 'delivery-lease-expired', 'receipt-deferred', 'scope-evicted']) {
    assert.ok(instrumented.includes(field), field);
  }
  assert.equal(instrumented.split('service.hasPendingParentCallbackRecovery()').length, source.split('service.hasPendingParentCallbackRecovery()').length, 'tracing must not invoke recovery-state accessors');
  assert.ok(!instrumented.includes('service.recoveryScopeState()'), 'trace reads must not create or evict scope state');
  assert.equal(instrumented.split('lease.store.getChangeRevision()').length, source.split('lease.store.getChangeRevision()').length, 'capture the original coordinator read without additional I/O');
  const result = await load(target.href, {}, () => assert.fail('target should be instrumented'));
  assert.equal(result.shortCircuit, true);
  assert.deepEqual(ts.transpileModule(result.source, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).diagnostics, []);
  assert.equal(await load('file:///unrelated.mjs', {}, () => 'unchanged'), 'unchanged');
  assert.throws(() => instrumentRecoveryTrace(source.replace('metrics.reconciles++;', 'metrics.reconciles += 1;')), /source anchor changed/);
});

test('resource recovery records retain a bounded recent trace and report dropped evidence', () => {
  for (let index = 0; index < 140; index++) recordRecoveryTrace({ event: 'reconcile', owner: { sessionId: 'fixture' }, branchDigest: 'branch',
    coordinatorRevision: 7, cachedRecoveryDigest: 'old', recoveryDigest: 'new', pending: true,
    beforeContext: { revision: 7 }, afterContext: { revision: -1, delivery: 'cursor'.repeat(100) }, index });
  const snapshot = recoveryTraceSnapshot();
  assert.equal(snapshot.total, 140);
  assert.equal(snapshot.records.length, 128);
  assert.equal(snapshot.dropped, 12);
  assert.equal(snapshot.records[0].index, 12);
  assert.equal(snapshot.records.at(-1).afterContext.delivery.length, 256);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 128 * 4096 + 128);
  snapshot.records.pop();
  assert.equal(recoveryTraceSnapshot().records.length, 128, 'sampling cannot consume trace evidence');
});
