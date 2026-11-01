import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'continuation-runtime-'));
process.env.TMPDIR = root;
register(new URL('./pi_host_stub_hooks.mjs', import.meta.url));
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

function fixture(name) {
  const workspace = join(root, name); mkdirSync(workspace);
  const tools = new Map(), handlers = new Map();
  const host = { events: new EventEmitter(), registerTool: x => tools.set(x.name, x),
    registerCommand() {}, appendEntry() {}, on: (n, fn) => handlers.set(n, fn), sendMessage() {} };
  const ctx = { cwd: workspace, model: { provider: 'test', id: 'model' }, hasUI: false,
    isIdle: () => true, ui: { notify() {}, setWidget() {} },
    sessionManager: { getSessionId: () => name, getBranch: () => [] } };
  extension(host);
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
  await test('configuration changes cannot silently replace an extension implementation on resume', async () => {
    const f = fixture('extension-owner');
    const a = join(root, 'extension-a.ts'), b = join(root, 'extension-b.ts');
    writeFileSync(a, 'export default function() {}'); writeFileSync(b, 'export default function() {}');
    try {
      setConfigForTests({ toolExtensions: { custom_tool: a } });
      const first = idOf(await f.execute('subagent_spawn', { prompt: 'initial', cwd: f.workspace,
        model: 'test/model', tools: 'read,custom_tool', sandbox: false, callback: false, retain_session: true }));
      const meta = await terminal(first); assert.equal(meta.status, 'completed');
      const original = JSON.stringify(meta), count = listMetas().length;
      setConfigForTests({ toolExtensions: { custom_tool: b } });
      await assert.rejects(f.execute('subagent_resume', { id: first, prompt: 'continue' }),
        /resolved extension implementations changed/);
      assert.equal(listMetas().length, count, 'no differently configured child was launched');
      assert.equal(JSON.stringify(readMeta(first)), original);
    } finally { setConfigForTests(undefined); f.shutdown(); }
  });

  await test('continued recipes preserve role, agent and alias identity across attempts', async () => {
    const f = fixture('identity-owner');
    try {
      const first = idOf(await f.execute('subagent_spawn', { prompt: 'initial', cwd: f.workspace,
        model: 'test/model', tools: 'read', clean: true, sandbox: false, callback: false, retain_session: true }));
      const meta = await terminal(first); assert.equal(meta.status, 'completed');
      // Seed a catalog-shaped recorded recipe without calling a model/catalog service.
      const identity = { agent: 'agent.payments', role: 'developer', alias: 'checkout' };
      writeMeta({ ...meta, recipe: { ...meta.recipe, ...identity } });
      const previous = JSON.stringify(readMeta(first));
      let prior = first;
      for (const prompt of ['first feedback', 'second feedback']) {
        const next = idOf(await f.execute('subagent_resume', { id: prior, prompt }));
        const continued = await terminal(next); assert.equal(continued.status, 'completed');
        for (const [key, value] of Object.entries(identity)) assert.equal(continued.recipe[key], value);
        assert.equal(continued.sessionId, meta.sessionId);
        prior = next;
      }
      assert.equal(JSON.stringify(readMeta(first)), previous);
    } finally { f.shutdown(); }
  });

  await test('resume cannot retire its validated conversation before the child opens it', async () => {
    const f = fixture('history-owner');
    try {
      const first = idOf(await f.execute('subagent_spawn', { prompt: 'old context', cwd: f.workspace,
        model: 'test/model', tools: 'read', clean: true, sandbox: false, callback: false, retain_session: true }));
      const meta = await terminal(first); assert.equal(meta.status, 'completed');
      const saved = findSavedConversation({sessionDir:meta.recipe.sessionDir,sessionId:meta.sessionId,expectedCwd:f.workspace});
      assert.equal(saved.kind, 'ok');
      await f.execute('subagent_release', { id: first });
      const old = new Date(Date.now() - 10 * 86400000);
      utimesSync(saved.conversation.path, old, old); utimesSync(runDir(first), old, old);
      writeFileSync(join(baseDir(), 'cleanup-state.json'), JSON.stringify({lastLocalDate:'1970-01-01'}));
      const next = idOf(await f.execute('subagent_resume', { id: first, prompt: 'new feedback' }));
      const continued = await terminal(next); assert.equal(continued.status, 'completed');
      const child = JSON.parse(readFileSync(join(root, `child-${continued.pid}.json`), 'utf8'));
      assert.equal(child.before, 2, 'the real SDK must load both old messages rather than create empty history');
      assert.equal(child.sessionId, meta.sessionId);
      assert.equal(continued.sessionId, meta.sessionId);
    } finally { f.shutdown(); }
  });
} finally {
  process.env.PATH = oldPath;
  rmSync(root, { recursive: true, force: true });
}
