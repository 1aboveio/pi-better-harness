#!/usr/bin/env node
/** Monitor GitHub run state without treating terminal redraws as progress. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);

/** Keep provider transitions; omit clocks and other changing presentation data. */
export function runProgressState(run) {
  if (!run || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(run.status)) {
    throw new Error('Unreadable GitHub run status.');
  }
  return {
    status: run.status,
    conclusion: run.conclusion || null,
    jobs: (run.jobs ?? []).map(job => ({
      id: job.databaseId,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion || null,
      steps: (job.steps ?? []).map(step => ({
        number: step.number,
        name: step.name,
        status: step.status,
        conclusion: step.conclusion || null,
        startedAt: step.startedAt || null,
      })).sort((a, b) => a.number - b.number),
    })).sort((a, b) => a.id - b.id),
  };
}

export async function watchRun({ readRun, emit, wait }) {
  let previous;
  for (;;) {
    const run = await readRun();
    const state = runProgressState(run);
    const fingerprint = JSON.stringify(state);
    if (fingerprint !== previous) {
      emit(state);
      previous = fingerprint;
    }
    if (state.status === 'completed') {
      if (state.conclusion !== 'success') throw new Error(`GitHub run completed with ${state.conclusion ?? 'no conclusion'}.`);
      return state;
    }
    await wait();
  }
}

async function main(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repo', '--run', '--interval-seconds'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: --repo owner/repo --run id [--interval-seconds 30]');
    options.set(args[i], args[i + 1]);
  }
  const repo = options.get('--repo');
  const runId = options.get('--run');
  const interval = Number(options.get('--interval-seconds') ?? 30);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(runId ?? '') || !Number.isFinite(interval) || interval <= 0) {
    throw new Error('Provide a repository, numeric run id, and positive polling interval.');
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const readRun = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { stdout } = await exec('gh', ['run', 'view', runId, '--repo', repo, '--json', 'status,conclusion,jobs'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
        return JSON.parse(stdout);
      } catch (error) {
        const detail = `${error.message ?? ''} ${error.stderr ?? ''}`;
        if (attempt >= 2 || !/EOF|timed out|timeout|connection reset|temporary failure/i.test(detail)) throw error;
        await wait(1000 * (attempt + 1));
      }
    }
  };
  await watchRun({ readRun, emit: state => console.log(JSON.stringify({
    status: state.status,
    conclusion: state.conclusion,
    activeSteps: state.jobs.flatMap(job => job.steps.filter(step => step.status === 'in_progress')
      .map(step => ({ job: job.name, step: step.name, startedAt: step.startedAt }))),
    completedJobs: state.jobs.filter(job => job.status === 'completed').length,
  })), wait: () => wait(interval * 1000) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
