import { isMainThread } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { currentOwnerIdentity } from '../../src/daemon-owner.ts';
if (isMainThread && process.env.PI_RESOURCE_REPORT_DIR) {
  const identity = currentOwnerIdentity();
  const sqlite = createRequire(import.meta.url)('node:sqlite'), Original = sqlite.DatabaseSync;
  const connections = { coordinator: 0, derived: 0, other: 0 };
  sqlite.DatabaseSync = class extends Original {
    counted = true;
    constructor(path, ...args) { super(path, ...args); this.kind = String(path).endsWith('operation-coordinator.sqlite') ? 'coordinator' : path === ':memory:' ? 'derived' : 'other'; connections[this.kind]++; }
    close() { super.close(); if (this.counted) { connections[this.kind]--; this.counted = false; } }
  };
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let generation = '';
  const sample = () => {
    let next = ''; try { next = readFileSync(join(process.env.PI_RESOURCE_REPORT_DIR, 'generation'), 'utf8'); } catch {}
    if (next !== generation) { generation = next; lag.reset(); }
    writeFileSync(join(process.env.PI_RESOURCE_REPORT_DIR, `${process.pid}.json`), JSON.stringify({ identity, generation, at: Date.now(), cpu: process.cpuUsage(), usage: process.resourceUsage(), rss: process.memoryUsage().rss, connections,
    lagMs: { p50: lag.percentile(50)/1e6, p95: lag.percentile(95)/1e6, p99: lag.percentile(99)/1e6 } }));
  };
  sample(); setInterval(sample, 250).unref();
}
