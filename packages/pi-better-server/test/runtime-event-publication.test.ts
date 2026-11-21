import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { measureEventPublication } = await import(new URL('../scripts/event-publication/measure.mjs', import.meta.url).href);

test('external committed changes reach exact real socket subscribers within the healthy publication budget', { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync('/tmp/p751-events-')), agent = join(root, 'agent'), transport = join(root, 's');
  const taskId = 'sa_event_publication', run = join(root, 'pi-better-subagents/runs', taskId), metaPath = join(run, 'meta.json');
  mkdirSync(agent); mkdirSync(run, { recursive: true });
  writeFileSync(metaPath, JSON.stringify({ id: taskId, cwd: root, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
    sessionId: 'worker', callbackOrigin: { cwd: root, sessionId: 'parent' }, name: 'original' }));
  const daemon = fork(new URL('./support/work-daemon.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'],
    env: { ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    const [ready] = await once(daemon, 'message');
    for (const subscribers of [1, 5, 10]) {
      const report = await measureEventPublication({ socketPath: ready.ready, agentDir: agent, scope: { cwd: root, sessionId: 'parent', limit: 10 },
        metaPath, taskId, subscribers, commits: 3 });
      assert.equal(report.ms.samples, subscribers * 3);
      assert.ok(report.ms.p50 >= 0);
      assert.ok(report.ms.max <= 1000, JSON.stringify(report));
      console.log(JSON.stringify({ eventPublication: report }));
    }
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit'); daemon.send('stop');
      const timer = setTimeout(() => daemon.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
