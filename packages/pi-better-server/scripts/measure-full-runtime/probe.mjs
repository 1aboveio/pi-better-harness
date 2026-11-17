import { isMainThread } from 'node:worker_threads';
import { createRequire, register } from 'node:module';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';
import { currentOwnerIdentity } from '../../src/daemon-owner.ts';
import { recoveryTraceSnapshot } from './recovery-trace.mjs';
import { installOwnedRouter, registerOwnedLoader, gcThreads } from './owned-fixture.mjs';
export const fixtureControl = isMainThread && process.env.PI_RESOURCE_REPORT_DIR ? installOwnedRouter() : undefined;
if (isMainThread && process.env.PI_RESOURCE_REPORT_DIR) {
  registerOwnedLoader();
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
  let sequence = 0;
  let gc = { count: 0, durationMs: 0 };
  let diagnostics = { samples: 0, sampleWallMs: 0, cpuMicros: 0 };
  let generationStartedAt = performance.now();
  let peakRss = 0, sampledPeakCpuPercent = 0, previousCpu = process.cpuUsage(), previousAt = performance.now();
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (entry.startTime >= generationStartedAt) { gc.count++; gc.durationMs += entry.duration; }
  });
  observer.observe({ entryTypes: ['gc'] });
  const sample = () => {
    const began = performance.now(), beganCpu = process.cpuUsage();
    let next = ''; try { next = readFileSync(join(process.env.PI_RESOURCE_REPORT_DIR, 'generation'), 'utf8'); } catch {}
    if (next !== generation) {
      generation = next; lag.reset(); gc = { count: 0, durationMs: 0 };
      sequence = 0;
      generationStartedAt = began;
      diagnostics = { samples: 0, sampleWallMs: 0, cpuMicros: 0 };
      peakRss = 0; sampledPeakCpuPercent = 0; previousCpu = beganCpu; previousAt = began;
    }
    const rss = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, rss);
    if (began > previousAt) sampledPeakCpuPercent = Math.max(sampledPeakCpuPercent,
      ((beganCpu.user - previousCpu.user) + (beganCpu.system - previousCpu.system)) / ((began - previousAt) * 10));
    previousCpu = beganCpu; previousAt = began;
    const target=join(process.env.PI_RESOURCE_REPORT_DIR, `${process.pid}.json`), temporary=`${target}.tmp`;
    writeFileSync(temporary, JSON.stringify({ identity, generation, sequence: ++sequence, at: Date.now(), cpu: process.cpuUsage(), usage: process.resourceUsage(), rss, connections, gcThreads: gcThreads(), backgroundRecoveryTrace: recoveryTraceSnapshot(),
    window: { peakRss, sampledPeakCpuPercent, sampleIntervalMs: 250, gc: { ...gc, scope: 'this main thread only; worker-thread GC not covered' }, diagnostics: { ...diagnostics } },
    lagMs: { p50: lag.percentile(50)/1e6, p95: lag.percentile(95)/1e6, p99: lag.percentile(99)/1e6 } }));
    renameSync(temporary,target);
    const spent = process.cpuUsage(beganCpu);
    diagnostics.samples++; diagnostics.sampleWallMs += performance.now() - began; diagnostics.cpuMicros += spent.user + spent.system;
  };
  sample(); setInterval(sample, 250).unref();
}
