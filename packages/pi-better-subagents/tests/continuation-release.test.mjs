import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectContinuationRuntime } from '../continuation-runtime.ts';
import { assertContinuationExtensions } from '../continuation.ts';

function fixture(t) {
  const install = realpathSync(mkdtempSync(join(tmpdir(), 'continuation-release-')));
  t.after(() => rmSync(install, { recursive: true, force: true }));
  const create = id => {
    const root = join(install, 'releases', id.repeat(64));
    const domain = join(root, 'src/runtime/domain/subagents');
    mkdirSync(domain, { recursive: true });
    mkdirSync(join(root, 'node/bin'), { recursive: true });
    mkdirSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist'), { recursive: true });
    const build = { contentId: id.repeat(64), protocolVersion: 1, piSdkVersion: '0.82.0', nodeVersion: '24.14.1', platform: `${process.platform}-${process.arch}` };
    writeFileSync(join(root, 'runtime.json'), JSON.stringify({ format: 1, root, installRoot: install, build, node: join(root, 'node/bin/node'), entrypoint: join(root, 'src/cli.ts'), manifestPath: join(root, 'runtime.json') }));
    for (const name of ['child-steer.ts', 'child-ownership.ts', 'child-operations.ts', 'task-runtime.mjs', 'managed-worker.mjs']) {
      writeFileSync(join(domain, name), `console.log(${JSON.stringify(id)})`);
    }
    writeFileSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'), '');
    writeFileSync(join(root, 'node/bin/node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    chmodSync(join(root, 'node/bin/node'), 0o700);
    const args = ['--no-extensions', '--extension', join(domain, 'child-steer.ts'), '--extension', join(domain, 'child-ownership.ts')];
    return { root, domain, args };
  };
  return { old: create('a'), current: create('b') };
}

test('an upgrade resumes the saved release, including Node, worker, SDK and extensions', t => {
  const { old, current } = fixture(t);
  const recipe = { baseExtensionArgs: old.args, extensionArgs: old.args };
  const runtime = selectContinuationRuntime({ currentDir: current.domain, recipe });
  assert.equal(runtime.root, old.root);
  assert.deepEqual(runtime.mapArgs(current.args), old.args);
  assert.doesNotThrow(() => assertContinuationExtensions('old', recipe, runtime.mapArgs(current.args), []));
  const command = runtime.command({ file: '/unused/node', fileArgs: [join(current.domain, 'task-runtime.mjs'), join(current.root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'), '/policy.json'] });
  assert.equal(command.file, join(old.root, 'node/bin/node'));
  assert.equal(command.fileArgs[1], join(old.root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
  assert.equal(command.fileArgs[2], '/policy.json');
  const child = spawnSync(process.platform === 'win32' ? process.execPath : command.file, command.fileArgs, { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'a', 'must execute the old worker, not just relabel its recipe');
  assert.equal(runtime.mapPath(join(current.domain, 'child-operations.ts')), join(old.domain, 'child-operations.ts'));
  assert.deepEqual(runtime.mapArgs(['--model', join(current.root, 'literal-prompt')]), ['--model', join(current.root, 'literal-prompt')]);
  assert.deepEqual(recipe.baseExtensionArgs, old.args);
});

test('runtime pinning does not authorize a changed custom extension', t => {
  const { old, current } = fixture(t);
  const recipe = { baseExtensionArgs: [...old.args, '--extension', '/custom/original.ts'] };
  const runtime = selectContinuationRuntime({ currentDir: current.domain, recipe });
  assert.throws(() => assertContinuationExtensions('old', recipe, runtime.mapArgs([...current.args, '--extension', '/custom/replacement.ts']), []), /implementations changed/);
});

test('missing or incompatible saved releases refuse before launch without falling back', t => {
  const { old, current } = fixture(t);
  const recipe = { baseExtensionArgs: old.args };
  const path = join(old.root, 'runtime.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.build.protocolVersion = 2;
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => selectContinuationRuntime({ currentDir: current.domain, recipe }), /incompatible/);
  rmSync(old.root, { recursive: true });
  assert.throws(() => selectContinuationRuntime({ currentDir: current.domain, recipe }), /unavailable/);
});

test('an explicit release reference cannot select another installation', t => {
  const { old, current } = fixture(t);
  assert.throws(() => selectContinuationRuntime({currentDir: current.domain, recipe: {
    runtimeRoot: join(old.root, '..', '..', 'foreign', 'c'.repeat(64)), baseExtensionArgs: old.args,
  }}), /not a sibling managed release/);
});

test('ordinary local extensions retain strict identity and new tasks use the current release', t => {
  const { current } = fixture(t);
  assert.equal(selectContinuationRuntime({ currentDir: current.domain }), undefined);
  assert.equal(selectContinuationRuntime({ currentDir: '/repo/subagents', recipe: { baseExtensionArgs: ['--extension', '/custom/a.ts'] } }), undefined);
});
