import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeCapture } from '../scripts/measure-full-runtime/build-darwin-capture.mjs';

test('native build inputs retain platform flags and exact byte identities without compilation', () => {
  const root = mkdtempSync(join(tmpdir(), '808-darwin-inputs-'));
  const includeDirectory = join(root, 'include'); mkdirSync(includeDirectory);
  writeFileSync(join(includeDirectory, 'node_api.h'), 'component header marker; never compiled');
  const source = fileURLToPath(new URL('../scripts/measure-full-runtime/darwin-capture.cc', import.meta.url));
  // Opaque compiler-boundary specimen only, never a native addon or capture observation.
  const specimen = Buffer.from('component compiler output bytes; not Mach-O');
  try {
    const darwin = process.platform === 'darwin';
    const result = buildNativeCapture(root, { includeDirectory, compile: (command, args, options) => {
      assert.equal(command, darwin ? 'clang++' : 'c++');
      if (darwin) {
        assert.equal(args.includes('-Wl,-no_uuid'), false, 'canonical dyld requires the default LC_UUID load command');
        assert.equal(args.includes('-Wl,-random_uuid'), false, 'retain content-based UUID generation');
        assert.equal(args[args.indexOf('-arch') + 1], process.arch === 'arm64' ? 'arm64' : 'x86_64');
      }
      const linkFlags = darwin ? ['-bundle', 'dynamic_lookup', '-lproc'] : ['-shared', '-fPIC'];
      for (const flag of [...linkFlags, '-std=c++17', '-O2', '-fvisibility=hidden', '-DNAPI_VERSION=8']) assert.ok(args.includes(flag));
      assert.equal(args[args.indexOf('-I') + 1], includeDirectory);
      assert.ok(args.includes(source));
      assert.deepEqual(options, { stdio: 'pipe', timeout: 30000 });
      writeFileSync(args[args.indexOf('-o') + 1]!, specimen);
    } });
    assert.equal(result.path, join(root, darwin ? 'darwin-capture.node' : 'linux-capture-clock.node'));
    assert.equal(result.sourceSha256, createHash('sha256').update(readFileSync(source)).digest('hex'));
    assert.equal(result.binarySha256, createHash('sha256').update(specimen).digest('hex'));
    assert.equal(result.napiVersion, 8);
    const failure = new Error('component compiler failure');
    assert.throws(() => buildNativeCapture(root, { includeDirectory, compile: () => { throw failure; } }), error => error === failure);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
