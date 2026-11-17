import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
let linuxUnits;

function cpuMicros(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(value);
  assert.ok(match, `Invalid OS cumulative CPU: ${value}`);
  return ((Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600
    + Number(match[3]) * 60 + Number(match[4])) * 1e6 + Number(`0.${match[5] ?? 0}`) * 1e6);
}

/** One platform command owns this NEW capture, not the independent probe files. */
export function platformCapture(pids, { run = execFileSync, read = readFileSync, now = Date.now, platform = process.platform, units } = {}) {
  assert.ok(['darwin', 'linux'].includes(platform), 'Unsupported batch capture platform');
  const scale = platform === 'linux' ? units ?? (linuxUnits ??= { ticks: Number(run('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()),
    pageBytes: Number(run('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim()) }) : undefined;
  const captureStartedAt = now();
  const cpuStarted = process.cpuUsage();
  const cost = external => {
    const cpu = process.cpuUsage(cpuStarted);
    return { scope: 'capture-owner-process', ownerCpuMicros: cpu.user + cpu.system,
      childCpuMicros: external ? null : 0, coverage: external ? 'incomplete-external-child-cost' : 'complete-no-child-process' };
  };
  if (platform === 'linux') {
    assert.ok(scale.ticks > 0 && scale.pageBytes > 0, 'Missing kernel counter units');
    const boot = read('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const records = pids.map(pid => {
      const raw = read(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      assert.ok(!['Z', 'X'].includes(fields[0]), 'Exited process in capture');
      return { identity: { pid, start: fields[19], boot }, observedAt: now(),
        cpu: { totalMicros: (Number(fields[11]) + Number(fields[12])) * 1e6 / scale.ticks }, rss: Number(fields[21]) * scale.pageBytes };
    });
    return { captureStartedAt, capturedAt: now(), records, source: { kind: 'proc-batch', platform,
      cpuResolutionMs: 1000 / scale.ticks, diagnosticCost: cost(false), semantics: 'one owned acquisition; individual kernel read times retained' } };
  }
  const raw = run('ps', ['-ww', '-p', pids.join(','), '-o', 'pid=,lstart=,time=,rss='], {
    encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' },
  });
  const capturedAt = now();
  const records = raw.trim().split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+([\d:.-]+)\s+(\d+)\s*$/.exec(line);
    assert.ok(match, `Unusable batch process record: ${line}`);
    return { identity: { pid: Number(match[1]), start: `ps-lstart:${match[2].replace(/\s+/g, ' ')}` },
      cpu: { totalMicros: cpuMicros(match[3]) }, rss: Number(match[4]) * 1024 };
  });
  return { captureStartedAt, capturedAt, records,
    source: { kind: 'ps-batch', platform, cpuResolutionMs: 10, diagnosticCost: cost(true),
      semantics: 'OS batch listing; acquisition span retained, not an atomic kernel transaction' } };
}

export function createBatchCapture({ capture = platformCapture, generation, pids }) {
  assert.equal(new Set(pids).size, pids.length, 'Duplicate requested process');
  assert.ok(pids.length && pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  let sequence = 0, required;
  return () => {
    const batch = capture(pids);
    assert.ok(batch.records.every(record => record.at === undefined && record.sourceCohort === undefined), 'Cannot relabel independent timestamp records');
    assert.ok(Number.isSafeInteger(batch.captureStartedAt) && Number.isSafeInteger(batch.capturedAt)
      && batch.capturedAt >= batch.captureStartedAt, 'Invalid capture clock');
    assert.deepEqual(batch.records.map(row => row.identity.pid).sort((a,b) => a-b), [...pids].sort((a,b) => a-b), 'Incomplete OS PID set');
    const identities = batch.records.map(row => row.identity).sort((a,b) => a.pid-b.pid);
    required ??= identities;
    assert.deepEqual(identities, required, 'Batch process start identity changed');
    const sourceCohort = { ...batch.source, id: randomUUID(), captureStartedAt: batch.captureStartedAt,
      capturedAt: batch.capturedAt, pids: [...pids] };
    sequence++;
    return batch.records.map(record => ({ ...record, generation, sequence, at: batch.capturedAt, sourceCohort }));
  };
}
