import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgressState, watchRun } from './watch-github-run.mjs';

const step = (name, status, number = 1) => ({ name, status, number, startedAt: '2026-11-01T17:28:40Z' });
const run = (steps, extra = {}) => ({ status: 'in_progress', jobs: [
  { databaseId: 1, name: 'publish', status: 'in_progress', steps },
], ...extra });
const complete = { status: 'completed', conclusion: 'success', jobs: [] };

async function exercise(snapshots) {
  const emitted = [];
  let polls = 0;
  let waits = 0;
  await watchRun({
    readRun: async () => { assert.ok(polls < snapshots.length, 'the watcher terminates'); return snapshots[polls++]; },
    emit: state => emitted.push(state),
    wait: async () => { waits++; },
  });
  return { emitted, polls, waits };
}

test('repeated GitHub redraws and changing display clocks produce no progress output', async () => {
  const active = run([step('Verify workspace', 'in_progress')]);
  const result = await exercise([
    { ...active, updatedAt: '2026-11-01T17:30:00Z', elapsedSeconds: 80 },
    { ...active, updatedAt: '2026-11-01T17:31:00Z', elapsedSeconds: 140 },
    { ...active, updatedAt: '2026-11-01T17:34:00Z', elapsedSeconds: 320 },
    complete,
  ]);
  assert.equal(result.polls, 4);
  assert.equal(result.waits, 3, 'polling continues even though progress output stays quiet');
  assert.equal(result.emitted.length, 2, 'only initial state and completion count as progress');
  assert.equal(result.emitted[0].jobs[0].steps[0].name, 'Verify workspace');
});

test('a real step transition advances the observable state', async () => {
  const before = run([step('Verify workspace', 'in_progress'), step('Publish package', 'queued', 2)]);
  const after = run([step('Verify workspace', 'completed'), step('Publish package', 'in_progress', 2)]);
  const { emitted } = await exercise([before, before, after, complete]);
  assert.equal(emitted.length, 3);
  assert.equal(emitted[1].jobs[0].steps[1].status, 'in_progress');
});

test('job and step response ordering does not invent progress', () => {
  const a = { databaseId: 2, name: 'second', status: 'in_progress', steps: [step('b', 'queued', 2), step('a', 'in_progress')] };
  const b = { databaseId: 1, name: 'first', status: 'completed', steps: [] };
  assert.deepEqual(
    runProgressState({ status: 'in_progress', jobs: [a, b] }),
    runProgressState({ status: 'in_progress', jobs: [b, { ...a, steps: [...a.steps].reverse() }] }),
  );
});

test('unreadable provider state and read errors fail visibly rather than staying pending', async () => {
  assert.throws(() => runProgressState({ status: 'mystery' }), /Unreadable/);
  await assert.rejects(watchRun({
    readRun: async () => { throw new Error('GitHub unavailable'); },
    emit: () => assert.fail('no healthy state was read'),
    wait: async () => assert.fail('an unreadable state must not become pending'),
  }), /GitHub unavailable/);
});

test('a failed run reports its terminal state and fails the watcher', async () => {
  const emitted = [];
  await assert.rejects(watchRun({
    readRun: async () => ({ status: 'completed', conclusion: 'failure', jobs: [] }),
    emit: state => emitted.push(state),
    wait: async () => assert.fail('terminal failure must not keep waiting'),
  }), /completed with failure/);
  assert.equal(emitted[0].conclusion, 'failure');
});
