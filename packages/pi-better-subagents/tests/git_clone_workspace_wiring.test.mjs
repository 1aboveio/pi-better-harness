/**
 * Source-level wiring tests for git_clone_workspace in index.ts.
 * @covers subagent_spawn.git_clone_workspace
 * @level unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, '..', 'index.ts');
const indexSource = readFileSync(indexPath, 'utf8');

describe('subagent_spawn git_clone_workspace wiring', () => {
    it('imports resolveSubagentWorkspace from git-workspace.ts', () => {
        assert.ok(
            indexSource.includes('resolveSubagentWorkspace'),
            'index.ts must import resolveSubagentWorkspace',
        );
        assert.ok(
            indexSource.includes('from "./git-workspace.ts"') ||
            indexSource.includes("from './git-workspace.ts'"),
            'index.ts must import from git-workspace.ts',
        );
    });

    it('declares a git_clone_workspace tool parameter', () => {
        assert.ok(
            indexSource.includes('git_clone_workspace'),
            'index.ts tool schema must include git_clone_workspace',
        );
    });

    it('calls resolveSubagentWorkspace in the execute path', () => {
        assert.ok(
            indexSource.includes('resolveSubagentWorkspace({'),
            'index.ts must call resolveSubagentWorkspace({ ... })',
        );
    });

    it('passes git_clone_workspace into resolveSubagentWorkspace', () => {
        assert.ok(
            indexSource.includes('gitCloneWorkspace: p.git_clone_workspace'),
            'index.ts must forward p.git_clone_workspace as gitCloneWorkspace',
        );
    });

    it('passes the resolved cwd to spawnDetached', () => {
        assert.ok(
            indexSource.includes('spawnDetached({ file: cmd.file, fileArgs: cmd.fileArgs, cwd,') ||
            indexSource.includes('spawnDetached({ file: cmd.file, fileArgs: cmd.fileArgs, cwd: cwd'),
            'index.ts must pass the resolved cwd to spawnDetached',
        );
    });

    it('records the resolved sandbox directory in run meta', () => {
        assert.ok(
            indexSource.includes('sandbox: sandboxDir') ||
            indexSource.includes('sandbox: requestedSandboxDir'),
            'index.ts must record the resolved sandbox directory in meta',
        );
    });

    it('mentions git_clone_workspace in prompt guidelines', () => {
        assert.ok(
            indexSource.includes('git_clone_workspace'),
            'index.ts prompt guidelines must mention git_clone_workspace',
        );
    });
});
