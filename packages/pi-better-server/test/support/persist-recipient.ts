import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';

/** Direct tool fixtures have no assistant message to trigger the SDK's deferred write. */
export function persistRecipientForHandoff(manager: SessionManager): string {
  const path = manager.getSessionFile();
  assert.ok(path, 'recipient must use the original persistent session path');
  if (!existsSync(path)) writeFileSync(path,
    [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const reopened = SessionManager.open(path);
  assert.equal(reopened.getSessionId(), manager.getSessionId(), 'handoff must reopen the same persisted recipient');
  assert.deepEqual(reopened.getBranch(), JSON.parse(JSON.stringify(manager.getBranch())), 'handoff must retain the captured branch');
  return path;
}
