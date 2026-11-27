import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { EventEmitter } from 'node:events';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'continuation-runtime-'));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.TMPDIR = root;
register(new URL('./pi_host_stub_hooks.mjs', import.meta.url));
const { managedDomainPort } = await import("./managed-domain-port.mjs");
const { default: extension } = await import('../index.ts');
const { setConfigForTests } = await import('../config.ts');
const { baseDir, readMeta, listMetas, runDir, writeMeta } = await import('../registry.ts');
const { findSavedConversation } = await import('../continuation.ts');
const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const sdk = pathToFileURL(join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
const bin = join(root, 'bin'); mkdirSync(bin);
const executable = join(bin, 'pi');
writeFileSync(executable, `#!/usr/bin/env node
(async()=>{
const {SessionManager}=await import(${JSON.stringify(sdk)});
const args=process.argv.slice(2);const option=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
const saved=option('--session');const dir=option('--session-dir');
const manager=saved?SessionManager.open(saved,dir):SessionManager.create(process.cwd(),dir,{id:option('--session-id')});
const before=manager.buildSessionContext().messages.length;
manager.appendMessage({role:'user',content:args.at(-1),timestamp:1});
manager.appendMessage({role:'assistant',content:[{type:'text',text:'ok'}],timestamp:2});
require('node:fs').writeFileSync(${JSON.stringify(join(root, 'child-'))}+process.pid+'.json',JSON.stringify({before,sessionId:manager.getSessionId(),argv:args}));
process.stdout.write(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'ok'}]}]})+'\\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
`);
chmodSync(executable, 0o755);
const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath ?? ''}`;
const { startWorkRuntimeFixture } = await import('./work-runtime-fixture.mjs');
const stopRuntime = await startWorkRuntimeFixture();

function fixture(name, implementation = extension, port = managedDomainPort()) {
  const workspace = join(root, name); mkdirSync(workspace);
  const tools = new Map(), handlers = new Map();
  const host = { events: new EventEmitter(), registerTool: x => tools.set(x.name, x),
    registerCommand() {}, appendEntry() {}, on: (n, fn) => handlers.set(n, fn), sendMessage() {} };
  const ctx = { cwd: workspace, model: { provider: 'test', id: 'model' }, hasUI: false,
    isProjectTrusted: () => true,
    modelRegistry: { getAvailable: () => [{ provider: 'test', id: 'model', reasoning: true }], find: () => undefined },
    isIdle: () => true, ui: { notify() {}, setWidget() {} },
    sessionManager: { getSessionId: () => name, getBranch: () => [] } };
  implementation(host, port);
  const execute = (tool, params) => tools.get(tool).execute('check', params, undefined, undefined, ctx);
  return { execute, workspace, shutdown: () => handlers.get('session_shutdown')?.({}, ctx) };
}
function idOf(result) { return result.details?.runId ?? result.content[0].text.match(/id=(\S+)/)[1]; }
async function terminal(id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const meta = readMeta(id);
    if (meta && !['running', 'orphaned'].includes(meta.status)) return meta;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Attempt ${id} did not finalize`);
}

try {
  await test('a server upgrade continues the same native history with its original worker release', { skip: process.platform === 'win32' }, async () => {
    const install = realpathSync(join(root));
    symlinkSync(join(repo, 'node_modules'), join(install, 'node_modules'), 'dir');
    async function release(id) {
      const releaseRoot = join(install, 'releases', id.repeat(64));
      const domain = join(releaseRoot, 'src/runtime/domain/subagents');
      cpSync(join(repo, 'packages/pi-better-subagents'), domain, { recursive: true,
        filter: path => !['tests', 'node_modules'].includes(path.split('/').at(-1)) });
      mkdirSync(join(releaseRoot, 'node/bin'), { recursive: true });
      const node = join(releaseRoot, 'node/bin/node');
      writeFileSync(node, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`); chmodSync(node, 0o700);
      writeFileSync(join(releaseRoot, 'runtime.json'), JSON.stringify({format: 1, root: releaseRoot, installRoot: install, node,
        build: {contentId: id.repeat(64), protocolVersion: 1, piSdkVersion: 'fixture', nodeVersion: process.versions.node, platform: process.platform}}));
      const port = managedDomainPort();
      port.workerCommand = args => ({file: process.execPath, fileArgs: [join(domain, 'child-runtime.mjs'), executable, ...args]});
      return {root: releaseRoot, domain, port, implementation: (await import(pathToFileURL(join(domain, 'index.ts')).href)).default};
    }
    const old = await release('a'), current = await release('b');
    const firstHost = fixture('release-before', old.implementation, old.port);
    const nextHost = fixture('release-after', current.implementation, current.port);
    try {
      const first = await terminal(idOf(await firstHost.execute('subagent_spawn', {
        prompt: 'before upgrade', cwd: firstHost.workspace, model: 'test/model', sandbox: false, callback: false, tools: 'read', skills: [],
      })));
      assert.equal(first.recipe.runtimeRoot, old.root);
      const previous = JSON.stringify(first);
      const resumed = await terminal(idOf(await nextHost.execute('subagent_spawn', {session_id: first.sessionId, prompt: 'after upgrade'})));
      assert.equal(resumed.exitCode, 0);
      assert.equal(resumed.sessionId, first.sessionId);
      assert.equal(resumed.recipe.runtimeRoot, old.root);
      const child = JSON.parse(readFileSync(join(root, `child-${resumed.pid}.json`), 'utf8'));
      assert.equal(child.before, 2, 'native history survives the release change');
      assert.ok(child.argv.includes(join(old.domain, 'child-steer.ts')));
      assert.ok(!child.argv.includes(join(current.domain, 'child-steer.ts')));
      assert.equal(JSON.stringify(readMeta(first.id)), previous);
    } finally { firstHost.shutdown(); nextHost.shutdown(); }
  });

  await test('configuration changes cannot silently replace an extension implementation on resume', async () => {
    const f = fixture('extension-owner');
    const a = join(root, 'extension-a.ts'), b = join(root, 'extension-b.ts');
    writeFileSync(a, 'export default function() {}'); writeFileSync(b, 'export default function() {}');
    try {
      setConfigForTests({ toolExtensions: { custom_tool: a } });
      const first = idOf(await f.execute('subagent_spawn', { prompt: 'initial', cwd: f.workspace,
        model: 'test/model', tools: 'read,custom_tool', sandbox: false, callback: false }));
      const meta = await terminal(first); assert.equal(meta.status, 'completed');
      const original = JSON.stringify(meta), count = listMetas().length;
      setConfigForTests({ toolExtensions: { custom_tool: b } });
      await assert.rejects(f.execute('subagent_spawn', { session_id: readMeta(first).sessionId, prompt: 'continue' }),
        /resolved extension implementations changed/);
      assert.equal(listMetas().length, count, 'no differently configured child was launched');
      assert.equal(JSON.stringify(readMeta(first)), original);
    } finally { setConfigForTests(undefined); f.shutdown(); }
  });

  await test('continued recipes preserve role, agent and alias identity across attempts', async () => {
    const f = fixture('identity-owner');
    try {
      const roles = join(f.workspace, '.pi/agents/roles'), agents = join(f.workspace, '.pi/agents/agents');
      mkdirSync(roles, { recursive: true }); mkdirSync(agents);
      const role = effort => `---\nschema: pi-agent/v1\nkind: role\nid: role.developer\nname: Developer\ndefaults:\n  model: test/model\n  effort: ${effort}\n---\nFrozen ${effort} instructions.\n`;
      writeFileSync(join(roles, 'developer.md'), role('low'));
      writeFileSync(join(agents, 'payments.md'), '---\nschema: pi-agent/v1\nkind: agent\nid: agent.payments\nname: Payments\nroleId: role.developer\ninstructions:\n  mode: add\n---\nOwned agent instructions.\n');
      const first = idOf(await f.execute('subagent_spawn', { prompt: 'initial', cwd: f.workspace,
        agent: 'agent.payments', alias: 'checkout', tools: 'read', clean: true, sandbox: false, callback: false }));
      const meta = await terminal(first); assert.equal(meta.status, 'completed');
      assert.equal(meta.effort, 'low');
      const identity = { agent: 'agent.payments', alias: 'checkout' };
      const previous = JSON.stringify(readMeta(first));
      writeFileSync(join(roles, 'developer.md'), role('high'));
      const fresh = await terminal(idOf(await f.execute('subagent_spawn', { prompt: 'new definition', cwd: f.workspace,
        agent: 'agent.payments', tools: 'read', clean: true, sandbox: false, callback: false })));
      assert.equal(fresh.effort, 'high');
      assert.notEqual(fresh.catalog.snapshotDigest, meta.catalog.snapshotDigest);
      let prior = first;
      for (const prompt of ['first feedback', 'second feedback']) {
        const next = idOf(await f.execute('subagent_spawn', { session_id: readMeta(prior).sessionId, prompt }));
        const continued = await terminal(next); assert.equal(continued.status, 'completed');
        for (const [key, value] of Object.entries(identity)) assert.equal(continued.recipe[key], value);
        assert.equal(continued.model, 'test/model'); assert.equal(continued.effort, 'low');
        assert.equal(continued.recipe.tools, 'read'); assert.equal(continued.recipe.allowNested, false);
        assert.equal(continued.sessionId, meta.sessionId);
        prior = next;
      }
      assert.equal(JSON.stringify(readMeta(first)), previous);
    } finally { f.shutdown(); }
  });

  await test('a continuation revalidates the saved conversation after the volatile artifacts are swept', async () => {
    const f = fixture('history-owner');
    try {
      const first = idOf(await f.execute('subagent_spawn', { prompt: 'old context', cwd: f.workspace,
        model: 'test/model', tools: 'read', clean: true, sandbox: false, callback: false }));
      const meta = await terminal(first); assert.equal(meta.status, 'completed');
      const saved = findSavedConversation({sessionDir:meta.recipe.sessionDir,sessionId:meta.sessionId,expectedCwd:f.workspace});
      assert.equal(saved.kind, 'ok');
      // Saved sessions are durable, so the sweep no longer needs a release to
      // keep this conversation; it only reclaims the volatile attempt artifacts.
      const old = new Date(Date.now() - 10 * 86400000);
      utimesSync(saved.conversation.path, old, old); utimesSync(runDir(first), old, old);
      writeFileSync(join(baseDir(), 'cleanup-state.json'), JSON.stringify({lastLocalDate:'1970-01-01'}));
      const next = idOf(await f.execute('subagent_spawn', { session_id: readMeta(first).sessionId, prompt: 'new feedback' }));
      const continued = await terminal(next); assert.equal(continued.status, 'completed');
      const child = JSON.parse(readFileSync(join(root, `child-${continued.pid}.json`), 'utf8'));
      assert.equal(child.before, 2, 'the real SDK must load both old messages rather than create empty history');
      assert.equal(child.sessionId, meta.sessionId);
      assert.equal(continued.sessionId, meta.sessionId);
    } finally { f.shutdown(); }
  });
} finally {
  await stopRuntime();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  process.env.PATH = oldPath;
  rmSync(root, { recursive: true, force: true });
}
