const { writeFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');
const { PerformanceObserver } = require('node:perf_hooks');
const { threadId } = require('node:worker_threads');

let gc, gcObserver;
const observedGcThreads = new Set();
function observedContinuousNs(binding = process.env.PI_RESOURCE_CLOCK_BINDING) {
  return binding ? require(binding).continuousNs() : undefined;
}

function threadGc(clockBinding) {
  if (!gc) {
    gc = { observed: true, count: 0, durationMs: 0, startedAt: Date.now() };
    gcObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        gc.count++;
        gc.durationMs += entry.duration;
      }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  }
  return { ...gc, observedAt: Date.now(), observedContinuousNs: observedContinuousNs(clockBinding) };
}

function observeGcThread(key = `worker-${threadId}`, directory = process.env.PI_RESOURCE_REPORT_DIR, clockBinding) {
  if (observedGcThreads.has(key)) return;
  observedGcThreads.add(key);
  threadGc(clockBinding);
  const path = join(directory, `${process.pid}-${key}.gc`);
  const sample = () => {
    writeFileSync(path + '.tmp', JSON.stringify({ thread: key, physicalThreadId: threadId, ...threadGc(clockBinding) }));
    renameSync(path + '.tmp', path);
  };
  sample();
  setInterval(sample, 250).unref();
}

exports.observeGcThread = observeGcThread;
exports.threadGc = threadGc;
exports.observedContinuousNs = observedContinuousNs;
