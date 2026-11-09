import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExtensions } from '../extensions.mjs';
import { resolveChildClosure, resolveChildLaunch, checkChildPreflight, installedPackage, configSnapshot } from '../child-dependencies.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'child-deps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = (name, pi = {}) => {
    const path = join(root, 'node_modules', name); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, pi })); return path;
  };
  const resolvePath = (spec, from) => installedPackage(spec.replace(/^npm:/, ''), [from, root]);
  return { root, pkg, resolvePath };
}
const requirements = { providers: ['deepseek', 'ollama-cloud'], modelGroups: [
  { provider: 'deepseek', ids: ['deepseek-chat'] }, { provider: 'ollama-cloud', ids: ['glm'], prefix: 'glm-' },
] };
const selection = () => resolveExtensions({ tools: 'read,bash', model: 'router/auto' });

test('loads TypeScript declarations with the host loader and no extension initialization', async t => {
  const f = fixture(t);
  const router = f.pkg('pi-better-model-router', { childRequirements: './requirements.ts', extensions: ['./index.ts'] });
  f.pkg('pi-ollama-cloud');
  writeFileSync(join(router, 'index.ts'), 'throw new Error("extension initialized during discovery");');
  writeFileSync(join(router, 'requirements.ts'), `export default function({model}: {model: string}) { return model === 'router/auto' ? ${JSON.stringify(requirements)} : undefined; }`);
  const plan = await resolveChildClosure({ resolution: selection(), model: 'router/auto', virtual: true, resolvePath: f.resolvePath });
  assert.deepEqual(plan.providers, ['deepseek', 'ollama-cloud']);
  assert.ok(plan.specs.includes('npm:pi-ollama-cloud'));
  writeFileSync(join(router, 'requirements.ts'), 'export default () => undefined;');
  await assert.rejects(checkChildPreflight({ ...plan, model: 'router/auto', tools: [] }, env()), /declaration drift/);
});

test('recursive static and dynamic closure includes router and Ollama without extension init', async t => {
  const f = fixture(t);
  f.pkg('pi-better-model-router', { childDependencies: ['npm:helper'], childRequirements: './requirements.ts' });
  f.pkg('helper', { childDependencies: ['npm:leaf'] }); f.pkg('leaf'); f.pkg('pi-ollama-cloud');
  const calls = [];
  const plan = await resolveChildClosure({ resolution: selection(), model: 'router/auto', virtual: true,
    resolvePath: f.resolvePath, load: async path => { calls.push(path); return () => requirements; } });
  assert.deepEqual(plan.specs, ['npm:pi-better-model-router', 'npm:helper', 'npm:leaf', 'npm:pi-ollama-cloud']);
  assert.equal(calls.length, 1); assert.match(calls[0], /requirements.ts$/);
  assert.equal(plan.modelGroups[1].prefix, 'glm-');
});

test('launch closure keeps nested-only suppliers and relative dependencies in their declaring context in both passes', async t => {
  const f = fixture(t);
  const router = f.pkg('pi-better-model-router', { childDependencies: ['./relative'], childRequirements: './requirements.ts' });
  const nested = join(router, 'node_modules', 'pi-ollama-cloud');
  const relative = join(router, 'relative');
  for (const path of [nested, relative]) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'package.json'), '{}'); }
  const trusted = f.pkg('trusted');
  const resolvePath = (spec, from) => spec === trusted ? trusted : spec.startsWith('./') ? join(from, spec) : f.resolvePath(spec, from);
  const options = { resolution: selection(), model: 'router/auto', virtual: true, resolvePath,
    load: async () => () => requirements };
  const { resolution, fullResolution } = await resolveChildLaunch(options, [trusted]);
  for (const result of [resolution, fullResolution]) {
    assert.equal(result.paths['npm:pi-ollama-cloud'], realpathSync(nested));
    assert.equal(result.paths['./relative'], join(realpathSync(router), 'relative'));
  }
  assert.equal(fullResolution.paths[trusted], trusted);
  assert.equal(f.resolvePath('npm:pi-ollama-cloud'), undefined, 'supplier exists only under its declaring router');
});

test('cycle and missing transitive suppliers fail with their source', async t => {
  const f = fixture(t); const resolution = selection();
  f.pkg('pi-better-model-router', { childDependencies: ['npm:helper'] });
  await assert.rejects(resolveChildClosure({ resolution, resolvePath: f.resolvePath }), /helper.*required by.*router.*not installed/);
  f.pkg('helper', { childDependencies: ['npm:pi-better-model-router'] });
  await assert.rejects(resolveChildClosure({ resolution, resolvePath: f.resolvePath }), /cycle:.*router.*helper.*router/);
});

test('virtual selected models require a mapped declaring owner', async t => {
  const f = fixture(t); f.pkg('pi-better-model-router');
  await assert.rejects(resolveChildClosure({ resolution: selection(), model: 'router/auto', virtual: true, resolvePath: f.resolvePath }), /no mapped supplier/);
  await assert.rejects(resolveChildClosure({ resolution: resolveExtensions({ config: { inheritExtensions: true } }), model: 'router/auto', virtual: true, resolvePath: f.resolvePath }), /inherit mode is unsupported/);
  await assert.rejects(resolveChildClosure({ resolution: resolveExtensions({ model: 'unknown/auto' }), model: 'unknown/auto', virtual: true, resolvePath: f.resolvePath }), /no mapped supplier/);
});

test('bundled dependency lookup finds nested harness packages', t => {
  const f = fixture(t); const harness = f.pkg('pi-better-harness');
  const nested = join(harness, 'node_modules', 'pi-better-model-router'); mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'package.json'), '{}');
  assert.equal(installedPackage('pi-better-model-router', [harness]), realpathSync(nested));
});

test('builtin-only isolated and clean children do not gain provider extensions', async t => {
  const f = fixture(t);
  for (const clean of [false, true]) {
    const plan = await resolveChildClosure({ resolution: resolveExtensions({ tools: 'read,bash', model: 'openai/gpt', clean }), resolvePath: f.resolvePath });
    assert.deepEqual(plan.specs, []);
  }
});

const models = [{ provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions' },
  { provider: 'ollama-cloud', id: 'glm-new', api: 'openai-completions' }];
const env = (available = models, tools = ['read', 'bash']) => ({ registry: { getAvailable: () => [{ provider: 'router', id: 'auto', api: 'pi-virtual' }, ...available] }, tools,
  model: { provider: 'router', id: 'auto' } });
const plan = () => ({ model: 'router/auto', tools: ['read', 'bash'], fingerprints: [], declarations: [], ...requirements });

test('child preflight accepts actual prefix candidate and rejects missing provider, candidate, tools and model', async () => {
  await checkChildPreflight(plan(), env());
  await assert.rejects(checkChildPreflight(plan(), env(models.slice(0, 1))), /provider ollama-cloud/);
  await assert.rejects(checkChildPreflight(plan(), env([models[0], { ...models[1], id: 'other' }])), /no available candidate.*ollama-cloud/);
  await assert.rejects(checkChildPreflight(plan(), env(models, ['read'])), /tool bash/);
  await assert.rejects(checkChildPreflight(plan(), { ...env(), model: models[0] }), /Selected child model/);
});

test('preflight rejects changed config files and dynamic declaration output', async t => {
  const f = fixture(t); const path = join(f.root, 'model-router.json'); writeFileSync(path, '{}');
  const frozen = { ...plan(), configSnapshot: configSnapshot([f.root]) };
  writeFileSync(join(f.root, 'auth.json'), '{"refreshed":true}');
  writeFileSync(join(f.root, 'models-store.json'), '{"refreshed":true}');
  await checkChildPreflight(frozen, env());
  writeFileSync(path, '{"changed":true}');
  await assert.rejects(checkChildPreflight(frozen, env()), /configuration drift/);
  const declared = { ...plan(), declarations: [{ entry: path, requirements }] };
  await assert.rejects(checkChildPreflight(declared, env(), async () => () => ({ ...requirements, providers: [] })), /requirements changed/);
});
