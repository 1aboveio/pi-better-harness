import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTaskTools } from '../subagent-tools.ts';
import { assertContinuationExtensions, ContinuationError } from '../continuation.ts';

test('trusted tool revocation narrows continuation while implementation replacement still refuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'continuation-permissions-'));
  try {
    const a = join(root, 'trusted-a.ts'), b = join(root, 'trusted-b.ts');
    writeFileSync(a, 'export default function() {}'); writeFileSync(b, 'export default function() {}');
    const baseArgs = ['--no-extensions', '--extension', '/runtime/provider.ts'];
    const plan = ({ network = true, enabled = true, implementation = a } = {}) => planTaskTools({
      requested: ['read', 'web_fetch'], builtins: ['read'], network,
      settings: { applyPatch: false, trusted: enabled ? [{name: 'web_fetch', package: implementation}] : [] },
      registered: [], toolExtensions: { web_fetch: implementation }, resolvePath: spec => spec,
    });
    const initial = plan();
    assert.equal(initial.trusted.length, 1);
    const recipe = { baseExtensionArgs: baseArgs, trustedExtensions: initial.trusted,
      extensionArgs: [...baseArgs, '--extension', a] };
    const original = structuredClone(recipe);
    for (const options of [{network: false}, {enabled: false}]) {
      const narrowed = plan(options);
      assert.equal(narrowed.trusted.length, 0);
      assert.equal(narrowed.refused[0].name, 'web_fetch');
      assert.doesNotThrow(() => assertContinuationExtensions('prior', recipe, baseArgs, narrowed.trusted));
    }
    assert.doesNotThrow(() => assertContinuationExtensions('prior', recipe, baseArgs, plan().trusted),
      're-granting the original implementation remains valid');
    assert.throws(() => assertContinuationExtensions('prior', recipe, baseArgs, plan({implementation: b}).trusted), ContinuationError,
      're-granting a different implementation must not erase the original identity');
    assert.throws(() => assertContinuationExtensions('prior', recipe, ['--extension', '/runtime/other.ts'], []), ContinuationError,
      'permission revocation does not excuse changing the base runtime');
    assert.deepEqual(recipe, original, 'narrowed permission admission cannot rewrite implementation provenance');
  } finally { rmSync(root, {recursive: true, force: true}); }
});
