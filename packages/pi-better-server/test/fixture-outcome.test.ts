import test from 'node:test';
import assert from 'node:assert/strict';
import { withFixtureCleanup } from './support/fixture-outcome.ts';

test('fixture outcome preserves first body error and reports cleanup separately without new observations', async t => {
  const output: any[][] = [];
  t.mock.method(console, 'error', (...args: any[]) => { output.push(args); });
  const body = new Error('original assertion');
  const cleanup = Object.assign(new Error('sealed artifact unlink'), { code: 'EACCES', syscall: 'unlink' });
  let cleanups = 0;
  await assert.rejects(withFixtureCleanup(async () => { throw body; }, async () => { cleanups++; throw cleanup; }), error => error === body);
  assert.equal(cleanups, 1);
  assert.equal(output.length, 1);
  assert.equal(output[0]![0], '[result-supervision-fixture-failure]');
  const evidence = JSON.parse(output[0]![1]);
  assert.equal(evidence.bodyCompleted, false);
  assert.equal(evidence.firstBodyError.message, body.message);
  assert.equal(evidence.cleanupError.code, 'EACCES');
});

test('cleanup-only failures still fail, while successful cleanup is silent and error evidence is bounded', async t => {
  const output: any[][] = [];
  t.mock.method(console, 'error', (...args: any[]) => { output.push(args); });
  const cleanup = new Error('x'.repeat(10000));
  await assert.rejects(withFixtureCleanup(async () => {}, async () => { throw cleanup; }), error => error === cleanup);
  assert.equal(JSON.parse(output[0]![1]).bodyCompleted, true);
  assert.equal(JSON.parse(output[0]![1]).firstBodyError, null);
  assert.ok(Buffer.byteLength(output[0]![1]) < 5000);
  await withFixtureCleanup(async () => {}, async () => {});
  const body = new Error('body only');
  await assert.rejects(withFixtureCleanup(async () => { throw body; }, async () => {}), error => error === body);
  assert.equal(output.length, 1);
});
