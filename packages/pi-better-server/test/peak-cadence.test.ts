import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { on, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildDarwinCapture } from '../scripts/measure-full-runtime/build-darwin-capture.mjs';

test('real peak capture survives a delayed control loop but still rejects a physical miss', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'p808-peak-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = process.platform === 'darwin' ? buildDarwinCapture(root) : null;
  assert.ok(process.platform === 'darwin' || process.platform === 'linux', 'Unsupported peak sampler test platform');

  for (const mode of ['delay-control', 'pause-collector']) {
    const gcDirectory = join(root, mode);
    mkdirSync(gcDirectory);
    const child = fork(new URL('./support/peak-cadence.mjs', import.meta.url), [mode, gcDirectory, JSON.stringify(binding)], { execArgv: [] });
    const messages = on(child, 'message', { close: ['exit'], signal: t.signal });
    const exited = once(child, 'exit');
    try {
      let [message] = (await messages.next()).value ?? [];
      if (mode === 'pause-collector') {
        assert.equal(message?.type, 'pause-ready');
        assert.ok(child.kill('SIGSTOP'), 'Could not pause the owned collector process');
        try { await delay(650, undefined, { signal: t.signal }); }
        finally { child.kill('SIGCONT'); }
        child.send({ type: 'resume' });
        [message] = (await messages.next()).value ?? [];
      }
      assert.equal(message?.type, 'result');
      const { elapsedMs, frames, gapMs, peak } = message;
      t.diagnostic(JSON.stringify({ mode, elapsedMs, frames, gapMs, issues: peak.issues }));
      assert.deepEqual(await exited, [0, null]);
      assert.ok(elapsedMs >= 600, 'The injected stall did not span the peak gap limit');
      if (mode === 'delay-control') {
        assert.ok(gapMs <= 250, `Physical capture gap ${gapMs} ms exceeds 250 ms`);
        assert.ok(peak.qualified, JSON.stringify(peak.issues));
        assert.ok(peak.intervals.some((interval: { at: number }) => interval.at > peak.firstAt && interval.at < peak.lastAt));
      } else {
        assert.ok(gapMs > 250, 'The collector pause did not make a real gap');
        assert.equal(peak.qualified, false);
        assert.ok(peak.issues.includes('missing-cohort-interval'));
        assert.equal(peak.cpuPercent, null);
        assert.equal(peak.rssBytes, null);
      }
    } finally {
      await messages.return?.();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }
});
