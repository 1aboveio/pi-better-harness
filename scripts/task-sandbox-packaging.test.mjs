// @covers task-sandbox.packaging
// @level integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { taskSandboxCopies } from './sync-task-sandbox.mjs';

test('both task executors match their canonical shared implementation', () => {
  for (const copy of taskSandboxCopies()) assert.equal(readFileSync(copy.path, 'utf8'), copy.content, `${copy.path}: run npm run sync:task-sandbox`);
});

test('standalone consumers include the task executor and mandatory child launcher', () => {
  for (const name of ['pi-better-sandbox', 'pi-better-subagents']) {
    const [pack] = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: resolve('packages', name), encoding: 'utf8', shell: process.platform === 'win32',
    }));
    const files = new Set(pack.files.map((entry) => entry.path));
    for (const path of ['shared-task-sandbox.ts', 'shared-task-files.ts']) assert.ok(files.has(path), `${name} missing ${path}`);
    if (name === 'pi-better-subagents') {
      for (const path of ['task-runtime.mjs', 'task-guard.ts', 'task-policy.ts']) assert.ok(files.has(path), `${name} missing ${path}`);
    }
  }
});
