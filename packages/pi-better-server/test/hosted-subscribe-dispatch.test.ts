import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { WorkQueryExecutor } from '../src/runtime/query-executor.ts';
import { WorkClient } from '../src/runtime/work-client.mjs';
const { instrumentHostedRead } = await import(String('../scripts/measure-full-runtime/recovery-trace-loader.mjs'));
const { recordHostedReadPhase } = await import(String('../scripts/measure-full-runtime/recovery-trace.mjs'));

test('actual server subscribe dispatch receives an actual worker snapshot and writes the original correlated reply', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-dispatch-')), output = join(root, 'phase.json');
  const previous = process.env.PI_FULL_RUNTIME_CREATION_REPORT;
  process.env.PI_FULL_RUNTIME_CREATION_REPORT = output;
  const source = instrumentHostedRead(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'), 'server');
  const tree = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  let branch: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(tree).startsWith('["runtime_get_snapshot", "runtime_subscribe", "runtime_unsubscribe", "runtime_get_metrics"]')) branch = node;
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(branch);
  const code = ts.transpileModule(branch.getText(tree), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const executor = new WorkQueryExecutor(root, 'hosted-dispatch', { workerUrl: new URL('./support/hosted-read-observed-worker.mjs', import.meta.url) });
  const frames: any[] = [];
  const clientTransport = new Duplex({ read() {},
    write(line, _encoding, done) {
      const command = JSON.parse(String(line));
      queueMicrotask(() => {
        if (['hello', 'runtime_register_client'].includes(command.type)) {
          clientTransport.emit('data', JSON.stringify({ id: command.id, success: true, data: {} }) + '\n');
        } else void dispatch(command).catch((error: Error) => clientTransport.emit('error', error));
      });
      done();
    },
  });
  const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
    write(line: string) { frames.push(JSON.parse(line)); clientTransport.emit('data', line); return true; } });
  // Execute the actual server branch; only its external socket is replaced.
  const dispatch = new Function('work', 'socket', 'recordHostedReadPhase', `
    let workQueries, runtimeInFlight = 0;
    const greeted = true;
    return async command => { const {type,id}=command; ${code} };
  `)(() => executor, socket, recordHostedReadPhase);
  const client = new WorkClient(clientTransport, root);
  try {
    await client.ready;
    await client.request('runtime_register_client', { clientId: 'controlled-hosted-client' });
    const observed = await client.subscribe({ cwd: root, sessionId: 'hosted-owner', limit: 200 });
    const reply = frames.find(value => value.id === 'work-3');
    assert.ok(reply, 'original socket envelope must carry the original request ID');
    assert.equal(reply.success, true);
    assert.equal(reply.command, 'runtime_subscribe');
    assert.ok(['ready', 'rebuilding'].includes(reply.data.status), 'source not ready must remain rebuilding');
    assert.equal(reply.data.instanceId, 'hosted-dispatch');
    assert.deepEqual(reply.data.rows, []);
    assert.deepEqual(observed, reply.data, 'actual client decoder settles the subscribe promise from the correlated server frame');
    const server = JSON.parse(readFileSync(output + '.server.json', 'utf8'));
    const worker = JSON.parse(readFileSync(output + '.worker.json', 'utf8'));
    assert.equal(server.phase, 'socket-written');
    assert.equal(server.id, 'work-3');
    assert.equal(worker.phase, 'reply-posted');
    assert.ok(worker.threadId > 0);
    assert.equal(executor.metrics().executor.completed, 1);
    t.diagnostic(JSON.stringify({ server, worker, replyStatus: reply.data.status, completed: executor.metrics().executor.completed }));
  } finally {
    client.close();
    await executor.close();
    if (previous === undefined) delete process.env.PI_FULL_RUNTIME_CREATION_REPORT;
    else process.env.PI_FULL_RUNTIME_CREATION_REPORT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
