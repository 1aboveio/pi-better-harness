import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { baseline, workloadCounterDelta } from './incremental-workload.mjs';
import { summarizeCohorts } from './aggregate-samples.mjs';

export const requiredWindows = [4416, 10000].flatMap(history => [1, 5, 10].flatMap(clients =>
  [48, 96, 192].map(group => ({ history, clients, group }))));
const key = value => `${value?.history}/${value?.clients}/${value?.group}`;
const identity = value => `${value?.pid}:${value?.start}`;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Structural/evidence audit only: this cannot authenticate a machine or manufacture missing observations. */
export function validatePairedReports(beforeInput, afterInput, expected = {}) {
  const issues = [], pairs = [];
  if (!expected || typeof expected !== 'object') expected = {};
  let fixedHost;
  const issue = (path, code) => issues.push({ path, code });
  const equal = (a, b, path) => { if (!isDeepStrictEqual(a, b)) issue(path, 'mismatch'); };
  const audit = (input, side) => {
    const reports = Array.isArray(input) ? input : [input], windows = new Map();
    for (const [index, report] of reports.entries()) {
      const path = `${side}[${index}]`;
      if (!report || typeof report !== 'object') { issue(path, 'malformed-report'); continue; }
      const host = { machine: report.machine, platform: report.platform, node: report.node, id: report.measurement?.fixedHostId, hostname: report.measurement?.hostname };
      if (fixedHost) equal(host, fixedHost, path + '.fixed-host'); else fixedHost = host;
      const approved = expected[side];
      if (!approved || !/^[a-f0-9]{40}$/.test(approved.head ?? '') || !digest(approved.sourceSha256) || !digest(approved.artifactContentId)) issue(path + '.expected', 'missing-approved-source-artifact');
      equal(report.source?.head, approved?.head, path + '.source.head');
      equal(report.source?.manifest?.sha256, approved?.sourceSha256, path + '.source.manifest');
      equal(report.measurement?.artifact?.contentId, approved?.artifactContentId, path + '.artifact');
      if (report.source?.kind !== 'git-checkout' || !digest(report.source?.manifest?.sha256)) issue(path + '.source', 'missing-source-identity');
      // The approved content manifest covers source files, including untracked
      // source. Private caches/evidence outside its scope are not code changes.
      if (typeof report.source?.dirty !== 'string' || report.source.dirty.split('\n').some(line => line && !line.startsWith('?? '))) issue(path + '.source.dirty', 'unclean-source');
      if (report.mode !== 'resource-matrix' || report.failure) issue(path, 'failed-or-smoke-report');
      if (report.measurement?.schemaVersion !== 1) issue(path + '.measurement', 'unsupported-schema');
      if (typeof report.measurement?.fixedHostId !== 'string' || !report.measurement.fixedHostId.trim() || !report.measurement?.hostname) issue(path + '.host', 'missing-fixed-host');
      if (typeof expected.fixedHostId !== 'string' || !expected.fixedHostId.trim()) issue(path + '.host', 'missing-approved-host');
      else equal(report.measurement?.fixedHostId, expected.fixedHostId, path + '.approved-host');
      for (const field of ['release', 'arch', 'cpus', 'cpuModel', 'totalMemory']) if (!report.machine?.[field]) issue(path + '.machine.' + field, 'missing-machine-field');
      if (!report.node || !['darwin', 'linux'].includes(report.platform)) issue(path + '.platform', 'missing-runtime-platform');
      if (!isDeepStrictEqual(report.measurement?.diagnosticBudget, { samplerIntervalMs: 250, controlIntervalMs: 100 })) issue(path + '.diagnosticBudget', 'missing-or-changed-budget');
      if (!digest(expected.fixtureSha256) || !digest(report.measurement?.fixtureSha256)) issue(path + '.fixture', 'missing-fixture-identity');
      else equal(report.measurement.fixtureSha256, expected.fixtureSha256, path + '.fixture');
      if (!report.measurement?.activeWorkload || !report.workload?.tasks?.length || !report.incremental) issue(path + '.workload', 'missing-workload');
      equal(report.measurement?.activeWorkload, { subagents: 1, durableCommands: 2, legacyCommands: 2, hostedSessions: 2, offline: true }, path + '.active-workload');
      if (!Array.isArray(report.scenarios) || !report.scenarios.length) { issue(path + '.scenarios', 'missing-windows'); continue; }
      for (const [n, scenario] of report.scenarios.entries()) {
        const p = `${path}.scenarios[${n}]`;
        if (!scenario || typeof scenario !== 'object') { issue(p, 'malformed-window'); continue; }
        const workload = { history: report.incremental?.history, group: report.incremental?.group, clients: scenario.clients }, windowKey = key(workload);
        if (windows.has(windowKey)) issue(p, 'duplicate-window');
        windows.set(windowKey, { report, scenario, path: p });
        if (!requiredWindows.some(value => key(value) === windowKey) || scenario.clients !== report.incremental?.clients) issue(p, 'unexpected-workload');
        if (!finite(scenario.elapsedMs) || scenario.elapsedMs < 600000 || !finite(report.incremental?.durationMs) || report.incremental.durationMs < 600000) issue(p + '.elapsedMs', 'short-or-missing-duration');
        if (!finite(scenario.startedAt) || !finite(scenario.endedAt) || scenario.endedAt - scenario.startedAt < 600000 || Math.abs(scenario.endedAt - scenario.startedAt - scenario.elapsedMs) > 250) issue(p + '.timestamps', 'invalid-window');
        const resources = scenario.resources, starts = scenario.resourceBefore, required = scenario.requiredProcesses;
        if (![resources, starts, required].every(value => Array.isArray(value) && value.length)) { issue(p + '.resources', 'missing-process-inventory'); continue; }
        if ([resources, starts, required].some(list => list.some(value => !value || typeof value !== 'object'))) { issue(p + '.resources', 'malformed-process'); continue; }
        const ids = list => list.map(value => identity(value.identity)).sort();
        for (const list of [resources, starts, required]) {
          if (new Set(ids(list)).size !== list.length) issue(p + '.resources', 'duplicate-process');
          if (list.some(value => !Number.isSafeInteger(value.identity?.pid) || value.identity.pid <= 0 || typeof value.identity.start !== 'string' || !value.identity.start)) issue(p + '.resources', 'invalid-process-identity');
        }
        equal(ids(resources), ids(starts), p + '.process-generation'); equal(ids(required), ids(resources), p + '.related-process-coverage');
        const roles = required.map(value => value.role);
        for (const role of ['server', 'guardian', 'worker', 'runner', 'command', 'remote-runner', 'remote-command', 'remote-adapters-and-measurement']) if (roles.filter(value => value === role).length !== 1) issue(p + '.roles.' + role, 'missing-or-duplicate-role');
        if (roles.filter(value => value === 'pi').length !== scenario.clients || roles.filter(value => value === 'legacy-command').length !== 2) issue(p + '.roles', 'wrong-process-count');
        if (roles.some(role => !['server', 'guardian', 'worker', 'runner', 'command', 'remote-runner', 'remote-command', 'remote-adapters-and-measurement', 'pi', 'legacy-command'].includes(role))) issue(p + '.roles', 'unknown-role');
        for (const value of resources) {
          const prior = starts.find(row => identity(row.identity) === identity(value.identity));
          if (!prior) continue;
          if (value.generation !== String(scenario.clients) || prior.generation !== value.generation) issue(p + '.generation', 'wrong-sample-generation');
          equal(value.role, required.find(row => identity(row.identity) === identity(value.identity))?.role, p + '.resource-role');
          for (const field of ['user', 'system']) if (!finite(prior.cpu?.[field]) || !finite(value.cpu?.[field]) || value.cpu[field] < prior.cpu[field]) issue(p + '.cpu', 'missing-or-reset-counter');
          const cpuMs = ((value.cpu?.user - prior.cpu?.user) + (value.cpu?.system - prior.cpu?.system)) / 1000;
          if (!finite(value.cpuMs) || !finite(cpuMs) || Math.abs(cpuMs - value.cpuMs) > 0.000001) issue(p + '.cpuMs', 'incorrect-process-total');
          for (const [delta, counter] of [['fsRead', 'fsRead'], ['fsWrite', 'fsWrite']]) if (!finite(value[delta]) || !finite(prior.usage?.[counter]) || !finite(value.usage?.[counter]) || value.usage[counter] - prior.usage[counter] !== value[delta]) issue(p + '.' + delta, 'missing-or-reset-counter');
          if (!finite(value.rss)) issue(p + '.rss', 'missing-counter');
          if (!finite(value.at) || !finite(prior.at) || prior.at > scenario.startedAt || value.at < scenario.endedAt - 250 || scenario.startedAt - prior.at > 500 || value.at - scenario.endedAt > 500) issue(p + '.sample-times', 'stale-or-outside-window');
          if (!finite(value.at) || !finite(prior.at) || value.at - prior.at < 600000) issue(p + '.sample-duration', 'short-process-window');
          if (!finite(value.window?.diagnostics?.samples) || value.window.diagnostics.samples < 1 || !finite(value.window?.diagnostics?.cpuMicros) || !finite(value.window?.diagnostics?.sampleWallMs)) issue(p + '.diagnostics', 'missing-sampler-cost');
          if (value.window?.sampleIntervalMs !== 250) issue(p + '.diagnostics', 'changed-process-sampler-budget');
        }
        for (const [total, field] of [['totalCpuMs', 'cpuMs'], ['totalRss', 'rss']]) if (!finite(scenario[total]) || resources.some(value => !finite(value[field])) || Math.abs(resources.reduce((sum, value) => sum + value[field], 0) - scenario[total]) > 0.000001) issue(p + '.' + total, 'incorrect-aggregate');
        try { workloadCounterDelta(scenario.countersBefore, scenario.metrics); } catch { issue(p + '.metrics', 'missing-reset-or-generation-change'); }
        const reconciliation = Array.isArray(report.incrementalWindows) ? report.incrementalWindows.find(value => value?.clients === scenario.clients) : undefined;
        if (!reconciliation?.workloadBefore || !reconciliation?.workloadAfter) issue(p + '.reconciliation', 'missing-final-results');
        else {
          equal(reconciliation.workloadBefore, reconciliation.workloadAfter, p + '.final-results');
          const final = reconciliation.workloadAfter;
          if (final.history !== workload.history || !Array.isArray(final.results) || final.results.length !== workload.group) issue(p + '.reconciliation', 'wrong-final-counts');
          if (!Array.isArray(report.workload?.tasks) || report.workload.tasks.length !== workload.group
            || new Set(report.workload.tasks.map(task => task?.id)).size !== workload.group
            || report.workload.tasks.some(task => !task || typeof task.id !== 'string' || typeof task.finalText !== 'string' || ![task.costUSD, task.input, task.output].every(finite))) issue(p + '.workload.tasks', 'invalid-task-inventory');
          else {
            const wanted = report.workload.tasks.map(({ id, finalText, costUSD, input, output }) => ({ id, finalText, costUSD, input, output }));
            equal(final.results, wanted, p + '.reconciliation.tasks');
          }
        }
        // The current collector explicitly lacks these observations. Flags alone cannot fill them.
        const peak = scenario.aggregatePeak;
        if (report.measurement?.coverage?.aggregatePeak !== true || peak?.scope !== 'simultaneous-related-processes' || !finite(peak.cpuPercent) || !finite(peak.rssBytes) || !Number.isSafeInteger(peak.samples) || peak.samples < 1) issue(p + '.coverage.aggregatePeak', 'not-qualified');
        const rebuiltPeak = summarizeCohorts(scenario.aggregateCohorts, { required, generation: String(scenario.clients) }, { startedAt: scenario.startedAt, endedAt: scenario.endedAt });
        if (!rebuiltPeak.qualified || !isDeepStrictEqual(peak, rebuiltPeak)) issue(p + '.coverage.aggregatePeak', 'missing-or-inconsistent-cohort-stream');
        const gc = scenario.workerGc;
        if (report.measurement?.coverage?.workerGc !== true || gc?.threadCoverage !== 'all' || !Array.isArray(gc.processes)
          || gc.processes.some(value => !value?.identity || !finite(value.count) || !finite(value.durationMs))
          || !isDeepStrictEqual(ids(gc.processes), ids(resources))) issue(p + '.coverage.workerGc', 'not-qualified');
        for (const field of ['queueAge', 'eventLatency', 'recovery', 'exit']) {
          const value = scenario[field];
          if (report.measurement?.coverage?.[field] !== true || !Number.isSafeInteger(value?.samples) || value.samples < 1
            || !['p50', 'p95', 'p99', 'max'].every(name => finite(value[name]))
            || value.p50 > value.p95 || value.p95 > value.p99 || value.p99 > value.max) issue(p + '.coverage.' + field, 'not-qualified');
        }
      }
    }
    for (const window of requiredWindows) if (!windows.has(key(window))) issue(side + '.' + key(window), 'missing-required-window');
    return windows;
  };
  const before = audit(beforeInput, 'before'), after = audit(afterInput, 'after');
  if (expected.before?.head !== baseline) issue('before.expected.head', 'wrong-baseline');
  for (const [windowKey, a] of before) {
    const b = after.get(windowKey); if (!b) { issue(windowKey + '.workload', 'missing-paired-workload'); continue; }
    equal(a.report.machine, b.report.machine, windowKey + '.machine');
    for (const field of ['fixedHostId', 'hostname', 'fixtureSha256', 'diagnosticBudget', 'activeWorkload']) equal(a.report.measurement?.[field], b.report.measurement?.[field], windowKey + '.' + field);
    for (const field of ['platform', 'node', 'incremental']) equal(a.report[field], b.report[field], windowKey + '.' + field);
    equal(a.report.workload?.tasks, b.report.workload?.tasks, windowKey + '.task-workload');
    equal(a.report.workload?.seededLogBytes, b.report.workload?.seededLogBytes, windowKey + '.seededLogBytes');
    pairs.push({ window: windowKey, beforeCpuMs: a.scenario.totalCpuMs, afterCpuMs: b.scenario.totalCpuMs });
  }
  // Source808/796 specify duration and complete reporting, not a numeric CPU reduction target.
  return { schemaVersion: 1, qualified: issues.length === 0, issues,
    cpuComparison: issues.length ? null : pairs,
    cpuThreshold: { status: 'not-specified', reason: 'Original source has no numeric CPU improvement threshold; none inferred from component timings.' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , beforePath, afterPath, expectedPath] = process.argv;
    if (!beforePath || !afterPath || !expectedPath) throw new Error('Usage: paired-report.mjs BEFORE.json AFTER.json APPROVED-IDENTITIES.json');
    const read = path => JSON.parse(readFileSync(path, 'utf8'));
    const result = validatePairedReports(read(beforePath), read(afterPath), read(expectedPath));
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.qualified ? 0 : 1;
  } catch (error) { console.log(JSON.stringify({ qualified: false, error: String(error) })); process.exitCode = 1; }
}
