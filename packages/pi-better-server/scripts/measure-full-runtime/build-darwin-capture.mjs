import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

/** Build only. On Linux this addon supplies CLOCK_BOOTTIME for the /proc reader. */
export function buildNativeCapture(outputDirectory, { includeDirectory = process.env.PI_RESOURCE_NODE_INCLUDE_DIR
  ?? resolve(dirname(process.execPath), '../include/node'), compile = execFileSync } = {}) {
  assert.ok(existsSync(join(includeDirectory, 'node_api.h')), 'Node-API headers missing; supply the approved Node header directory, no download or runtime substitution');
  const source = fileURLToPath(new URL('./darwin-capture.cc', import.meta.url));
  mkdirSync(outputDirectory, { recursive: true });
  assert.ok(['linux', 'darwin'].includes(process.platform), 'Unsupported native capture platform');
  const darwin = process.platform === 'darwin';
  const path = join(outputDirectory, darwin ? 'darwin-capture.node' : 'linux-capture-clock.node');
  assert.ok(['arm64','x64'].includes(process.arch), 'Unsupported Node architecture');
  // Keep the linker's content-based LC_UUID: canonical dyld requires it.
  const flags = darwin ? ['-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
  compile(darwin ? 'clang++' : 'c++', [...flags, '-std=c++17', '-O2', '-fvisibility=hidden', '-DNAPI_VERSION=8',
    '-I', includeDirectory, source, ...(darwin ? ['-lproc'] : []), '-o', path], { stdio: 'pipe', timeout: 30000 });
  const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  return { path, sourceSha256: sha(source), binarySha256: sha(path), napiVersion: 8 };
}

export const buildDarwinCapture = buildNativeCapture;
