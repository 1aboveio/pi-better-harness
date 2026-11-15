import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backgroundDigest } from './managed-authority.js';
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
      expect(await owner.execute('wait_for_operations',{task_ids:[id],continuation_note:'Inspect the stopped task'})).not.toContain('not registered');
      const request_id='same-public-cancellation-key';
      const stopped = await requester.execute('bg_task_stop', { id, all: true, request_id });
      expect(stopped).toContain('cancelled');
      const evidenceDb=new DatabaseSync(join(process.env.PI_CODING_AGENT_DIR!,'operation-coordinator.sqlite'),{readOnly:true});
      try {expect(evidenceDb.prepare('SELECT COUNT(*) AS count FROM evidence_reads WHERE operation_id IN (SELECT operation_id FROM operations WHERE task_id=?)').get(id!)?.count).toBe(0);}finally{evidenceDb.close();}
      await expect.poll(() => owner.execute('bg_task_status', { id })).toContain('cancelled');
      expect(requester.manager.getSessionId()).toBe('native-requester');
      expect(owner.manager.getSessionId()).toBe('native-owner');
      const readIntents=()=>{const db=new DatabaseSync(join(process.env.PI_CODING_AGENT_DIR!,'operation-coordinator.sqlite'),{readOnly:true});try{return db.prepare('SELECT intent_json FROM task_cancellation_requests').all().map((row:any)=>JSON.parse(row.intent_json)).filter((intent:any)=>intent.taskId===id);}finally{db.close();}};
      const original=readIntents();expect(original).toHaveLength(1);
      expect(original[0].owner.sessionId).toBe('native-owner');
      expect(original[0].expectedLaunchToken).toBeTruthy();expect(original[0].expectedHostId).not.toBe('unavailable');
      expect(original[0].reason).toContain(backgroundDigest({kind:'parent-session',sessionId:'native-requester',workspace:realpathSync(requesterCwd)}));
      expect(await requester.execute('bg_task_stop',{id,all:true,request_id})).toContain('cancelled');
      expect(readIntents()).toHaveLength(1);
      expect(await requester.execute('bg_task',{action:'stop',id,request_id})).toMatch(/another execution owner|not_accepted/);
      // The same public request key from the original owner is a distinct admission.
      expect(await owner.execute('bg_task_stop',{id,request_id})).toContain('cancelled');
      expect(await owner.execute('bg_status',{action:'stop',id,request_id})).toContain('cancelled');
      const independent=readIntents();expect(independent).toHaveLength(2);
      expect(new Set(independent.map((intent:any)=>intent.idempotencyKey)).size).toBe(2);
      expect(independent.every((intent:any)=>intent.owner.sessionId==='native-owner')).toBe(true);
    } finally {
      if (id) await owner.execute('bg_task_stop', { id });
      await requester.close(); await owner.close();
      rmSync(cwd, { recursive: true, force: true });
      if (otherWorkspace) rmSync(requesterCwd, { recursive: true, force: true });
    }
  });
});
