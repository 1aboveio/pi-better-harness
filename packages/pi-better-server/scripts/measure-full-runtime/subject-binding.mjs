import assert from 'node:assert/strict';
import { relative, resolve as resolvePath, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let roots;
export function initialize(data) { roots = data; }

/** Only the pinned measurement driver's references are redirected; subject imports stay subject-owned. */
export function subjectModuleUrl(url, binding) {
  if (!url.startsWith('file:')) return url;
  const path = fileURLToPath(url);
  const server = join(binding.driverCheckout, 'packages/pi-better-server/src');
  const inside = (root) => { const value = relative(root, path); return value && !value.startsWith('..') && !value.startsWith('/'); };
  if (inside(server)) return pathToFileURL(join(binding.artifactRoot, 'src', relative(server, path))).href;
  for (const name of ['pi-better-subagents', 'pi-better-background-tasks', 'operation-coordinator']) {
    const root = join(binding.driverCheckout, 'packages', name);
    if (inside(root)) return pathToFileURL(join(binding.checkout, 'packages', name, relative(root, path))).href;
  }
  return url;
}

export function parseSubjectBinding(value) {
  const binding = JSON.parse(value);
  for (const key of ['checkout', 'artifactRoot', 'driverCheckout']) assert.ok(typeof binding[key] === 'string' && resolvePath(binding[key]) === binding[key], `Explicit absolute ${key} required`);
  return binding;
}

export async function resolve(specifier, context, nextResolve) {
  // Resolve a driver's SDK through the measured artifact, not the driver's installation.
  if (specifier === '@earendil-works/pi-coding-agent' && context.parentURL?.startsWith(pathToFileURL(join(roots.driverCheckout, 'packages/pi-better-server/scripts')).href)) {
    return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(roots.artifactRoot, 'package.json')).href });
  }
  const resolved = await nextResolve(specifier, context);
  const url = subjectModuleUrl(resolved.url, roots);
  return url === resolved.url ? resolved : nextResolve(url, context);
}
