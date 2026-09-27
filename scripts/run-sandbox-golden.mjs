import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'docs/tests/sandbox-compatibility.smoke.manifest.json'), 'utf8'));
const evidence = process.env.PI_SANDBOX_EVIDENCE_DIR
    ? resolve(process.env.PI_SANDBOX_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), 'sandbox-golden-evidence-'));
mkdirSync(evidence, { recursive: true });
// A failed driver must never inherit a previous run's green evidence.
for (const name of ['smoke-results.json', 'smoke-verdict.json']) rmSync(join(evidence, name), { force: true });
const startedAt = new Date().toISOString();
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
let paths = [], failure;
try {
    assert.equal(manifest.profiles['pr-local'].mutationPolicy, 'isolated-writes');
    const ids = manifest.paths.map(p => p.id);
    assert.ok(ids.length > 0 && new Set(ids).size === ids.length, 'Manifest needs unique nonempty paths');
    for (const p of manifest.paths) assert.ok(p.observable && p.profiles.includes('pr-local'));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sandbox-compatibility.golden.mjs'], {
        cwd: root, env: { ...process.env, PI_SANDBOX_EVIDENCE_DIR: evidence },
        encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    writeFileSync(join(evidence, 'driver.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    const results = JSON.parse(readFileSync(join(evidence, 'smoke-results.json'), 'utf8'));
    paths = results.paths;
    assert.ok(Array.isArray(paths));
    assert.deepEqual(paths.map(p => p.id).sort(), [...ids].sort(), 'Driver and curated manifest disagree');
    assert.equal(result.status, 0, result.error?.message ?? 'Golden driver failed');
    assert.ok(paths.every(p => p.status === 'pass'), 'One or more paths failed or are blocked');
} catch (error) { failure = error.message; }
const verdict = {
    verdict: failure ? 'DEAD' : 'ALIVE', profile: 'pr-local', target: 'local',
    platform: process.platform, revision, startedAt, generatedAt: new Date().toISOString(),
    paths, ...(failure ? { failure } : {}),
};
writeFileSync(join(evidence, 'smoke-verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
console.log(`Sandbox compatibility: ${verdict.verdict}; evidence: ${evidence}`);
if (failure) { console.error(failure); process.exitCode = 1; }
