// @covers task-sandbox.runtime-integrity
// @level integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writableRuntimeAlias } from './index.ts';

test('runtime aliases inside a writable project are unsafe even when outside writes are disabled', { skip: process.platform === 'win32' }, (t) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'task-runtime-alias-')));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const project = join(base, 'project'), runtime = join(base, 'runtime');
    mkdirSync(project); mkdirSync(runtime);
    const alias = join(project, 'agent');
    symlinkSync(runtime, alias);
    assert.equal(writableRuntimeAlias(alias, project, { projectFiles: 'read-write', outsideProject: 'read', storedCredentials: 'read' }), alias);
    assert.equal(writableRuntimeAlias(alias, project, { projectFiles: 'read', outsideProject: 'read-write', storedCredentials: 'read' }), undefined);
    assert.equal(writableRuntimeAlias(runtime, project, { projectFiles: 'read-write', outsideProject: 'read', storedCredentials: 'read' }), undefined);
});
