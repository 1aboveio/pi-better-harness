import assert from 'node:assert/strict';
import { measureEventPublication } from './event-publication/measure.mjs';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, cpus, release, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert.ok(['darwin', 'linux'].includes(process.platform), 'This measurement requires macOS or Linux');
const { WorkClient } = await import(`${workspace}/packages/pi-better-server/src/runtime/work-client.mjs`);
const sdkEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
const sdkCli = fileURLToPath(new URL('./cli.js', sdkEntry));
const sdkVersion = JSON.parse(readFileSync(new URL('../package.json', sdkEntry), 'utf8')).version;
const children = new Set();
let requestId = 0;
function waitMessage(child, check, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`IPC timeout for ${child.pid}`)); }, timeout);
    const message = value => { if (check(value)) { cleanup(); resolve(value); } };
    const exit = code => { cleanup(); reject(new Error(`Child ${child.pid} exited ${code}`)); };
    function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', exit); }
    child.on('message', message); child.once('exit', exit);
  });
}
async function sample(child) {
  const id = ++requestId;
  const result = waitMessage(child, m => m.type === 'resource-sample' && m.id === id);
  child.send({ type: 'resource-sample', id });
  return result;
}
async function refreshProvider(child) {
  const id = ++requestId;
  const result = waitMessage(child, message => message.type === 'provider-refreshed' && message.id === id);
  child.send({ type: 'provider-refresh', id });
  const response = await result;
  assert.equal(response.error, undefined, response.error);
  return response.rows;
}
function track(child) { children.add(child); child.once('exit', () => children.delete(child)); return child; }
async function stop(child, graceful = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (graceful) child.send('stop'); else child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited; clearTimeout(timer);
}
function distribution(values) {
  const sorted = [...values].sort((a,b) => a-b);
  const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { samples: sorted.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) };
}
const report = { source: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }).trim() }, machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), osRelease: release() }, platform: process.platform, arch: process.arch, node: process.version,
  sdk: sdkVersion, scope: 'Real Pi RPC processes with standalone Subagents, control RPC at 10 Hz, seeded read-only work records; no guardian in slice #753.', scenarios: [] };
const output = process.env.PI_SHARED_READ_REPORT ?? join(tmpdir(), 'pi-shared-read-resources.json');
const phase = (step, history, clients = 0) => { report.phase = { step, history, clients }; };
try {
  for (const history of [4416, 10000]) {
    phase('seed-history', history);
    const root = realpathSync(mkdtempSync('/tmp/p751-res-'));
    const agent = join(root, 'agent'), transport = join(root, 's'), runs = join(root, 'pi-better-subagents/runs');
    const durable = join(agent, 'subagents'), archives = join(durable, 'attempts');
    const sessionId = 'b005eb3d-66af-4b8b-88b7-0dd4971de123';
    const sessionPath = join(root, 'shared-observer.jsonl');
    writeFileSync(sessionPath, JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: root }) + '\n');
    mkdirSync(runs, { recursive: true }); mkdirSync(archives, { recursive: true });
    for (let i = 0; i < history; i++) {
      const id = `sa_resource_history_${i}`;
      writeFileSync(join(archives, `${id}.json`), JSON.stringify({ version: 1, meta: {
        id, cwd: root, status: 'completed', startedAt: i, endedAt: i + 1, sessionId: id, callback: false,
        recipe: { version: 1, sessionId: id, cwd: root, sessionDir: join(durable, 'sessions') } } }));
    }
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent,
      PI_SERVER_DIR: transport, PI_SUBAGENT_DURABLE_DIR: durable, TMPDIR: root, TMP: root, TEMP: root,
      PI_OFFLINE: '1', PI_CATALOG_ACCEPTANCE_PROBE: '1', PI_SANDBOX_RECOVERY_SNAPSHOT: 'off' };
    const work = track(fork(new URL('./measure-shared-reads/probe.mjs', import.meta.url), [], { env, execArgv: [], stdio: ['ignore','ignore','inherit','ipc'] }));
    for (let i = 0; i < 2; i++) {
      const id = `sa_resource_active_${i}`; mkdirSync(join(runs, id));
      writeFileSync(join(runs, id, 'meta.json'), JSON.stringify({ id, cwd: root, status: 'running',
        pid: work.pid, spawnPid: process.pid, startedAt: Date.now(), sessionId: id, callback: false, callbackOrigin: { cwd: root, sessionId }, name: `resource-work-${i}` }));
    }
    const server = track(fork(new URL('./measure-shared-reads/daemon.mjs', import.meta.url), [], { env, execArgv: [], stdio: ['ignore','ignore','inherit','ipc'] }));
    phase('start-server', history);
    const ready = await waitMessage(server, m => m.type === 'ready');
    const control = new WorkClient(ready.socket, agent); await control.ready;
    const pis = [];
    const rebuildLatencies = [];
    const rebuildStarted = performance.now();
    phase('initial-snapshot', history);
    const initial = control.get({ cwd: root, active: true });
    let indexed = await initial;
    while (indexed.status !== 'ready') {
      phase('rebuild-status', history);
      assert.ok(performance.now() - rebuildStarted < 30000, `Rebuild did not recover: ${indexed.reason}`);
      const began = performance.now(); await control.request('runtime_get_status'); rebuildLatencies.push(performance.now() - began);
      await delay(20); phase('rebuild-snapshot', history); indexed = await control.get({ cwd: root, active: true });
    }
    const rebuildMs = performance.now() - rebuildStarted;
    assert.ok(rebuildLatencies.every(ms => ms < 250), 'status RPC must respond within 250 ms during index rebuild');
    assert.equal(indexed.activity.active, 2);
    phase('history-count', history);
    assert.equal((await control.get({ cwd: root, active: false, limit: 1 })).totalMatching, history);
    for (const count of [1, 5, 10]) {
      phase('start-pi-clients', history, count);
      while (pis.length < count) {
        const pi = track(fork(sdkCli, ['--mode','rpc','--offline','--session',sessionPath,'--no-extensions',
          '--extension',join(workspace,'packages/pi-better-subagents/index.ts'),
          '--no-skills','--no-prompt-templates','--no-themes'], {
          cwd: root, env, execArgv: ['--import', new URL('./measure-shared-reads/probe.mjs', import.meta.url).href], stdio: ['pipe','pipe','pipe','ipc'] }));
        let stderr = ''; pi.stderr.on('data', chunk => { stderr += chunk; });
        pi.rpc = (type = 'get_state') => new Promise((resolve, reject) => {
          const id = `measure-${++requestId}`;
          const timer = setTimeout(() => { cleanup(); reject(new Error(`Pi RPC timeout: ${stderr}`)); }, 15000);
          let buffer = '';
          const read = chunk => { buffer += chunk; for (;;) {
            const end = buffer.indexOf('\n'); if (end < 0) break;
            const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
            try { const message = JSON.parse(line); if (message.id === id) { cleanup(); resolve(message); return; } } catch {}
          } };
          function cleanup() { clearTimeout(timer); pi.stdout.off('data', read); }
          pi.stdout.on('data', read); pi.stdin.write(JSON.stringify({ id, type }) + '\n');
        });
        await pi.rpc(); pis.push(pi);
      }
      phase('warmup', history, count);
      await delay(1200);
      const providerDeadline = performance.now() + 15000;
      let providerRows;
      do {
        providerRows = await Promise.all(pis.map(refreshProvider));
        if (providerRows.every(rows => rows >= 2)) break;
        assert.ok(performance.now() < providerDeadline, `Actual provider did not observe active work: ${providerRows}`);
        await delay(100);
      } while (true);
      await control.get({ cwd: root, active: true });
      const before = await control.request('runtime_get_metrics');
      report.lastMetrics = before;
      phase('measurement-window', history, count);
      const subjects = [...pis, server, work];
      const start = await Promise.all(subjects.map(sample));
      const began = performance.now(), latencies = [];
      const windowMs = count === 10 && history === 10000 ? 60000 : 3000;
      while (performance.now() - began < windowMs) {
        const sent = performance.now(); await Promise.all(pis.map(async pi => { await pi.rpc(); assert.ok(await refreshProvider(pi) >= 2); })); latencies.push(performance.now() - sent);
        await delay(100);
      }
      const elapsedMs = performance.now() - began;
      const end = await Promise.all(subjects.map(sample));
      for (let i = 0; i < pis.length; i++) {
        assert.equal(end[i].fileCalls.archiveReads, start[i].fileCalls.archiveReads, 'unchanged actual provider must not reread archives');
        assert.equal(end[i].fileCalls.markerStats, start[i].fileCalls.markerStats, 'unchanged actual provider must not stat per-archive markers');
      }
      phase('post-window-snapshot', history, count);
      await control.get({ cwd: root, active: true });
      const after = await control.request('runtime_get_metrics');
      report.lastMetrics = after;
      assert.equal(after.metadataReads, before.metadataReads, 'unchanged history must not be reread for more Pi clients');
      assert.equal(after.projections, before.projections, 'unchanged work must not be reprojected for more Pi clients');
      assert.ok(after.inventories - before.inventories <= Math.ceil(elapsedMs / 1000) + 2,
        'shared compatibility inventory must not multiply with Pi clients');
      assert.ok(after.sqlite.active <= 2, 'read worker must retain the root database budget');
      assert.equal((await control.request('runtime_get_status')).hostedSessions, 0,
        'ordinary local Pi clients must not create hosted sessions');
      const resources = end.map((value, i) => ({ pid: value.pid, identity: value.identity, role: i < pis.length ? 'pi' : i === pis.length ? 'server' : 'work',
        archiveReadDelta: value.fileCalls.archiveReads - start[i].fileCalls.archiveReads, markerStatDelta: value.fileCalls.markerStats - start[i].fileCalls.markerStats,
        cpuMs: ((value.cpu.user - start[i].cpu.user) + (value.cpu.system - start[i].cpu.system))/1000,
        rss: value.rss, fsRead: value.usage.fsRead - start[i].usage.fsRead, fsWrite: value.usage.fsWrite - start[i].usage.fsWrite,
        lagMs: value.lag }));
      const entry = { history, clients: count, elapsedMs, resources, actualProviderRefresh: true, providerRows,
        totalFsRead: resources.reduce((sum,r) => sum+r.fsRead, 0), totalFsWrite: resources.reduce((sum,r) => sum+r.fsWrite, 0),
        totalCpuMs: resources.reduce((sum,r) => sum+r.cpuMs, 0), totalRss: resources.reduce((sum,r) => sum+r.rss, 0),
        rpcMs: distribution(latencies), inventoryDelta: after.inventories-before.inventories,
        metadataReadDelta: after.metadataReads-before.metadataReads, projectionDelta: after.projections-before.projections,
        sqlite: after.sqlite, rebuild: { ms: rebuildMs, controlRpcMs: distribution(rebuildLatencies) } };
      report.scenarios.push(entry);
      phase('event-publication', history, count);
      entry.eventPublication = await measureEventPublication({ socketPath: ready.socket, agentDir: agent,
        scope: { cwd: root, sessionId, active: true }, metaPath: join(runs, 'sa_resource_active_0', 'meta.json'),
        taskId: 'sa_resource_active_0', subscribers: count });
      assert.ok(entry.eventPublication.ms.max <= 1000, `Committed changes must reach healthy subscribers within 1s: ${JSON.stringify(entry.eventPublication.ms)}`);
      assert.ok(entry.eventPublication.ms.p50 >= 0, 'Event visibility must follow the source commit');
      console.log(JSON.stringify(entry));
    }
    await Promise.all(pis.map(pi => stop(pi))); control.close(); await stop(server, true); await stop(work);
    rmSync(root, { recursive: true, force: true });
  }
  report.phase = { step: 'complete' };
} catch (error) {
  report.failure = { message: String(error).slice(0, 2048) };
  throw error;
} finally {
  try {
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Resource report: ${output}`);
  } finally { await Promise.all([...children].map(child => stop(child))); }
}
