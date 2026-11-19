import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession, ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { traceHostedHook } from '../scripts/measure-full-runtime/hosted-hook-trace.mjs';
import ts from 'typescript';

test('actual hosted fixture registration forwards all hooks and tools with distinct owner ordinals', async () => {
  const source = readFileSync(new URL('../scripts/measure-full-runtime/hosted-extension.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('hosted-extension.ts', source, ts.ScriptTarget.Latest, true);
  let capture: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'capture') capture = node;
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(capture?.initializer);
  const code = ts.transpileModule(`const capture = ${capture.initializer.getText(tree)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const handlers: any[] = [], tools = new Map(), registered: any[] = [], observations: any[] = [];
  const pi = { on: (event: string, handler: any) => handlers.push({ event, handler }), registerTool: (tool: any) => registered.push(tool) };
  const factory = new Function('pi', 'tools', 'traceHostedHook', `${code}; return capture;`)(pi, tools,
    (owner: string, event: string, ordinal: number, handler: any) => {
      observations.push({ owner, event, ordinal }); return handler;
    });
  const background = factory('background'), subagents = factory('subagents');
  const callback = () => 'unchanged';
  background.on('session_start', callback); background.on('session_start', callback);
  subagents.on('session_start', callback); subagents.on('tool_call', callback);
  assert.deepEqual(observations.map(value => [value.owner, value.event, value.ordinal]), [
    ['background', 'session_start', 1], ['background', 'session_start', 2], ['subagents', 'session_start', 1], ['subagents', 'tool_call', 1],
  ]);
  assert.ok(handlers.every(value => value.handler === callback));
  const tool = { name: 'actual-tool' }; subagents.registerTool(tool);
  assert.equal(tools.get(tool.name), tool); assert.deepEqual(registered, [tool]);
});

test('actual SDK bind and sequential dispatch identify the held session-start hook without skipping correctness handlers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-hook-'));
  const previous = process.env.PI_FULL_RUNTIME_CREATION_REPORT;
  const output = join(root, 'hook.json');
  process.env.PI_FULL_RUNTIME_CREATION_REPORT = output;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const context = {};
  const handler = (owner: string, ordinal: number, wait = false) => traceHostedHook(owner, 'session_start', ordinal,
    async (event: any, ctx: any) => {
      assert.equal(event.type, 'session_start'); assert.equal(ctx, context);
      calls.push(`${owner}:${ordinal}`);
      if (wait) await held;
    });
  const runner: any = {
    extensions: [
      { handlers: new Map([['session_start', [handler('background', 1), handler('background', 2), handler('background', 3)]]]) },
      { handlers: new Map([['session_start', [handler('subagents', 1, true), handler('subagents', 2)]]]) },
    ],
    createContext: () => context, isSessionBeforeEvent: () => false,
    emitError: (error: any) => assert.fail(JSON.stringify(error)),
    emit(event: any) { return ExtensionRunner.prototype.emit.call(this, event); },
  };
  const session: any = { _extensionRunner: runner, _sessionStartEvent: { type: 'session_start', reason: 'startup' },
    _applyExtensionBindings() {}, async extendResourcesFromExtensions() { calls.push('resources-discover'); } };
  const pending = AgentSession.prototype.bindExtensions.call(session, { mode: 'rpc' });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['background:1', 'background:2', 'background:3', 'subagents:1']);
    const marker = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(marker.phase, 'subagents:session_start:1'); assert.equal(marker.status, 'entered');
    assert.ok(Buffer.byteLength(readFileSync(output)) < 256);
    release(); await pending;
    assert.deepEqual(calls.slice(-2), ['subagents:2', 'resources-discover']);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).status, 'returned');
    const failure = new Error('original hook failure');
    await assert.rejects(traceHostedHook('subagents', 'session_start', 1, () => { throw failure; })(), error => error === failure);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).status, 'failed');
    const untouched = () => 'original';
    assert.equal(traceHostedHook('subagents', 'tool_call', 1, untouched), untouched);
  } finally {
    release(); await pending.catch(() => {});
    if (previous === undefined) delete process.env.PI_FULL_RUNTIME_CREATION_REPORT;
    else process.env.PI_FULL_RUNTIME_CREATION_REPORT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
