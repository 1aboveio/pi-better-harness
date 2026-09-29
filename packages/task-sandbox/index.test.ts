// @covers task-sandbox.runtime-integrity
// @level integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseIni } from 'ini';
import { sandboxSupported } from '../sandbox-core/index.ts';
import { createTaskBashOperations, createTaskScratch, sanitizeNpmUserConfig, taskCommandEnvironment, taskNpmUserConfigPath, writableRuntimeAlias } from './index.ts';

test('sanitized npm config preserves cache-routing registries and drops credentials and unrelated settings', () => {
    const safe = sanitizeNpmUserConfig([
        'registry=https://registry.example.test/npm/',
        '@private:registry=https://npm.example.test/',
        '@userinfo:registry=https://user:secret@npm.example.test/',
        '@query:registry=https://npm.example.test/?token=secret',
        '//npm.example.test/:_authToken=super-secret',
        '_auth=also-secret',
        'proxy=https://user:secret@proxy.example.test/',
        'cache=/tmp/attacker-selected-cache',
    ].join('\n'));
    assert.deepEqual({ ...parseIni(safe) }, {
        registry: 'https://registry.example.test/npm/',
        '@private:registry': 'https://npm.example.test/',
    });
    assert.doesNotMatch(safe, /secret|auth|proxy|cache/i);
});

test('task scratch snapshots a safe npm config and credential-off environments cannot replace it', (t) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'task-npm-home-')));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, '.npmrc'), [
        'registry=https://registry.example.test/',
        '//registry.example.test/:_authToken=super-secret',
    ].join('\n'));
    const scratch = createTaskScratch(home);
    t.after(() => rmSync(scratch.path, { recursive: true, force: true }));
    assert.deepEqual({ ...parseIni(readFileSync(taskNpmUserConfigPath(scratch.path), 'utf8')) }, {
        registry: 'https://registry.example.test/',
    });
    const policy = {
        writableRoot: join(home, 'project'), home,
        permissions: { projectFiles: 'read-write', outsideProject: 'write', storedCredentials: 'read', commands: true, network: true },
        runtimeWrite: [scratch.path],
    } as const;
    const env = taskCommandEnvironment(policy, {
        HOME: home, npm_config_cache: join(home, '.npm'), NPM_CONFIG_USERCONFIG: join(home, 'host-npmrc'),
    }, { npm_config_userconfig: join(home, 'override-npmrc') });
    assert.equal(env.npm_config_userconfig, taskNpmUserConfigPath(scratch.path));
    assert.equal(env.NPM_CONFIG_USERCONFIG, undefined);
    assert.equal(env.npm_config_cache, join(home, '.npm'), 'the shared host cache remains selected');
    assert.equal(env.HOME, home, 'the task keeps its real home so default cache paths remain shared');
});

test('confined npm uses sanitized registry routing with the shared cache while the real npmrc stays unreadable', { skip: !sandboxSupported() }, async (t) => {
    const base = realpathSync(mkdtempSync(join(process.env.PI_SANDBOX_TEST_TMPDIR ?? '/var/tmp', 'task-npm-kernel-')));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const home = join(base, 'home'), project = join(home, 'project');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(home, '.npm'));
    writeFileSync(join(home, '.npmrc'), [
        'registry=https://registry.example.test/',
        '//registry.example.test/:_authToken=super-secret',
    ].join('\n'));
    const scratch = createTaskScratch(home);
    const policy = {
        writableRoot: project, home,
        permissions: { projectFiles: 'read-write', outsideProject: 'write', storedCredentials: 'read', commands: true, network: false },
        runtimeWrite: [scratch.path], denyWrite: [scratch.anchor],
    } as const;
    const controller = { requireLaunchPlan: () => ({ confined: true as const, profilePath: join(base, 'task.sb'), policy }) };
    const operations = createTaskBashOperations(controller);
    const run = async (command: string) => {
        let output = '';
        const result = await operations.exec(command, project, {
            onData: (chunk) => { output += chunk.toString(); },
            signal: new AbortController().signal,
            timeout: 30,
            env: {
                HOME: home,
                npm_config_registry: undefined,
                NPM_CONFIG_REGISTRY: undefined,
                npm_config_cache: undefined,
                NPM_CONFIG_CACHE: undefined,
            },
        });
        return { ...result, output };
    };
    const config = await run('printf "USERCONFIG=%s\\n" "$npm_config_userconfig"; npm config get registry; npm config get cache; cat "$npm_config_userconfig"');
    assert.equal(config.exitCode, 0, config.output);
    assert.match(config.output, new RegExp(`USERCONFIG=${taskNpmUserConfigPath(scratch.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(config.output, /https:\/\/registry\.example\.test\//);
    assert.match(config.output, new RegExp(join(home, '.npm').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(config.output, /super-secret|_authToken/);

    const denied = await run('cat "$HOME/.npmrc"');
    assert.notEqual(denied.exitCode, 0, 'the real credential-bearing npmrc must remain unreadable');
    assert.doesNotMatch(denied.output, /super-secret/);
});

test('runtime aliases inside compatibility temp are unsafe under Outside Read', { skip: process.platform === 'win32' }, (t) => {
    const temporary = realpathSync(mkdtempSync('/tmp/task-runtime-alias-'));
    const outside = realpathSync(mkdtempSync(join(process.env.PI_SANDBOX_TEST_TMPDIR ?? '/var/tmp', 'task-runtime-target-')));
    t.after(() => { rmSync(temporary, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
    const project = join(outside, 'project'), runtime = join(outside, 'agent');
    mkdirSync(project); mkdirSync(runtime);
    const alias = join(temporary, 'agent');
    symlinkSync(runtime, alias);
    const profile = { projectFiles: 'read-write', outsideProject: 'read', storedCredentials: 'read' };
    assert.equal(writableRuntimeAlias(alias, project, profile, true), alias);
    assert.equal(writableRuntimeAlias(runtime, project, profile, true), undefined);
    // The outside-read entry itself is stable, but its target chain is not.
    const stable = join(outside, 'stable-agent');
    symlinkSync(alias, stable);
    assert.equal(writableRuntimeAlias(stable, project, profile, true), alias);
    assert.equal(writableRuntimeAlias(join(stable, 'settings.json'), project, profile, true), alias);
    const relative = join(outside, 'relative-agent');
    symlinkSync('stable-agent', relative);
    assert.equal(writableRuntimeAlias(relative, project, profile, true), alias);
    const cycle = join(outside, 'cycle');
    symlinkSync('cycle', cycle);
    assert.throws(() => writableRuntimeAlias(cycle, project, profile, true), /Too many symlinks/);
});

test('runtime aliases inside a writable project are unsafe even when outside writes are disabled', { skip: process.platform === 'win32' }, (t) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'task-runtime-alias-')));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const project = join(base, 'project'), runtime = join(base, 'runtime');
    mkdirSync(project); mkdirSync(runtime);
    const alias = join(project, 'agent');
    symlinkSync(runtime, alias);
    assert.equal(writableRuntimeAlias(alias, project, { projectFiles: 'read-write', outsideProject: 'read', storedCredentials: 'read' }), alias);
    assert.equal(writableRuntimeAlias(alias, project, { projectFiles: 'read', outsideProject: 'read-write', storedCredentials: 'read' }), undefined);
    assert.equal(writableRuntimeAlias(runtime, project, { projectFiles: 'read-write', outsideProject: 'read', storedCredentials: 'read' }), undefined);
});

test('Write levels treat a runtime alias as replaceable only where they allow removal', { skip: process.platform === 'win32' }, (t) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'task-runtime-alias-write-')));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const project = join(base, 'project'), runtime = join(base, 'runtime');
    mkdirSync(project); mkdirSync(runtime);
    const alias = join(project, 'agent');
    symlinkSync(runtime, alias);
    // Project files = Write cannot unlink or rename over the link, so it stays put.
    const outsideTemp = join(base, 'outside-agent');
    symlinkSync(runtime, outsideTemp);
    const legacyWrite = { projectFiles: 'write', outsideProject: 'read', storedCredentials: 'read' };
    if (!project.startsWith('/tmp/') && !project.startsWith('/private/tmp/')) {
        assert.equal(writableRuntimeAlias(alias, project, legacyWrite), undefined);
    }
    // Outside project = Write: temp is always disposable, so a link there is replaceable.
    const broad = { projectFiles: 'read-write', outsideProject: 'write', storedCredentials: 'read' };
    assert.equal(writableRuntimeAlias(outsideTemp, project, broad), outsideTemp);
    assert.equal(writableRuntimeAlias(alias, project, broad), alias);
});
