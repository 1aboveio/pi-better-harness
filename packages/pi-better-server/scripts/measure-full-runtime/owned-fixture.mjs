import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { register } from 'node:module';

let executor, gc, gcObserver;
function publish(name, value) {
  const path = join(process.env.PI_RESOURCE_REPORT_DIR, `${process.pid}-${name}`);
  writeFileSync(path + '.tmp', JSON.stringify(value)); renameSync(path + '.tmp', path);
}
export function registerOwnedLoader() {
  publish(`loader-${threadId}.expected`, { thread: `loader-${threadId}` });
  register(new URL('./recovery-trace-loader.mjs', import.meta.url), { data: { resourceParentThreadId: threadId } });
}
export function observeGcThread(key = `worker-${threadId}`) {
  threadGc();
  const sample = () => publish(`${key}.gc`, { thread: key, physicalThreadId: threadId, ...threadGc() });
  sample(); setInterval(sample, 250).unref();
}
export function gcThreads() {
  const names = readdirSync(process.env.PI_RESOURCE_REPORT_DIR).filter(name => name.startsWith(`${process.pid}-`));
  const read = name => JSON.parse(readFileSync(join(process.env.PI_RESOURCE_REPORT_DIR, name), 'utf8'));
  const expected = names.filter(name => name.endsWith('.expected')).map(read).filter(value => !value.exitedAt);
  const records = names.filter(name => name.endsWith('.gc')).map(read).filter(value => expected.some(item => item.thread === value.thread));
  return { expected: expected.map(value => value.thread), records,
    complete: expected.every(value => records.some(record => record.thread === value.thread && record.observedAt >= Date.now() - 250)) };
}
export function threadGc() {
  if (!gc) {
    gc = { observed: true, count: 0, durationMs: 0, startedAt: Date.now() };
    gcObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) { gc.count++; gc.durationMs += entry.duration; } });
    gcObserver.observe({ entryTypes: ['gc'] });
  }
  return { ...gc, observedAt: Date.now() };
}
export function bindOwnedExecutor(value) {
  assert.ok(process.env.PI_RESOURCE_REPORT_DIR && value.agentDir === process.env.PI_CODING_AGENT_DIR, 'Fixture executor ownership mismatch');
  assert.ok(!executor || executor === value, 'Ambiguous fixture executor owner');
  executor = value;
}
export function ownedWorkerUrl(original) {
  assert.equal(String(original), String(new URL('../../src/runtime/query-worker.mjs', import.meta.url)), 'No fixture binding for foreign worker');
  return new URL('./owned-query-worker.mjs', import.meta.url);
}
export function bindOwnedModel(model, port) {
  threadGc();
  port.on('message', message => {
    if (message?.type !== 'resource-fixture-evict') return;
    model.parseStates.clear(); model.healthStates.clear();
    port.postMessage({ type: 'resource-fixture-evicted', nonce: message.nonce, checkpoints: model.metrics.checkpoints });
  });
}
export async function controlOwnedExecutor(executor, action) {
  assert.ok(executor && !executor.closed, 'Missing live fixture-owned executor');
  if (action === 'describe') return { actions: ['evict', 'restart'], scope: 'runtime', pid: process.pid };
  const began = performance.now(), previous = executor.worker;
  if (action === 'evict') {
    const nonce = randomUUID();
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); previous.off('message', on); previous.off('exit', exited); };
      const on = reply => { if (reply.type === 'resource-fixture-evicted' && reply.nonce === nonce) { cleanup(); resolve(); } };
      const exited = () => { cleanup(); reject(Error('Owned reader exited during eviction')); };
      const timer = setTimeout(() => { cleanup(); reject(Error('Owned eviction acknowledgement missing')); }, 30000);
      previous.on('message', on); previous.once('exit', exited);
      previous.postMessage({ type: 'resource-fixture-evict', nonce });
    });
    // Refresh the existing metrics mailbox through a normal read; no cache
    // rebuild or fabricated post-eviction counters are returned to WorkClient.
    await executor.snapshot({ limit: 1 });
  } else if (action === 'restart') {
    await previous.terminate();
    const deadline = Date.now() + 30000;
    while (executor.worker === previous || executor.metrics().executor.worker !== 'running'
      || executor.observation().status !== 'ready') {
      assert.ok(Date.now() < deadline, 'Owned query-worker recovery did not finish');
      await delay(25);
    }
    assert.notEqual(executor.worker, previous, 'Restart did not create a physical reader handle');
  } else throw Error(`Unsupported fixture action: ${action}`);
  return { action, scope: 'runtime', elapsedMs: performance.now() - began };
}

// Private IPC follows only ChildProcess handles CREATED by this fixture tree.
// It never resolves a PID into a process handle or sends a signal to a PID.
export function installOwnedRouter() {
  const cp = createRequire(import.meta.url)('node:child_process'), fork = cp.fork, spawn = cp.spawn, children = new Set();
  const threads = createRequire(import.meta.url)('node:worker_threads'), OriginalWorker = threads.Worker;
  threads.Worker = class extends OriginalWorker {
    constructor(...args) { super(...args); const key = `worker-${this.threadId}`;
      publish(`${key}.expected`, { thread: key });
      this.once('exit', () => publish(`${key}.expected`, { thread: key, exitedAt: Date.now() })); }
  };
  cp.fork = (...args) => { const child = fork(...args); children.add(child); child.once('exit', () => children.delete(child)); return child; };
  cp.spawn = (command, args, options) => {
    const ownedNode = [process.execPath, process.env.PI_TEST_PRIVATE_RUNTIME_NODE].includes(command)
      && options?.env?.PI_RESOURCE_REPORT_DIR === process.env.PI_RESOURCE_REPORT_DIR && Array.isArray(options.stdio);
    const child = spawn(command, args, ownedNode && !options.stdio.includes('ipc') ? { ...options, stdio: [...options.stdio, 'ipc'] } : options);
    if (ownedNode) { children.add(child); child.once('exit', () => children.delete(child)); child.channel?.unref(); }
    return child;
  };
  syncBuiltinESMExports();
  const request = async (pid, action) => {
    if (pid === process.pid) return controlOwnedExecutor(executor, action);
    const branches = [...children].filter(child => child.connected);
    assert.ok(branches.length, 'No owned descendant can provide fixture control');
    const cleanups = [];
    return Promise.any(branches.map(child => new Promise((resolve, reject) => {
      const nonce = randomUUID();
      const done = reply => { if (reply?.type !== 'resource-fixture-reply' || reply.nonce !== nonce) return;
        clearTimeout(timer); child.off('message', done); reply.error ? reject(Error(reply.error)) : resolve(reply.result); };
      const timer = setTimeout(() => { child.off('message', done); reject(Error('Owned fixture control timed out')); }, 30000);
      cleanups.push(() => { clearTimeout(timer); child.off('message', done); });
      child.on('message', done); child.send({ type: 'resource-fixture-control', nonce, pid, action });
    }))).finally(() => cleanups.forEach(cleanup => cleanup()));
  };
  process.on('message', async message => {
    if (message?.type !== 'resource-fixture-control') return;
    try { process.send?.({ type: 'resource-fixture-reply', nonce: message.nonce, result: await request(message.pid, message.action) }); }
    catch (error) { process.send?.({ type: 'resource-fixture-reply', nonce: message.nonce, error: String(error) }); }
  });
  process.channel?.unref();
  return request;
}

export function distribution(values) {
  assert.ok(values.length && values.every(value => Number.isFinite(value) && value >= 0), 'Missing actual metric observations');
  const sorted = values.slice().sort((a,b) => a-b);
  return { samples: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)],
    p99: sorted[Math.floor(sorted.length * .99)], max: sorted.at(-1) };
}
