import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorkReadModel } from '../src/runtime/read-model.ts';
const storeUrl = new URL('../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs', import.meta.url).href;
const { openStore } = await import(storeUrl);

for (const fault of ['concurrent-commits', 'replacement']) test(`captured coordinator snapshot fences ${fault}`, { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-snapshot-'));
  const source = join(root, 'operation-coordinator.sqlite');
  openStore({ path: source }).close();
  const paths = [];
  for (let i = 0; i < 260; i++) {
    const directory = join(root, 'runs', `sa_${i}`); mkdirSync(directory, { recursive: true });
    const path = join(directory, 'meta.json'); paths.push(path);
    writeFileSync(join(directory, 'output.log'), '');
    writeFileSync(path, JSON.stringify({ id: `sa_${i}`, cwd: root, sessionId: `sa_${i}`, status: 'completed', startedAt: i }));
  }
  const model = new WorkReadModel(root, 'captured', { baseDir: root, durableDir: join(root, 'archive'), intervalMs: 60000 });
  try {
    const reader = (model as any).reader, begin = reader.beginSnapshot.bind(reader);
    let captures = 0, commits = 0;
    reader.beginSnapshot = () => {
      const snapshot = begin(); captures++;
      if (fault === 'concurrent-commits') {
        // Another actual process commits AFTER the actual read transaction pins
        // its immutable view. Every batch encounters a newer global commit.
        execFileSync(process.execPath, ['--input-type=module', '-e',
          `import { openStore } from ${JSON.stringify(storeUrl)}; const s=openStore({path:process.argv[1]}); s.setUpgradeFence(process.argv[2]); s.close();`,
          source, `commit-${captures}`], { env: process.env, stdio: 'pipe' });
        commits++;
      } else if (captures === 1) {
        const replacement = join(root, 'replacement.sqlite');
        openStore({ path: replacement }).close();
        renameSync(replacement, source);
      }
      return snapshot;
    };
    if (fault === 'replacement') {
      await (model as any).scan(paths.slice(0, 128));
      assert.equal(model.snapshot().rows.length, 0, 'foreign source generation must not publish staged rows');
      assert.equal(model.snapshot().status, 'degraded');
      assert.match(model.snapshot().reason!, /identity changed/);
    }
    for (let page = 0; page < 12 && model.snapshot().status !== 'ready'; page++) await model.reconcile(false);
    assert.equal(model.snapshot().status, 'ready', model.snapshot().reason);
    assert.equal(model.snapshot({ cwd: root, limit: 1 }).totalMatching, 260);
    assert.ok(captures <= 16, 'finite import must progress despite a commit after every capture');
    if (fault === 'concurrent-commits') assert.ok(commits >= 3, 'real commits must overlap multiple bounded import batches');
    assert.equal(model.metrics.assignments.pending, 0);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});
