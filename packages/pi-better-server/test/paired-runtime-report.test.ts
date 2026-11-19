import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePairedReports } from '../scripts/measure-full-runtime/paired-report.mjs';
import { summarizeCohorts } from '../scripts/measure-full-runtime/aggregate-samples.mjs';
import { baseline } from '../scripts/measure-full-runtime/incremental-workload.mjs';

// Adversarial schema specimens only. No specimen is a measurement or can qualify:
// required matrix windows and unimplemented metric coverage are always missing.
function specimen() {
  const roles = ['server', 'guardian', 'worker', 'runner', 'command', 'remote-runner', 'remote-command', 'remote-adapters-and-measurement', 'pi', 'legacy-command', 'legacy-command'];
  const resources = roles.map((role, i) => ({ identity: { pid: i + 1, start: `start-${i}` }, role, generation: '1', at: 600100,
    cpu: { user: 2000, system: 1000 }, cpuMs: 2, rss: 100, usage: { fsRead: 2, fsWrite: 3 }, fsRead: 1, fsWrite: 2,
    window: { sampleIntervalMs: 250, diagnostics: { samples: 2400, cpuMicros: 2, sampleWallMs: 1 } } }));
  const counters = { projections: 1, assignmentProjections: 1, logProjections: 1, healthProjections: 1,
    logReads: { bytes: 10, reads: 1, parsedEvents: 1, displayFolded: 1, healthFolded: 1 },
    sourceWork: Object.fromEntries(['entity', 'repair'].map(k => [k, { batches: 1, paths: 1, stats: 1, metadataReads: 1, logBytes: 1, logReads: 1 }])),
    executor: { restarts: 0, worker: 'running' }, assignments: { generation: 'generation-a' } };
  const tasks = Array.from({ length: 48 }, (_, i) => ({ id: `task-${i}`, finalText: 'schema-only', costUSD: 1, input: 1, output: 1 }));
  return { mode: 'resource-matrix', source: { kind: 'git-checkout', head: baseline, dirty: '', manifest: { sha256: 'a'.repeat(64) } },
    measurement: { schemaVersion: 1, fixedHostId: 'schema-host', hostname: 'schema-hostname', artifact: { contentId: 'b'.repeat(64) }, fixtureSha256: 'c'.repeat(64),
      diagnosticBudget: { samplerIntervalMs: 250, controlIntervalMs: 100, batchCapturePeriodMs: 100 },
      activeWorkload: { subagents: 1, durableCommands: 2, legacyCommands: 2, hostedSessions: 2, offline: true }, coverage: {} },
    machine: { release: 'schema-os', arch: 'arm64', cpus: 1, cpuModel: 'schema-cpu', totalMemory: 1 }, node: 'schema-node', platform: 'darwin',
    incremental: { history: 4416, clients: 1, group: 48, durationMs: 600000 }, workload: { tasks, seededLogBytes: 1 },
    incrementalWindows: [{ clients: 1, workloadBefore: { history: 4416, results: tasks }, workloadAfter: { history: 4416, results: tasks } }],
    scenarios: [{ clients: 1, startedAt: 100, endedAt: 600100, elapsedMs: 600000, resources,
      requiredProcesses: resources.map(({ identity, role }) => ({ identity: { ...identity }, role })),
      resourceBefore: resources.map(row => ({ ...row, identity: { ...row.identity }, at: 100, cpu: { user: 1000, system: 0 }, usage: { fsRead: 1, fsWrite: 1 } })),
      totalCpuMs: 22, totalRss: 1100, countersBefore: structuredClone(counters), metrics: structuredClone(counters) }] };
}
const expected = { fixedHostId: 'schema-host', fixtureSha256: 'c'.repeat(64), before: { head: baseline, sourceSha256: 'a'.repeat(64), artifactContentId: 'b'.repeat(64) },
  after: { head: baseline, sourceSha256: 'a'.repeat(64), artifactContentId: 'b'.repeat(64) } };
const has = (result: ReturnType<typeof validatePairedReports>, fragment: string, code?: string) => result.issues.some(issue => issue.path.includes(fragment) && (!code || issue.code === code));

test('external measurements cannot substitute driver identity for approved subject identity', () => {
  const value: any = specimen();
  value.subject = { checkout: '/subject', artifactRoot: '/artifact' };
  value.driver = { kind: 'git-checkout', head: 'd'.repeat(40), dirty: '', manifest: { sha256: 'e'.repeat(64) } };
  const approval = { ...expected, driver: { head: 'f'.repeat(40), sourceSha256: 'e'.repeat(64) } };
  assert.ok(has(validatePairedReports(value, value, approval), '.driver.head', 'mismatch'));
  assert.ok(has(validatePairedReports(value, value, expected), '.driver', 'missing-approved-driver'));
});

test('observed baseline parser work cannot qualify an unmeasured total source-work breakdown', () => {
  const value: any = specimen();
  for (const metrics of [value.scenarios[0].countersBefore, value.scenarios[0].metrics]) {
    metrics.baselineObservation = { complete: true, threadId: 1, moduleUrls: ['parse', 'health', 'cursor', 'tail'], durableCheckpoints: false };
  }
  assert.ok(has(validatePairedReports(value, value, expected), '.metrics', 'unavailable-source-work-breakdown'));
});

test('baseline inventory totals accept measured source sums but reject hidden work and candidate relabeling', () => {
  const before: any = specimen(), after: any = specimen();
  const zero = { batches: 0, paths: 0, stats: 0, metadataReads: 0, logBytes: 0, logReads: 0, projections: 0, directories: 0, metadataBytes: 0, canonicalizations: 0, otherReadBytes: 0, otherReadCalls: 0, assignmentCalls: 0, displayCalls: 0, healthCalls: 0 };
  const total = { ...zero, batches: 1, paths: 3, stats: 2, metadataReads: 1, logBytes: 10, logReads: 1, projections: 1 };
  for (const metrics of [before.scenarios[0].countersBefore, before.scenarios[0].metrics]) {
    metrics.inventories = 1; metrics.metadataReads = 1;
    metrics.baselineObservation = { complete: true, threadId: 1, moduleUrls: ['parse', 'health', 'cursor', 'tail', 'model'], durableCheckpoints: false,
      sourceWork: { kind: 'baseline-inventory', complete: true, total: { ...total }, sources: {
        'read-model': { ...total, logBytes: 0, logReads: 0 }, 'parse': { ...zero, logBytes: 10, logReads: 1 },
        'health-observation': { ...zero }, 'log-cursor': { ...zero }, 'shared-log-utils': { ...zero }, uncategorized: { ...zero } } } };
  }
  const observed = validatePairedReports(before, after, expected);
  assert.equal(observed.issues.some(issue => issue.path.startsWith('before') && issue.path.endsWith('.metrics')), false);
  assert.equal(observed.qualified, false, 'Schema specimens still lack native coverage and all matrix windows');
  before.scenarios[0].metrics.baselineObservation.sourceWork.total.stats++;
  assert.ok(has(validatePairedReports(before, after, expected), '.metrics', 'missing-reset-or-generation-change'));
  after.scenarios[0].metrics.baselineObservation = before.scenarios[0].countersBefore.baselineObservation;
  assert.ok(has(validatePairedReports(before, after, expected), '.metrics', 'candidate-requires-ordinary-and-repair'));
});

test('recorded primary admission refusal and malformed reports cannot qualify or yield CPU comparisons', () => {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/808-native-admission-refused.json', import.meta.url), 'utf8'));
  for (const value of [recorded, null, {}, { scenarios: [null] }, { scenarios: [{ resources: [null], resourceBefore: [null], requiredProcesses: [null] }] }]) {
    const result = validatePairedReports(value, value, expected);
    assert.equal(result.qualified, false); assert.equal(result.cpuComparison, null); assert.ok(result.issues.length);
  }
});

test('paired validator CLI rejects the retained refused run without invoking measurement code', () => {
  const report = fileURLToPath(new URL('./fixtures/808-native-admission-refused.json', import.meta.url));
  const cli = fileURLToPath(new URL('../scripts/measure-full-runtime/paired-report.mjs', import.meta.url));
  // The refusal report is also deliberately NOT an approved-identity document.
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, report, report, report], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.qualified, false); assert.equal(output.cpuComparison, null);
  assert.ok(output.issues.some((issue: any) => issue.code === 'failed-or-smoke-report'));
});

test('valid counter arithmetic does not hide incomplete windows or coverage and invent a CPU threshold', () => {
  const result = validatePairedReports(specimen(), specimen(), expected);
  assert.equal(result.qualified, false); assert.equal(result.cpuComparison, null);
  assert.ok(has(result, 'coverage.workerGc')); assert.ok(has(result, 'coverage.aggregatePeak')); assert.ok(has(result, 'coverage.queueAge'));
  assert.ok(result.issues.some(issue => issue.code === 'missing-required-window'));
  assert.ok(!has(result, '.cpuMs')); assert.ok(!has(result, '.totalCpuMs'));
  assert.equal(result.cpuThreshold.status, 'not-specified');
});

test('paired report accepts the exact native diagnostic budget on both sides', () => {
  const result = validatePairedReports(specimen(), specimen(), expected);
  assert.deepEqual(result.issues.filter(issue => issue.path.endsWith('.diagnosticBudget')), []);
});

for (const [name, invalidBudget] of [
  ['wrong batch period', { samplerIntervalMs: 250, controlIntervalMs: 100, batchCapturePeriodMs: 101 }],
  ['missing batch period', { samplerIntervalMs: 250, controlIntervalMs: 100 }],
  ['extra budget field', { samplerIntervalMs: 250, controlIntervalMs: 100, batchCapturePeriodMs: 100, extra: 1 }],
] as const) test(`paired report rejects a matching budget with ${name} on both sides`, () => {
  const [before, after] = [specimen(), specimen()].map(report => ({
    ...report, measurement: { ...report.measurement, diagnosticBudget: invalidBudget },
  }));
  const result = validatePairedReports(before, after, expected);
  assert.deepEqual(result.issues.filter(issue => issue.path.endsWith('.diagnosticBudget')), [
    { path: 'before[0].diagnosticBudget', code: 'missing-or-changed-budget' },
    { path: 'after[0].diagnosticBudget', code: 'missing-or-changed-budget' },
  ]);
});

for (const [name, change, path, code] of [
  ['host', (r: any) => { r.measurement.fixedHostId = 'other'; }, 'fixed-host', 'mismatch'],
  ['missing host', (r: any) => { delete r.measurement.fixedHostId; }, '.host', 'missing-fixed-host'],
  ['workload', (r: any) => { r.incremental.history = 10000; }, '.workload', 'missing-paired-workload'],
  ['budget', (r: any) => { r.measurement.diagnosticBudget.controlIntervalMs = 50; }, 'diagnosticBudget', 'missing-or-changed-budget'],
  ['duration', (r: any) => { r.scenarios[0].elapsedMs = 599999; }, '.elapsedMs', 'short-or-missing-duration'],
  ['missing duration', (r: any) => { delete r.scenarios[0].elapsedMs; }, '.elapsedMs', 'short-or-missing-duration'],
  ['source', (r: any) => { r.source.head = 'c'.repeat(40); }, '.source.head', 'mismatch'],
  ['artifact', (r: any) => { r.measurement.artifact.contentId = 'c'.repeat(64); }, '.artifact', 'mismatch'],
  ['fixture artifact', (r: any) => { r.measurement.fixtureSha256 = 'd'.repeat(64); }, '.fixture', 'mismatch'],
  ['counter', (r: any) => { r.scenarios[0].resources[0].cpu.user = 0; }, '.cpu', 'missing-or-reset-counter'],
  ['sum', (r: any) => { r.scenarios[0].totalCpuMs = 0; }, '.totalCpuMs', 'incorrect-aggregate'],
  ['process generation', (r: any) => { r.scenarios[0].resources[0].identity.start = 'reused-pid'; }, '.process-generation', 'mismatch'],
  ['worker generation', (r: any) => { r.scenarios[0].metrics.executor.restarts = 1; }, '.metrics', 'missing-reset-or-generation-change'],
  ['sample generation', (r: any) => { r.scenarios[0].resources[0].generation = 'other'; }, '.generation', 'wrong-sample-generation'],
  ['duplicate process', (r: any) => { r.scenarios[0].resources[1].identity = { ...r.scenarios[0].resources[0].identity }; }, '.resources', 'duplicate-process'],
  ['missing related process', (r: any) => { r.scenarios[0].resources.pop(); }, '.related-process-coverage', 'mismatch'],
  ['missing counter', (r: any) => { delete r.scenarios[0].resources[0].cpu.system; }, '.cpu', 'missing-or-reset-counter'],
  ['final result', (r: any) => { r.incrementalWindows[0].workloadAfter = { history: 4416, results: [] }; }, '.final-results', 'mismatch'],
  ['stale sample', (r: any) => { r.scenarios[0].resourceBefore[0].at = 0; r.scenarios[0].startedAt = 1000; }, '.sample-times', 'stale-or-outside-window'],
  ['short process window', (r: any) => { r.scenarios[0].resources[0].at--; }, '.sample-duration', 'short-process-window'],
] as const) test(`paired report rejects ${name}`, () => {
  const after = specimen(); change(after);
  const result = validatePairedReports(specimen(), after, expected);
  assert.ok(has(result, path, code), JSON.stringify(result.issues));
  assert.equal(result.cpuComparison, null); assert.equal(result.qualified, false);
});

test('duplicate windows and missing approved identities cannot qualify', () => {
  const report = specimen();
  const result = validatePairedReports([report, report], report);
  assert.ok(result.issues.some(issue => issue.code === 'duplicate-window'));
  assert.ok(result.issues.some(issue => issue.code === 'missing-approved-source-artifact'));
  assert.ok(result.issues.some(issue => issue.code === 'missing-approved-host'));
  assert.equal(result.cpuComparison, null);
});

test('coverage flags cannot replace observations and before duration is independently mandatory', () => {
  const before = specimen(), after = specimen();
  before.scenarios[0]!.elapsedMs = 1;
  const coverage = { workerGc: true, aggregatePeak: true, queueAge: true, eventLatency: true, recovery: true, exit: true };
  Object.assign(after.measurement.coverage, coverage);
  Object.assign(after.scenarios[0]!, Object.fromEntries(Object.keys(coverage).map(key => [key, {}])));
  const result = validatePairedReports(before, after, expected);
  assert.ok(has(result, 'before[0].scenarios[0].elapsedMs', 'short-or-missing-duration'));
  assert.ok(has(result, 'after[0].scenarios[0].coverage.workerGc', 'not-qualified'));
  assert.ok(has(result, 'after[0].scenarios[0].coverage.aggregatePeak', 'not-qualified'));
  assert.ok(has(result, 'after[0].scenarios[0].coverage.queueAge', 'not-qualified'));
  assert.equal(result.cpuComparison, null);
});

test('claimed aggregate peak is rejected unless its retained cohort stream reproduces it', () => {
  const report = specimen();
  Object.assign(report.measurement.coverage, { aggregatePeak: true });
  Object.assign(report.scenarios[0]!, { aggregatePeak: { scope: 'simultaneous-related-processes', cpuPercent: 1, rssBytes: 1, samples: 1 }, aggregateCohorts: [] });
  const result = validatePairedReports(report, report, expected);
  assert.ok(has(result, '.coverage.aggregatePeak', 'missing-or-inconsistent-cohort-stream'));
  assert.equal(result.cpuComparison, null); assert.equal(result.qualified, false);
});

test('a valid native budget does not excuse a 251 ms cohort gap', () => {
  const before = specimen();
  const window = before.scenarios[0]!;
  const { startedAt, endedAt, requiredProcesses } = window;
  const cohorts = Array.from({ length: (endedAt - startedAt) / 250 + 1 }, (_, index) =>
    requiredProcesses.map(({ identity }) => ({ identity, generation: '1', sequence: index + 1,
      at: startedAt + index * 250, cpu: { user: index, system: 0 }, rss: 100 })));
  const summarize = (frames: typeof cohorts) => summarizeCohorts(frames,
    { required: requiredProcesses, generation: '1' }, { startedAt, endedAt });
  Object.assign(before.measurement.coverage, { aggregatePeak: true });
  Object.assign(window, { aggregatePeak: summarize(cohorts), aggregateCohorts: cohorts });

  const after = structuredClone(before);
  const gappedCohorts = structuredClone(cohorts);
  for (const sample of gappedCohorts[1]!) sample.at++;
  Object.assign(after.scenarios[0]!, { aggregatePeak: summarize(gappedCohorts), aggregateCohorts: gappedCohorts });

  const result = validatePairedReports(before, after, expected);
  assert.deepEqual(result.issues.filter(issue => issue.path.endsWith('.coverage.aggregatePeak')), [
    { path: 'after[0].scenarios[0].coverage.aggregatePeak', code: 'not-qualified' },
    { path: 'after[0].scenarios[0].coverage.aggregatePeak', code: 'missing-or-inconsistent-cohort-stream' },
  ]);
  assert.equal(result.qualified, false);
  assert.equal(result.cpuComparison, null);
});

test('batch capture cannot hide unobserved external observer cost behind coverage flags', () => {
  const report = specimen() as any;
  report.scenarios[0].aggregateCohorts = [[{ cpu: { totalMicros: 1 }, sourceCohort: {
    diagnosticCost: { coverage: 'incomplete-external-child-cost', ownerCpuMicros: 1, childCpuMicros: null },
  } }]];
  const result = validatePairedReports(report, report, expected);
  assert.ok(has(result,'.diagnostics.batch','unobserved-external-capture-cost'));
  assert.equal(result.qualified,false); assert.equal(result.cpuComparison,null);
});
