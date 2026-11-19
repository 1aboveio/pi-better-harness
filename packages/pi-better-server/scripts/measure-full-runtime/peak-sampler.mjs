import assert from 'node:assert/strict';
import { on } from 'node:events';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import { createBatchCapture, linuxCaptureUnits, platformCapture } from './batch-capture.mjs';
import { observeGcThread } from './worker-gc.cjs';

export const peakCapturePeriodMs = 100;

const gcFile = (directory, id, extension) => join(directory, `${process.pid}-peak-${id}.${extension}`);

// Keep captures in the worker until the final process counters have been read.
// The worker shares the measured driver's PID, CPU counters and RSS.
export function openPeakSampler({ pids, generation, nativeBinding, gcDirectory }) {
  assert.ok(pids.includes(process.pid), 'Peak sampler CPU must be in the measured cohort');
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { pids, generation, nativeBinding, gcDirectory }, execArgv: [],
  });
  const samplerId = worker.threadId;
  const replies = on(worker, 'message', { close: ['exit'] });
  async function receive(expected, request) {
    if (request) worker.postMessage(request);
    const reply = await replies.next();
    assert.equal(reply.value?.[0].type, expected, `Peak sampler exited before ${expected}`);
    return reply.value[0].value;
  }
  return {
    ready: receive('ready'),
    start: () => receive('started', { type: 'start' }),
    stop: endedAt => receive('stopped', { type: 'stop', endedAt }),
    read: () => receive('frames', { type: 'read' }),
    async close() {
      await worker.terminate();
      await replies.return();
      if (gcDirectory) for (const extension of ['expected', 'expected.tmp', 'gc', 'gc.tmp']) {
        rmSync(gcFile(gcDirectory, samplerId, extension), { force: true });
      }
    },
  };
}

if (!isMainThread) {
  const { pids, generation, nativeBinding, gcDirectory } = workerData;
  const options = process.platform === 'darwin'
    ? { nativeCapture: createRequire(import.meta.url)(nativeBinding.path).capture, nativeBindingId: nativeBinding.binarySha256 }
    : { units: linuxCaptureUnits() };
  const capture = createBatchCapture({ pids, generation, capture: pids => platformCapture(pids, options) });
  const frames = [];
  let timer;
  function tick() {
    frames.push(capture());
    timer = setTimeout(tick, peakCapturePeriodMs);
  }
  if (gcDirectory) {
    const thread = `peak-${threadId}`;
    observeGcThread(thread, gcDirectory);
    const expected = gcFile(gcDirectory, threadId, 'expected');
    writeFileSync(`${expected}.tmp`, JSON.stringify({ thread, physicalThreadId: threadId }));
    renameSync(`${expected}.tmp`, expected);
  }
  parentPort.on('message', ({ type, endedAt }) => {
    if (type === 'start') {
      tick();
      parentPort.postMessage({ type: 'started', value: frames[0] });
    } else if (type === 'stop') {
      clearTimeout(timer);
      if (frames.at(-1)[0].at < endedAt) frames.push(capture());
      parentPort.postMessage({ type: 'stopped' });
    } else if (type === 'read') {
      parentPort.postMessage({ type: 'frames', value: frames });
    }
  });
  parentPort.postMessage({ type: 'ready', value: Date.now() });
}
