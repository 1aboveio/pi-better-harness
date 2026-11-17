import assert from 'node:assert/strict';
import { threadId } from 'node:worker_threads';

const modules = new Map();
const kinds = ['shared-log-utils', 'log-cursor', 'parse', 'health-observation'];
export function registerBaselineModule(url, kind, controls) {
  assert.ok(kinds.includes(kind) && !modules.has(url), 'Ambiguous baseline module observation');
  modules.set(url, { kind, controls, counters: { bytes: 0, reads: 0, parsedEvents: 0, displayFolded: 0, healthFolded: 0 } });
}
export function observeBaseline(url, key, value = 1) {
  const record = modules.get(url);
  assert.ok(record && Object.hasOwn(record.counters, key) && Number.isFinite(value) && value >= 0, 'Missing actual baseline observation');
  record.counters[key] += value;
}
export function baselineObservation(expected) {
  const records = expected.map(url => modules.get(url));
  const complete = expected.length === kinds.length && new Set(expected).size === kinds.length && kinds.every(kind => records.some(record => record?.kind === kind));
  if (!complete) return { complete: false, threadId, missing: expected.filter(url => !modules.has(url)), durableCheckpoints: false };
  return { complete: true, threadId, moduleUrls: expected.slice(), durableCheckpoints: false,
    hotDisplay: records.find(record => record.kind === 'parse').controls.size(),
    hotHealth: records.find(record => record.kind === 'health-observation').controls.size(),
    logReads: Object.fromEntries(Object.keys(records[0].counters).map(key => [key, records.reduce((sum, record) => sum + record.counters[key], 0)])) };
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
  if (['shared-log-utils', 'log-cursor', 'parse'].includes(kind)) {
    replace('readSync,', 'readSync as baselineReadSync,');
    wrappers += `function readSync(...args) { const n = baselineReadSync(...args); observeBaseline(import.meta.url,'reads'); observeBaseline(import.meta.url,'bytes',n); return n; }\n`;
  }
  if (kind === 'shared-log-utils') {
    replace('readFileSync,', 'readFileSync as baselineReadFileSync,');
    wrappers += `function readFileSync(...args) { const value = baselineReadFileSync(...args); observeBaseline(import.meta.url,'reads'); observeBaseline(import.meta.url,'bytes',typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength); return value; }\n`;
  }
  if (kind === 'parse') {
    replace('function foldParseEvent(state, e) {', "function foldParseEvent(state, e) { observeBaseline(import.meta.url,'displayFolded');");
    replace('return JSON.parse(line);', "const event = JSON.parse(line); observeBaseline(import.meta.url,'parsedEvents'); return event;");
  }
  if (kind === 'health-observation') {
    replace('for (const raw of events) {', "for (const raw of events) { observeBaseline(import.meta.url,'healthFolded');");
    replace('events.push(JSON.parse(s));', "events.push(JSON.parse(s)); observeBaseline(import.meta.url,'parsedEvents');");
  }
  const controls = kind === 'parse' ? '{size:()=>parseStates.size,reset:()=>resetParseRunCursor()}'
    : kind === 'health-observation' ? '{size:()=>factLogStates.size,reset:()=>resetChildEventLogCursor()}' : '{}';
  return `import {registerBaselineModule,observeBaseline} from ${JSON.stringify(helper)};\n${source}\n${wrappers}\nregisterBaselineModule(import.meta.url,${JSON.stringify(kind)},${controls});\n`;
}

export function baselineModuleUrls(workerUrl) {
  return kinds.map(kind => new URL(`./domain/${kind}.mjs`, workerUrl).href);
}
