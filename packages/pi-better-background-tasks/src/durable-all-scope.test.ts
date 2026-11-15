import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { startWorkRuntime } from './test-support/work-runtime.js';
import { nativeBackground } from './test-support/native-background.js';
let stopRuntime: () => Promise<void>;
beforeAll(async () => { stopRuntime = await startWorkRuntime(); });
afterAll(async () => { await stopRuntime(); });

describe('native durable explicit all-session cancellation', () => {
  for (const otherWorkspace of [false, true]) it(`retains the requester identity with all:true (other workspace=${otherWorkspace})`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bg-all-owner-'));
    const requesterCwd = otherWorkspace ? mkdtempSync(join(tmpdir(), 'bg-all-requester-')) : cwd;
    const owner = await nativeBackground({ cwd, sessionId: 'native-owner' });
    const requester = await nativeBackground({ cwd: requesterCwd, sessionId: 'native-requester' });
    let id: string | undefined;
    try {
      const launch = await owner.execute('bg_task_spawn', { name: 'owned sleeper', shell: false, argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'], callback: false });
      id = launch.match(/bgs_[0-9a-f]{20}/)?.[0];
      expect(id).toBeDefined();
      const refused = await requester.execute('bg_task_stop', { id });
      expect(refused).toMatch(/another execution owner|outside.*scope|not stopped|not_accepted/);
      expect(await owner.execute('bg_task_status', { id })).toContain('running');
      const stopped = await requester.execute('bg_task_stop', { id, all: true });
      expect(stopped).toContain('cancelled');
      await expect.poll(() => owner.execute('bg_task_status', { id })).toContain('cancelled');
      expect(requester.manager.getSessionId()).toBe('native-requester');
      expect(owner.manager.getSessionId()).toBe('native-owner');
    } finally {
      if (id) await owner.execute('bg_task_stop', { id });
      await requester.close(); await owner.close();
      rmSync(cwd, { recursive: true, force: true });
      if (otherWorkspace) rmSync(requesterCwd, { recursive: true, force: true });
    }
  });
});
