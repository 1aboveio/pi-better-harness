import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
let linuxUnits;

export function linuxCaptureUnits(run = execFileSync) {
  return linuxUnits ??= { ticks: Number(run('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()),
    pageBytes: Number(run('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim()) };
}

/** One platform owner acquires this NEW batch, never independent probe files. */
export function platformCapture(pids, { run = execFileSync, read = readFileSync, now = Date.now, platform = process.platform, units, nativeCapture, nativeBindingId } = {}) {
  assert.ok(['darwin', 'linux'].includes(platform), 'Unsupported batch capture platform');
  const scale = platform === 'linux' ? units ?? linuxCaptureUnits(run) : undefined;
  const captureStartedAt = now();
  const cpuStarted = process.cpuUsage();
  const cost = () => {
    const cpu = process.cpuUsage(cpuStarted);
    return { scope: 'capture-owner-process', ownerCpuMicros: cpu.user + cpu.system,
      childCpuMicros: 0, coverage: 'complete-no-child-process' };
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
      cpuResolutionMs: 1000 / scale.ticks, diagnosticCost: cost(), semantics: 'one owned acquisition; individual kernel read times retained' } };
  }
  assert.equal(typeof nativeCapture, 'function', 'In-process Darwin capture binding required; no child-process fallback');
  const batch = nativeCapture(pids);
  return { ...batch, source: { kind: 'darwin-libproc-batch', platform, nativeBindingId,
    captureStartedNs: batch.captureStartedNs, capturedNs: batch.capturedNs,
    cpuResolutionMs: batch.cpuResolutionMs, diagnosticCost: cost(),
    semantics: 'one in-process libproc batch; kernel birth token and per-record acquisition time retained' } };
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
    assert.ok(batch.records.every(record => record.observedAt === undefined || Number.isSafeInteger(record.observedAt)
      && record.observedAt >= batch.captureStartedAt && record.observedAt <= batch.capturedAt), 'Independent observation outside actual acquisition span');
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
