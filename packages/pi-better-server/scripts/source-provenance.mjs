import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Content identity remains available in compatibility copies without Git metadata. */
export function sourceProvenance(workspace) {
  let head = null, dirty = null;
  // A parent repository must not accidentally identify an unpacked source tree.
  if (existsSync(join(workspace, '.git'))) {
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8', stdio: 'pipe' }).trim();
      dirty = execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch { head = null; dirty = null; }
  }
  const files = [];
  const walk = relative => {
    for (const entry of readdirSync(join(workspace, relative), { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const directory of ['packages', 'scripts']) if (existsSync(join(workspace, directory))) walk(directory);
  for (const file of ['package.json', 'package-lock.json']) if (existsSync(join(workspace, file))) files.push(file);
  const manifest = files.sort().map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(workspace, path))).digest('hex') }));
  return { head, dirty, kind: head ? 'git-checkout' : 'source-copy-without-git',
    manifest: { algorithm: 'sha256', scope: 'packages and scripts excluding node_modules/dist/coverage, plus root package manifests',
      files: manifest.length, sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') } };
}
