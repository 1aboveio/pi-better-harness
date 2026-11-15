import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export async function sdkRecipient({ cwd, sessionId, sent, notes, sendMessage }) {
    const directory = mkdtempSync(join(tmpdir(), 'sdk-recipient-'));
    const child = fork(new URL('./sdk-recipient-worker.mjs', import.meta.url), [], { execArgv: ['--import', 'tsx'],
        env: { ...process.env, PI_BETTER_CALLBACK_BATCH_MS: process.env.PI_BETTER_CALLBACK_BATCH_MS ?? "5000", RECIPIENT_FIXTURE: JSON.stringify({ cwd, sessionId, directory, preflight: Boolean(sendMessage) }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('message', message => {
        if (message.sendRequest) {
            const request = message.sendRequest;
            try { sendMessage(request.message, request.options, []); child.send({ type: 'send-decision', id: request.id }); }
            catch (error) { child.send({ type: 'send-decision', id: request.id, error: String(error) }); }
        }
        if (message.delivery) sent.push(message.delivery);
        if (message.notice) notes.push(message.notice);
    });
    const ready = new Promise(resolve => child.on('message', message => { if (message.ready) resolve(); }));
    await Promise.race([ready, once(child, 'exit').then(() => { throw new Error(errors); })]);
    let sequence = 0;
    async function request(type, value) {
        if (!child.connected) return;
        const id = ++sequence;
        const done = new Promise((resolve, reject) => { const listener = message => { if (message.id === id && !message.sendRequest) { child.off('message', listener); if (message.error) reject(new Error(message.error)); else resolve(message.value); } }; child.on('message', listener); });
        child.send({ id, type, value }); return done;
    }
    return {
        rows: () => request('rows'), detail: id => request('detail', id), captureBranch: () => request('capture-branch'), branch: id => request('branch', id), busy: () => request('busy'), settle: () => request('settle'),
        async flush() {
            // Observation arrives over a real socket before this explicit batch-boundary check.
            const deadline = Date.now() + 1500;
            while (!await request('pending') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
            return request('flush');
        }, start: () => request('start'), pendingCount: () => request('pending'),
        async failure(value) {
            if (!child.connected) return;
            const id = ++sequence;
            const done = new Promise(resolve => { const listener = message => { if (message.id === id) { child.off('message', listener); resolve(); } }; child.on('message', listener); });
            child.send({ id, type: 'failure', value }); await done;
        },
        async close() { if (child.exitCode !== null || !child.connected) return; const exited = once(child, 'exit'); child.send({ type: 'stop' }); await exited; },
    };
}
