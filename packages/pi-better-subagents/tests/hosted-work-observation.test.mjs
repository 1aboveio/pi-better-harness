import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession, ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { WorkReadModel } from '../../pi-better-server/src/runtime/read-model.ts';
import { WorkQueries } from '../../pi-better-server/src/runtime/queries.ts';
import { traceHostedHook, traceHostedRequests } from '../../pi-better-server/scripts/measure-full-runtime/hosted-hook-trace.mjs';

const key = '__hostedWorkObservationTransport';
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:net' && context.parentURL?.endsWith('/shared-work-client.mjs'))
      return { url: 'fixture:hosted-work-net', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:hosted-work-net') return { format: 'module', shortCircuit: true,
      source: `export const connect = () => globalThis.${key}();` };
    return next(url, context);
  },
});
const { WorkClient } = await import('../shared-work-client.mjs');
const { startWorkObservation, stopWorkObservation, workObservation } = await import('../work-observation.ts');

test('actual SDK startup awaits Subagents subscribe and real scoped collection before completing hosted bind', { timeout: 10000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-work-'))), marker = join(root, 'hook.json');
  const previous = process.env.PI_FULL_RUNTIME_CREATION_REPORT;
  process.env.PI_FULL_RUNTIME_CREATION_REPORT = marker;
  writeFileSync(join(root, 'server-registration-v1.json'), JSON.stringify({ version: 1, agentDir: root, serverDir: root }));
  const watch = () => Object.assign(new EventEmitter(), { close() {}, ready: Promise.resolve() });
  const model = new WorkReadModel(root, 'hosted-work', { baseDir: root, durableDir: join(root, 'durable'), intervalMs: 60000, watch });
  const socket = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
  const stream = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
    write(line) { socket.emit('data', line); return true; } });
  const queries = new WorkQueries(model, stream);
  const requests = [], failures = [];
  let releaseSubscribe;
  const reply = (id, data) => socket.emit('data', JSON.stringify({ id, success: true, data }) + '\n');
  socket.write = line => {
    const command = JSON.parse(line); requests.push(command.type);
    queueMicrotask(() => {
      try {
        if (command.type === 'hello') return reply(command.id, {});
        const value = queries.handle(command);
        if (command.type === 'runtime_subscribe') releaseSubscribe = () => reply(command.id, value);
        else reply(command.id, value);
      } catch (error) { failures.push(error); }
    });
    return true;
  };
  globalThis[key] = () => socket;
  traceHostedRequests(WorkClient);
  let completed = false;
  const startup = traceHostedHook('subagents', 'session_start', 2,
    async () => { await startWorkObservation(root, { cwd: root, sessionId: 'hosted-owner' }, () => {}); });
  const runner = { extensions: [{ handlers: new Map([['session_start', [startup]]]) }],
    createContext: () => ({}), isSessionBeforeEvent: () => false, emitError(error) { failures.push(error); },
    emit(event) { return ExtensionRunner.prototype.emit.call(this, event); } };
  let pending;
  try {
    await model.reconcile();
    const session = { _extensionRunner: runner, _sessionStartEvent: { type: 'session_start', reason: 'startup' },
      _applyExtensionBindings() {}, async extendResourcesFromExtensions() { completed = true; } };
    pending = AgentSession.prototype.bindExtensions.call(session, { mode: 'rpc' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseSubscribe, 'function');
    assert.equal(completed, false, 'hosted bind must not bypass its awaited correctness hook');
    assert.deepEqual(requests, ['hello', 'runtime_subscribe']);
    const waiting = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(waiting.phase, 'subagents:session_start:2');
    assert.equal(waiting.dependency.type, 'runtime_subscribe'); assert.equal(waiting.dependency.state, 'pending');
    t.diagnostic(JSON.stringify({ controlledHeldBoundary: waiting, completed, requests }));
    releaseSubscribe(); await pending;
    assert.deepEqual(failures, []);
    assert.equal(completed, true);
    assert.equal(workObservation().status, 'ready');
    assert.deepEqual(workObservation().rows, []);
    assert.equal(workObservation().instanceId, 'hosted-work');
    assert.ok(requests.filter(type => type === 'runtime_get_snapshot').length >= 5, 'actual collector must read and confirm its scoped pages');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).status, 'returned');
    const settled = requests.length; await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, settled, 'settled bind creates no polling demand');
    t.diagnostic(JSON.stringify({ completed, observation: workObservation().status, requests: requests.length, finalMarker: JSON.parse(readFileSync(marker, 'utf8')) }));
  } finally {
    releaseSubscribe?.(); await pending?.catch(() => {});
    stopWorkObservation(); queries.close(); await model.close(); delete globalThis[key];
    if (previous === undefined) delete process.env.PI_FULL_RUNTIME_CREATION_REPORT;
    else process.env.PI_FULL_RUNTIME_CREATION_REPORT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test.after(() => hooks.deregister());
