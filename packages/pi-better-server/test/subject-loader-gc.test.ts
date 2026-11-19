import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('subject resolver created before the report directory still captures the actual subsequent fixture loader GC', () => {
  const root = mkdtempSync(join(tmpdir(), 'subject-loader-gc-'));
  const checkout = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const resolver = new URL('../scripts/measure-full-runtime/subject-binding.mjs', import.meta.url).href;
  const fixture = new URL('../scripts/measure-full-runtime/owned-fixture.mjs', import.meta.url).href;
  try {
    const env = { ...process.env };
    delete env.PI_RESOURCE_REPORT_DIR;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { register } from 'node:module';
      import { readdirSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { registerOwnedLoader } from ${JSON.stringify(fixture)};
      register(${JSON.stringify(resolver)}, { data: ${JSON.stringify({ checkout, driverCheckout: checkout, artifactRoot: join(checkout, 'packages/pi-better-server') })} });
      process.env.PI_RESOURCE_REPORT_DIR = ${JSON.stringify(root)};
      registerOwnedLoader();
      await import('node:fs/promises');
      const files = readdirSync(process.env.PI_RESOURCE_REPORT_DIR);
      const gc = files.find(file => file.endsWith('-loader-0.gc'));
      assert.ok(gc, 'the actual loader must publish into this window, not a stale environment directory');
      const sample = JSON.parse(readFileSync(join(process.env.PI_RESOURCE_REPORT_DIR, gc), 'utf8'));
      assert.equal(sample.thread, 'loader-0');
      assert.ok(sample.physicalThreadId > 0);
      assert.ok(sample.observedAt > 0);
      console.log('actual-loader-gc-captured');
    `], { env, encoding: 'utf8', timeout: 20000 });
    assert.match(output, /actual-loader-gc-captured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
