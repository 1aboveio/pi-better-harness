import assert from 'node:assert/strict';
import type { OwnerInspection } from '../../src/daemon-owner.ts';

export function assertGuardedServerReleased(owner: OwnerInspection, checkpoint: { pid?: number; token?: string }): void {
  if (owner.status !== 'missing') console.error('[result-guardian-owner-failure]', JSON.stringify({
    status: owner.status,
    owner: 'owner' in owner ? { pid: owner.owner.pid, token: owner.owner.token.slice(0, 128),
      start: owner.owner.start?.slice(0, 128) ?? null, boot: owner.owner.boot?.slice(0, 128) ?? null } : null,
    checkpoint: { pid: checkpoint.pid ?? null, token: checkpoint.token?.slice(0, 128) ?? null },
    sameCheckpointOwner: 'owner' in owner ? owner.owner.pid === checkpoint.pid && owner.owner.token === checkpoint.token : null,
  }));
  assert.equal(owner.status, 'missing');
}
