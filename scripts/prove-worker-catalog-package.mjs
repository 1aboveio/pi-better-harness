/** Offline acceptance check: install the packed CLI without Pi peers and resolve workers. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageHarnessDependencies } from './stage-harness-dependencies.mjs';

const root = mkdtempSync(join(tmpdir(), 'worker-catalog-package-'));
const bundle = process.argv.includes('--bundle');
const packageName = bundle ? 'pi-better-harness' : 'pi-better-subagents';
const packageRoot = fileURLToPath(new URL(`../packages/${packageName}/`, import.meta.url));
try {
    if (bundle) stageHarnessDependencies({ ignoreScripts: true });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], {
        cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }))[0];
    const installation = join(root, 'installation');
    execFileSync('npm', ['install', '--prefix', installation, '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', join(root, packed.filename)], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const request = {
        version: 1, harness: 'pi', cwd: root, userRoot: join(root, 'empty-user'), projectTrusted: false,
        available: ['openai/gpt-6.1-sol', 'openai/gpt-6-luna', 'openai/gpt-6-astra'].map((model) => ({
            model, supportedEfforts: ['medium', 'high'],
        })),
    };
    const plan = JSON.parse(execFileSync(process.execPath, [join(installation, 'node_modules/.bin/pi-agent-catalog')], {
        cwd: root, input: JSON.stringify(request), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }));
    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    assert.deepEqual(plan.slots.implementer.launch, { role: 'developer' });
    assert.equal(plan.slots.implementer.model, 'openai/gpt-6.1-sol');
    assert.equal(plan.slots.implementer.selection.model.source, 'role-default');
    console.log(`Packed ${packageName} CLI installation passed: role defaults resolved without Pi peers or network access.`);
} finally {
    rmSync(root, { recursive: true, force: true });
}