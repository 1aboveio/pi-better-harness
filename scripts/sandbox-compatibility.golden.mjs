// Real-kernel golden paths for the default task sandbox.
// node --import tsx scripts/sandbox-compatibility.golden.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { describeSandboxSupport } from '../packages/pi-better-subagents/shared-sandbox-core.ts';
import { writableRuntimeAlias } from '../packages/pi-better-subagents/shared-task-sandbox.ts';
import taskGuard from '../packages/pi-better-subagents/task-guard.ts';

const ids = ['workspace-temp', 'protected-paths', 'runtime-identity', 'outside-off', 'credential-service', 'outside-write'];
const evidenceDir = resolve(process.env.PI_SANDBOX_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'pi-sandbox-evidence-')));
const paths = [], cleanups = [];
let currentPathId;
const addCleanup = (cleanup) => cleanups.push({ id: currentPathId, cleanup });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const text = (result) => result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');

function report() {
    mkdirSync(evidenceDir, { recursive: true });
    const verdict = paths.length === ids.length && paths.every((p, i) => p.id === ids[i] && p.status === 'pass') ? 'ALIVE' : 'DEAD';
    writeFileSync(join(evidenceDir, 'smoke-results.json'), JSON.stringify({ paths }, null, 2) + '\n');
    writeFileSync(join(evidenceDir, 'smoke-verdict.json'), JSON.stringify({ verdict, platform: process.platform }, null, 2) + '\n');
    return verdict;
}
function fixture(permissions = {}, parent = '/var/tmp') {
    const base = realpathSync(mkdtempSync(join(parent, 'pi-compat-golden-')));
    addCleanup(() => rmSync(base, { recursive: true, force: true }));
    const project = join(base, 'project'), agent = join(base, 'agent'), control = join(base, 'control'), scratch = join(base, 'scratch');
    for (const dir of [project, agent, control, scratch]) mkdirSync(dir);
    writeFileSync(join(scratch, '.sandbox-anchor'), '');
    writeFileSync(join(agent, 'auth.json'), '{}');
    writeFileSync(join(agent, 'settings.json'), '{}');
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    addCleanup(() => {
        if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgent;
    });
    const policy = { version: 1, root: project, home: join(base, 'home'), agentDir: agent,
        profilePath: join(control, 'task.sb'), scratch,
        permissions: { projectFiles: 'read-write', outsideProject: 'read', storedCredentials: 'read', commands: true, network: true, ...permissions },
        denyWrite: [agent, control, join(scratch, '.sandbox-anchor')], tools: ['read', 'write', 'edit', 'bash'] };
    return { base, project, agent, control, scratch, policy };
}
async function sessionFor(f) {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd: f.project, agentDir: f.agent, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [{ name: 'task-sandbox', factory: (pi) => taskGuard(pi, f.policy, (error) => { throw error; }) }] });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
        modelsPath: join(f.agent, 'models.json'), modelsStorePath: join(f.agent, 'models-store.json') });
    const { session } = await createAgentSession({ cwd: f.project, agentDir: f.agent, resourceLoader: loader, modelRuntime,
        settingsManager, sessionManager: SessionManager.inMemory(f.project), noTools: 'builtin' });
    addCleanup(() => session.dispose());
    await session.bindExtensions({});
    session.setActiveToolsByName(['read', 'write', 'edit', 'bash']);
    return session;
}
async function execute(session, name, params) {
    const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is active`);
    const decision = await session.agent.beforeToolCall?.({ toolCall: { id: randomUUID(), name, arguments: params }, args: params });
    if (decision?.block) throw new Error(decision.reason);
    return tool.execute(randomUUID(), params, new AbortController().signal);
}
async function bash(session, script, marker) {
    const result = await execute(session, 'bash', { command: `${quote(process.execPath)} -e ${quote(script)}`, timeout: 12 });
    assert.ok(text(result).includes(marker), `missing ${marker} from guarded bash`);
}
function executable(name) {
    for (const dir of ['/usr/bin', '/bin']) {
        const path = join(dir, name);
        try { accessSync(path, constants.X_OK); return path; } catch { /* next */ }
    }
    throw new Error(`missing ${name} (install dbus-x11, gnome-keyring, libsecret-tools)`);
}
function checkedSecurity(args) {
    const result = spawnSync('/usr/bin/security', args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, `security ${args[0]} failed (exit ${result.status ?? result.error?.code})`);
}
async function macCredential(session) {
    const directory = realpathSync(mkdtempSync('/var/tmp/pi-golden-keychain-'));
    const keychain = join(directory, 'synthetic.keychain-db');
    let created = false;
    addCleanup(() => {
        const deleted = created ? spawnSync('/usr/bin/security', ['delete-keychain', keychain], { timeout: 10000, stdio: 'ignore' }) : undefined;
        rmSync(directory, { recursive: true, force: true });
        if (deleted && deleted.status !== 0) throw new Error(`disposable Keychain deletion failed (${deleted.status ?? deleted.error?.code})`);
    });
    checkedSecurity(['create-keychain', '-p', 'synthetic-password', keychain]);
    created = true;
    checkedSecurity(['unlock-keychain', '-p', 'synthetic-password', keychain]);
    checkedSecurity(['add-generic-password', '-a', 'sandbox-fixture', '-s', 'pi-runtime-compatibility',
        '-w', 'synthetic-value', '-T', '/usr/bin/security', keychain]);
    const result = await execute(session, 'bash', { command: `/usr/bin/security find-generic-password -a sandbox-fixture -s pi-runtime-compatibility -w ${quote(keychain)}`, timeout: 12 });
    assert.match(text(result), /synthetic-value/);
    return 'disposable Keychain retrieved via guarded bash; no search list or login Keychain changes';
}
async function serviceChild() {
    const daemon = spawn(executable('gnome-keyring-daemon'), ['--foreground', '--components=secrets', '--unlock'],
        { stdio: ['pipe', 'ignore', 'pipe'] });
    let daemonErrors = '';
    daemon.stderr.on('data', chunk => { daemonErrors = (daemonErrors + chunk.toString()).slice(-1000); });
    daemon.on('error', error => { daemonErrors = error.message; });
    daemon.stdin.end('synthetic-password\n');
    // Do not let secret-tool auto-activate a second daemon before the unlocked
    // fixture owns the service name on this private bus.
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
        const owner = spawnSync(executable('dbus-send'), ['--session', '--dest=org.freedesktop.DBus',
            '--type=method_call', '--print-reply', '/org/freedesktop/DBus',
            'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.secrets'],
            { encoding: 'utf8', timeout: 1000 });
        if (owner.status === 0 && /boolean true/.test(owner.stdout)) { ready = true; break; }
        if (daemon.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const store = ready ? spawnSync(executable('secret-tool'), ['store', '--label=Sandbox golden fixture', 'pi-sandbox-golden', 'isolated'],
        { input: 'synthetic-value\n', encoding: 'utf8', timeout: 8000 }) : { status: null, stderr: 'private service name not acquired' };
    if (store.status !== 0) {
        daemon.kill('SIGKILL');
        process.stdout.write(JSON.stringify({ ready: false, error: `secret-tool store failed (${store.status ?? store.error?.code}): ${store.stderr?.slice(-500)}; daemon: ${daemonErrors}` }) + '\n');
        return;
    }
    process.stdout.write(JSON.stringify({ ready: true, address: process.env.DBUS_SESSION_BUS_ADDRESS }) + '\n');
    if (daemon.exitCode === null) await new Promise((done) => daemon.once('exit', done));
}
async function linuxCredential(session, f) {
    const dbus = executable('dbus-run-session');
    executable('dbus-daemon'); executable('gnome-keyring-daemon'); executable('secret-tool');
    const env = { PATH: '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8' };
    const isolated = join(f.base, 'service');
    for (const name of ['home', 'config', 'data', 'cache', 'runtime']) mkdirSync(join(isolated, name), { recursive: true, mode: 0o700 });
    Object.assign(env, { HOME: join(isolated, 'home'), XDG_CONFIG_HOME: join(isolated, 'config'),
        XDG_DATA_HOME: join(isolated, 'data'), XDG_CACHE_HOME: join(isolated, 'cache'), XDG_RUNTIME_DIR: join(isolated, 'runtime') });
    const child = spawn(dbus, ['--', process.execPath, '--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--service-child'],
        { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
    addCleanup(kill);
    const ready = await new Promise((accept, reject) => {
        let buffer = '', errors = '', finished = false;
        const timer = setTimeout(() => { kill(); finish(new Error('private keyring startup timed out')); }, 15000);
        const finish = (error, value) => {
            if (finished) return;
            finished = true; clearTimeout(timer);
            child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError);
            error ? reject(error) : accept(value);
        };
        const onExit = (code) => finish(new Error(`private keyring exited before ready (${code}): ${errors.slice(-300)}`));
        const onError = (error) => finish(error);
        const onData = (chunk) => {
            buffer += chunk.toString();
            if (buffer.length > 4096) return finish(new Error('private keyring handshake exceeded limit'));
            if (!buffer.includes('\n')) return;
            try { const value = JSON.parse(buffer.split('\n')[0]); finish(value.ready ? null : new Error(value.error ?? 'private keyring failed'), value); }
            catch (error) { finish(error); }
        };
        child.stderr.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-300); });
        child.on('error', onError); child.on('exit', onExit); child.stdout.on('data', onData);
    });
    const command = [executable('env'), '-i', `PATH=/usr/bin:/bin`, `DBUS_SESSION_BUS_ADDRESS=${ready.address}`,
        `HOME=${env.HOME}`, `XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`, `XDG_DATA_HOME=${env.XDG_DATA_HOME}`,
        `XDG_CACHE_HOME=${env.XDG_CACHE_HOME}`, `XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}`,
        executable('secret-tool'), 'lookup', 'pi-sandbox-golden', 'isolated'].map(quote).join(' ');
    const result = await execute(session, 'bash', { command, timeout: 12 });
    assert.match(text(result), /synthetic-value/);
    assert.equal(child.exitCode, null, 'private service stopped before retrieval');
    return 'isolated D-Bus and gnome-keyring seeded outside confinement; guarded secret-tool lookup succeeded';
}
async function run() {
    const support = describeSandboxSupport();
    if (!['darwin', 'linux'].includes(process.platform) || !support.supported ||
        support.backend !== (process.platform === 'darwin' ? 'macos-seatbelt' : 'linux-bubblewrap')) {
        throw new Error(`sandbox backend prerequisite: ${support.reason ?? support.backend ?? 'unsupported platform'}`);
    }
    const checks = [
        async () => {
            const f = fixture(), session = await sessionFor(f);
            const temp = realpathSync(mkdtempSync('/tmp/pi-golden-temp-'));
            addCleanup(() => rmSync(temp, { recursive: true, force: true }));
            await execute(session, 'write', { path: 'workspace.txt', content: 'before' });
            await execute(session, 'edit', { path: 'workspace.txt', edits: [{ oldText: 'before', newText: 'after' }] });
            assert.match(text(await execute(session, 'read', { path: 'workspace.txt' })), /after/);
            await execute(session, 'write', { path: join(temp, 'file-tool'), content: 'ok' });
            await bash(session, `const fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
                assert.equal(os.tmpdir(),${JSON.stringify(f.scratch)});
                fs.writeFileSync(${JSON.stringify(join(temp, 'shell'))},'ok');
                fs.writeFileSync(os.tmpdir()+'/private','ok'); console.log('TEMP_OK');`, 'TEMP_OK');
            assert.equal(readFileSync(join(temp, 'file-tool'), 'utf8'), 'ok');
            assert.equal(readFileSync(join(temp, 'shell'), 'utf8'), 'ok');
            assert.equal(readFileSync(join(f.scratch, 'private'), 'utf8'), 'ok');
            return 'SDK write and guarded bash wrote literal /tmp; shell TMPDIR is private scratch';
        },
        async () => {
            const f = fixture({}, '/tmp');
            const absent = join(f.project, '.env.local');
            f.policy.denyWrite.push(absent);
            const session = await sessionFor(f);
            const sentinel = realpathSync(mkdtempSync('/var/tmp/pi-golden-outside-'));
            addCleanup(() => rmSync(sentinel, { recursive: true, force: true }));
            const forbidden = [join(f.agent, 'settings.json'), join(f.control, 'task.sb'), join(f.scratch, '.sandbox-anchor')];
            const indirect = join(f.project, 'control-alias');
            symlinkSync(f.control, indirect);
            for (const path of [...forbidden, join(indirect, 'task.sb')]) await assert.rejects(execute(session, 'write', { path, content: 'bad' }));
            await assert.rejects(execute(session, 'write', { path: join(sentinel, 'arbitrary.lock'), content: 'bad' }));
            const script = `const fs=require('node:fs'),assert=require('node:assert/strict');
                for (const path of ${JSON.stringify([...forbidden, join(indirect, 'task.sb'), absent])}) assert.throws(()=>fs.writeFileSync(path,'bad'));
                assert.throws(()=>fs.renameSync(${JSON.stringify(f.base)},${JSON.stringify(f.base + '-moved')}));
                assert.throws(()=>fs.rmSync(${JSON.stringify(f.agent)},{recursive:true}));
                assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(sentinel, 'shell.lock'))},'bad'));
                fs.writeFileSync(${JSON.stringify(join(f.project, 'normal'))},'ok'); console.log('GUARDS_OK');`;
            await bash(session, script, 'GUARDS_OK');
            assert.equal(readFileSync(join(f.agent, 'settings.json'), 'utf8'), '{}');
            assert.equal(readFileSync(join(f.project, 'normal'), 'utf8'), 'ok');
            assert.equal(existsSync(join(sentinel, 'arbitrary.lock')), false);
            assert.equal(existsSync(join(sentinel, 'shell.lock')), false);
            // Linux materializes the absent leaf before the first guarded worker launch.
            await assert.rejects(execute(session, 'write', { path: absent, content: 'bad' }));
            assert.notEqual(existsSync(absent) && readFileSync(absent, 'utf8'), 'bad');
            if (process.platform === 'linux') {
                const failed = fixture({}, '/tmp');
                const parentFile = join(failed.project, 'not-a-directory');
                writeFileSync(parentFile, 'unchanged');
                failed.policy.denyWrite.push(join(parentFile, 'protected'));
                const failedSession = await sessionFor(failed);
                await assert.rejects(execute(failedSession, 'write', { path: 'ordinary', content: 'bad' }), /Cannot protect denied path/);
                await assert.rejects(execute(failedSession, 'bash', { command: 'printf bad', timeout: 12 }), /Cannot protect denied path/);
                assert.equal(existsSync(join(failed.project, 'ordinary')), false);
                assert.equal(readFileSync(parentFile, 'utf8'), 'unchanged');
            }
            return 'controls, aliases, parent rename, outside sentinel, absent guard and failed materialization rejected';
        },
        async () => {
            const f = fixture({}, '/tmp'), session = await sessionFor(f);
            const sibling = realpathSync(mkdtempSync('/var/tmp/pi-golden-identity-'));
            addCleanup(() => rmSync(sibling, { recursive: true, force: true }));
            const runtimeHop = join(f.base, 'runtime-hop'); symlinkSync(f.agent, runtimeHop);
            const stable = join(sibling, 'stable-runtime'); symlinkSync(runtimeHop, stable);
            assert.equal(writableRuntimeAlias(runtimeHop, f.project, f.policy.permissions, true), runtimeHop);
            assert.equal(writableRuntimeAlias(stable, f.project, f.policy.permissions, true), runtimeHop);
            const alias = join(f.base, 'project-alias'); symlinkSync(f.project, alias);
            await execute(session, 'write', { path: 'first', content: 'first' });
            await bash(session, `const fs=require('node:fs'),assert=require('node:assert/strict');
                assert.throws(()=>fs.renameSync(${JSON.stringify(f.base)},${JSON.stringify(f.base + '-moved')}));
                assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(sibling, 'escaped'))},'bad'));
                fs.writeFileSync(${JSON.stringify(join(alias, 'via-alias'))},'ok'); console.log('IDENTITY_OK');`, 'IDENTITY_OK');
            await execute(session, 'write', { path: 'second', content: 'second' });
            await execute(session, 'write', { path: join(alias, 'tool-alias'), content: 'ok' });
            await assert.rejects(execute(session, 'write', { path: join(sibling, 'tool-escaped'), content: 'bad' }));
            assert.equal(readFileSync(join(f.project, 'via-alias'), 'utf8'), 'ok');
            assert.equal(readFileSync(join(f.project, 'tool-alias'), 'utf8'), 'ok');
            assert.equal(readFileSync(join(f.project, 'second'), 'utf8'), 'second');
            assert.equal(existsSync(join(sibling, 'tool-escaped')), false);
            return 'workspace identity retained across launches; alias confined; sibling and parent retarget denied';
        },
        async () => {
            const f = fixture({ outsideProject: 'off', storedCredentials: 'read' }), session = await sessionFor(f);
            const hostTemp = join('/tmp', `pi-golden-hidden-${randomUUID()}`);
            writeFileSync(hostTemp, 'host sentinel');
            addCleanup(() => rmSync(hostTemp, { force: true }));
            const command = `if /bin/cat ${quote(hostTemp)} >/dev/null 2>&1; then exit 10; fi; ` +
                `printf ok > ${quote(join(f.scratch, 'off-scratch'))}; printf OFF_OK`;
            const result = await execute(session, 'bash', { command, timeout: 12 });
            assert.ok(text(result).includes('OFF_OK'));
            assert.equal(readFileSync(join(f.scratch, 'off-scratch'), 'utf8'), 'ok');
            assert.equal(readFileSync(hostTemp, 'utf8'), 'host sentinel');
            return 'Outside Off hides host temp; private scratch remains writable';
        },
        async () => {
            const f = fixture(), session = await sessionFor(f);
            return process.platform === 'darwin' ? macCredential(session) : linuxCredential(session, f);
        },
        async () => {
            // The Subagents default. The fixture home sits outside every temp
            // root (temp is always removable), inside this checkout.
            const f = fixture({ outsideProject: 'write' }, fileURLToPath(new URL('.', import.meta.url)));
            const home = f.policy.home, sibling = join(home, 'projects', 'other-repo'), cache = join(home, '.gradle');
            mkdirSync(sibling, { recursive: true }); mkdirSync(cache);
            writeFileSync(join(sibling, 'README.md'), 'keep me');
            const session = await sessionFor(f);
            await bash(session, `const fs=require('node:fs'),assert=require('node:assert/strict');
                const lock=${JSON.stringify(join(cache, 'dists', 'gradle.zip.lck'))};
                fs.mkdirSync(require('node:path').dirname(lock),{recursive:true}); fs.writeFileSync(lock,'lock'); fs.rmSync(lock);
                assert.throws(()=>fs.rmSync(${JSON.stringify(sibling)},{recursive:true}));
                assert.throws(()=>fs.renameSync(${JSON.stringify(sibling)},${JSON.stringify(join(home, '.cache-moved'))}));
                assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(f.control, 'task.sb'))},'bad'));
                ${process.platform === 'darwin'
                    ? `fs.writeFileSync(${JSON.stringify(join(sibling, 'README.md'))},'edited in place');`
                    : `assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(sibling, 'README.md'))},'bad'));`}
                fs.writeFileSync('built','ok'); fs.rmSync('built'); console.log('WRITE_OK');`, 'WRITE_OK');
            assert.equal(readFileSync(join(sibling, 'README.md'), 'utf8'), process.platform === 'darwin' ? 'edited in place' : 'keep me');
            return process.platform === 'darwin'
                ? 'user cache written and cleaned; sibling repo edited in place but not removed or moved; controls denied'
                : 'user cache written and cleaned; sibling repo read-only (bubblewrap fallback) and not removed; controls denied';
        },
    ];
    for (let i = 0; i < ids.length; i++) {
        currentPathId = ids[i];
        try {
            const note = await checks[i]();
            paths.push({ id: ids[i], status: 'pass', evidence: [note], note });
        } catch (error) {
            const message = (error instanceof Error ? error.message : String(error))
                .replaceAll('synthetic-value', '[redacted]').replaceAll('synthetic-password', '[redacted]');
            paths.push({ id: ids[i], status: /missing |timed out|startup|unavailable/i.test(message) ? 'blocked' : 'fail',
                evidence: [`${error?.name ?? 'Error'}: ${message.slice(0, 600)}`], note: `golden path did not complete: ${message.slice(0, 300)}` });
        }
        report();
    }
}
if (process.argv[2] === '--service-child') {
    await serviceChild();
} else {
    const watchdog = setTimeout(() => {
        for (const id of ids.slice(paths.length)) paths.push({ id, status: 'blocked', evidence: [], note: 'golden run exceeded 180 seconds' });
        report();
        for (const { cleanup } of cleanups.reverse()) { try { cleanup(); } catch { /* best effort */ } }
        process.exit(1);
    }, 180000);
    try { await run(); }
    catch (error) {
        for (const id of ids.slice(paths.length)) paths.push({ id, status: 'blocked', evidence: [], note: String(error.message ?? error) });
    } finally {
        clearTimeout(watchdog);
        for (const { id, cleanup } of cleanups.reverse()) {
            try { cleanup(); }
            catch (error) {
                const row = paths.find((path) => path.id === id) ?? paths.at(-1);
                if (row) { row.status = 'fail'; row.evidence.push(`cleanup failed: ${error.message}`); row.note = 'disposable resource cleanup failed'; }
                process.stderr.write(`cleanup failed: ${error.message}\n`);
            }
        }
        const verdict = report();
        process.stdout.write(`${verdict} (${process.platform}); evidence: ${evidenceDir}\n`);
        if (verdict === 'DEAD') process.exitCode = 1;
    }
}
