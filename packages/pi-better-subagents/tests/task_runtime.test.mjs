// @covers subagent.trusted-runtime-task-boundary
// @level integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { describeSandboxSupport } from '../shared-sandbox-core.ts';
import { createTaskBashOperations } from '../shared-task-sandbox.ts';
import taskGuard from '../task-guard.ts';
import { parseTaskPolicy, prepareTaskRuntime } from '../task-policy.ts';

function fixture(t, permissions = {}) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'pi-task-runtime-')));
    const project = join(base, 'project'), agent = join(base, 'agent'), control = join(base, 'control');
    const scratch = join(base, 'scratch');
    for (const dir of [project, agent, control, scratch]) mkdirSync(dir);
    writeFileSync(join(scratch, '.sandbox-anchor'), '');
    writeFileSync(join(agent, 'auth.json'), '{}');
    writeFileSync(join(agent, 'settings.json'), '{}');
    const policy = { version: 1, root: project, home: join(base, 'home'), agentDir: agent, profilePath: join(control, 'task.sb'), scratch,
        permissions: { projectFiles: 'read-write', outsideProject: 'read', storedCredentials: 'read', commands: true, network: true, ...permissions },
        denyWrite: [agent, control, join(scratch, '.sandbox-anchor')], tools: ['read', 'write', 'edit', 'bash', 'escape'] };
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    t.after(() => {
        if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgent;
        rmSync(base, { recursive: true, force: true });
    });
    return { base, project, agent, control, policy };
}

const supported = describeSandboxSupport().supported;

test('real Pi RPC startup takes runtime locks with task network and commands disabled', { skip: !supported }, (t) => {
    const f = fixture(t, { commands: false, network: false, storedCredentials: 'off' });
    const prepared = prepareTaskRuntime({ root: f.project, controlDir: f.control,
        tools: ['read', 'write', 'edit', 'bash'], permissions: f.policy.permissions,
        piBin: fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))) });
    t.after(() => rmSync(prepared.policy.scratch, { recursive: true, force: true }));
    const result = spawnSync(prepared.file, [...prepared.fileArgs,
        '--mode', 'rpc', '--offline', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--no-builtin-tools'], {
        cwd: f.project, encoding: 'utf8', timeout: 30000,
        input: '{"type":"get_state","id":"startup"}\n',
        env: { ...process.env, PI_CODING_AGENT_DIR: f.agent },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const rows = (result.stderr + '\n' + result.stdout).split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert.equal(rows.find((row) => row.id === 'startup')?.success, true, result.stdout);
    assert.deepEqual(rows.find((row) => row.type === 'task_sandbox_ready')?.tools, ['read', 'write', 'edit', 'bash'], result.stderr + result.stdout);
    assert.doesNotMatch(result.stderr, /EPERM|EACCES|permission denied/i);
    assert.equal(readFileSync(join(f.agent, 'auth.json'), 'utf8'), '{}');
    assert.equal(existsSync(join(f.agent, 'auth.json.lock')), false);
});

test('malformed bootstrap policy terminates before Pi can offer tools', (t) => {
    const f = fixture(t);
    const policyPath = join(f.control, 'bad.json');
    writeFileSync(policyPath, '{');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../task-runtime.mjs', import.meta.url)), fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), policyPath, '--mode', 'rpc'], {
        cwd: f.project, encoding: 'utf8', timeout: 15000, input: '{"type":"get_state","id":"startup"}\n',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Task sandbox bootstrap failed/);
    assert.doesNotMatch(result.stdout, /task_sandbox_ready|"success":true/);
});

async function sessionFixture(t, f, extraFactories = []) {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd: f.project, agentDir: f.agent, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [...extraFactories, { name: 'task-sandbox', factory: (pi) => taskGuard(pi, f.policy, (error) => { throw error; }) }] });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(f.agent, 'models.json'), modelsStorePath: join(f.agent, 'models-store.json') });
    const { session } = await createAgentSession({ cwd: f.project, agentDir: f.agent, resourceLoader: loader, modelRuntime,
        settingsManager, sessionManager: SessionManager.inMemory(f.project), noTools: 'builtin' });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    return session;
}

async function execute(session, name, params) {
    const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is active`);
    const decision = await session.agent.beforeToolCall?.({ toolCall: { id: 'boundary-test', name, arguments: params }, args: params });
    if (decision?.block) throw new Error(decision.reason);
    return tool.execute('boundary-test', params, new AbortController().signal);
}

test('actual SDK dispatch confines writes and rejects unclassified extension execution', { skip: !supported }, async (t) => {
    const f = fixture(t, { commands: false, storedCredentials: 'off', outsideProject: 'off' });
    let escaped = false;
    const session = await sessionFixture(t, f, [(pi) => pi.registerTool({ ...createWriteToolDefinition(f.project), name: 'escape',
        execute: async () => { escaped = true; return { content: [{ type: 'text', text: 'escaped' }], details: undefined }; } })]);
    session.setActiveToolsByName(['read', 'write', 'bash', 'escape']);
    await execute(session, 'write', { path: 'inside.txt', content: 'inside' });
    assert.equal(readFileSync(join(f.project, 'inside.txt'), 'utf8'), 'inside');
    f.policy.permissions.outsideProject = 'read-write';
    await assert.rejects(execute(session, 'write', { path: join(f.base, 'outside.txt'), content: 'no' }));
    await assert.rejects(execute(session, 'write', { path: join(f.agent, 'settings.json.lock'), content: 'no' }));
    await assert.rejects(execute(session, 'read', { path: join(f.agent, 'auth.json') }));
    await assert.rejects(execute(session, 'bash', { command: 'true' }), /commands.*Off/i);
    await assert.rejects(execute(session, 'escape', { path: 'unused', content: 'unused' }), /verified task execution adapter/);
    assert.equal(escaped, false);
    assert.equal(existsSync(join(f.base, 'outside.txt')), false);
});

test('late replacement with a copied guarded schema still fails source verification', { skip: !supported }, async (t) => {
    const f = fixture(t);
    let replace;
    const session = await sessionFixture(t, f, [(pi) => { replace = () => {
        const schema = pi.getAllTools().find((tool) => tool.name === 'write').parameters;
        pi.registerTool({ ...createWriteToolDefinition(f.project), parameters: schema });
    }; }]);
    replace();
    await assert.rejects(execute(session, 'write', { path: join(f.base, 'outside.txt'), content: 'no' }), /replaced by an unverified/);
    assert.equal(existsSync(join(f.base, 'outside.txt')), false);
});

test('task commands use private scratch without granting writes to other temporary paths', { skip: !supported }, async (t) => {
    const f = fixture(t);
    const session = await sessionFixture(t, f);
    const script = `
      const fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
      const scratch=${JSON.stringify(f.policy.scratch)};
      assert.equal(os.tmpdir(),scratch);
      fs.writeFileSync(scratch+'/created-by-command','scratch');
      assert.throws(()=>fs.renameSync(scratch,scratch+'-moved'));
      assert.throws(()=>fs.writeFileSync(scratch+'/.sandbox-anchor','no'));
      assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(f.base, 'outside-temp'))},'no'));
      console.log('scratch-ok');
    `;
    const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
    const result = await execute(session, 'bash', { command: `${quote(process.execPath)} -e ${quote(script)}` });
    assert.match(JSON.stringify(result), /scratch-ok/);
    await execute(session, 'write', { path: join(f.policy.scratch, 'created-by-file-tool'), content: 'scratch' });
    assert.equal(readFileSync(join(f.policy.scratch, 'created-by-file-tool'), 'utf8'), 'scratch');
    assert.equal(existsSync(join(f.base, 'outside-temp')), false);
});

test('shell initialization executes only inside confinement and cancellation remains effective', { skip: !supported }, async (t) => {
    const f = fixture(t);
    const startup = join(f.project, 'startup.sh'), escaped = join(f.base, 'escaped');
    writeFileSync(startup, `printf escaped > '${escaped}'\nprintf startup-ran\\n\n`);
    const ops = createTaskBashOperations({ requireLaunchPlan: () => ({ confined: true,
        profilePath: f.policy.profilePath, policy: { writableRoot: f.project, home: f.policy.home,
            denyWrite: f.policy.denyWrite, permissions: f.policy.permissions } }) }, () => '/bin/bash');
    let output = '';
    const result = await ops.exec('printf command-ran', f.project, { env: { BASH_ENV: startup }, onData: (data) => { output += data; } });
    assert.equal(result.exitCode, 0);
    assert.match(output, /command-ran/);
    assert.match(output, /startup-ran/);
    assert.equal(existsSync(escaped), false);
    let drained = '';
    await ops.exec('(printf tail) & printf head', f.project, { onData: (data) => { drained += data; } });
    assert.match(drained, /head/);
    assert.match(drained, /tail/);
    await assert.rejects(ops.exec('sleep 10', f.project, { timeout: 0.05, onData: () => {} }), /timeout:/);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 50);
    try { await assert.rejects(ops.exec('sleep 10', f.project, { signal: abort.signal, onData: () => {} }), /aborted/); }
    finally { clearTimeout(timer); }
    const { killTrackedDetachedChildren } = await import(new URL('./utils/shell.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
    let trackedPid;
    await ops.exec('printf "ready:%s\\n" "$$"; exec sleep 10', f.project, {
        timeout: 2,
        onData: (data) => {
            const match = data.toString().match(/ready:(\d+)/);
            if (match) { trackedPid = Number(match[1]); killTrackedDetachedChildren(); }
        },
    });
    assert.ok(trackedPid, 'the tracked command started');
    assert.throws(() => process.kill(trackedPid, 0), /ESRCH/, 'SDK shutdown cleanup must terminate the detached command');
});

test('policy snapshots validate and detach their mutable input', (t) => {
    const f = fixture(t);
    const frozen = parseTaskPolicy(f.policy);
    f.policy.permissions.outsideProject = 'read-write';
    f.policy.denyWrite.length = 0;
    assert.equal(frozen.permissions.outsideProject, 'read');
    assert.equal(frozen.denyWrite.length, 3);
    assert.throws(() => parseTaskPolicy({ ...f.policy, root: 'relative' }), /absolute/);
});
