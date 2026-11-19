import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { summarizeCohorts } from '../../scripts/measure-full-runtime/aggregate-samples.mjs';
import { openPeakSampler } from '../../scripts/measure-full-runtime/peak-sampler.mjs';
import { processMatchesStart } from '../../src/daemon-owner.ts';
import { continuousClock, elapsedMsBetween } from '../../scripts/measure-full-runtime/batch-capture.mjs';

const [mode, gcDirectory, bindingJson] = process.argv.slice(2);
const binding = JSON.parse(bindingJson);
const { continuousNs } = createRequire(import.meta.url)(binding.path);
const pids = [process.pid, process.ppid], generation = '1';
process.env.PI_RESOURCE_REPORT_DIR = gcDirectory;
process.env.PI_RESOURCE_CLOCK_BINDING = binding.path;
await import('../../scripts/measure-full-runtime/probe.mjs');
process.channel.ref();
writeFileSync(join(gcDirectory, 'generation'), generation);

// One failing process is sufficient to block the driver's full-cohort gate.
async function completeSample(afterAt) {
  const deadline = performance.now() + 2000;
  let sample;
  do {
    sample = JSON.parse(readFileSync(join(gcDirectory, `${process.pid}.json`), 'utf8'));
    const { identity, gcThreads } = sample;
    if (identity.pid === process.pid && processMatchesStart(identity.pid, identity.start)
      && sample.generation === generation && BigInt(sample.observedContinuousNs) >= BigInt(afterAt) && gcThreads.complete
      && gcThreads.records.every(record => BigInt(record.observedContinuousNs) >= BigInt(afterAt))) return sample;
    await delay(25);
  } while (performance.now() < deadline);
  throw new Error(`all actual processes sampled in this measurement generation timed out: ${JSON.stringify({
    pid: sample.identity.pid, generation: sample.generation, at: sample.at, afterAt, gcThreads: sample.gcThreads,
  })}`);
}

await completeSample(0);
const sampler = openPeakSampler({ pids, generation, nativeBinding: binding });
let result;
try {
  const before = await completeSample(await sampler.ready);
  const expected = before.gcThreads.lifecycle.find(record => record.entry?.endsWith('/peak-sampler.mjs'));
  assert.ok(expected, 'Fixture must register the physical sampler thread before the window');
  assert.ok(before.gcThreads.records.some(record => record.thread === expected.thread && record.physicalThreadId === expected.physicalThreadId));

  const first = await sampler.start();
  const startedAt = Date.now();
  const startedContinuousNs = continuousNs();
  if (mode === 'delay-control') {
    // Keep the real control timer pending during a synchronous event-loop stall.
    const timer = delay(100);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
    await timer;
  } else {
    const resume = once(process, 'message');
    process.send({ type: 'pause-ready' });
    await resume;
  }
  const endedContinuousNs = continuousNs(), endedAt = Date.now();
  await sampler.stop(endedContinuousNs);
  const after = await completeSample(endedContinuousNs);
  assert.deepEqual(after.gcThreads.lifecycle, before.gcThreads.lifecycle);
  const frames = await sampler.read();
  assert.deepEqual(frames[0], first);
  assert.ok(frames.every((frame, index) => frame.length === pids.length && frame.every((row, pidIndex) =>
    row.identity.pid === pids[pidIndex] && row.sequence === index + 1 && row.sourceCohort.diagnosticCost.childCpuMicros === 0)));
  const gapMs = Math.max(...frames.slice(1).map((frame, index) => elapsedMsBetween(frames[index][0].sourceCohort.capturedContinuousNs, frame[0].sourceCohort.capturedContinuousNs)));
  const peak = summarizeCohorts(frames, { required: first, generation, clock: continuousClock(process.platform) }, { startedAt, endedAt, startedContinuousNs, endedContinuousNs });
  result = { type: 'result', elapsedMs: elapsedMsBetween(startedContinuousNs, endedContinuousNs), frames: frames.length, gapMs, peak,
    coverage: { pid: process.pid, generation, beforeAt: before.at, afterAt: after.at,
      threads: before.gcThreads.records.map(record => [record.thread, record.physicalThreadId]) } };
} finally {
  await sampler.close();
}
process.send(result);
process.disconnect();
