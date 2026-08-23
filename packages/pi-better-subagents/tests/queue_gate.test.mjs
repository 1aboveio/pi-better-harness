/**
 * Queue and PR sandbox gate wiring for issue #42.
 * @covers sandbox.command-wrapper
 * @covers sandbox.spawn-policy
 * @level unit
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';

const queueRunner = new URL('./run_queue.sh', import.meta.url);
const ciWorkflow = new URL('../../../.github/workflows/ci.yml', import.meta.url);
const packageManifest = new URL('../package.json', import.meta.url);
const queueSmokes = [
    'test_env_inherit.sh',
    'test_web_fetch.sh',
    'test_gh_issues.sh',
    'test_headless_isolation.sh',
];

it('runs the environment inheritance scenario in the merge queue suite', async () => {
    const source = await readFile(queueRunner, 'utf8');

    assert.match(
        source,
        /"\$DIR\/test_env_inherit\.sh"/,
        'the queue suite must prove environment inheritance through its sandboxed child',
    );
});

it('runs every queue smoke through a sandboxed child work directory', async () => {
    for (const name of queueSmokes) {
        const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');

        assert.match(source, /WORK="\$RUNTIME\//, `${name} creates a dedicated sandbox work directory`);
        assert.match(source, /run_child[\s\S]*?\n\s*"\$WORK"/, `${name} passes its work directory to the child`);
    }
});

it('runs unchanged deterministic sandbox-exec checks in a macOS PR-gate lane', async () => {
    const source = await readFile(ciWorkflow, 'utf8');

    assert.match(source, /runs-on:\s*macos-latest/, 'a PR gate must run on macOS');
    // The lane invokes this package's own script rather than inlining the
    // commands, so the checks are asserted where they now live: the script.
    assert.match(
        source,
        /npm run test:macos-sandbox -w packages\/pi-better-subagents/,
        'the macOS PR gate must run this package\'s sandbox-exec lane',
    );

    const { scripts } = JSON.parse(await readFile(packageManifest, 'utf8'));
    const lane = scripts['test:macos-sandbox'];
    assert.ok(lane, 'the package must define the macOS sandbox-exec lane');
    assert.match(lane, /bash tests\/test_sandbox_applied\.sh/, 'macOS must run the existing write-inside assertion');
    assert.match(lane, /bash tests\/test_sandbox_deny_outside\.sh/, 'macOS must run the existing write-denial assertion');
    assert.match(lane, /--test tests\/sandbox_profile\.test\.mjs/, 'macOS must retain the deterministic profile regression');
});

it('runs the real bubblewrap confinement file on a Linux lane', async () => {
    const source = await readFile(ciWorkflow, 'utf8');
    const { scripts } = JSON.parse(await readFile(packageManifest, 'utf8'));

    // The Linux confinement file is deliberately outside the `tests/*.test.mjs`
    // glob, so `npm test` never reaches it. It has to be named somewhere, or
    // the Linux lane proves nothing while reporting green.
    const lane = scripts['test:linux-sandbox'];
    assert.ok(lane, 'the package must define the Linux bubblewrap lane');
    assert.match(lane, /--test tests\/linux_bubblewrap\.integration\.mjs/, 'the lane must run the real bwrap file');
    assert.match(
        source,
        /npm run test:linux-sandbox -w packages\/pi-better-subagents/,
        'CI must invoke the Linux bubblewrap lane',
    );
    assert.match(source, /apt-get install --yes bubblewrap/, 'the Linux lane must install the backend');
    assert.match(
        source,
        /require-sandbox-backend\.mjs linux-bubblewrap/,
        'the Linux lane must probe the backend so a missing one fails rather than skips',
    );
});
