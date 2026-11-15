import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export async function sdkRecipient({ cwd, sessionId, sent, notes }) {
    const directory = mkdtempSync(join(tmpdir(), 'sdk-recipient-'));
    const child = fork(new URL('./sdk-recipient-worker.mjs', import.meta.url), [], { execArgv: ['--import', 'tsx'],
        env: { ...process.env, RECIPIENT_FIXTURE: JSON.stringify({ cwd, sessionId, directory }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('message', message => {
        if (message.delivery) sent.push(message.delivery);
        if (message.notice) notes.push(message.notice);
    });
    const ready = new Promise(resolve => child.on('message', message => { if (message.ready) resolve(); }));
    await Promise.race([ready, once(child, 'exit').then(() => { throw new Error(errors); })]);
    let sequence = 0;
    return {
        async failure(value) {
            if (!child.connected) return;
            const id = ++sequence;
            const done = new Promise(resolve => { const listener = message => { if (message.id === id) { child.off('message', listener); resolve(); } }; child.on('message', listener); });
            child.send({ id, type: 'failure', value }); await done;
        },
        async close() { if (child.exitCode !== null || !child.connected) return; const exited = once(child, 'exit'); child.send({ type: 'stop' }); await exited; },
    };
}
