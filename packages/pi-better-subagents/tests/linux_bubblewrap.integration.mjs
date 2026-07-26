/**
 * Linux integration: real bubblewrap children use the production sandbox builder
 * and prove the kernel-enforced read/write boundary by filesystem effects.
 * @covers sandbox.command-wrapper
 * @covers sandbox.spawn-policy
 * @level integration
 */
import { createServer } from 'node:http';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const { maybeBuildSandboxCommand, sandboxSupported } = await import(
    new URL('../sandbox.ts', import.meta.url).href,
);
const { spawnDetached } = await import(new URL('../spawn.ts', import.meta.url).href);

function nodeScript(source, ...args) {
    return ['-e', source, ...args];
}

async function runSandboxedChild({ base, writableDir, cwd = writableDir, args }) {
    const command = maybeBuildSandboxCommand({
        profilePath: join(base, 'unused.sb'),
        writableDir,
        home: homedir(),
        piBin: process.execPath,
        piArgs: args,
    }, { sandboxEnabled: true, explicitSandbox: true });
    assert.ok(command, 'the selected Linux backend must return a product wrapper command');
    assert.match(command.file, /(?:^|\/)bwrap$/, 'this confinement test must exercise bubblewrap');

    const logPath = join(base, `child-${Date.now()}-${Math.random()}.log`);
    const spawned = spawnDetached({
        file: command.file,
        fileArgs: command.fileArgs,
        cwd,
        logPath,
    });
    // spawnDetached intentionally unrefs children; retain this test process only
    // until the real bwrap child has reported its exit code.
    const keepAlive = setInterval(() => {}, 1000);
    try {
        const exitCode = await spawned.exit;
        return { exitCode, log: readFileSync(logPath, 'utf8') };
    } finally {
        clearInterval(keepAlive);
    }
}

async function withLocalServer(run) {
    const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('host-local-http-ok');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object', 'server must listen on a concrete local port');
    try {
        await run(`http://127.0.0.1:${address.port}/proof`);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

it('enforces the real Linux bubblewrap confinement boundary from the product builder', async () => {
    assert.equal(process.platform, 'linux', 'this Linux confinement lane must not route to another backend');
    assert.equal(sandboxSupported(), true, 'Linux confinement requires executable bubblewrap; missing bwrap is a hard failure');

    const base = mkdtempSync(join(process.cwd(), '.pi-bwrap-integration-'));
    const canonicalWorkdir = join(base, 'work');
    const aliasWorkdir = join(base, 'work-alias');
    const outsidePath = join(base, 'outside.txt');
    const deniedOutsidePath = join(base, 'outside-write-denied.txt');
    const outsideTarget = join(base, 'outside-target.txt');
    const insideSymlink = join(canonicalWorkdir, 'outside-link');
    const tmpPath = join(tmpdir(), `pi-bwrap-tmp-${process.pid}-${Date.now()}`);
    const piMarker = join(homedir(), '.pi', `bwrap-write-denied-${process.pid}-${Date.now()}`);
    mkdirSync(canonicalWorkdir, { recursive: true });
    symlinkSync(canonicalWorkdir, aliasWorkdir);
    writeFileSync(outsidePath, 'readable-outside');
    writeFileSync(outsideTarget, 'outside-target-must-not-change');
    symlinkSync(outsideTarget, insideSymlink);
    assert.equal(existsSync(piMarker), false, 'the unique ~/.pi marker must not already exist');

    try {
        const canonicalCommand = maybeBuildSandboxCommand({
            profilePath: join(base, 'unused.sb'),
            writableDir: aliasWorkdir,
            home: homedir(),
            piBin: process.execPath,
            piArgs: nodeScript('process.exit(0)'),
        }, { sandboxEnabled: true, explicitSandbox: true });
        assert.ok(canonicalCommand, 'a symlinked workdir must still select the Linux backend');
        assert.ok(
            canonicalCommand.fileArgs.includes(realpathSync(canonicalWorkdir)),
            'the product builder must bind the real workdir rather than its symlink alias',
        );
        assert.equal(canonicalCommand.fileArgs.includes(aliasWorkdir), false, 'the alias must not become a second writable root');

        const inside = await runSandboxedChild({
            base,
            writableDir: aliasWorkdir,
            cwd: aliasWorkdir,
            args: nodeScript(
                "const fs=require('node:fs'); fs.writeFileSync(process.argv[1], 'inside-round-trip'); process.stdout.write(fs.readFileSync(process.argv[1], 'utf8'));",
                join(aliasWorkdir, 'inside.txt'),
            ),
        });
        assert.equal(inside.exitCode, 0, inside.log);
        assert.equal(readFileSync(join(canonicalWorkdir, 'inside.txt'), 'utf8'), 'inside-round-trip');

        const outside = await runSandboxedChild({
            base,
            writableDir: aliasWorkdir,
            cwd: aliasWorkdir,
            args: nodeScript("require('node:fs').writeFileSync(process.argv[1], 'forbidden')", deniedOutsidePath),
        });
        assert.notEqual(outside.exitCode, 0, 'an outside write must fail at the OS boundary');
        assert.equal(existsSync(deniedOutsidePath), false, 'a denied outside write must create no host file');

        const afterOutsideDenial = await runSandboxedChild({
            base,
            writableDir: aliasWorkdir,
            cwd: aliasWorkdir,
            args: nodeScript("require('node:fs').writeFileSync(process.argv[1], 'inside-after-denial')", join(aliasWorkdir, 'inside-after-denial.txt')),
        });
        assert.equal(afterOutsideDenial.exitCode, 0, afterOutsideDenial.log);
        assert.equal(readFileSync(join(canonicalWorkdir, 'inside-after-denial.txt'), 'utf8'), 'inside-after-denial');

        const symlinkWrite = await runSandboxedChild({
            base,
            writableDir: aliasWorkdir,
            cwd: aliasWorkdir,
            args: nodeScript("require('node:fs').writeFileSync(process.argv[1], 'symlink-escape')", insideSymlink),
        });
        assert.notEqual(symlinkWrite.exitCode, 0, 'a symlink inside the writable root must not permit outside writes');
        assert.equal(readFileSync(outsideTarget, 'utf8'), 'outside-target-must-not-change');

        const outsideRead = await runSandboxedChild({
            base,
            writableDir: aliasWorkdir,
            cwd: aliasWorkdir,
            args: nodeScript("process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", outsidePath),
        });
        assert.equal(outsideRead.exitCode, 0, outsideRead.log);
        assert.match(outsideRead.log, /readable-outside/);

        const piWrite = await runSandboxedChild({
            base,
            writableDir: aliasWorkdir,
            cwd: aliasWorkdir,
            args: nodeScript("require('node:fs').writeFileSync(process.argv[1], 'forbidden')", piMarker),
        });
        assert.notEqual(piWrite.exitCode, 0, '~/.pi must stay read-only on Linux');
        assert.equal(existsSync(piMarker), false, 'the denied ~/.pi write must create no host file');

        const approvedSystemPaths = await runSandboxedChild({
            base,
            writableDir: aliasWorkdir,
            cwd: aliasWorkdir,
            args: nodeScript(
                "const fs=require('node:fs'); fs.writeFileSync(process.argv[1], 'host-tmp-ok'); fs.writeFileSync('/dev/null', 'discarded');",
                tmpPath,
            ),
        });
        assert.equal(approvedSystemPaths.exitCode, 0, approvedSystemPaths.log);
        assert.equal(readFileSync(tmpPath, 'utf8'), 'host-tmp-ok');

        await withLocalServer(async (url) => {
            const network = await runSandboxedChild({
                base,
                writableDir: aliasWorkdir,
                cwd: aliasWorkdir,
                args: nodeScript(
                    "const http=require('node:http'); http.get(process.argv[1], (response) => { let body=''; response.setEncoding('utf8'); response.on('data', (chunk) => body += chunk); response.on('end', () => { process.stdout.write(body); process.exit(body === 'host-local-http-ok' ? 0 : 1); }); }).on('error', (error) => { console.error(error); process.exit(1); });",
                    url,
                ),
            });
            assert.equal(network.exitCode, 0, network.log);
            assert.match(network.log, /host-local-http-ok/);
        });
    } finally {
        rmSync(tmpPath, { force: true });
        rmSync(base, { recursive: true, force: true });
    }
});
