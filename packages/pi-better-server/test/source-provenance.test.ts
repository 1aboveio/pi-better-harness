import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { sourceProvenance } = await import(new URL('../scripts/source-provenance.mjs', import.meta.url).href);

test('copied source reports unknown Git identity and a reproducible content manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-copy-'));
  try {
    mkdirSync(join(root, 'packages'));
    writeFileSync(join(root, 'packages', 'sample.ts'), 'export const value = 1;');
    const first = sourceProvenance(root);
    assert.equal(first.head, null); assert.equal(first.dirty, null);
    assert.equal(first.kind, 'source-copy-without-git');
    assert.equal(first.manifest.files, 1);
    const scratch = join(root, 'packages', 'server', '.work', 'crash');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'operation-coordinator.sqlite-shm'), 'temporary runtime state');
    assert.deepEqual(sourceProvenance(root), first);
    writeFileSync(join(root, 'packages', 'sample.ts'), 'export const value = 2;');
    assert.notEqual(sourceProvenance(root).manifest.sha256, first.manifest.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
