import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildNativeCapture } from '../scripts/measure-full-runtime/build-darwin-capture.mjs';

test('prestarted subject resolver publishes fresh loader GC in the native process clock domain', t => {
  const root = mkdtempSync(join(tmpdir(), 'subject-loader-gc-'));
  const checkout = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const resolver = new URL('../scripts/measure-full-runtime/subject-binding.mjs', import.meta.url).href;
  const probe = new URL('../scripts/measure-full-runtime/probe.mjs', import.meta.url).href;
  try {
    const binding = buildNativeCapture(root);
    const env = { ...process.env };
    delete env.PI_RESOURCE_REPORT_DIR;
    delete env.PI_RESOURCE_CLOCK_BINDING;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { createRequire, register } from 'node:module';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      register(${JSON.stringify(resolver)}, { data: ${JSON.stringify({ checkout, driverCheckout: checkout, artifactRoot: join(checkout, 'packages/pi-better-server') })} });
      // This is the driver's order: the loader already exists when the addon path is published.
      process.env.PI_RESOURCE_REPORT_DIR = ${JSON.stringify(root)};
      process.env.PI_RESOURCE_CLOCK_BINDING = ${JSON.stringify(binding.path)};
      writeFileSync(join(process.env.PI_RESOURCE_REPORT_DIR, 'generation'), '1');
      const { continuousNs } = createRequire(import.meta.url)(process.env.PI_RESOURCE_CLOCK_BINDING);
      const cutoff = BigInt(continuousNs());
      await import(${JSON.stringify(probe)});
      const sample = JSON.parse(readFileSync(join(process.env.PI_RESOURCE_REPORT_DIR, process.pid + '.json'), 'utf8'));
      const end = BigInt(continuousNs());
      assert.equal(sample.identity.pid, process.pid);
      assert.equal(sample.generation, '1');
      assert.deepEqual(sample.gcThreads.expected, ['loader-0']);
      assert.equal(sample.gcThreads.records.length, 1);
      const [loader] = sample.gcThreads.records;
      assert.equal(loader.thread, 'loader-0');
      assert.ok(loader.physicalThreadId > 0);
      assert.ok(loader.observedAt > 0);
      for (const [name, stamp] of [['process', sample.observedContinuousNs], ['loader', loader.observedContinuousNs]]) {
        assert.equal(typeof stamp, 'string', name + ' lacks observedContinuousNs');
        assert.ok(BigInt(stamp) >= cutoff && BigInt(stamp) <= end, name + ' is outside the native clock bounds');
      }
      assert.equal(sample.gcThreads.complete, true);
      console.log(JSON.stringify({ pid: process.pid, cutoff: String(cutoff), process: sample.observedContinuousNs,
        loader: loader.observedContinuousNs, physicalThreadId: loader.physicalThreadId, complete: sample.gcThreads.complete }));
    `], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(JSON.parse(output).complete, true);
    t.diagnostic(output.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
