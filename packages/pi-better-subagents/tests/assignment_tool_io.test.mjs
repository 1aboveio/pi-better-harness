import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('registered list tools share projection reads through filtering, formatting and cursors', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'assignment-tool-io-')));
    const keys = ['TMPDIR', 'PI_CODING_AGENT_DIR', 'PI_SUBAGENT_DURABLE_DIR'];
    const saved = keys.map(key => [key, process.env[key]]);
    process.env.TMPDIR = root;
    process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
    process.env.PI_SUBAGENT_DURABLE_DIR = join(root, 'durable');
    const { writeMeta, runDir, logPathFor, baseDir } = await import('../registry.ts');
    const { subagentListTool } = await import('../tools.ts');
    const { openStore } = await import('../../operation-coordinator/index.ts');
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
    openStore({ path: join(process.env.PI_CODING_AGENT_DIR, 'operation-coordinator.sqlite') }).close();
    const scoped = 30;
    const metas = Array.from({ length: 200 }, (_, i) => ({ id: `sa_tool_io_${i}`, sessionId: `session-${i}`,
        cwd: i < scoped ? '/fixture/visible' : '/fixture/other', status: 'completed', pid: 0,
        spawnPid: process.pid, startedAt: i, endedAt: i + 1, exitCode: 0, promptPreview: 'fixture',
        operations: { conversationId: `session-${i}`, workspace: i < scoped ? '/fixture/visible' : '/fixture/other' } }));
    for (const meta of metas) {
        writeMeta(meta);
        fs.writeFileSync(logPathFor(meta.id), '');
    }
    const Type = Object.fromEntries(['Object', 'String', 'Number', 'Boolean', 'Array', 'Optional'].map(key => [key, value => value]));
    const tool = subagentListTool(Type, { getActiveOrigin: () => ({ cwd: '/fixture/visible' }) });
    const body = result => result.content.map(c => c.text ?? '').join('\n');
    const read = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(path, ...args) {
        if (String(path).startsWith(join(baseDir(), 'runs') + '/') && String(path).endsWith('/meta.json')) reads++;
        return read.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    try {
        const first = body(await tool.execute('first', { limit: 10 }));
        assert.match(first, /30 matching/);
        const cursor = first.match(/statusCursor=(\S+)/)?.[1];
        assert.ok(cursor);
        reads = 0;
        const unchanged = body(await tool.execute('again', { limit: 10, cursor }));
        assert.match(unchanged, /unchanged/);
        assert.ok(reads <= scoped * 3, `unchanged list reread ${reads} metadata files`);
        t.diagnostic(`unchanged list: ${reads} metadata reads for ${scoped} scoped runs out of ${metas.length}`);
        const changed = { ...metas[0], id: 'sa_tool_io_resume', resumedFrom: metas[0].id,
            startedAt: 1000, status: 'failed', failureReason: 'fixture failure',
            operations: { ...metas[0].operations, resumeLaunchToken: 'fixture-resume' } };
        // An independent writer publishes a continuation without updating this process's caches.
        fs.mkdirSync(runDir(changed.id));
        fs.writeFileSync(join(runDir(changed.id), 'meta.json'), JSON.stringify(changed));
        const filtered = body(await tool.execute('failed', { limit: 1, status: ['failed'] }));
        assert.match(filtered, /2 matching/);
        assert.match(filtered, /sa_tool_io_resume/);
    } finally {
        fs.readFileSync = read;
        syncBuiltinESMExports();
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
