/**
 * Unit + integration tests for disposable Git clone workspace preparation.
 * @covers subagent_spawn.git_clone_workspace
 * @covers git_workspace.inspect
 * @covers git_workspace.clone
 * @level unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const {
    inspectGitWorkspace,
    prepareGitCloneWorkspace,
    isGitMetadataOutsideSandbox,
    resolveSubagentWorkspace,
    assertSafeGitWorkspace,
    buildGitCloneArgs,
    resolveCloneUrl,
    readGitRemotes,
} = await import(new URL('../git-workspace.ts', import.meta.url).href);

const {
    maybeBuildSandboxCommand,
    sandboxSupported,
} = await import(new URL('../sandbox.ts', import.meta.url).href);

function resolveGitBin() {
    try {
        return execFileSync('which', ['git'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
        return null;
    }
}
const GIT_BIN = resolveGitBin();
if (!GIT_BIN) {
    throw new Error(
        'git is required to run disposable clone workspace tests (AC2–AC10). ' +
        'Install git and re-run; tests must not skip when git is absent.',
    );
}

function runGit(cwd, args, opts = {}) {
    const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
    return execFileSync(GIT_BIN, argv, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
    }).trim();
}

function makeRepo(base, name) {
    const dir = join(base, name);
    runGit(base, `init --bare ${name}.git`);
    mkdirSync(dir);
    runGit(dir, 'init');
    runGit(dir, 'checkout -b main');
    runGit(dir, 'config user.email test@example.com');
    runGit(dir, 'config user.name Test');
    writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
    runGit(dir, 'add README.md');
    runGit(dir, ['commit', '-m', 'initial']);
    return dir;
}

function makeLinkedWorktree(base, repoName, wtName) {
    const repo = join(base, repoName);
    const wt = join(base, wtName);
    runGit(repo, `worktree add ${wt} -b ${wtName}-branch`);
    return wt;
}

/**
 * Run a command through the product-selected OS write sandbox (sandbox-exec on
 * macOS, bwrap on Linux). Returns { exitCode, stdout, stderr }.
 */
function runThroughProductSandbox({ writableDir, file, fileArgs, cwd = writableDir, env }) {
    const base = mkdtempSync(join(tmpdir(), 'pi-gitws-sbx-run-'));
    try {
        const cmd = maybeBuildSandboxCommand({
            profilePath: join(base, 'profile.sb'),
            writableDir,
            home: env?.HOME ?? homedir(),
            piBin: file,
            piArgs: fileArgs,
        }, { sandboxEnabled: true, explicitSandbox: true });
        assert.ok(cmd, 'product sandbox wrapper must be available for this integration test');
        const result = spawnSync(cmd.file, cmd.fileArgs, {
            cwd,
            encoding: 'utf-8',
            env: { ...process.env, ...(env ?? {}) },
        });
        return {
            exitCode: result.status ?? 1,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            wrapper: cmd.file,
        };
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
}

describe('git-workspace', () => {
    describe('inspectGitWorkspace', () => {
        it('identifies a normal repository as not a linked worktree', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-normal-'));
            try {
                const repo = makeRepo(base, 'repo');
                const info = inspectGitWorkspace(repo);
                assert.equal(info.isLinkedWorktree, false);
                assert.ok(existsSync(info.gitDir));
                assert.ok(lstatSync(join(repo, '.git')).isDirectory());
                assert.equal(isGitMetadataOutsideSandbox(info, repo), false);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.inspect
        // @covers git_workspace.inspect
        // @level unit
        it('detects a linked worktree whose gitdir is outside the workspace root', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-linked-'));
            try {
                const repo = makeRepo(base, 'main');
                const wt = makeLinkedWorktree(base, 'main', 'wt');
                const info = inspectGitWorkspace(wt);
                assert.equal(info.isLinkedWorktree, true);
                assert.ok(!info.gitDir.startsWith(wt));
                assert.equal(isGitMetadataOutsideSandbox(info, wt), true);
                assert.match(
                    readFileSync(join(wt, '.git'), 'utf-8'),
                    /^gitdir:\s*/m,
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('resolves the common git directory for reference acceleration', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-common-'));
            try {
                const repo = makeRepo(base, 'main');
                const wt = makeLinkedWorktree(base, 'main', 'wt');
                const info = inspectGitWorkspace(wt);
                assert.ok(existsSync(info.commonGitDir));
                assert.ok(existsSync(join(info.commonGitDir, 'objects')));
                assert.equal(info.commonGitDir, inspectGitWorkspace(repo).commonGitDir);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('throws for a non-git directory', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-nogit-'));
            try {
                assert.throws(() => inspectGitWorkspace(base), /not a git repository/i);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });
    });

    describe('prepareGitCloneWorkspace', () => {
        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('produces a clone with a real .git directory inside the target', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-clone-'));
            try {
                const repo = makeRepo(base, 'repo');
                const target = join(base, 'clone');
                const result = prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });
                assert.equal(result, target);
                assert.ok(existsSync(join(target, '.git')));
                assert.ok(lstatSync(join(target, '.git')).isDirectory());
                assert.ok(existsSync(join(target, 'README.md')));
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('checks out the source branch name and commit (not detached HEAD)', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-checkout-'));
            try {
                const repo = makeRepo(base, 'repo');
                const sourceCommit = runGit(repo, 'rev-parse HEAD');
                const sourceBranch = runGit(repo, 'rev-parse --abbrev-ref HEAD');
                assert.notEqual(sourceBranch, 'HEAD', 'fixture must be on a named branch');
                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });
                const targetCommit = runGit(target, 'rev-parse HEAD');
                const targetBranch = runGit(target, 'rev-parse --abbrev-ref HEAD');
                assert.equal(targetCommit, sourceCommit);
                assert.equal(targetBranch, sourceBranch, 'clone must preserve the symbolic branch name');
                assert.notEqual(targetBranch, 'HEAD', 'clone must not land in detached HEAD when source had a branch');
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('honors an explicit branch or commit to checkout', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-checkout-explicit-'));
            try {
                const repo = makeRepo(base, 'repo');
                runGit(repo, 'checkout -b side');
                writeFileSync(join(repo, 'side.md'), 'side\n');
                runGit(repo, 'add side.md');
                runGit(repo, ['commit', '-m', 'side']);
                const sideCommit = runGit(repo, 'rev-parse side');
                runGit(repo, 'checkout main');

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target, checkout: 'side' });
                assert.equal(runGit(target, 'rev-parse HEAD'), sideCommit);
                assert.ok(existsSync(join(target, 'side.md')));
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('checks out an explicit named branch as a symbolic branch (not detached HEAD)', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-checkout-named-branch-'));
            try {
                const repo = makeRepo(base, 'repo');
                runGit(repo, 'checkout -b side');
                writeFileSync(join(repo, 'side.md'), 'side\n');
                runGit(repo, 'add side.md');
                runGit(repo, ['commit', '-m', 'side']);
                const sideCommit = runGit(repo, 'rev-parse side');
                // Source is on main while the caller requests the named branch "side".
                runGit(repo, 'checkout main');
                assert.equal(runGit(repo, 'rev-parse --abbrev-ref HEAD'), 'main');

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target, checkout: 'side' });

                assert.equal(runGit(target, 'rev-parse HEAD'), sideCommit);
                const targetBranch = runGit(target, 'rev-parse --abbrev-ref HEAD');
                assert.equal(
                    targetBranch,
                    'side',
                    'explicit named-branch checkout must land on symbolic branch side',
                );
                assert.notEqual(
                    targetBranch,
                    'HEAD',
                    'explicit named-branch checkout must not leave detached HEAD',
                );
                assert.ok(existsSync(join(target, 'side.md')));
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('uses reference acceleration argv and dissociates from the parent repo', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-dissoc-'));
            try {
                const upstream = join(base, 'upstream.git');
                runGit(base, 'init --bare upstream.git');
                const repo = join(base, 'repo');
                runGit(base, `clone ${upstream} repo`);
                runGit(repo, 'config user.email test@example.com');
                runGit(repo, 'config user.name Test');
                writeFileSync(join(repo, 'README.md'), 'ref-acc\n');
                runGit(repo, 'add README.md');
                runGit(repo, ['commit', '-m', 'initial']);
                runGit(repo, 'push -u origin HEAD');

                const info = inspectGitWorkspace(repo);
                const cloneUrl = resolveCloneUrl(repo, info);
                assert.equal(cloneUrl, upstream, 'clone URL must prefer the upstream remote, not the working tree');

                const args = buildGitCloneArgs({
                    referenceRepo: info.commonGitDir,
                    cloneUrl,
                    targetDir: join(base, 'clone'),
                });
                // Fails-if-broken: removing --reference-if-able from production
                // must break this exact argv contract.
                assert.deepEqual(args.slice(0, 4), [
                    'clone',
                    '--reference-if-able',
                    info.commonGitDir,
                    '--dissociate',
                ]);
                assert.equal(args[4], cloneUrl);
                assert.notEqual(args[4], info.repoRoot, 'clone source must not be the parent working tree when origin exists');

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });
                const alternates = join(target, '.git', 'objects', 'info', 'alternates');
                assert.equal(existsSync(alternates), false, 'clone must not retain alternates after --dissociate');
                assert.equal(runGit(target, 'rev-parse HEAD'), runGit(repo, 'rev-parse HEAD'));
                assert.equal(
                    runGit(target, 'remote get-url origin'),
                    runGit(repo, 'remote get-url origin'),
                    'clone origin must remain the upstream remote after preparation',
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('falls back cleanly when the local reference is unavailable', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-ref-fallback-'));
            try {
                const upstream = join(base, 'upstream.git');
                runGit(base, 'init --bare upstream.git');
                const repo = join(base, 'repo');
                runGit(base, `clone ${upstream} repo`);
                runGit(repo, 'config user.email test@example.com');
                runGit(repo, 'config user.name Test');
                writeFileSync(join(repo, 'README.md'), 'fallback\n');
                runGit(repo, 'add README.md');
                runGit(repo, ['commit', '-m', 'initial']);
                runGit(repo, 'push -u origin HEAD');

                const missingRef = join(base, 'missing-objects.git');
                // Intentionally point --reference-if-able at a non-repo path.
                // Git must fall back to a normal clone rather than fail hard.
                const target = join(base, 'clone');
                prepareGitCloneWorkspace({
                    sourceDir: repo,
                    targetDir: target,
                    referenceRepo: missingRef,
                });
                assert.ok(lstatSync(join(target, '.git')).isDirectory());
                assert.equal(existsSync(join(target, '.git', 'objects', 'info', 'alternates')), false);
                assert.equal(runGit(target, 'rev-parse HEAD'), runGit(repo, 'rev-parse HEAD'));
                assert.equal(runGit(target, 'remote get-url origin'), upstream);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('preserves source remotes so pushes target upstream, not the parent working tree', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-remote-'));
            try {
                const upstream = join(base, 'upstream.git');
                runGit(base, 'init --bare upstream.git');
                const repo = join(base, 'repo');
                runGit(base, `clone ${upstream} repo`);
                runGit(repo, 'config user.email test@example.com');
                runGit(repo, 'config user.name Test');
                writeFileSync(join(repo, 'a.txt'), 'a\n');
                runGit(repo, 'add a.txt');
                runGit(repo, ['commit', '-m', 'first']);
                runGit(repo, 'push -u origin HEAD');

                const sourceOrigin = runGit(repo, 'remote get-url origin');
                assert.equal(realpathSync(sourceOrigin), realpathSync(upstream));

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });

                const cloneOrigin = runGit(target, 'remote get-url origin');
                assert.equal(
                    realpathSync(cloneOrigin),
                    realpathSync(upstream),
                    'clone origin must be the upstream remote, not the source working tree',
                );
                assert.notEqual(
                    realpathSync(cloneOrigin),
                    realpathSync(repo),
                    'clone origin must not rewrite to the parent working tree',
                );

                // Push a new branch and prove it lands on upstream, not the source tree.
                runGit(target, 'checkout -b review-proof');
                writeFileSync(join(target, 'proof.txt'), 'proof\n');
                runGit(target, 'add proof.txt');
                runGit(target, ['commit', '-m', 'proof']);
                runGit(target, 'push -u origin review-proof');

                const upstreamHas = runGit(upstream, 'branch --list review-proof');
                assert.match(upstreamHas, /review-proof/);
                // Source working tree must not have gained the branch tip as a local branch
                // from a path-style origin rewrite.
                const sourceBranches = runGit(repo, 'branch --list review-proof');
                assert.equal(sourceBranches, '', 'push must not update the source working tree branches');
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        // Class: git-remote-preservation — structured config read + whitespace URLs,
        // multi-remote, fetch-only, distinct pushurl, stale clone remote removal.
        it('preserves remotes with whitespace URLs via structured git config (not remote -v)', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-ws-remote-'));
            try {
                // Local bare remotes whose paths contain spaces — the exact failure
                // mode of `git remote -v` + non-whitespace URL capture.
                const fetchRemote = join(base, 'up stream.git');
                const pushRemote = join(base, 'push dest.git');
                const otherRemote = join(base, 'other remote.git');
                mkdirSync(fetchRemote);
                mkdirSync(pushRemote);
                mkdirSync(otherRemote);
                runGit(fetchRemote, 'init --bare');
                runGit(pushRemote, 'init --bare');
                runGit(otherRemote, 'init --bare');

                const repo = join(base, 'repo');
                mkdirSync(repo);
                runGit(repo, 'init');
                runGit(repo, 'checkout -b main');
                runGit(repo, 'config user.email test@example.com');
                runGit(repo, 'config user.name Test');
                writeFileSync(join(repo, 'a.txt'), 'a\n');
                runGit(repo, 'add a.txt');
                runGit(repo, ['commit', '-m', 'first']);

                // origin: whitespace fetch URL + distinct whitespace pushurl
                runGit(repo, ['remote', 'add', 'origin', fetchRemote]);
                runGit(repo, ['remote', 'set-url', '--push', 'origin', pushRemote]);
                // second remote: fetch-only whitespace path (no distinct pushurl)
                runGit(repo, ['remote', 'add', 'upstream', otherRemote]);
                runGit(repo, ['push', '-u', 'origin', 'HEAD']);

                // Model must surface every remote with full whitespace-preserving URLs.
                const model = readGitRemotes(repo);
                assert.deepEqual(
                    model.map((r) => r.name).sort(),
                    ['origin', 'upstream'],
                    'readGitRemotes must not drop remotes whose URLs contain spaces',
                );
                const origin = model.find((r) => r.name === 'origin');
                const upstream = model.find((r) => r.name === 'upstream');
                assert.deepEqual(origin.urls, [fetchRemote]);
                assert.deepEqual(origin.pushUrls, [pushRemote]);
                assert.deepEqual(upstream.urls, [otherRemote]);
                assert.deepEqual(upstream.pushUrls, [], 'fetch-only remote must not invent a pushUrl');

                // resolveCloneUrl must prefer origin fetch URL even with spaces.
                const info = inspectGitWorkspace(repo);
                assert.equal(resolveCloneUrl(repo, info), fetchRemote);

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });

                // After sync: both remotes present with exact URLs; no stale remotes.
                const cloneModel = readGitRemotes(target);
                assert.deepEqual(
                    cloneModel.map((r) => r.name).sort(),
                    ['origin', 'upstream'],
                    'clone must preserve every source remote name',
                );
                const cloneOrigin = cloneModel.find((r) => r.name === 'origin');
                const cloneUpstream = cloneModel.find((r) => r.name === 'upstream');
                assert.equal(
                    runGit(target, 'remote get-url origin'),
                    fetchRemote,
                    'clone fetch URL must preserve whitespace path',
                );
                assert.equal(
                    runGit(target, ['remote', 'get-url', '--push', 'origin']),
                    pushRemote,
                    'clone pushurl must preserve whitespace path',
                );
                assert.deepEqual(cloneOrigin.urls, [fetchRemote]);
                assert.deepEqual(cloneOrigin.pushUrls, [pushRemote]);
                assert.equal(
                    runGit(target, 'remote get-url upstream'),
                    otherRemote,
                    'additional fetch-only remote must be preserved',
                );
                assert.deepEqual(cloneUpstream.pushUrls, []);

                // Behavioral proof: push lands on the configured push remote.
                runGit(target, 'checkout -b ws-proof');
                writeFileSync(join(target, 'proof.txt'), 'proof\n');
                runGit(target, 'add proof.txt');
                runGit(target, ['commit', '-m', 'ws-proof']);
                runGit(target, 'push -u origin ws-proof');
                assert.match(
                    runGit(pushRemote, 'branch --list ws-proof'),
                    /ws-proof/,
                    'push must land on the whitespace push remote',
                );
                assert.equal(
                    runGit(fetchRemote, 'branch --list ws-proof'),
                    '',
                    'push must not land on the fetch-only remote',
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        // Class: git-remote-preservation — multi-remote + stale clone remote removal.
        it('preserves multiple remotes and removes stale clone-only remotes', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-multi-remote-'));
            try {
                const originBare = join(base, 'origin.git');
                const mirrorBare = join(base, 'mirror.git');
                runGit(base, 'init --bare origin.git');
                runGit(base, 'init --bare mirror.git');

                const repo = join(base, 'repo');
                runGit(base, `clone ${originBare} repo`);
                runGit(repo, 'config user.email test@example.com');
                runGit(repo, 'config user.name Test');
                writeFileSync(join(repo, 'a.txt'), 'a\n');
                runGit(repo, 'add a.txt');
                runGit(repo, ['commit', '-m', 'first']);
                runGit(repo, 'push -u origin HEAD');
                // Source has origin + mirror; no "extra" remote.
                runGit(repo, ['remote', 'add', 'mirror', mirrorBare]);

                const sourceNames = readGitRemotes(repo).map((r) => r.name).sort();
                assert.deepEqual(sourceNames, ['mirror', 'origin']);

                const target = join(base, 'clone');
                // Clone-from-path would invent origin → parent tree; sync must rewrite
                // and must not leave any remote the source lacks.
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });

                const cloneRemotes = readGitRemotes(target);
                assert.deepEqual(
                    cloneRemotes.map((r) => r.name).sort(),
                    ['mirror', 'origin'],
                    'clone remote set must match source exactly',
                );
                assert.equal(
                    realpathSync(runGit(target, 'remote get-url origin')),
                    realpathSync(originBare),
                );
                assert.equal(
                    realpathSync(runGit(target, 'remote get-url mirror')),
                    realpathSync(mirrorBare),
                );
                // No leftover path-style origin pointing at the parent working tree.
                assert.notEqual(
                    realpathSync(runGit(target, 'remote get-url origin')),
                    realpathSync(repo),
                    'origin must not be rewritten to the parent working tree',
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('preserves distinct remote push URLs (pushurl), not only fetch URLs', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-pushurl-'));
            try {
                const fetchRemote = join(base, 'fetch.git');
                const pushRemote = join(base, 'push.git');
                runGit(base, 'init --bare fetch.git');
                runGit(base, 'init --bare push.git');

                const repo = join(base, 'repo');
                runGit(base, `clone ${fetchRemote} repo`);
                runGit(repo, 'config user.email test@example.com');
                runGit(repo, 'config user.name Test');
                writeFileSync(join(repo, 'a.txt'), 'a\n');
                runGit(repo, 'add a.txt');
                runGit(repo, ['commit', '-m', 'first']);
                // Distinct push destination via remote.<name>.pushurl.
                runGit(repo, `remote set-url --push origin ${pushRemote}`);
                runGit(repo, 'push -u origin HEAD');

                const sourceFetch = runGit(repo, 'remote get-url origin');
                const sourcePush = runGit(repo, 'remote get-url --push origin');
                assert.equal(realpathSync(sourceFetch), realpathSync(fetchRemote));
                assert.equal(realpathSync(sourcePush), realpathSync(pushRemote));
                assert.notEqual(
                    realpathSync(sourceFetch),
                    realpathSync(sourcePush),
                    'fixture must use distinct fetch and push URLs',
                );

                // Model must surface both URLs (fails if push entry is discarded).
                const model = readGitRemotes(repo);
                const origin = model.find((remote) => remote.name === 'origin');
                assert.ok(origin, 'origin remote must be present');
                assert.deepEqual(origin.urls.map((url) => realpathSync(url)), [realpathSync(fetchRemote)]);
                assert.ok(origin.pushUrls.length > 0, 'readGitRemotes must preserve pushUrl when distinct');
                assert.deepEqual(origin.pushUrls.map((url) => realpathSync(url)), [realpathSync(pushRemote)]);

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });

                const cloneFetch = runGit(target, 'remote get-url origin');
                const clonePush = runGit(target, 'remote get-url --push origin');
                assert.equal(
                    realpathSync(cloneFetch),
                    realpathSync(fetchRemote),
                    'clone fetch URL must match source fetch URL',
                );
                assert.equal(
                    realpathSync(clonePush),
                    realpathSync(pushRemote),
                    'clone push URL must preserve source pushurl, not rewrite to fetch URL',
                );
                assert.notEqual(
                    realpathSync(clonePush),
                    realpathSync(cloneFetch),
                    'clone must keep pushurl distinct from fetch URL',
                );

                // A real push must land on the push remote, not the fetch remote.
                runGit(target, 'checkout -b pushurl-proof');
                writeFileSync(join(target, 'proof.txt'), 'proof\n');
                runGit(target, 'add proof.txt');
                runGit(target, ['commit', '-m', 'pushurl-proof']);
                runGit(target, 'push -u origin pushurl-proof');

                assert.match(
                    runGit(pushRemote, 'branch --list pushurl-proof'),
                    /pushurl-proof/,
                    'push must land on the configured push remote',
                );
                assert.equal(
                    runGit(fetchRemote, 'branch --list pushurl-proof'),
                    '',
                    'push must not land on the fetch-only remote',
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('clones from a linked worktree using the main repo as reference', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-linked-clone-'));
            try {
                const repo = makeRepo(base, 'main');
                const wt = makeLinkedWorktree(base, 'main', 'wt');
                const target = join(base, 'clone');
                const result = prepareGitCloneWorkspace({ sourceDir: wt, targetDir: target });
                assert.equal(result, target);
                assert.ok(lstatSync(join(target, '.git')).isDirectory());
                assert.equal(runGit(target, 'rev-parse HEAD'), runGit(wt, 'rev-parse HEAD'));
                const alternates = join(target, '.git', 'objects', 'info', 'alternates');
                assert.equal(existsSync(alternates), false);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('throws a helpful message when the source is not a git repository', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-nogit-clone-'));
            try {
                const target = join(base, 'clone');
                assert.throws(
                    () => prepareGitCloneWorkspace({ sourceDir: base, targetDir: target }),
                    /git_clone_workspace requires a Git repository/i,
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('fail-fast: assertSafeGitWorkspace blocks linked worktrees with outside metadata', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-assert-safe-'));
            try {
                const repo = makeRepo(base, 'main');
                const wt = makeLinkedWorktree(base, 'main', 'wt');
                // Sandbox root is the linked worktree itself — metadata lives outside.
                assert.throws(
                    () => assertSafeGitWorkspace(wt, wt),
                    /Linked worktree .* has Git metadata outside the sandbox[\s\S]*git_clone_workspace:true/i,
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('fail-fast: broken linked-worktree metadata prevents clone preparation', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-broken-wt-'));
            try {
                const repo = makeRepo(base, 'main');
                const wt = makeLinkedWorktree(base, 'main', 'wt');
                const info = inspectGitWorkspace(wt);
                assert.equal(info.isLinkedWorktree, true);

                // Corrupt the common git directory so preparation cannot succeed.
                // This drives the linked-worktree fail-fast path rather than a
                // generic non-git error.
                rmSync(info.commonGitDir, { recursive: true, force: true });

                const target = join(base, 'clone');
                assert.throws(
                    () => prepareGitCloneWorkspace({ sourceDir: wt, targetDir: target }),
                    /Linked worktree .* has Git metadata outside the sandbox[\s\S]*git_clone_workspace:true/i,
                );
                assert.equal(
                    existsSync(join(target, '.git')),
                    false,
                    'no clone workspace may be left behind after fail-fast',
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level integration
        it('preserves repo-local Git identity config so commits work without reconfiguring the clone', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-identity-'));
            // Empty HOME so a host global user.name/email cannot mask a missing
            // repo-local identity in the prepared clone (AC9 commit path).
            const emptyHome = join(base, 'empty-home');
            mkdirSync(emptyHome, { recursive: true });
            const noGlobal = { env: { ...process.env, HOME: emptyHome, XDG_CONFIG_HOME: join(emptyHome, '.config') } };
            try {
                const repo = makeRepo(base, 'repo');
                // Distinct repo-local identity; the clone must carry these
                // values rather than relying on host global config.
                runGit(repo, 'config --local user.email local@example.com');
                runGit(repo, 'config --local user.name LocalTest');
                writeFileSync(join(repo, 'identity.txt'), 'identity\n');
                runGit(repo, 'add identity.txt');
                runGit(repo, ['commit', '-m', 'first with local identity']);

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });

                // Repo-local identity must be present on the clone itself.
                assert.equal(runGit(target, 'config --local --get user.email'), 'local@example.com');
                assert.equal(runGit(target, 'config --local --get user.name'), 'LocalTest');

                // Committing in the clone must succeed WITHOUT setting identity
                // inside the target clone, even when global config is absent.
                writeFileSync(join(target, 'second.txt'), 'second\n');
                runGit(target, 'add second.txt');
                runGit(target, ['commit', '-m', 'second'], noGlobal);
                assert.match(runGit(target, 'log --oneline'), /second/);
                assert.match(runGit(target, ['log', '-1', '--format=%an <%ae>']), /LocalTest <local@example\.com>/);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });
    });

    describe('sandboxed git operations in clone workspace', () => {
        // @covers subagent_spawn.git_clone_workspace
        // @level integration
        it('supports status, fetch, edit, add, commit, rebase with conflict continue, and push dry-run', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-ops-'));
            try {
                const origin = join(base, 'origin.git');
                runGit(base, `init --bare origin.git`);
                const repo = join(base, 'repo');
                runGit(base, `clone ${origin} repo`);
                runGit(repo, 'config user.email test@example.com');
                runGit(repo, 'config user.name Test');
                writeFileSync(join(repo, 'shared.txt'), 'base\n');
                runGit(repo, 'add shared.txt');
                runGit(repo, ['commit', '-m', 'first']);
                runGit(repo, 'push -u origin HEAD');
                const baseCommit = runGit(repo, 'rev-parse HEAD');

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });
                // Identity is preserved from the source; do not reconfigure the clone.
                assert.equal(runGit(target, 'remote get-url origin'), origin);

                // status
                const status = runGit(target, 'status --short');
                assert.equal(status, '');

                // fetch
                runGit(target, 'fetch origin');
                assert.match(runGit(target, 'log --oneline origin/HEAD'), /first/);

                // edit + add + commit
                writeFileSync(join(target, 'c.txt'), 'c\n');
                runGit(target, 'add c.txt');
                runGit(target, ['commit', '-m', 'second']);

                // Non-conflicting rebase still works.
                runGit(target, 'rebase origin/HEAD');
                assert.match(runGit(target, 'log --oneline'), /second/);
                assert.match(runGit(target, 'log --oneline'), /first/);

                // --- Real conflict resolution + rebase --continue ---
                // Divergent same-file changes: upstream rewrites shared.txt one way,
                // the clone rewrites it another way on top of the same base.
                const upstreamWork = join(base, 'upstream-work');
                runGit(base, `clone ${origin} upstream-work`);
                runGit(upstreamWork, 'config user.email up@example.com');
                runGit(upstreamWork, 'config user.name Up');
                writeFileSync(join(upstreamWork, 'shared.txt'), 'upstream-change\n');
                runGit(upstreamWork, 'add shared.txt');
                runGit(upstreamWork, ['commit', '-m', 'upstream-edit']);
                runGit(upstreamWork, 'push origin HEAD');

                writeFileSync(join(target, 'shared.txt'), 'clone-change\n');
                runGit(target, 'add shared.txt');
                runGit(target, ['commit', '-m', 'clone-edit']);

                runGit(target, 'fetch origin');
                let rebaseThrew = false;
                try {
                    runGit(target, ['rebase', 'origin/HEAD']);
                } catch {
                    rebaseThrew = true;
                }
                assert.equal(rebaseThrew, true, 'divergent same-file edits must produce a rebase conflict');
                assert.match(runGit(target, 'status'), /rebase in progress|Unmerged paths|both modified/i);

                // Resolve the conflict, stage, and continue the rebase.
                writeFileSync(join(target, 'shared.txt'), 'resolved\n');
                runGit(target, 'add shared.txt');
                // Empty HOME is fine; identity is repo-local on the clone.
                runGit(target, ['-c', 'core.editor=true', 'rebase', '--continue']);
                assert.doesNotMatch(runGit(target, 'status'), /rebase in progress/i);
                assert.equal(readFileSync(join(target, 'shared.txt'), 'utf-8'), 'resolved\n');
                const log = runGit(target, 'log --oneline');
                assert.match(log, /clone-edit|upstream-edit|first/);
                assert.notEqual(runGit(target, 'rev-parse HEAD'), baseCommit);

                // push dry-run against the preserved upstream remote
                const pushOut = runGit(target, 'push --dry-run origin HEAD');
                assert.equal(typeof pushOut, 'string');
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @covers subagent_spawn.git_clone_workspace
        // @covers sandbox.command-wrapper
        // @level integration
        it('runs Git workflow through the product sandbox wrapper with outside-write denial', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-sbx-ops-'));
            // Outside probe must not sit under always-allowed prefixes on macOS
            // (/private/tmp, /private/var/folders, $HOME/.pi). Prefer $HOME.
            const outsideDir = join(homedir(), `pi-gitws-sbx-outside-${process.pid}-${Date.now()}`);
            const prevPath = process.env.PATH;
            try {
                mkdirSync(outsideDir, { recursive: true });
                const outsideFile = join(outsideDir, 'should-not-exist.txt');

                const origin = join(base, 'origin.git');
                runGit(base, 'init --bare origin.git');
                const repo = join(base, 'repo');
                runGit(base, `clone ${origin} repo`);
                runGit(repo, 'config user.email test@example.com');
                runGit(repo, 'config user.name Test');
                writeFileSync(join(repo, 'a.txt'), 'a\n');
                runGit(repo, 'add a.txt');
                runGit(repo, ['commit', '-m', 'first']);
                runGit(repo, 'push -u origin HEAD');

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });
                assert.ok(lstatSync(join(target, '.git')).isDirectory());

                // Precondition: outside path is writable without the sandbox.
                writeFileSync(join(outsideDir, '.probe'), 'ok');
                rmSync(join(outsideDir, '.probe'));

                const gitScript = [
                    'set -e',
                    `cd ${JSON.stringify(target)}`,
                    `${JSON.stringify(GIT_BIN)} status --short`,
                    `${JSON.stringify(GIT_BIN)} fetch origin`,
                    'printf "sandboxed\\n" > b.txt',
                    `${JSON.stringify(GIT_BIN)} add b.txt`,
                    `${JSON.stringify(GIT_BIN)} commit -m sandboxed-commit`,
                    `${JSON.stringify(GIT_BIN)} push --dry-run origin HEAD`,
                    'echo INSIDE_OK',
                ].join('\n');

                // Ensure a product sandbox wrapper is selected. On hosts without
                // a real backend (Linux CI unit lane without bwrap), install a
                // stub bwrap on PATH — same pattern as tests/sandbox_profile.test.mjs.
                let wrapperFileHint = /sandbox-exec$|bwrap$/;
                if (!sandboxSupported()) {
                    assert.equal(
                        platform(),
                        'linux',
                        'only the Linux stub-bwrap path is used when no real backend is present',
                    );
                    const stubDir = join(base, 'stub-bin');
                    mkdirSync(stubDir, { recursive: true });
                    const stubBwrap = join(stubDir, 'bwrap');
                    // Product topology stub: skip flags until "--", then exec child.
                    // Deny outside writes by removing any outside file the child creates
                    // and failing closed — honest about being a stub, not kernel bwrap.
                    writeFileSync(
                        stubBwrap,
                        [
                            '#!/bin/sh',
                            `OUTSIDE=${JSON.stringify(outsideFile)}`,
                            'while [ "$#" -gt 0 ]; do',
                            '  if [ "$1" = "--" ]; then shift; break; fi',
                            '  shift',
                            'done',
                            '"$@"',
                            'rc=$?',
                            'if [ -f "$OUTSIDE" ]; then',
                            '  rm -f "$OUTSIDE"',
                            '  echo OUTSIDE_WRITE_DENIED',
                            '  exit 12',
                            'fi',
                            'exit $rc',
                            '',
                        ].join('\n'),
                    );
                    chmodSync(stubBwrap, 0o755);
                    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
                    assert.equal(sandboxSupported(), true, 'stub bwrap on PATH must enable Linux sandbox support');
                    wrapperFileHint = new RegExp(`${stubBwrap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
                }

                // 1) Git workflow through the product-selected wrapper.
                const gitResult = runThroughProductSandbox({
                    writableDir: target,
                    file: '/bin/bash',
                    fileArgs: ['-c', gitScript],
                    cwd: target,
                });
                assert.match(gitResult.wrapper, wrapperFileHint, 'must use product sandbox wrapper');
                assert.equal(
                    gitResult.exitCode,
                    0,
                    `sandboxed git workflow failed: ${gitResult.stdout}\n${gitResult.stderr}`,
                );
                assert.match(gitResult.stdout, /INSIDE_OK/);
                assert.match(runGit(target, 'log --oneline'), /sandboxed-commit/);

                // 2) Outside-write denial through the same product wrapper.
                const denyScript = [
                    'set +e',
                    `printf leak > ${JSON.stringify(outsideFile)} 2>/dev/null`,
                    'ec=$?',
                    'set -e',
                    'if [ -f ' + JSON.stringify(outsideFile) + ' ]; then',
                    '  echo OUTSIDE_WRITE_OK',
                    '  exit 11',
                    'fi',
                    'echo OUTSIDE_WRITE_DENIED',
                    'exit 0',
                ].join('\n');
                const denyResult = runThroughProductSandbox({
                    writableDir: target,
                    file: '/bin/bash',
                    fileArgs: ['-c', denyScript],
                    cwd: target,
                });
                assert.match(denyResult.wrapper, wrapperFileHint, 'deny path must use product sandbox wrapper');
                assert.equal(existsSync(outsideFile), false, 'outside write must not persist');
                // Real backends: child exits 0 after failed write. Stub backend:
                // may exit 12 after removing the file — both prove denial.
                assert.ok(
                    denyResult.exitCode === 0 || denyResult.exitCode === 12,
                    `unexpected deny exit ${denyResult.exitCode}: ${denyResult.stdout}\n${denyResult.stderr}`,
                );
                assert.match(
                    `${denyResult.stdout}\n${denyResult.stderr}`,
                    /OUTSIDE_WRITE_DENIED/,
                    'outside write must be reported as denied',
                );
            } finally {
                if (prevPath === undefined) delete process.env.PATH;
                else process.env.PATH = prevPath;
                rmSync(base, { recursive: true, force: true });
                rmSync(outsideDir, { recursive: true, force: true });
            }
        });
    });

    describe('resolveSubagentWorkspace', () => {
        // @covers subagent_spawn.git_clone_workspace
        // @level unit
        it('returns the original cwd when git_clone_workspace is not requested', () => {
            const cwd = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-'));
            try {
                const result = resolveSubagentWorkspace({
                    ctxCwd: cwd,
                    sandboxEnabled: true,
                    runId: 'sa_test_1',
                    runDirPath: join(cwd, 'run'),
                });
                assert.equal(result.cwd, cwd);
                assert.equal(result.requestedSandboxDir, cwd);
            } finally {
                rmSync(cwd, { recursive: true, force: true });
            }
        });

        it('keeps sandbox_dir as the workspace root when provided', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-sbx-'));
            try {
                const repo = makeRepo(base, 'repo');
                const sandboxDir = join(base, 'clone');
                const result = resolveSubagentWorkspace({
                    ctxCwd: repo,
                    cwd: repo,
                    sandboxDir,
                    gitCloneWorkspace: true,
                    sandboxEnabled: true,
                    runId: 'sa_test_2',
                    runDirPath: join(base, 'run'),
                });
                assert.equal(realpathSync(result.cwd), realpathSync(sandboxDir));
                assert.equal(realpathSync(result.requestedSandboxDir ?? ''), realpathSync(sandboxDir));
                assert.ok(lstatSync(join(result.cwd, '.git')).isDirectory());
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix subagent_spawn.git_clone_workspace
        // @covers subagent_spawn.git_clone_workspace
        // @level unit
        it('prepares a clone workspace under the run dir when sandbox_dir is omitted', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-run-'));
            try {
                const repo = makeRepo(base, 'repo');
                const runDirPath = join(base, 'run');
                const result = resolveSubagentWorkspace({
                    ctxCwd: repo,
                    cwd: repo,
                    gitCloneWorkspace: true,
                    sandboxEnabled: true,
                    runId: 'sa_test_3',
                    runDirPath,
                });
                assert.ok(realpathSync(result.cwd).startsWith(realpathSync(runDirPath)));
                assert.equal(result.requestedSandboxDir, result.cwd);
                assert.ok(lstatSync(join(result.cwd, '.git')).isDirectory());
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('does not add a sandbox dir when sandbox is disabled', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-nosbx-'));
            try {
                const repo = makeRepo(base, 'repo');
                const result = resolveSubagentWorkspace({
                    ctxCwd: repo,
                    cwd: repo,
                    gitCloneWorkspace: true,
                    sandboxEnabled: false,
                    runId: 'sa_test_4',
                    runDirPath: join(base, 'run'),
                });
                assert.equal(result.requestedSandboxDir, undefined);
                assert.ok(lstatSync(join(result.cwd, '.git')).isDirectory());
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('uses cwd as the source repo when sandbox_dir is provided without cwd', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-src-'));
            try {
                const repo = makeRepo(base, 'repo');
                const sandboxDir = join(base, 'clone');
                const result = resolveSubagentWorkspace({
                    ctxCwd: repo,
                    sandboxDir,
                    gitCloneWorkspace: true,
                    sandboxEnabled: true,
                    runId: 'sa_test_5',
                    runDirPath: join(base, 'run'),
                });
                assert.equal(realpathSync(result.cwd), realpathSync(sandboxDir));
                assert.ok(lstatSync(join(result.cwd, '.git')).isDirectory());
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });
    });

    describe('clone helpers', () => {
        it('buildGitCloneArgs encodes the AC5 reference+dissociate remote shape', () => {
            const args = buildGitCloneArgs({
                referenceRepo: '/ref/repo.git',
                cloneUrl: 'https://example.com/upstream.git',
                targetDir: '/tmp/clone',
            });
            assert.deepEqual(args, [
                'clone',
                '--reference-if-able', '/ref/repo.git',
                '--dissociate',
                'https://example.com/upstream.git',
                '/tmp/clone',
            ]);
        });

        it('resolveCloneUrl prefers origin over the local working tree path', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-clone-url-'));
            try {
                const upstream = join(base, 'upstream.git');
                runGit(base, 'init --bare upstream.git');
                const repo = join(base, 'repo');
                runGit(base, `clone ${upstream} repo`);
                const info = inspectGitWorkspace(repo);
                assert.equal(resolveCloneUrl(repo, info), runGit(repo, 'remote get-url origin'));
                assert.deepEqual(readGitRemotes(repo).map((r) => r.name), ['origin']);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });
    });
});
