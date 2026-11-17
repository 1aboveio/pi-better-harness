import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { persistRecipientForHandoff } from './support/persist-recipient.ts';

test('direct tool recipient handoff persists the actual SDK identity and branch without inventing an assistant turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'recipient-persistence-'));
  try {
    const manager = SessionManager.create(root, join(root, 'native-sessions'));
    manager.appendCustomEntry('pending-fixture-work', { waiting: true });
    assert.equal(existsSync(manager.getSessionFile()!), false, 'SDK defers pre-assistant persistence');
    const path = persistRecipientForHandoff(manager);
    const reopened = SessionManager.open(path);
    assert.equal(reopened.getSessionId(), manager.getSessionId());
    assert.equal(reopened.getCwd(), manager.getCwd());
    assert.deepEqual(reopened.getBranch(), manager.getBranch());
    assert.equal(reopened.getEntries().some(entry => entry.type === 'message'), false);
    const first = readFileSync(path, 'utf8');
    persistRecipientForHandoff(manager);
    assert.equal(readFileSync(path, 'utf8'), first, 'existing transcript is not overwritten');
    reopened.appendCustomEntry('completion-receipt', { delivered: true });
    const again = SessionManager.open(path);
    assert.equal(again.getSessionId(), manager.getSessionId());
    assert.equal(again.getEntries().length, manager.getEntries().length + 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recipient checkpoint refuses a different existing identity without replacing its transcript', () => {
  const root = mkdtempSync(join(tmpdir(), 'recipient-conflict-'));
  try {
    const manager = SessionManager.create(root, join(root, 'native-sessions'));
    const foreign = SessionManager.inMemory(root);
    const path = manager.getSessionFile()!;
    const original = JSON.stringify(foreign.getHeader()) + '\n';
    writeFileSync(path, original);
    assert.throws(() => persistRecipientForHandoff(manager), /same persisted recipient/);
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
