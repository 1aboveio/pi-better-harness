import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { summarizeCohorts } from '../../scripts/measure-full-runtime/aggregate-samples.mjs';
import { openPeakSampler } from '../../scripts/measure-full-runtime/peak-sampler.mjs';

const [mode, gcDirectory, bindingJson] = process.argv.slice(2);
const pids = [process.pid, process.ppid], generation = '1';
const sampler = openPeakSampler({ pids, generation, nativeBinding: JSON.parse(bindingJson), gcDirectory });
let result;
try {
  await sampler.ready;
  const expectedName = readdirSync(gcDirectory).find(name => name.endsWith('.expected'));
  assert.ok(expectedName, 'Sampler must register its GC thread before the window');
  const expected = JSON.parse(readFileSync(join(gcDirectory, expectedName), 'utf8'));
  const gc = JSON.parse(readFileSync(join(gcDirectory, `${process.pid}-${expected.thread}.gc`), 'utf8'));
  assert.equal(gc.physicalThreadId, expected.physicalThreadId);
  assert.ok(gc.observed && gc.physicalThreadId > 0);

  const first = await sampler.start();
  const startedAt = Date.now();
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
  const endedAt = Date.now();
  await sampler.stop(endedAt);
  const frames = await sampler.read();
  assert.deepEqual(frames[0], first);
  assert.ok(frames.every((frame, index) => frame.length === pids.length && frame.every((row, pidIndex) =>
    row.identity.pid === pids[pidIndex] && row.sequence === index + 1 && row.sourceCohort.diagnosticCost.childCpuMicros === 0)));
  const gapMs = Math.max(...frames.slice(1).map((frame, index) => frame[0].at - frames[index][0].at));
  const peak = summarizeCohorts(frames, { required: first, generation }, { startedAt, endedAt });
  result = { type: 'result', elapsedMs: endedAt - startedAt, frames: frames.length, gapMs, peak };
} finally {
  await sampler.close();
}
assert.deepEqual(readdirSync(gcDirectory).filter(name => name.startsWith(`${process.pid}-peak-`)), []);
process.send(result);
process.disconnect();
