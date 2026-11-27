import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { privateRuntimeNode } from './private-runtime-node.ts';

test('ordinary SDK and real remote presentation adapters share managed ownership and isolate recipients', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mixed-adapter-')), reportPath = join(directory, 'report.json');
  let report: any;
  try {
    await promisify(execFile)(privateRuntimeNode().node, ['--import', 'tsx', fileURLToPath(new URL('../scripts/measure-full-runtime.mjs', import.meta.url))], {
      timeout: 80000, env: { ...process.env, PI_FULL_RUNTIME_MATRIX_ONLY: '1', PI_FULL_RUNTIME_REPORT: reportPath, PI_TEST_PRIVATE_RUNTIME_NODE: privateRuntimeNode().node },
    });
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.mode, 'mixed-adapter-smoke-not-performance');
    assert.equal(report.failure, undefined);
    assert.equal(report.mixed.isolation, true);
    assert.notEqual(report.mixed.recipient, report.mixed.otherRecipient);
    assert.equal(report.mixed.localExtensionHandlers, false);
    assert.match(report.mixed.exactRecipientReceipt, /^background-terminal:op_/);
    const roles = new Set(report.scenarios[0].resources.map((row: any) => row.role));
    for (const role of ['server','guardian','worker','pi','remote-adapters-and-measurement','remote-runner','remote-command']) assert.ok(roles.has(role), `missing real process role ${role}`);
    assert.ok(report.scenarios[0].connections.coordinator <= 2);
  } finally {
    if (!report) { try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch {} }
    if (report?.root) rmSync(report.root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
