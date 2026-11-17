import assert from 'node:assert/strict';
import { threadId } from 'node:worker_threads';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const modules = new Map();
const kinds = ['shared-log-utils', 'log-cursor', 'parse', 'health-observation', 'read-model'];
const workFields = ['batches', 'paths', 'stats', 'metadataReads', 'logBytes', 'logReads', 'projections', 'directories', 'metadataBytes', 'canonicalizations', 'otherReadBytes', 'otherReadCalls', 'assignmentCalls', 'displayCalls', 'healthCalls'];
let fsTotals;
export function installBaselineFsObservation() {
  assert.equal(fsTotals, undefined, 'Baseline filesystem observer already installed');
  fsTotals = { paths: 0, stats: 0, directories: 0, canonicalizations: 0, bytes: 0, reads: 0, unobserved: {} };
  const totals = fsTotals;
  let active = true;
  const require = createRequire(import.meta.url), fs = require('node:fs'), promises = require('node:fs/promises');
  const restore = [];
  const remember = (namespace, name, original) => {
    const installed = namespace[name];
    restore.push(() => {
      // A later wrapper (for example graceful-fs) may still own this export.
      if (namespace[name] === installed) namespace[name] = original;
    });
  };
  const boundTotals = () => {
    if (active) return totals;
    if (fsTotals && fsTotals !== totals) fsTotals.unobserved['retired-observer-alias'] = (fsTotals.unobserved['retired-observer-alias'] ?? 0) + 1;
    return undefined;
  };
  let fileReadDepth = 0;
  const count = (name, result, completion = false, args = []) => {
    const current = boundTotals();
    if (!current) return;
    if (name === 'readSync' && fileReadDepth) return;
    if (completion) {
      if (/readFile/.test(name) && typeof result === 'string') {
        const encoding = typeof args[1] === 'string' ? args[1] : args[1]?.encoding;
        if (!['utf8', 'utf-8'].includes(String(encoding).toLowerCase()) || result.includes('\uFFFD')) current.unobserved['file-byte-encoding'] = (current.unobserved['file-byte-encoding'] ?? 0) + 1;
      }
      if (/read/.test(name) && !/readdir|readlink/.test(name) && result !== undefined) current.bytes += typeof result === 'number' ? result : typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
      return;
    }
    current.paths++;
    if (/stat|exists|access/i.test(name)) current.stats++;
    else if (/readdir/.test(name)) current.directories++;
    else if (/realpath/.test(name)) current.canonicalizations++;
    else if (/read/.test(name) && !/readlink/.test(name)) {
      current.reads++;
    }
  };
  const wrapSync = (name, original) => {
    const wrapped = function(...args) {
      let result;
      if (name === 'readFileSync') fileReadDepth++;
      count(name);
      try { result = Reflect.apply(original, this, args); return result; }
      finally { if (name === 'readFileSync') fileReadDepth--; count(name, result, true, args); }
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    if (typeof original.native === 'function') wrapped.native = wrapSync(name, original.native);
    return wrapped;
  };
  for (const name of ['statSync', 'lstatSync', 'fstatSync', 'existsSync', 'accessSync', 'realpathSync', 'readlinkSync', 'openSync', 'closeSync', 'readdirSync', 'readFileSync', 'readSync']) {
    const original = fs[name];
    fs[name] = wrapSync(name, original);
    remember(fs, name, original);
  }
  for (const name of ['stat', 'lstat', 'access', 'realpath', 'readlink', 'readdir', 'readFile']) {
    const original = promises[name];
    promises[name] = async function(...args) {
      let result;
      count(name);
      try { result = await Reflect.apply(original, this, args); return result; }
      finally { count(name, result, true, args); }
    };
    Object.defineProperties(promises[name], Object.getOwnPropertyDescriptors(original));
    remember(promises, name, original);
  }
  for (const [namespace, names] of [[fs, ['read', 'readv', 'readvSync', 'readFile', 'stat', 'lstat', 'fstat', 'readdir', 'opendir', 'opendirSync']], [promises, ['open', 'opendir']]]) {
    for (const name of names) {
      const original = namespace[name];
      namespace[name] = function(...args) {
        const current = boundTotals();
        if (current) current.unobserved[name] = (current.unobserved[name] ?? 0) + 1;
        return Reflect.apply(original, this, args);
      };
      Object.defineProperties(namespace[name], Object.getOwnPropertyDescriptors(original));
      remember(namespace, name, original);
    }
  }
  syncBuiltinESMExports();
  return () => {
    if (!active) return;
    active = false;
    const errors = [];
    for (const reset of restore) { try { reset(); } catch (error) { errors.push(error); } }
    try { syncBuiltinESMExports(); } catch (error) { errors.push(error); }
    if (fsTotals === totals) fsTotals = undefined;
    if (errors.length) throw new AggregateError(errors, 'Baseline observer cleanup failed');
  };
}
export function registerBaselineModule(url, kind, controls) {
  assert.ok(kinds.includes(kind) && !modules.has(url), 'Ambiguous baseline module observation');
  modules.set(url, { kind, controls, counters: { bytes: 0, reads: 0, parsedEvents: 0, displayFolded: 0, healthFolded: 0 }, work: Object.fromEntries(workFields.map(key => [key, 0])) });
}
export function observeBaseline(url, key, value = 1) {
  const record = modules.get(url);
  assert.ok(record && Object.hasOwn(record.counters, key) && Number.isFinite(value) && value >= 0, 'Missing actual baseline observation');
  record.counters[key] += value;
  if (key === 'bytes') record.work.logBytes += value;
  if (key === 'reads') record.work.logReads += value;
}
export function observeBaselineWork(url, key, value = 1) {
  const record = modules.get(url);
  assert.ok(record && Object.hasOwn(record.work, key) && Number.isFinite(value) && value >= 0, 'Missing actual baseline source work');
  record.work[key] += value;
}
export function baselineObservation(expected) {
  const records = expected.map(url => modules.get(url));
  const complete = expected.length === kinds.length && new Set(expected).size === kinds.length && kinds.every(kind => records.some(record => record?.kind === kind));
  if (!complete) return { complete: false, threadId, missing: expected.filter(url => !modules.has(url)), durableCheckpoints: false };
  const sources = Object.fromEntries(records.map(record => [record.kind, { ...record.work }]));
  const known = Object.fromEntries(workFields.map(key => [key, records.reduce((sum, record) => sum + record.work[key], 0)]));
  const residual = Object.fromEntries(workFields.map(key => [key, 0]));
  if (fsTotals) {
    for (const key of ['paths', 'stats', 'directories', 'canonicalizations']) residual[key] = fsTotals[key] - known[key];
    residual.otherReadBytes = fsTotals.bytes - known.logBytes - known.metadataBytes;
    residual.otherReadCalls = fsTotals.reads - known.logReads - known.metadataReads;
    assert.ok(Object.values(residual).every(value => Number.isFinite(value) && value >= 0), 'Inconsistent baseline filesystem attribution');
  }
  sources.uncategorized = residual;
  return { complete: true, threadId, moduleUrls: expected.slice(), durableCheckpoints: false,
    hotDisplay: records.find(record => record.kind === 'parse').controls.size(),
    hotHealth: records.find(record => record.kind === 'health-observation').controls.size(),
    logReads: Object.fromEntries(Object.keys(records[0].counters).map(key => [key, records.reduce((sum, record) => sum + record.counters[key], 0)])),
    sourceWork: { kind: 'baseline-inventory', complete: Boolean(fsTotals) && Object.keys(fsTotals.unobserved).length === 0,
      unavailable: fsTotals ? { ...fsTotals.unobserved } : { 'filesystem-observer-not-installed': 1 },
      total: Object.fromEntries(workFields.map(key => [key, known[key] + residual[key]])), sources,
      definitions: { paths: 'Observed filesystem path/descriptor boundary visits, including retries and failures', stats: 'Actual stat/lstat/fstat and metadata availability probe attempts', projections: 'Original model row projection calls', uncategorized: 'Residual worker Node filesystem operations outside the five attributed module boundaries; all remain in TOTAL', totalReadBytes: 'logBytes + metadataBytes + otherReadBytes; native SQLite IO is separately retained in full process OS resource observations' } } };
}
export function evictBaselineParsers(expected, model) {
  assert.ok(baselineObservation(expected).complete, 'Eviction requires exact loaded baseline module URLs');
  for (const url of expected) modules.get(url).controls.reset?.();
  // Detail snapshots cache parseRun output; no authority or row state is cleared.
  if (model.details instanceof Map) model.details.clear();
  return baselineObservation(expected);
}

/** Observers run at original FS/parse/fold calls; reset callbacks close over the subject's own maps. */
export function instrumentBaselineModule(source, kind) {
  assert.ok(kinds.includes(kind), 'Unsupported baseline module');
  const replace = (anchor, replacement) => {
    assert.equal(source.split(anchor).length, 2, `Baseline observation anchor changed: ${kind}: ${anchor}`);
    source = source.replace(anchor, replacement);
  };
  const helper = new URL('./baseline-observation.mjs', import.meta.url).href;
  let wrappers = '';
  const visit = "observeBaselineWork(import.meta.url,'paths');";
  const fsImports = [...source.matchAll(/import \{[^}]*\} from "node:fs";/g)].map(match => match[0]);
  for (const fsImport of fsImports) {
    let observedImport = fsImport;
    for (const name of ['statSync', 'fstatSync', 'realpathSync']) if (new RegExp(`\\b${name}\\b`).test(fsImport)) {
      observedImport = observedImport.replace(new RegExp(`\\b${name}\\b`), `${name} as baseline${name}`);
      wrappers += `function ${name}(...args) { ${visit} observeBaselineWork(import.meta.url,'${name === 'realpathSync' ? 'canonicalizations' : 'stats'}'); return baseline${name}(...args); }\n`;
    }
    replace(fsImport, observedImport);
  }
  if (kind === 'read-model') {
    replace('import { readdir, readFile, stat } from "node:fs/promises";', 'import { readdir as baselineReaddir, readFile as baselineReadFile, stat as baselineStat } from "node:fs/promises";');
    wrappers += `async function readdir(...args) { ${visit} observeBaselineWork(import.meta.url,'directories'); return baselineReaddir(...args); }\n`;
    wrappers += `async function stat(...args) { ${visit} observeBaselineWork(import.meta.url,'stats'); return baselineStat(...args); }\n`;
    wrappers += `async function readFile(...args) { ${visit} const value = await baselineReadFile(...args); observeBaselineWork(import.meta.url,'metadataBytes',typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength); return value; }\n`;
    for (const [anchor, key] of [['this.counters.inventories++;', 'batches'], ['this.counters.metadataReads++;', 'metadataReads'], ['this.counters.projections++;', 'projections']]) replace(anchor, `${anchor} observeBaselineWork(import.meta.url,'${key}');`);
    replace('const assignment = project(meta, processes.get(meta.id) ?? meta.status);', "observeBaselineWork(import.meta.url,'assignmentCalls'); const assignment = project(meta, processes.get(meta.id) ?? meta.status);");
  }
  if (['shared-log-utils', 'log-cursor', 'parse'].includes(kind)) {
    replace('readSync,', 'readSync as baselineReadSync,');
    wrappers += `function readSync(...args) { ${visit} const n = baselineReadSync(...args); observeBaseline(import.meta.url,'reads'); observeBaseline(import.meta.url,'bytes',n); return n; }\n`;
  }
  if (kind === 'shared-log-utils') {
    replace('readFileSync,', 'readFileSync as baselineReadFileSync,');
    wrappers += `function readFileSync(...args) { ${visit} const value = baselineReadFileSync(...args); observeBaseline(import.meta.url,'reads'); observeBaseline(import.meta.url,'bytes',typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength); return value; }\n`;
  }
  if (kind === 'parse') {
    replace('export function parseRun(id, options = {}) {', "export function parseRun(id, options = {}) { observeBaselineWork(import.meta.url,'displayCalls');");
    replace('function foldParseEvent(state, e) {', "function foldParseEvent(state, e) { observeBaseline(import.meta.url,'displayFolded');");
    replace('return JSON.parse(line);', "const event = JSON.parse(line); observeBaseline(import.meta.url,'parsedEvents'); return event;");
  }
  if (kind === 'health-observation') {
    replace('export function extractChildEventFactsFromLog(id, opts = {}) {', "export function extractChildEventFactsFromLog(id, opts = {}) { observeBaselineWork(import.meta.url,'healthCalls');");
    replace('for (const raw of events) {', "for (const raw of events) { observeBaseline(import.meta.url,'healthFolded');");
    replace('events.push(JSON.parse(s));', "events.push(JSON.parse(s)); observeBaseline(import.meta.url,'parsedEvents');");
  }
  const controls = kind === 'parse' ? '{size:()=>parseStates.size,reset:()=>resetParseRunCursor()}'
    : kind === 'health-observation' ? '{size:()=>factLogStates.size,reset:()=>resetChildEventLogCursor()}' : '{}';
  return `import {registerBaselineModule,observeBaseline,observeBaselineWork} from ${JSON.stringify(helper)};\n${source}\n${wrappers}\nregisterBaselineModule(import.meta.url,${JSON.stringify(kind)},${controls});\n`;
}

export function baselineModuleUrls(workerUrl) {
  return kinds.map(kind => new URL(kind === 'read-model' ? './read-model.ts' : `./domain/${kind}.mjs`, workerUrl).href);
}

export function instrumentBaselineQueue(source) {
  const anchor = 'capacity: this.options.capacity ?? 64, waitMs:';
  assert.equal(source.split(anchor).length, 2, 'Baseline queue observation anchor changed');
  return source.replace(anchor, 'oldestQueuedAgeMs: this.queue.length ? Math.max(...this.queue.map(query => performance.now() - query.enqueued)) : 0, ' + anchor);
}
