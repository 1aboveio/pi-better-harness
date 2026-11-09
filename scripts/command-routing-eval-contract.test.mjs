// Contract for the command-routing comparison.
//
// Both rules exist because of review findings on the original evaluator:
// - the baseline must be committed text, because delivery rebases these commits
//   and any hard-coded revision stops existing in a fresh clone;
// - every invocation must own an empty trace, because a reused trace file let an
//   earlier run's target call be classified as the current run's decision.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jobTracePath, loadBaseline, resetTrace } from './command-routing-eval-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evaluator = readFileSync(join(root, 'scripts/command-routing.eval.mjs'), 'utf8');

test('the evaluator baseline is committed text, not a git revision', () => {
    const { oldParent, oldWorker } = loadBaseline(join(root, 'scripts/fixtures/command-routing-baseline.json'));
    assert.ok(oldWorker.length > 100, 'the worker handoff baseline is present');
    for (const line of oldParent.split('\n')) {
        assert.ok(line.trim().length > 0, 'every baseline policy line carries text');
    }
    assert.match(oldParent, /execution policy/i, 'the baseline is the pre-change policy text');
    assert.match(evaluator, /command-routing-baseline\.json/, 'the evaluator reads the committed baseline');
    assert.doesNotMatch(evaluator, /e8848cd/, 'the evaluator must not pin a pre-delivery revision');
    assert.doesNotMatch(evaluator, /'show'/, 'the evaluator must not read policy text out of git history');
});

test('each invocation writes its own trace file', () => {
    assert.notEqual(
        jobTracePath('/tmp/x', 'long-suite-old-1', 'run-a'),
        jobTracePath('/tmp/x', 'long-suite-old-1', 'run-b'),
        'a rerun must not share the earlier trace',
    );
});

test('a stale trace cannot be classified as the current run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-eval-'));
    try {
        const path = jobTracePath(dir, 'long-suite-old-1', 'run-a');
        resetTrace(path);
        assert.equal(readFileSync(path, 'utf8'), '', 'a fresh trace starts empty');
        writeFileSync(path, `${JSON.stringify({ name: 'bash', args: { command: 'npm run test:all' }, target: true })}\n`);
        resetTrace(path);
        const calls = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        assert.deepEqual(calls, [], 'rerunning the same case does not inherit the previous decision');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// The helper tests above cannot see whether the evaluator still uses these helpers,
// so this drives the real launch and classification path through a fake `pi`.
// It fails if the evaluator stops using a run-specific trace path, or drops the
// pre-launch reset.
test('the evaluator launch path cannot inherit a stale trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-eval-launch-'));
    try {
        const fakePi = join(root, 'scripts/fixtures/command-routing-eval-fake-pi.mjs');
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'pi'), `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`, { mode: 0o755 });
        const out = join(dir, 'out');
        mkdirSync(out, { recursive: true });
        // The decision an earlier run left behind, at the legacy shared pathname.
        writeFileSync(join(out, 'long-suite-old-1.trace.jsonl'),
            `${JSON.stringify({ name: 'bash', args: { command: 'npm run test:all' }, target: true })}\n`);

        const env = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            PI_ROUTING_EVAL_PROVIDER_EXTENSION: fakePi,
            PI_ROUTING_EVAL_MODEL: 'stub/stub',
        };
        const runEvaluator = () => execFileSync(process.execPath, [join(root, 'scripts/command-routing.eval.mjs'), out],
            { cwd: root, env, stdio: 'pipe', timeout: 120_000 });

        runEvaluator();
        const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')).results;
        const job = results.find((entry) => entry.id === 'long-suite-old-1');
        assert.ok(job, 'the evaluator produced a result for the seeded case');
        assert.equal(job.choice, 'handoff', 'a stale target call must not be read as this run choice');

        const started = readdirSync(out).filter((file) => file.endsWith('.trace.jsonl.started'));
        assert.ok(started.length > 0, 'the fake child recorded what it inherited');
        for (const file of started) {
            // A missing file here means the evaluator never reset the trace, and the
            // fake child would have failed instead of reporting a choice.
            assert.equal(readFileSync(join(out, file), 'utf8'), '---\n', `${file} must start empty`);
        }

        const pathsOf = () => readdirSync(out).filter((file) => file.endsWith('.trace.jsonl.paths'))
            .flatMap((file) => readFileSync(join(out, file), 'utf8').trim().split('\n').filter(Boolean));
        const firstRun = pathsOf();
        runEvaluator();
        const allPaths = pathsOf();
        assert.equal(new Set(allPaths).size, allPaths.length,
            'each invocation must receive its own trace paths, not a reused one');
        assert.ok(allPaths.length > firstRun.length, 'the second invocation recorded its own paths');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
