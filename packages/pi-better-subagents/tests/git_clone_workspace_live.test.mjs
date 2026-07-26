/**
 * Live tool-execution harness for subagent_spawn git_clone_workspace.
 *
 * Registers the real extension against a faithful ExtensionAPI stub, invokes
 * the registered tool execute path with git_clone_workspace:true, and asserts
 * the disposable clone workspace is prepared and used as the child cwd/sandbox.
 *
 * Resolves @earendil-works/* from tests/fixtures/earendil-stubs so CI does not
 * need a host pi install. A stub `pi` binary records the child spawn.
 *
 * @covers subagent_spawn.git_clone_workspace
 * @level integration
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STUB_PKG_ROOT = join(__dirname, 'fixtures', 'earendil-stubs');

function resolveGitBin() {
    try {
        return execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
    } catch {
        return null;
    }
}
const GIT_BIN = resolveGitBin();
if (!GIT_BIN) {
    throw new Error(
        'git is required to run live git_clone_workspace tool execution tests. ' +
        'Install git and re-run; tests must not skip when git is absent.',
    );
}

function runGit(cwd, args) {
    const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
    return execFileSync(GIT_BIN, argv, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function makeRepo(base, name) {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    runGit(dir, 'init');
    runGit(dir, 'checkout -b main');
    runGit(dir, 'config user.email live@example.com');
    runGit(dir, 'config user.name LiveTest');
    writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
    runGit(dir, 'add README.md');
    runGit(dir, ['commit', '-m', 'initial']);
    return dir;
}

/**
 * Resolve @earendil-works/* to the committed test fixtures so index.ts can load
 * without a host pi install (CI Linux unit lane has none).
 */
function installEarendilResolver() {
    register('data:text/javascript,' + encodeURIComponent(`
        export async function resolve(specifier, context, nextResolve) {
            if (specifier === '@earendil-works/pi-ai' || specifier.startsWith('@earendil-works/pi-ai/')) {
                return {
                    shortCircuit: true,
                    url: ${JSON.stringify(pathToFileURL(join(STUB_PKG_ROOT, '@earendil-works/pi-ai/index.js')).href)},
                };
            }
            if (specifier === '@earendil-works/pi-coding-agent' || specifier.startsWith('@earendil-works/pi-coding-agent/')) {
                return {
                    shortCircuit: true,
                    url: ${JSON.stringify(pathToFileURL(join(STUB_PKG_ROOT, '@earendil-works/pi-coding-agent/index.js')).href)},
                };
            }
            if (specifier === '@earendil-works/pi-tui' || specifier.startsWith('@earendil-works/pi-tui/')) {
                return {
                    shortCircuit: true,
                    url: ${JSON.stringify(pathToFileURL(join(STUB_PKG_ROOT, '@earendil-works/pi-tui/index.js')).href)},
                };
            }
            return nextResolve(specifier, context);
        }
    `), import.meta.url);
}

/**
 * Minimal ExtensionAPI / ExtensionContext harness that captures registerTool
 * and runs the real execute implementation.
 */
function createExtensionHarness(cwd) {
    /** @type {Map<string, any>} */
    const tools = new Map();
    const messages = [];
    /** @type {Map<string, Function[]>} */
    const handlers = new Map();
    const pi = {
        registerTool(def) {
            tools.set(def.name, def);
        },
        sendMessage(msg, options) {
            messages.push({ msg, options });
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
    };
    const ctx = {
        cwd,
        model: undefined,
        ui: {
            notify() {},
            setWidget() {},
        },
    };
    return { pi, ctx, tools, messages, handlers };
}

function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe('subagent_spawn git_clone_workspace live execute', () => {
    // @fails-without-fix subagent_spawn.git_clone_workspace
    // @covers subagent_spawn.git_clone_workspace
    // @level integration
    it('registers and executes git_clone_workspace through the real tool path', async () => {
        assert.ok(
            existsSync(join(STUB_PKG_ROOT, '@earendil-works', 'pi-ai', 'index.js')),
            'committed earendil stubs must exist for live tool execution',
        );
        installEarendilResolver();

        const base = mkdtempSync(join(tmpdir(), 'pi-gitws-live-'));
        const stubDir = join(base, 'bin');
        const marker = join(base, 'pi-invoked.marker');
        mkdirSync(stubDir, { recursive: true });

        // Stub `pi` so the live execute path can spawn without a model call.
        const stubPi = join(stubDir, 'pi');
        writeFileSync(
            stubPi,
            [
                '#!/bin/sh',
                `printf '%s\\n' "$*" > ${JSON.stringify(marker)}`,
                'printf \'{"type":"agent_end"}\\n\'',
                'exit 0',
                '',
            ].join('\n'),
        );
        chmodSync(stubPi, 0o755);

        const repo = makeRepo(base, 'repo');
        const upstream = join(base, 'upstream.git');
        runGit(base, 'init --bare upstream.git');
        runGit(repo, `remote add origin ${upstream}`);
        runGit(repo, 'push -u origin HEAD');

        const prevPath = process.env.PATH;
        process.env.PATH = `${stubDir}${prevPath ? `:${prevPath}` : ''}`;

        try {
            const indexUrl = pathToFileURL(join(REPO_ROOT, 'index.ts')).href + `?live=${Date.now()}`;
            const { default: extensionFactory } = await import(indexUrl);

            const harness = createExtensionHarness(repo);
            await extensionFactory(harness.pi);

            const tool = harness.tools.get('subagent_spawn');
            assert.ok(tool, 'extension must register subagent_spawn');
            assert.equal(typeof tool.execute, 'function', 'subagent_spawn must expose execute');

            // Schema must include the new option (TypeBox object keeps it on properties).
            const schemaJson = JSON.stringify(tool.parameters ?? {});
            assert.match(
                schemaJson,
                /git_clone_workspace/,
                'tool schema must declare git_clone_workspace',
            );

            const sandboxDir = join(base, 'sandbox-workspace');
            const result = await tool.execute(
                'toolcall_live_1',
                {
                    prompt: 'live git_clone_workspace smoke — exit immediately',
                    name: 'live-clone',
                    git_clone_workspace: true,
                    sandbox_dir: sandboxDir,
                    // Disable OS sandbox wrapper so the stub pi is spawned directly;
                    // the clone preparation path is what this harness proves.
                    sandbox: false,
                    callback: false,
                    clean: true,
                    tools: 'read,bash',
                    cwd: repo,
                },
                undefined,
                undefined,
                harness.ctx,
            );

            const text = JSON.stringify(result);
            assert.match(text, /Subagent launched/, `execute must return launch confirmation, got: ${text}`);
            assert.match(text, /id=sa_/, 'execute must return a run id');

            // Disposable clone prepared at the requested sandbox_dir.
            assert.ok(existsSync(join(sandboxDir, '.git')), 'clone .git must exist inside sandbox_dir');
            assert.ok(
                lstatSync(join(sandboxDir, '.git')).isDirectory(),
                'clone must have a real .git directory',
            );
            assert.ok(existsSync(join(sandboxDir, 'README.md')), 'clone must contain source files');
            assert.equal(
                runGit(sandboxDir, 'rev-parse --abbrev-ref HEAD'),
                'main',
                'live execute path must preserve the source branch',
            );
            assert.equal(
                realpathSync(runGit(sandboxDir, 'remote get-url origin')),
                realpathSync(upstream),
                'live execute path must preserve upstream origin',
            );

            // Child was actually spawned through the execute path.
            const deadline = Date.now() + 3000;
            while (!existsSync(marker) && Date.now() < deadline) {
                sleepMs(25);
            }
            assert.ok(existsSync(marker), 'stub pi must have been invoked by the live execute path');

            // Meta records the prepared clone workspace as cwd.
            const idMatch = text.match(/id=(sa_[a-z0-9_]+)/);
            assert.ok(idMatch, 'run id must be parseable from the tool result');
            const { readMeta } = await import(pathToFileURL(join(REPO_ROOT, 'registry.ts')).href);
            const meta = readMeta(idMatch[1]);
            assert.ok(meta, 'run meta must be written');
            assert.equal(realpathSync(meta.cwd), realpathSync(sandboxDir));

            // Best-effort cleanup of the (already-exited) child via the registered tool.
            const stop = harness.tools.get('subagent_stop');
            if (stop) {
                try {
                    await stop.execute('toolcall_stop', { id: idMatch[1] });
                } catch {
                    /* ignore */
                }
            }
        } finally {
            if (prevPath === undefined) delete process.env.PATH;
            else process.env.PATH = prevPath;
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix subagent_spawn.git_clone_workspace
    // @covers subagent_spawn.git_clone_workspace
    // @level integration
    it('fail-fast rejects broken linked worktrees through subagent_spawn without spawning', async () => {
        assert.ok(
            existsSync(join(STUB_PKG_ROOT, '@earendil-works', 'pi-ai', 'index.js')),
            'committed earendil stubs must exist for live tool execution',
        );
        installEarendilResolver();

        const base = mkdtempSync(join(tmpdir(), 'pi-gitws-live-broken-wt-'));
        const stubDir = join(base, 'bin');
        const spawnMarker = join(base, 'pi-invoked.marker');
        mkdirSync(stubDir, { recursive: true });

        // Stub pi must never be reached on the fail-fast path.
        const stubPi = join(stubDir, 'pi');
        writeFileSync(
            stubPi,
            [
                '#!/bin/sh',
                `printf '%s\n' "$*" > ${JSON.stringify(spawnMarker)}`,
                'printf \'{"type":"agent_end"}\n\'',
                'exit 0',
                '',
            ].join('\n'),
        );
        chmodSync(stubPi, 0o755);

        // Linked worktree whose common git metadata we then corrupt.
        const repo = makeRepo(base, 'main');
        const wt = join(base, 'wt');
        runGit(repo, `worktree add ${wt} -b wt-branch`);
        const commonGitDir = runGit(wt, 'rev-parse --path-format=absolute --git-common-dir');
        assert.ok(existsSync(join(wt, '.git')));
        assert.ok(!lstatSync(join(wt, '.git')).isDirectory(), 'fixture must be a linked worktree');
        rmSync(commonGitDir, { recursive: true, force: true });

        const prevPath = process.env.PATH;
        process.env.PATH = `${stubDir}${prevPath ? `:${prevPath}` : ''}`;

        try {
            const indexUrl = pathToFileURL(join(REPO_ROOT, 'index.ts')).href + `?live-broken=${Date.now()}`;
            const { default: extensionFactory } = await import(indexUrl);

            const harness = createExtensionHarness(wt);
            await extensionFactory(harness.pi);

            const tool = harness.tools.get('subagent_spawn');
            assert.ok(tool, 'extension must register subagent_spawn');

            const sandboxDir = join(base, 'sandbox-workspace');
            await assert.rejects(
                () => tool.execute(
                    'toolcall_live_broken_wt',
                    {
                        prompt: 'must not launch — broken linked worktree',
                        name: 'broken-wt',
                        git_clone_workspace: true,
                        sandbox_dir: sandboxDir,
                        sandbox: false,
                        callback: false,
                        clean: true,
                        tools: 'read,bash',
                        cwd: wt,
                    },
                    undefined,
                    undefined,
                    harness.ctx,
                ),
                /Linked worktree .* has Git metadata outside the sandbox[\s\S]*git_clone_workspace:true/i,
            );

            assert.equal(
                existsSync(spawnMarker),
                false,
                'stub pi/spawn marker must not be reached after linked-worktree fail-fast',
            );
            assert.equal(
                existsSync(join(sandboxDir, '.git')),
                false,
                'no clone workspace may be left behind after fail-fast',
            );
        } finally {
            if (prevPath === undefined) delete process.env.PATH;
            else process.env.PATH = prevPath;
            rmSync(base, { recursive: true, force: true });
        }
    });
});
