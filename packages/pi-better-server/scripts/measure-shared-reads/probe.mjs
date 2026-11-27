import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const archiveRoot = join(process.env.PI_SUBAGENT_DURABLE_DIR ?? '/nonexistent', 'attempts') + '/';
const markerRoot = join(process.env.PI_SUBAGENT_DURABLE_DIR ?? '/nonexistent', 'session-state') + '/';
const fileCalls = { archiveReads: 0, markerStats: 0 };
const readFile = fs.readFileSync, stat = fs.statSync;
fs.readFileSync = function(path, ...args) { if (String(path).startsWith(archiveRoot)) fileCalls.archiveReads++; return readFile.call(this, path, ...args); };
fs.statSync = function(path, ...args) { if (String(path).startsWith(markerRoot)) fileCalls.markerStats++; return stat.call(this, path, ...args); };
syncBuiltinESMExports();
import { currentOwnerIdentity } from '../../src/daemon-owner.ts';
const identity = currentOwnerIdentity();
import { monitorEventLoopDelay } from 'node:perf_hooks';
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
process.on('message', message => {
  if (message?.type !== 'resource-sample') return;
  process.send?.({ type: 'resource-sample', id: message.id, pid: process.pid, identity,
    fileCalls: { ...fileCalls }, cpu: process.cpuUsage(), rss: process.memoryUsage().rss, usage: process.resourceUsage(),
    lag: { p50: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 } });
  lag.reset();
});

process.on('message', message => {
  if (message?.type !== 'provider-refresh') return;
  try {
    const hooks = globalThis[Symbol.for('pi-better-subagents.acceptance-hooks')];
    if (!hooks?.listRows) throw new Error('Registered Subagents provider unavailable');
    const rows = hooks.listRows();
    process.send?.({ type: 'provider-refreshed', id: message.id, rows: rows.length });
  } catch (error) {
    process.send?.({ type: 'provider-refreshed', id: message.id, error: String(error) });
  }
});
