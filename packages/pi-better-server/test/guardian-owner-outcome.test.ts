import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGuardedServerReleased } from './support/guardian-owner-outcome.ts';

test('cached guardian owner outcomes distinguish unreleased and replacement owners without accepting either live owner', t => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-owner-outcome-'));
  const output: any[][] = [];
  t.mock.method(console, 'error', (...args: any[]) => { output.push(args); });
  try {
    const checkpoint = { pid: 1234, token: 'original-owner' };
    for (const same of [true, false]) {
      const owner = { status: 'live', owner: { pid: same ? 1234 : 5678, token: same ? checkpoint.token : 'replacement-owner' } };
      const path = join(root, 'cached-owner.json');
      writeFileSync(path, JSON.stringify(owner));
      const cached = JSON.parse(readFileSync(path, 'utf8'));
      assert.throws(() => assertGuardedServerReleased(cached, checkpoint), { code: 'ERR_ASSERTION' });
      assert.equal(JSON.parse(output.at(-1)![1]).sameCheckpointOwner, same);
    }
    assertGuardedServerReleased({ status: 'missing' }, checkpoint);
    assert.equal(output.length, 2, 'verified missing owner is silent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
