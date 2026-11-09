import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planWorkers } from '../worker-catalog.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'worker-catalog-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cwd = join(root, 'project');
    const userRoot = join(root, 'user');
    mkdirSync(cwd);
    function role(id, model, effort = 'high', scope = userRoot) {
        const directory = join(scope, 'agents', 'roles');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${id}.md`), `---\nschema: pi-agent/v1\nkind: role\nid: role.${id}\nname: ${id}\ndefaults:\n  model: ${model}\n  effort: ${effort}\n---\nOwn ${id} work.\n`);
    }
    role('developer', 'deepseek/deepseek-flash');
    role('explorer', 'openai/explorer', 'medium');
    role('reviewer', 'openai/reviewer', 'medium');
    const request = {
        version: 1, harness: 'pi', cwd, userRoot, foregroundModel: 'xai/grok-4.7',
        available: [
            { model: 'deepseek/deepseek-flash', supportedEfforts: ['off', 'medium', 'high', 'max'] },
            { model: 'openai/explorer', nativeModel: 'explorer-native', supportedEfforts: ['medium', 'high'] },
            { model: 'openai/reviewer', nativeModel: 'reviewer-native', supportedEfforts: ['medium', 'high'] },
            { model: 'xai/grok-4.7', nativeModel: 'grok-4.7', supportedEfforts: ['medium', 'high'] },
        ],
    };
    return { root, cwd, userRoot, request, role };
}

test('Grok coordinator uses the saved Developer model without pinning a Pi override', (t) => {
    const { request } = fixture(t);
    const plan = planWorkers(request);
    assert.equal(plan.ok, true);
    assert.equal(plan.slots.implementer.model, 'deepseek/deepseek-flash');
    assert.equal(plan.slots.implementer.effort, 'high');
    assert.equal(plan.slots.implementer.selection.model.source, 'role-default');
    assert.deepEqual(plan.slots.implementer.launch, { role: 'developer' });
    assert.deepEqual(plan.slots.diagnoser.launch, { role: 'developer' });
    assert.match(plan.slots.implementer.instructions, /Own developer work/);
});

test('explicit task overrides keep role instructions and override effort independently', (t) => {
    const { request } = fixture(t);
    request.overrides = { implementer: { model: 'deepseek/deepseek-flash@max' } };
    let plan = planWorkers(request);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.slots.implementer.launch, { role: 'developer', model: 'deepseek/deepseek-flash', thinking: 'max' });
    assert.equal(plan.slots.implementer.selection.model.source, 'invocation');
    request.overrides.implementer = { model: 'xai/grok-4.7' };
    plan = planWorkers(request);
    assert.equal(plan.slots.implementer.effort, 'high');
    assert.deepEqual(plan.slots.implementer.launch, { role: 'developer', model: 'xai/grok-4.7' });
    assert.match(plan.slots.implementer.instructions, /Own developer work/);
});

test('unavailable pins and unsupported explicit effort block the whole preflight', (t) => {
    const { request } = fixture(t);
    for (const override of [{ model: 'missing/model' }, { model: 'xai/grok-4.7', effort: 'max' }]) {
        const plan = planWorkers({ ...request, overrides: { implementer: override } });
        assert.equal(plan.ok, false);
        assert.equal(plan.slots.implementer.selection.model.explicitRequest, true);
        assert.ok(plan.diagnostics.some((item) => item.blocking));
        for (const worker of Object.values(plan.slots)) assert.equal(worker.launch, null);
    }
});

test('trusted project defaults and later catalog edits affect the next plan, not an old snapshot', (t) => {
    const { request, cwd, role } = fixture(t);
    role('developer', 'xai/grok-4.7', 'medium', join(cwd, '.pi'));
    const personal = planWorkers(request);
    assert.equal(personal.slots.implementer.model, 'deepseek/deepseek-flash');
    const project = planWorkers({ ...request, projectTrusted: true });
    assert.equal(project.slots.implementer.model, 'xai/grok-4.7');
    role('developer', 'deepseek/deepseek-flash', 'max');
    const next = planWorkers(request);
    assert.equal(next.slots.implementer.effort, 'max');
    assert.notEqual(next.catalogDigest, personal.catalogDigest);
    assert.equal(personal.slots.implementer.effort, 'high');
});

test('Codex requires an available native mapping and actual launch controls', (t) => {
    const { request } = fixture(t);
    const codex = { ...request, harness: 'codex', available: request.available.filter((item) => item.nativeModel) };
    let plan = planWorkers(codex);
    assert.equal(plan.ok, false);
    assert.equal(plan.slots.implementer.model, null);
    assert.equal(plan.slots.implementer.launch, null);
    // A model in Pi is not a Codex capability. Configure a supported host preference explicitly.
    codex.hostPreferences = { developer: { model: 'xai/grok-4.7' } };
    plan = planWorkers(codex);
    assert.equal(plan.ok, false);
    assert.ok(plan.diagnostics.some((item) => item.code === 'host-launch-unsupported'));
    codex.launchCapabilities = { model: true, effort: true, instructions: true };
    plan = planWorkers(codex);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.slots.implementer.launch, { model: 'grok-4.7', effort: 'high', instructions: 'Own developer work.\n' });
    assert.equal(plan.slots.implementer.selection.model.source, 'authoritative');
    codex.overrides = { implementer: { model: 'deepseek/deepseek-flash' } };
    plan = planWorkers(codex);
    assert.equal(plan.ok, false);
    assert.equal(plan.slots.implementer.model, null);
});

test('host preferences cannot weaken an explicit task choice or fabricate independent review', (t) => {
    const { request } = fixture(t);
    const plan = planWorkers({
        ...request, hostPreferences: { developer: { model: 'xai/grok-4.7' } },
        overrides: { implementer: { model: 'openai/reviewer' } },
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.slots.implementer.model, 'openai/reviewer');
    assert.ok(plan.diagnostics.some((item) => item.code === 'reviewer-not-independent'));
    for (const worker of Object.values(plan.slots)) assert.equal(worker.launch, null);
});

test('invalid role definitions block instead of returning an unnamed worker', (t) => {
    const { request, userRoot } = fixture(t);
    writeFileSync(join(userRoot, 'agents/roles/developer.md'), '---\nschema: pi-agent/v1\nkind: role\nid: role.developer\ndefaults:\n  effort: invalid\n---\nImplement.');
    const plan = planWorkers(request);
    assert.equal(plan.ok, false);
    assert.equal(plan.slots.implementer.launch, null);
    assert.ok(plan.diagnostics.some((item) => item.blocking));
});

test('malformed capabilities cannot claim a launchable model or effort', (t) => {
    const { request } = fixture(t);
    for (const available of [
        [{ model: 'deepseek-flash', supportedEfforts: ['high'] }],
        [{ model: 'deepseek/deepseek-flash', supportedEfforts: [] }],
        [{ model: 'deepseek/deepseek-flash', supportedEfforts: ['unknown'] }],
        [request.available[0], request.available[0]],
    ]) assert.throws(() => planWorkers({ ...request, available }), /invalid-model-capabilities/);
});

test('standalone CLI resolves shared roles without any Pi runtime installed', (t) => {
    const { request, root } = fixture(t);
    const portable = join(root, 'portable');
    mkdirSync(portable);
    for (const name of ['agent-catalog.mjs', 'worker-catalog.ts', 'model-resolution-core.ts', 'catalog-schema.ts', 'catalog-store.ts', 'catalog-resolver.ts', 'catalog-preferences.ts', 'agent-session-settings.ts', 'thinking.ts', 'tier-policy.ts', 'roles']) {
        cpSync(join(packageRoot, name), join(portable, name), { recursive: true });
    }
    writeFileSync(join(portable, 'package.json'), '{"type":"module"}');
    mkdirSync(join(portable, 'node_modules'));
    const repoRoot = resolve(packageRoot, '../..');
    for (const name of ['tsx', 'yaml', 'proper-lockfile']) {
        symlinkSync(join(repoRoot, 'node_modules', name), join(portable, 'node_modules', name), 'dir');
    }
    const result = spawnSync(process.execPath, [join(portable, 'agent-catalog.mjs')], { input: JSON.stringify(request), encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.ok, true);
    assert.equal(plan.slots.implementer.model, 'deepseek/deepseek-flash');
    assert.deepEqual(plan.slots.implementer.launch, { role: 'developer' });
    const bundle = join(root, 'bundle');
    mkdirSync(join(bundle, 'node_modules'), { recursive: true });
    symlinkSync(portable, join(bundle, 'node_modules', 'pi-better-subagents'), 'dir');
    const bundleBin = join(bundle, 'pi-agent-catalog.mjs');
    cpSync(join(repoRoot, 'packages/pi-better-harness/bin/pi-agent-catalog.mjs'), bundleBin);
    const bundled = spawnSync(process.execPath, [bundleBin], { input: JSON.stringify(request), encoding: 'utf8', cwd: root });
    assert.equal(bundled.status, 0, bundled.stderr + bundled.stdout);
    assert.deepEqual(JSON.parse(bundled.stdout).slots.implementer.launch, { role: 'developer' });
    const invalid = spawnSync(process.execPath, [join(portable, 'agent-catalog.mjs')], { input: '{broken', encoding: 'utf8', cwd: root });
    assert.equal(invalid.status, 2);
    assert.equal(JSON.parse(invalid.stdout).ok, false);
});