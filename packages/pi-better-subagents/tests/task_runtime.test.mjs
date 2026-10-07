// @covers subagent.trusted-runtime-task-boundary
// @level integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { describeSandboxSupport } from '../shared-sandbox-core.ts';
import { createTaskBashOperations } from '../shared-task-sandbox.ts';
import taskGuard, { trustedToolRefusal } from '../task-guard.ts';
import { parseTaskPolicy, prepareTaskRuntime } from '../task-policy.ts';
import { planTaskTools } from '../subagent-tools.ts';

function fixture(t, permissions = {}, fixtureParent = process.platform === 'win32' ? tmpdir() : '/var/tmp') {
    const base = realpathSync(mkdtempSync(join(fixtureParent, 'pi-task-runtime-')));
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
        const mask = join(control, '.pi-sandbox-mask', 'directory');
        if (existsSync(mask)) chmodSync(mask, 0o700);
        rmSync(base, { recursive: true, force: true });
    });
    return { base, project, agent, control, policy };
}

const supported = describeSandboxSupport().supported;

test('standalone launch defaults allow credential maintenance but keep process inventory Off', { skip: !supported }, (t) => {
    const f = fixture(t);
    const prepared = prepareTaskRuntime({ root: f.project, controlDir: f.control, tools: ['read'],
        piBin: fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))) });
    t.after(() => rmSync(prepared.policy.scratch, { recursive: true, force: true }));
    assert.equal(prepared.policy.permissions.storedCredentials, 'read-write');
    assert.equal(prepared.policy.permissions.processAccess, 'off');
    assert.ok(Object.isFrozen(prepared.policy.permissions));
});

test('old task policies retain inventory Off and invalid process levels fail closed', (t) => {
    const f = fixture(t);
    assert.equal(parseTaskPolicy(f.policy).permissions.processAccess, 'off');
    f.policy.permissions.processAccess = 'write';
    assert.throws(() => parseTaskPolicy(f.policy), /Invalid task sandbox processAccess/);
});

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

// @covers subagent.timing
test('the harness steer extension loads in a confined child without changing its guarded tool set', { skip: !supported }, (t) => {
    const f = fixture(t, { commands: false, network: false, storedCredentials: 'off' });
    const prepared = prepareTaskRuntime({ root: f.project, controlDir: f.control,
        tools: ['read', 'bash'], permissions: f.policy.permissions,
        piBin: fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))) });
    t.after(() => rmSync(prepared.policy.scratch, { recursive: true, force: true }));
    const result = spawnSync(prepared.file, [...prepared.fileArgs,
        '--mode', 'rpc', '--offline', '--no-session', '--no-extensions', '--extension', fileURLToPath(new URL('../child-steer.ts', import.meta.url)),
        '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--no-builtin-tools'], {
        cwd: f.project, encoding: 'utf8', timeout: 30000,
        input: '{"type":"get_state","id":"startup"}\n',
        env: { ...process.env, PI_CODING_AGENT_DIR: f.agent, PI_SUBAGENT_STEER_FILE: join(f.control, 'steer.json') },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const rows = (result.stderr + '\n' + result.stdout).split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert.equal(rows.find((row) => row.id === 'startup')?.success, true, result.stdout);
    assert.deepEqual(rows.find((row) => row.type === 'task_sandbox_ready')?.tools, ['read', 'bash'], result.stderr + result.stdout);
    assert.doesNotMatch(result.stderr, /Extension error|Failed to load extension/i);
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

test('SDK-loaded guarded tools confine writes and reject unclassified extension execution', { skip: !supported }, async (t) => {
    const f = fixture(t, { commands: false, storedCredentials: 'off', outsideProject: 'off' });
    let escaped = false;
    const session = await sessionFixture(t, f, [(pi) => pi.registerTool({ ...createWriteToolDefinition(f.project), name: 'escape',
        execute: async () => { escaped = true; return { content: [{ type: 'text', text: 'escaped' }], details: undefined }; } })]);
    session.setActiveToolsByName(['read', 'write', 'bash', 'escape']);
    await execute(session, 'write', { path: 'inside.txt', content: 'inside' });
    assert.equal(readFileSync(join(f.project, 'inside.txt'), 'utf8'), 'inside');
    f.policy.permissions.outsideProject = 'read-write';
    await assert.rejects(execute(session, 'write', { path: join(f.base, 'outside.txt'), content: 'no' }), /Task sandbox refused to write .*: permission-denied/);
    await assert.rejects(execute(session, 'write', { path: join(f.agent, 'settings.json.lock'), content: 'no' }), /Task sandbox refused to write .*: write-denied/);
    await assert.rejects(execute(session, 'read', { path: join(f.agent, 'auth.json') }), /Task sandbox refused to read .*: read-denied/);
    await assert.rejects(execute(session, 'bash', { command: 'true' }), /commands.*Off/i);
    await assert.rejects(execute(session, 'escape', { path: 'unused', content: 'unused' }), /verified task execution adapter/);
    assert.equal(escaped, false);
    assert.equal(existsSync(join(f.base, 'outside.txt')), false);
});

test('Process access activates the fixed inventory without general commands and stays immutable', { skip: !supported }, async (t) => {
    const f = fixture(t, { processAccess: 'read', commands: false, network: false,
        storedCredentials: process.platform === 'linux' ? 'read' : 'off' });
    f.policy.tools = ['process_list', 'bash'];
    const session = await sessionFixture(t, f);
    const name = 'pi-task-proc';
    const executable = join(f.project, name);
    copyFileSync('/bin/sleep', executable);
    const owned = spawn(executable, ['60'], { stdio: 'ignore' });
    t.after(async () => {
        if (owned.pid && owned.exitCode === null && owned.signalCode === null) {
            const closed = once(owned, 'close');
            owned.kill('SIGKILL');
            await closed;
        }
    });
    await once(owned, 'spawn');
    const listed = await execute(session, 'process_list', { name, limit: 200 });
    const details = JSON.parse(listed.content.find((part) => part.type === 'text').text);
    assert.equal(details.scope, 'current-user');
    assert.ok(details.processes.some((row) => row.pid === owned.pid && row.name === name), 'the confined inventory sees its owned fixture process');
    assert.ok(details.processes.every((row) => Object.keys(row).sort().join(',') === 'name,pid'));
    await assert.rejects(execute(session, 'bash', { command: 'true' }), /commands.*Off/i);
    f.policy.permissions.processAccess = 'off';
    const captured = await execute(session, 'process_list', { name: 'pi-no-such-inventory-process', limit: 1 });
    assert.deepEqual(JSON.parse(captured.content[0].text).processes, [], 'the captured Read policy is not changed by later edits');
});

test('Linux inventory refuses an unsupported credential mask without relaxing the launch policy', { skip: !supported || process.platform !== 'linux' }, async (t) => {
    const f = fixture(t, { processAccess: 'read', commands: false, network: false, storedCredentials: 'off' });
    f.policy.tools = ['process_list'];
    const session = await sessionFixture(t, f);
    await assert.rejects(execute(session, 'process_list', {}), /cannot hide stored credentials in a read-only whole-root bind/);
    assert.equal(f.policy.permissions.storedCredentials, 'off');
    assert.equal(f.policy.permissions.commands, false);
});

test('Process access Off does not activate inventory and cannot be bypassed by selecting its name', { skip: !supported }, async (t) => {
    const f = fixture(t, { processAccess: 'off' });
    f.policy.tools = ['read', 'process_list'];
    const session = await sessionFixture(t, f);
    assert.equal(session.agent.state.tools.some((tool) => tool.name === 'process_list'), false);
    session.setActiveToolsByName(['process_list']);
    await assert.rejects(execute(session, 'process_list', {}), /Process access is Off/);
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

test('task commands retain private scratch and deny ordinary outside writes', { skip: !supported }, async (t) => {
    const f = fixture(t);
    const session = await sessionFixture(t, f);
    const script = `
      const fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
      const scratch=${JSON.stringify(f.policy.scratch)};
      assert.equal(os.tmpdir(),scratch);
      fs.writeFileSync(scratch+'/created-by-command','scratch');
      assert.throws(()=>fs.renameSync(scratch,scratch+'-moved'), { code: /^(EPERM|EACCES|EROFS)$/ });
      assert.throws(()=>fs.writeFileSync(scratch+'/.sandbox-anchor','no'), { code: /^(EPERM|EACCES|EROFS)$/ });
      assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(f.base, 'outside-temp'))},'no'), { code: /^(EPERM|EACCES|EROFS)$/ });
      console.log('scratch-ok');
    `;
    const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
    const result = await execute(session, 'bash', { command: `${quote(process.execPath)} -e ${quote(script)}` });
    assert.match(JSON.stringify(result), /scratch-ok/);
    await execute(session, 'write', { path: join(f.policy.scratch, 'created-by-file-tool'), content: 'scratch' });
    assert.equal(readFileSync(join(f.policy.scratch, 'created-by-file-tool'), 'utf8'), 'scratch');
    assert.equal(existsSync(join(f.base, 'outside-temp')), false);
});

/**
 * True while `pid` can still run. On Linux a killed, orphaned process may stay a zombie
 * until its reaper collects it; a zombie cannot execute, so it counts as gone.
 */
function processLingers(pid) {
    if (process.platform === 'linux') {
        try {
            if (/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
        } catch { return false; }
    }
    try { process.kill(pid, 0); return true; } catch { return false; }
}

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
    try {
        // The kill is delivered before exec resolves, but the kernel may not have torn the
        // process down yet: wait (bounded) instead of asserting immediately. A command that
        // was never killed keeps running `sleep 10` and still fails.
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && processLingers(trackedPid)) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(processLingers(trackedPid), false, 'SDK shutdown cleanup must terminate the detached command');
    } finally {
        try { process.kill(trackedPid, 'SIGKILL'); } catch { /* already gone */ }
    }
});

test('default task tools retain literal /tmp writes without opening outside files or arbitrary locks', { skip: !supported || process.platform === 'win32' }, async (t) => {
    const f = fixture(t);
    const session = await sessionFixture(t, f);
    const temporary = mkdtempSync('/tmp/pi-compat-task-');
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    await execute(session, 'write', { path: join(temporary, 'tool.log'), content: 'temporary file tool' });
    const command = await execute(session, 'bash', { command: `printf shell > '${temporary}/shell.log'` });
    assert.equal(readFileSync(join(temporary, 'shell.log'), 'utf8'), 'shell', JSON.stringify(command));
    assert.equal(readFileSync(join(temporary, 'tool.log'), 'utf8'), 'temporary file tool');
    await assert.rejects(execute(session, 'write', { path: join(f.base, 'unrelated.lock'), content: 'denied' }), /Task sandbox refused to write .*: permission-denied/);
    assert.equal(existsSync(join(f.base, 'unrelated.lock')), false);
});

test('compatibility temp cannot retarget project ancestors or sibling runtime controls', { skip: !supported || process.platform === 'win32' }, async (t) => {
    const f = fixture(t, {}, '/tmp');
    const session = await sessionFixture(t, f);
    const outside = realpathSync(mkdtempSync('/var/tmp/pi-protected-sentinel-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const script = `
      const fs=require('node:fs'),assert=require('node:assert/strict');
      for(const path of ${JSON.stringify([join(f.agent, 'settings.json'), join(f.control, 'policy')])}) {
        assert.throws(()=>fs.writeFileSync(path,'forbidden'), { code: /^(EPERM|EACCES|EROFS)$/ });
      }
      // Linux bind mounts reject directory removal/rename with EBUSY.
      const directoryDenied = process.platform === 'linux' ? /^(EPERM|EACCES|EROFS|EBUSY)$/ : /^(EPERM|EACCES|EROFS)$/;
      assert.throws(()=>fs.renameSync(${JSON.stringify(f.base)},${JSON.stringify(f.base + '-moved')}), { code: directoryDenied });
      // Node 24's native recursive rm can wrap EROFS as UV_UNKNOWN (-4094).
      assert.throws(()=>fs.rmSync(${JSON.stringify(f.agent)},{recursive:true}), error =>
        directoryDenied.test(error.code) || (process.platform === 'linux' && error.code === '' &&
          error.errno === -4094 && error.syscall === 'rm' && error.path === ${JSON.stringify(f.agent)}));
      fs.writeFileSync(${JSON.stringify(join(f.project, 'ordinary.txt'))},'allowed');
    `;
    const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
    await execute(session, 'bash', { command: `${quote(process.execPath)} -e ${quote(script)}` });
    assert.equal(existsSync(f.base + '-moved'), false);
    assert.equal(readFileSync(join(f.agent, 'settings.json'), 'utf8'), '{}');
    assert.equal(readFileSync(join(f.agent, 'auth.json'), 'utf8'), '{}');
    assert.equal(existsSync(join(f.control, 'policy')), false);
    assert.equal(readFileSync(join(f.project, 'ordinary.txt'), 'utf8'), 'allowed');
    // A separate launch must still refer to the same captured project.
    await execute(session, 'write', { path: 'second-launch.txt', content: 'same root' });
    assert.equal(readFileSync(join(f.project, 'second-launch.txt'), 'utf8'), 'same root');
    await assert.rejects(execute(session, 'write', { path: join(outside, 'denied.lock'), content: 'no' }), /Task sandbox refused to write .*: permission-denied/);
});

test('default SDK task can retrieve a synthetic macOS Keychain item', { skip: !supported || process.platform !== 'darwin' }, async (t) => {
    const f = fixture(t);
    const keychainDirectory = realpathSync(mkdtempSync('/var/tmp/pi-synthetic-keychain-'));
    const keychain = join(keychainDirectory, 'synthetic.keychain-db');
    const security = (args) => {
        const result = spawnSync('/usr/bin/security', args, { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
    };
    security(['create-keychain', '-p', 'synthetic-password', keychain]);
    t.after(() => {
        spawnSync('/usr/bin/security', ['delete-keychain', keychain], { encoding: 'utf8' });
        rmSync(keychainDirectory, { recursive: true, force: true });
    });
    security(['unlock-keychain', '-p', 'synthetic-password', keychain]);
    security(['add-generic-password', '-a', 'sandbox-fixture', '-s', 'pi-runtime-compatibility', '-w', 'synthetic-value', '-T', '/usr/bin/security', keychain]);
    const session = await sessionFixture(t, f);
    const result = await execute(session, 'bash', { command: `/usr/bin/security find-generic-password -a sandbox-fixture -s pi-runtime-compatibility -w '${keychain}'` });
    assert.match(JSON.stringify(result), /synthetic-value/);
    await assert.rejects(execute(session, 'write', { path: join(f.agent, 'settings.json'), content: 'denied' }), /Task sandbox refused to write .*: write-denied/);
});

test('default Outside Write: caches work, sibling repos stay, controls and provenance stay unwritable', { skip: !supported || process.platform === 'win32' }, async (t) => {
    // A home outside every temp root: temp is always removable, so a fixture
    // home there would prove nothing about the home rules.
    const f = fixture(t, { outsideProject: 'write' }, fileURLToPath(new URL('.', import.meta.url)));
    const home = f.policy.home;
    const sibling = join(home, 'projects', 'other-repo');
    mkdirSync(join(home, '.cache'), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'README.md'), 'keep me');
    const provenance = join(f.control, 'task-runtime');
    mkdirSync(provenance);
    writeFileSync(join(provenance, 'sa_1.json'), '{}');
    const session = await sessionFixture(t, f);
    const run = async (command) => JSON.stringify(await execute(session, 'bash', { command }).catch((error) => ({ error: String(error) })));
    const cache = join(home, '.cache', 'tool');
    assert.match(await run(`mkdir -p '${cache}' && printf x > '${cache}/entry' && rm -rf '${cache}' && echo cache-ok`), /cache-ok/);
    assert.match(await run(`if rm -rf '${sibling}' 2>/dev/null; then echo removed; else echo refused; fi`), /refused/);
    assert.match(await run(`if mv '${sibling}' '${join(home, '.cache', 'moved')}' 2>/dev/null; then echo moved; else echo refused; fi`), /refused/);
    assert.equal(readFileSync(join(sibling, 'README.md'), 'utf8'), 'keep me');
    assert.match(await run(`if printf '{}' > '${join(provenance, 'sa_2.json')}' 2>/dev/null; then echo forged; else echo refused; fi`), /refused/);
    assert.match(await run(`if rm -f '${join(provenance, 'sa_1.json')}' 2>/dev/null; then echo deleted; else echo refused; fi`), /refused/);
    assert.equal(existsSync(join(provenance, 'sa_2.json')), false);
    assert.equal(existsSync(join(provenance, 'sa_1.json')), true);
    await execute(session, 'write', { path: join(home, '.cache', 'from-tool.txt'), content: 'ok' });
    assert.equal(readFileSync(join(home, '.cache', 'from-tool.txt'), 'utf8'), 'ok');
    await assert.rejects(execute(session, 'write', { path: join(f.control, 'task-policy.json'), content: '{}' }), /Task sandbox refused to write .*: write-denied/);
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

// ---- extension tools for confined children (ADR 0009) -------------------------

function fakeToolPackage(dir, name, marker) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', pi: { extensions: ['./index.ts'] } }));
    writeFileSync(join(dir, 'index.ts'), `export default function (pi) {
  pi.registerTool({ name: 'web_fetch', label: 'fetch', description: 'test fetch', parameters: { type: 'object', properties: {} },
    async execute() { return { content: [{ type: 'text', text: ${JSON.stringify(marker)} }], details: undefined }; } });
}\n`);
    return realpathSync(dir);
}

function startTrusted(t, f, { load, trustedRoot, network = true, applyPatch = false, toolName = 'web_fetch', packageName = 'npm:trusted-web' }) {
    const prepared = prepareTaskRuntime({ root: f.project, controlDir: f.control,
        tools: ['read', 'write', 'edit', 'bash', ...(applyPatch ? ['apply_patch'] : []), toolName],
        permissions: { ...f.policy.permissions, network }, applyPatch,
        extensionTools: [{ name: toolName, package: packageName, root: trustedRoot, network: true }],
        extensionPaths: [load],
        piBin: fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))) });
    t.after(() => rmSync(prepared.policy.scratch, { recursive: true, force: true }));
    const result = spawnSync(prepared.file, [...prepared.fileArgs,
        '--mode', 'rpc', '--offline', '--no-session', '--no-extensions', '--extension', load,
        '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--no-builtin-tools'], {
        cwd: f.project, encoding: 'utf8', timeout: 30000,
        input: '{"type":"get_state","id":"startup"}\n',
        env: { ...process.env, PI_CODING_AGENT_DIR: f.agent },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const rows = (result.stderr + '\n' + result.stdout).split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    return { ready: rows.find((row) => row.type === 'task_sandbox_ready'), output: result.stderr + result.stdout };
}

test('a confined child admits a trusted tool only from its ticked package and only with Network On', { skip: !supported }, (t) => {
    const f = fixture(t);
    const trusted = fakeToolPackage(join(f.base, 'pkgs', 'trusted-web'), 'trusted-web', 'trusted');
    const impostor = fakeToolPackage(join(f.base, 'pkgs', 'impostor-web'), 'impostor-web', 'impostor');
    const good = startTrusted(t, f, { load: trusted, trustedRoot: trusted, applyPatch: true });
    assert.deepEqual(good.ready?.tools, ['read', 'write', 'edit', 'bash', 'apply_patch'], good.output);
    assert.deepEqual(good.ready?.trusted, ['web_fetch'], good.output);
    const other = startTrusted(t, f, { load: impostor, trustedRoot: trusted });
    assert.equal(other.ready?.trusted, undefined, other.output);
    assert.match(other.ready?.refused?.[0]?.reason ?? '', /not the trusted package npm:trusted-web/);
    const offline = startTrusted(t, f, { load: trusted, trustedRoot: trusted, network: false });
    assert.equal(offline.ready?.trusted, undefined, offline.output);
    assert.match(offline.ready?.refused?.[0]?.reason ?? '', /needs Network access, which is Off/);
});

test('a ticked SSH tool loads the real SSH extension into a confined child without admitting its other tools', { skip: !supported }, (t) => {
    const f = fixture(t);
    const root = realpathSync(fileURLToPath(new URL('../../pi-better-ssh', import.meta.url)));
    const plan = planTaskTools({ requested: ['ssh_profile'], network: true,
        settings: { applyPatch: false, trusted: [{ name: 'ssh_profile', package: 'npm:pi-better-ssh' }] },
        builtins: ['read', 'write', 'edit', 'bash'],
        registered: [{ name: 'ssh_profile', sourceInfo: { path: join(root, 'src', 'index.ts'), source: 'npm:pi-better-ssh', baseDir: root } }],
        resolvePath: () => undefined });
    assert.deepEqual(plan.refused, []);
    const [tool] = plan.trusted;
    const child = startTrusted(t, f, { load: tool.loadPath, trustedRoot: tool.root, toolName: tool.name, packageName: tool.package });
    assert.deepEqual(child.ready?.trusted, ['ssh_profile'], child.output);
    assert.equal(child.ready?.refused, undefined, child.output);
});

test('trusted-tool admission checks name, canonical package root and network', (t) => {
    const f = fixture(t);
    const root = join(f.base, 'pkg');
    mkdirSync(root);
    writeFileSync(join(root, 'index.ts'), '');
    const policy = parseTaskPolicy({ ...f.policy, extensionTools: [{ name: 'web_fetch', package: 'npm:web', root, network: true }] });
    assert.equal(trustedToolRefusal(policy, 'web_fetch', join(root, 'index.ts')), undefined);
    assert.match(trustedToolRefusal(policy, 'web_search', join(root, 'index.ts')), /not a trusted tool/);
    assert.match(trustedToolRefusal(policy, 'web_fetch', join(f.base, 'pkg-other', 'index.ts')), /not the trusted package/);
    assert.match(trustedToolRefusal(policy, 'web_fetch', '<inline:x>'), /no package source/);
    assert.match(trustedToolRefusal(policy, 'web_fetch', undefined), /no package source/);
    const offline = parseTaskPolicy({ ...f.policy, permissions: { ...f.policy.permissions, network: false },
        extensionTools: [{ name: 'web_fetch', package: 'npm:web', root, network: true }] });
    assert.match(trustedToolRefusal(offline, 'web_fetch', join(root, 'index.ts')), /Network access, which is Off/);
    assert.throws(() => parseTaskPolicy({ ...f.policy, extensionTools: [{ name: 'x', package: 'p', root: 'relative', network: false }] }), /extension tools/);
    assert.throws(() => parseTaskPolicy({ ...f.policy, applyPatch: 'yes' }), /apply_patch/);
    const frozen = parseTaskPolicy({ ...f.policy, extensionTools: [{ name: 'web_fetch', package: 'npm:web', root, network: true }] });
    assert.throws(() => { frozen.extensionTools.push({}); }, TypeError, 'the admitted list cannot be widened');
});

test('SDK-loaded apply_patch follows the task file rules in a confined session', { skip: !supported }, async (t) => {
    const f = fixture(t, { projectFiles: 'read-write', outsideProject: 'read' });
    f.policy.applyPatch = true;
    f.policy.tools = ['read', 'write', 'edit', 'bash', 'apply_patch'];
    writeFileSync(join(f.project, 'a.txt'), 'one\n');
    writeFileSync(join(f.project, 'gone.txt'), 'bye\n');
    writeFileSync(join(f.base, 'outside.txt'), 'keep\n');
    const session = await sessionFixture(t, f);
    const patch = (...body) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');
    await execute(session, 'apply_patch', { input: patch('*** Update File: a.txt', '-one', '+two', '*** Add File: b.txt', '+new', '*** Delete File: gone.txt') });
    assert.equal(readFileSync(join(f.project, 'a.txt'), 'utf8'), 'two\n');
    assert.equal(readFileSync(join(f.project, 'b.txt'), 'utf8'), 'new\n');
    assert.equal(existsSync(join(f.project, 'gone.txt')), false);
    // Outside project = Read: no write, no delete outside the workspace.
    await assert.rejects(execute(session, 'apply_patch', { input: patch(`*** Delete File: ${join(f.base, 'outside.txt')}`) }), /permission-denied/);
    await assert.rejects(execute(session, 'apply_patch', { input: patch(`*** Add File: ${join(f.base, 'new-outside.txt')}`, '+no') }), /permission-denied/);
    await assert.rejects(execute(session, 'apply_patch', { input: patch(`*** Update File: ${join(f.agent, 'settings.json')}`, '-{}', '+{"x":1}') }), /write-denied|permission-denied/);
    assert.equal(readFileSync(join(f.base, 'outside.txt'), 'utf8'), 'keep\n');
    assert.equal(existsSync(join(f.base, 'new-outside.txt')), false);
    assert.equal(readFileSync(join(f.agent, 'settings.json'), 'utf8'), '{}');
});

test('a single-file extension is loaded and admitted by itself, never its whole directory', { skip: !supported }, (t) => {
    const f = fixture(t);
    const extensions = join(f.base, 'agent-extensions');
    mkdirSync(extensions);
    const marker = join(f.base, 'sibling-loaded');
    const register = (text) => `pi.registerTool({ name: 'web_fetch', label: 'fetch', description: 'test fetch', parameters: { type: 'object', properties: {} },
    async execute() { return { content: [{ type: 'text', text: ${JSON.stringify(text)} }], details: undefined }; } });`;
    const good = join(extensions, 'fetcher.ts');
    writeFileSync(good, `export default function (pi) { ${register('good')} }\n`);
    // Unconfined extension code: if Pi scanned the directory, this would run and leave a marker.
    const sibling = join(extensions, 'sibling.ts');
    writeFileSync(sibling, `import { writeFileSync } from 'node:fs';\nexport default function (pi) { writeFileSync(${JSON.stringify(marker)}, 'x'); ${register('sibling')} }\n`);
    const plan = planTaskTools({ requested: ['web_fetch'], settings: { applyPatch: false, trusted: [{ name: 'web_fetch', package: realpathSync(good) }] },
        network: true, builtins: ['read', 'write', 'edit', 'bash'],
        registered: [{ name: 'web_fetch', sourceInfo: { path: realpathSync(good), source: 'local', origin: 'top-level', baseDir: realpathSync(extensions) } }],
        resolvePath: () => undefined });
    const [tool] = plan.trusted;
    assert.equal(tool.loadPath, realpathSync(good));
    assert.equal(tool.root, realpathSync(good));
    const admitted = startTrusted(t, f, { load: tool.loadPath, trustedRoot: tool.root });
    assert.deepEqual(admitted.ready?.trusted, ['web_fetch'], admitted.output);
    assert.equal(existsSync(marker), false, 'the sibling extension was never loaded');
    const impostor = startTrusted(t, f, { load: realpathSync(sibling), trustedRoot: tool.root });
    assert.equal(impostor.ready?.trusted, undefined, impostor.output);
    assert.match(impostor.ready?.refused?.[0]?.reason ?? '', /not the trusted package/);
});
