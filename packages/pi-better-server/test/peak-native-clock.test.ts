import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { aggregateCohort } from '../scripts/measure-full-runtime/aggregate-samples.mjs';
import { continuousClock, createBatchCapture, elapsedMsBetween, platformCapture } from '../scripts/measure-full-runtime/batch-capture.mjs';
import { buildNativeCapture } from '../scripts/measure-full-runtime/build-darwin-capture.mjs';

test('physical peak uses elapsed time across backward and forward epoch steps and rejects a real miss', async t => {
  const root = mkdtempSync(join(tmpdir(), 'p808-clock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = buildNativeCapture(root);
  const native = createRequire(import.meta.url)(binding.path);
  let shiftMs = 0;
  const shiftNs = (raw: string) => (BigInt(raw) + BigInt(shiftMs) * 1000000n).toString();
  const capture = createBatchCapture({ pids: [process.pid, process.ppid], generation: '1', capture: pids => platformCapture(pids, {
    nativeBindingId: binding.binarySha256,
    continuousNs: native.continuousNs,
    now: () => Date.now() + shiftMs,
    nativeCapture(ids) {
      const batch = native.capture(ids);
      return { ...batch, captureStartedAt: batch.captureStartedAt + shiftMs, capturedAt: batch.capturedAt + shiftMs,
        captureStartedNs: shiftNs(batch.captureStartedNs), capturedNs: shiftNs(batch.capturedNs),
        records: batch.records.map((row: any) => ({ ...row, observedAt: row.observedAt + shiftMs,
          observedAtNs: shiftNs(row.observedAtNs) })) };
    },
  }) });
  const first = capture();
  const options = { required: first, generation: '1', clock: continuousClock(process.platform) };
  await delay(20);
  shiftMs = -600;
  const backward = capture();
  assert.ok(backward[0]!.at - first[0]!.at < -250);
  const backwardsVerdict = aggregateCohort(first, backward, options);
  assert.equal(backwardsVerdict.qualified, true, JSON.stringify(backwardsVerdict.issues));
  const intervalMs = elapsedMsBetween(first[0]!.sourceCohort.capturedContinuousNs!, backward[0]!.sourceCohort.capturedContinuousNs!);
  assert.ok(intervalMs > 0 && intervalMs <= 250);
  const cpuDelta = backward.reduce((total, row, index) => total + (row.cpu.totalMicros - first[index]!.cpu.totalMicros), 0);
  assert.equal(backwardsVerdict.cpuPercent, cpuDelta / (intervalMs * 10));
  await delay(20);
  shiftMs = 600;
  const forward = capture();
  assert.ok(forward[0]!.at - backward[0]!.at > 250);
  const forwardsVerdict = aggregateCohort(backward, forward, options);
  assert.equal(forwardsVerdict.qualified, true, JSON.stringify(forwardsVerdict.issues));
  await delay(320);
  shiftMs = 280; // Hide the actual pause from the epoch difference only.
  const missed = capture();
  assert.ok(missed[0]!.at - forward[0]!.at < 250);
  const miss = aggregateCohort(forward, missed, options);
  assert.deepEqual(miss.issues, ['missing-cohort-interval']);
  assert.equal(miss.cpuPercent, null);
  assert.equal(miss.rssBytes, null);
  const unstamped = structuredClone(forward);
  for (const row of unstamped) delete row.sourceCohort.capturedContinuousNs;
  assert.ok(aggregateCohort(backward, unstamped, options).issues.includes('current:invalid-continuous-time'));
});
