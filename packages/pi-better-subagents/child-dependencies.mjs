/** Declared child dependency closure. Reading a contract never initializes its extension. */
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BUILTIN_PROVIDER_EXTENSIONS, providerOf } from './extensions.mjs';

export function packageRoot(path) {
  let dir = statSync(path).isDirectory() ? path : dirname(path);
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return realpathSync(dir);
}

/** Search the declaring package's dependencies first, then the caller's installed roots. */
export function installedPackage(name, roots) {
  for (const root of roots.filter(Boolean)) {
    let dir = root;
    while (true) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
}

export async function loadContract(path) {
  // Use the host's TS loader, with fresh module state for every declaration read.
  const sdkRequire = createRequire(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const { createJiti } = await import(pathToFileURL(sdkRequire.resolve('jiti')).href);
  return createJiti(import.meta.url, { tryNative: false, fsCache: false, moduleCache: false })
    .import(path, { default: true });
}

function strings(value, label) {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x.trim()))
    throw new Error(`Invalid child declaration: ${label} must be an array of nonempty strings.`);
  return value;
}
export function validateRequirements(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid childRequirements result.');
  strings(value.providers, 'providers');
  if (!Array.isArray(value.modelGroups)) throw new Error('Invalid childRequirements modelGroups.');
  for (const group of value.modelGroups) {
    if (!group || typeof group.provider !== 'string' || !group.provider.trim()) throw new Error('Invalid model group provider.');
    strings(group.ids, 'modelGroups.ids');
    if (group.prefix !== undefined && (typeof group.prefix !== 'string' || !group.prefix)) throw new Error('Invalid model group prefix.');
    if (!group.ids.length && !group.prefix) throw new Error('Empty child model group.');
  }
  return value;
}

export function fingerprint(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

// Credential refresh and catalog caches are runtime state, not dependency configuration.
const CONFIG_INPUTS = ['settings.json', 'harness-settings.json', 'model-router.json', 'models.json'];
export function configSnapshot(directories) {
  return directories.map(dir => ({ dir, files: CONFIG_INPUTS.map(name => ({ name, hash: fingerprint(join(dir, name)) })) }));
}

export async function resolveChildClosure({ resolution, model, virtual = false, config = {}, resolvePath,
  load = loadContract, configPaths = [] }) {
  const result = { ...resolution, specs: [], reasons: { ...resolution.reasons }, paths: {}, declarations: [],
    providers: [], modelGroups: [], fingerprints: configPaths.map(path => ({ path, hash: fingerprint(path) })) };
  if (resolution.mode !== 'isolated') {
    if (virtual) throw new Error(`Virtual model ${model} requires isolated mode with a declared supplier; ${resolution.mode} mode is unsupported.`);
    return { ...result, specs: resolution.specs, paths: Object.fromEntries(resolution.specs.map(spec => {
      const path = resolvePath(spec);
      if (!path) throw new Error(`Child dependency ${spec} is not installed.`);
      return [spec, path];
    })) };
  }
  const providerMap = { ...BUILTIN_PROVIDER_EXTENSIONS, ...(config.providerExtensions ?? {}) };
  const active = [], done = new Set();
  let ownsVirtual = false;
  const visit = async (spec, from) => {
    const path = resolvePath(spec, from);
    if (!path) throw new Error(`Child dependency ${spec}${from ? ` required by ${from}` : ''} is not installed.`);
    const root = packageRoot(path);
    const identity = root ?? realpathSync(path);
    if (active.includes(identity)) throw new Error(`Child dependency cycle: ${[...active, identity].join(' -> ')}`);
    if (done.has(identity)) return;
    active.push(identity);
    // Two packages may declare the same relative spec against different roots.
    const key = result.paths[spec] && result.paths[spec] !== path ? path : spec;
    result.specs.push(key); result.paths[key] = path;
    if (root) {
      const manifestPath = join(root, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      result.fingerprints.push({ path: manifestPath, hash: fingerprint(manifestPath) });
      const declaration = manifest.pi ?? {};
      for (const dependency of strings(declaration.childDependencies ?? [], 'pi.childDependencies')) await visit(dependency, root);
      if (declaration.childRequirements !== undefined) {
        if (typeof declaration.childRequirements !== 'string' || isAbsolute(declaration.childRequirements)) throw new Error(`Invalid childRequirements path in ${root}`);
        const entry = resolve(root, declaration.childRequirements);
        if (!entry.startsWith(root + '/')) throw new Error(`childRequirements escapes ${root}`);
        const fn = await load(entry);
        if (typeof fn !== 'function') throw new Error(`childRequirements in ${root} has no default function.`);
        const requirements = await fn({ model });
        result.fingerprints.push({ path: entry, hash: fingerprint(entry) });
        result.declarations.push({ entry, requirements: requirements ?? null });
        if (requirements !== undefined) {
          validateRequirements(requirements);
          if ((resolution.reasons[spec] ?? []).includes(`provider:${providerOf(model)}`)) ownsVirtual = true;
          result.providers.push(...requirements.providers);
          result.modelGroups.push(...requirements.modelGroups);
          for (const provider of requirements.providers) {
            const mapped = providerMap[provider];
            for (const supplier of typeof mapped === 'string' ? [mapped] : mapped ?? []) await visit(supplier, root);
          }
        }
      }
    }
    active.pop(); done.add(identity);
  };
  for (const spec of resolution.specs) await visit(spec);
  if (virtual && !ownsVirtual) throw new Error(`Virtual model ${model} has no mapped supplier with a childRequirements contract for this selection.`);
  result.providers = [...new Set(result.providers)];
  return result;
}

/** Both passes start with declared roots; expanded specs retain their declaring context only inside a traversal. */
export async function resolveChildLaunch(options, trustedPaths = []) {
  const resolution = await resolveChildClosure(options);
  const fullResolution = await resolveChildClosure({ ...options, resolution: {
    ...options.resolution, specs: [...options.resolution.specs, ...new Set(trustedPaths)],
  } });
  return { resolution, fullResolution };
}

/** Validate actual child registration, never the parent's catalog. Groups require one physical candidate. */
export async function checkChildPreflight(plan, { registry, tools, model }, load = loadContract) {
  if (plan.configSnapshot && JSON.stringify(configSnapshot(plan.configSnapshot.map(item => item.dir))) !== JSON.stringify(plan.configSnapshot))
    throw new Error('Child configuration drift: agent or project JSON configuration changed. Launch again.');
  for (const item of plan.fingerprints) if (fingerprint(item.path) !== item.hash)
    throw new Error(`Child configuration/declaration drift: ${item.path}. Launch again with current configuration.`);
  for (const declaration of plan.declarations) {
    const fn = await load(declaration.entry);
    const current = await fn({ model: plan.model });
    if (JSON.stringify(current ?? null) !== JSON.stringify(declaration.requirements))
      throw new Error(`Child requirements changed: ${declaration.entry}. Launch again.`);
  }
  if (plan.model && (!model || `${model.provider}/${model.id}` !== plan.model)) throw new Error(`Selected child model ${plan.model} is missing or changed.`);
  const available = registry.getAvailable();
  if (plan.model && !available.some(m => `${m.provider}/${m.id}` === plan.model))
    throw new Error(`Selected child model ${plan.model} is not available; check its provider and credentials.`);
  for (const provider of plan.providers) if (!available.some(m => m.provider === provider && m.api !== 'pi-virtual'))
    throw new Error(`Child requires available provider ${provider}; check its extension and credentials.`);
  for (const group of plan.modelGroups) if (!available.some(m => m.provider === group.provider && m.api !== 'pi-virtual' &&
    (group.ids.includes(m.id) || (group.prefix && m.id.startsWith(group.prefix)))))
    throw new Error(`Child has no available candidate for ${group.provider}: ${group.ids.join(', ')}${group.prefix ? ` (prefix ${group.prefix})` : ''}. Check extension, models and credentials.`);
  for (const tool of plan.tools) if (!tools.includes(tool)) throw new Error(`Child requested tool ${tool} is unavailable.`);
}
