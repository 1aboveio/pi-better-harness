/**
 * Unit: sandbox.ts chooses and builds the OS write-confinement wrapper.
 * @covers sandbox.backend-selection
 * @covers sandbox.command-wrapper
 * @covers sandbox.spawn-policy
 * @level unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { sandboxSupported, buildSandboxCommand, maybeBuildSandboxCommand } = await import(
    new URL('../sandbox.ts', import.meta.url).href,
);
const { spawnDetached } = await import(new URL('../spawn.ts', import.meta.url).href);

function sandboxArgs(base, writableDir) {
    return {
        profilePath: join(base, 'profile.sb'),
        writableDir,
        home: join(base, 'home'),
        piBin: '/usr/bin/true',
        piArgs: ['-p', '--mode', 'json', 'original prompt'],
    };
}

async function withPlatform(value, run) {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...descriptor, value });
    try {
        return await run();
    } finally {
        Object.defineProperty(process, 'platform', descriptor);
    }
}

async function withPath(value, run) {
    const previous = process.env.PATH;
    process.env.PATH = value;
    try {
        return await run();
    } finally {
        if (previous === undefined) delete process.env.PATH;
        else process.env.PATH = previous;
    }
}

async function withUnreadablePath(run) {
    const previous = process.env;
    process.env = new Proxy(previous, {
        get(target, property, receiver) {
            if (property === 'PATH') throw new Error('PATH must not be read for sandbox:false');
            return Reflect.get(target, property, receiver);
        },
    });
    try {
        return await run();
    } finally {
        process.env = previous;
    }
}

function writeBwrapStub(dir, body, mode = 0o755) {
    const path = join(dir, 'bwrap');
    writeFileSync(path, body);
    chmodSync(path, mode);
    return path;
}

describe('sandbox profile (subagent write confinement)', () => {
    // @characterizes sandbox.command-wrapper
    // @covers sandbox.command-wrapper
    // @level unit
    it('keeps the existing macOS sandbox-exec wrapper and profile', async () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-sbx-unit-'));
        const writable = join(base, 'work');
        mkdirSync(writable, { recursive: true });
        try {
            await withPlatform('darwin', () => {
                const args = sandboxArgs(base, writable);
                const cmd = buildSandboxCommand(args);
                assert.equal(cmd.file, '/usr/bin/sandbox-exec');
                assert.deepEqual(
                    cmd.fileArgs,
                    ['-f', args.profilePath, '/usr/bin/true', '-p', '--mode', 'json', 'original prompt'],
                    'wrapper must preserve the executable and original pi argv order',
                );

                const body = readFileSync(args.profilePath, 'utf8');
                assert.match(body, /\(version 1\)/);
                assert.match(body, /\(allow default\)/);
                assert.match(body, /\(deny file-write\*\)/);
                assert.ok(body.includes(`(allow file-write* (subpath "${realpathSync(writable)}"))`));
                assert.match(body, /\/private\/var\/folders/);
                assert.match(body, /\/private\/tmp/);
                assert.match(body, /\/dev/);
                assert.ok(body.includes('.pi'), `profile should allow home/.pi:\n${body}`);
            });
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.backend-selection
    // @covers sandbox.backend-selection
    // @level unit
    it('discovers an executable Linux bwrap without executing or probing it', async () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-bwrap-discovery-'));
        const executed = join(base, 'executed');
        writeBwrapStub(base, `#!/bin/sh\nprintf executed > '${executed}'\nexit 99\n`);
        try {
            await withPlatform('linux', () => withPath(base, () => {
                assert.equal(sandboxSupported(), true);
                assert.equal(existsSync(executed), false, 'support discovery must not execute bwrap');
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.backend-selection
    // @covers sandbox.backend-selection
    // @level unit
    it('reports Linux sandbox support false for absent or non-executable bwrap', async () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-bwrap-absent-'));
        try {
            await withPlatform('linux', () => withPath(base, () => {
                assert.equal(sandboxSupported(), false, 'an absent bwrap is not a supported backend');
                writeBwrapStub(base, '#!/bin/sh\nexit 0\n', 0o644);
                assert.equal(sandboxSupported(), false, 'a non-executable bwrap is not a supported backend');
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.spawn-policy
    // @covers sandbox.spawn-policy
    // @level unit
    it('errors explicitly without bwrap but default-on degrades to a direct command', async () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-bwrap-policy-'));
        const writable = join(base, 'work');
        mkdirSync(writable, { recursive: true });
        try {
            await withPlatform('linux', () => withPath(base, () => {
                const args = sandboxArgs(base, writable);
                assert.equal(
                    maybeBuildSandboxCommand(args, { sandboxEnabled: true, explicitSandbox: false }),
                    undefined,
                    'default-on mode must preserve the direct-execution degradation when bwrap is absent',
                );
                assert.throws(
                    () => maybeBuildSandboxCommand(args, { sandboxEnabled: true, explicitSandbox: true }),
                    /Linux sandbox requires executable bubblewrap \(bwrap\) on PATH/i,
                );
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.spawn-policy
    // @covers sandbox.spawn-policy
    // @level unit
    it('bypasses backend discovery and wrapper construction for sandbox:false', async () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-bwrap-opt-out-'));
        const writable = join(base, 'work');
        mkdirSync(writable, { recursive: true });
        try {
            await withPlatform('linux', () => withUnreadablePath(() => {
                assert.equal(
                    maybeBuildSandboxCommand(sandboxArgs(base, writable), { sandboxEnabled: false, explicitSandbox: false }),
                    undefined,
                );
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.command-wrapper
    // @covers sandbox.command-wrapper
    // @level unit
    it('builds the Linux bubblewrap topology with canonical workdir and original argv', async () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-bwrap-command-'));
        const writable = join(base, 'work');
        mkdirSync(writable, { recursive: true });
        writeBwrapStub(base, '#!/bin/sh\nexit 0\n');
        try {
            await withPlatform('linux', () => withPath(base, () => {
                const args = sandboxArgs(base, writable);
                const cmd = buildSandboxCommand(args);
                const canonicalWorkdir = realpathSync(writable);
                assert.equal(cmd.file, join(base, 'bwrap'));
                assert.deepEqual(cmd.fileArgs, [
                    '--ro-bind', '/', '/',
                    '--bind', canonicalWorkdir, canonicalWorkdir,
                    '--bind', '/tmp', '/tmp',
                    '--dev', '/dev',
                    '--', '/usr/bin/true', '-p', '--mode', 'json', 'original prompt',
                ]);
                assert.equal(cmd.fileArgs.includes('--unshare-net'), false, 'network must remain shared');
                assert.equal(cmd.fileArgs.includes('--die-with-parent'), false, 'detached children must remain durable');
                assert.equal(cmd.fileArgs.some((arg) => arg.includes('.pi')), false, '~/.pi must have no writable binding');
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.spawn-policy
    // @covers sandbox.spawn-policy
    // @level unit
    it('fails closed after bwrap selection and never executes the direct child', async () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-bwrap-fail-closed-'));
        const writable = join(base, 'work');
        const backendMarker = join(base, 'backend-ran');
        const directMarker = join(base, 'direct-child-ran');
        mkdirSync(writable, { recursive: true });
        writeBwrapStub(base, `#!/bin/sh\nprintf backend > '${backendMarker}'\nexit 73\n`);
        try {
            await withPlatform('linux', () => withPath(base, async () => {
                const args = sandboxArgs(base, writable);
                args.piBin = '/bin/sh';
                args.piArgs = ['-c', 'printf direct-child > "$1"', 'sh', directMarker];
                const cmd = maybeBuildSandboxCommand(args, { sandboxEnabled: true, explicitSandbox: true });
                assert.ok(cmd, 'an executable bwrap must be selected');
                const spawned = spawnDetached({
                    file: cmd.file,
                    fileArgs: cmd.fileArgs,
                    cwd: writable,
                    logPath: join(base, 'child.log'),
                });
                // spawnDetached intentionally unrefs children; retain this test
                // process only until its real child has reported an exit code.
                const keepAlive = setInterval(() => {}, 1000);
                try {
                    assert.equal(await spawned.exit, 73);
                } finally {
                    clearInterval(keepAlive);
                }
                assert.equal(existsSync(backendMarker), true, 'the selected backend was invoked');
                assert.equal(existsSync(directMarker), false, 'a failed backend must never retry the child bare');
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});
