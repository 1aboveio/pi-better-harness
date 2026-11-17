import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { requiredWindows, validatePairedReports } from './paired-report.mjs';
import { baseline } from './incremental-workload.mjs';

/** Fixed-host sequential campaign; no checkout/build/authority changes or synthetic baseline fallback. */
export async function runCampaign(config, { run = executeWindow, save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2)); } } = {}) {
  assert.ok(config?.approved?.fixedHostId && config.outputDirectory, 'Approved host/source/artifact/fixture identities required');
  for (const side of ['before','after']) {
    const approved = config.approved[side];
    assert.ok(/^[a-f0-9]{40}$/.test(approved?.head ?? '') && ['sourceSha256','artifactContentId'].every(key => /^[a-f0-9]{64}$/.test(approved?.[key] ?? '')), 'Approved source and artifact identity missing');
  }
  assert.equal(config.approved.before.head, baseline, 'Original baseline identity changed');
  assert.ok(/^[a-f0-9]{64}$/.test(config.approved.fixtureSha256 ?? ''), 'Approved fixture identity missing');
  const result = { status: 'running', nativeQualification: 'notRun', before: [], after: [], steps: [] };
  const persist = () => save(join(config.outputDirectory, 'campaign.json'), result);
  for (const side of ['before', 'after']) {
    assert.ok(config[side]?.checkout && config.approved[side], `${side} source/artifact missing; original AC7 applies, no zero baseline`);
    for (const workload of requiredWindows) {
      const step = { side, workload, status: 'running' }; result.steps.push(step); persist();
      try {
        const report = await run({ side, workload, checkout: config[side].checkout,
          approved: config.approved, outputDirectory: config.outputDirectory, durationMs: 600000 });
        assert.ok(!report.failure && report.incremental?.durationMs >= 600000, 'Missing or short actual workload');
        assert.equal(report.source?.head, config.approved[side].head, 'Observed source differs from approved source');
        assert.equal(report.source?.manifest?.sha256, config.approved[side].sourceSha256, 'Observed source manifest differs');
        assert.equal(report.measurement?.artifact?.contentId, config.approved[side].artifactContentId, 'Observed artifact differs');
        assert.equal(report.measurement?.fixtureSha256, config.approved.fixtureSha256, 'Observed fixture differs');
        result[side].push(report); step.status = 'captured'; persist();
      } catch (error) { step.status = 'failed'; step.error = String(error); result.status = 'failed'; persist(); throw error; }
    }
  }
  result.comparison = validatePairedReports(result.before, result.after, config.approved);
  result.status = result.comparison.qualified ? 'qualified' : 'unqualified';
  for (const step of result.steps) step.status = result.comparison.qualified ? 'qualified' : 'unqualified';
  result.nativeQualification = result.comparison.qualified ? 'qualified' : 'notQualified'; persist();
  assert.ok(result.comparison.qualified, 'Actual paired campaign did not satisfy unchanged qualification criteria');
  return result;
}

async function executeWindow({ side, workload, checkout, approved, outputDirectory, durationMs }) {
  const script = join(resolve(checkout), 'packages/pi-better-server/scripts/measure-full-runtime.mjs');
  assert.ok(existsSync(script), `${side} fixture absent: original AC7 remains applicable; backport an approved identical measurement fixture, never fabricate missing baseline metrics`);
  mkdirSync(outputDirectory, { recursive: true });
  const output = join(outputDirectory, `${side}-${workload.history}-${workload.clients}-${workload.group}.json`);
  await new Promise((resolveDone, reject) => {
    const child = fork(script, [], { cwd: checkout, execArgv: ['--import', 'tsx'], stdio: 'inherit', env: { ...process.env,
      PI_INCREMENTAL_WORKLOAD: '1', PI_INCREMENTAL_MUTATIONS: '1', PI_INCREMENTAL_DURATION_MS: String(durationMs),
      PI_INCREMENTAL_HISTORY: String(workload.history), PI_INCREMENTAL_CLIENTS: String(workload.clients), PI_INCREMENTAL_GROUP: String(workload.group),
      PI_FULL_RUNTIME_HOST_ID: approved.fixedHostId, PI_FULL_RUNTIME_REPORT: output } });
    child.once('error', reject); child.once('exit', (code, signal) => code === 0 && !signal ? resolveDone() : reject(Error(`Actual ${side} window failed: ${code ?? signal}`)));
  });
  return JSON.parse(readFileSync(output, 'utf8'));
}
