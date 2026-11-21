import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { backgroundDigest } from './managed-authority.js';
import { readAdmissionStartToken, readProcessStartTokenFresh } from './process-identity.js';
import { currentForegroundSandboxPolicy, FOREGROUND_SANDBOX_POLICY_CHANNEL } from './sandbox.js';
import { backgroundListNeedsHistory, backgroundObservation } from './work-observation.js';
/** Native host proof carries scope and captured policy, never a transcript or module path. */
export async function requestBackgroundTool(pi: ExtensionAPI, ctx: ExtensionContext, key: string, tool: string, params: unknown, parameters?: unknown, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted)
        throw new Error('Background request cancelled before admission');
    const input = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    const list = tool === 'bg_task_list' || (tool === 'bg_task' && input.action === 'list');
    if (list && backgroundListNeedsHistory(input)) {
        // The root history index is shared. Wait on its read plane before acquiring
        // a grant or entering the serialized tool queue, even for an all-session list.
        const snapshot = await backgroundObservation(pi, ctx, true, false, { limit: 1 }, { timeoutMs: 60000, signal });
        if (snapshot.status !== 'ready')
            throw new Error(snapshot.reason ?? `Background history is ${snapshot.status}`);
    } else {
        await backgroundObservation(pi, ctx);
    }
    signal?.throwIfAborted();
    const root = realpathSync(getAgentDir()), registration = JSON.parse(readFileSync(join(root, 'server-registration-v1.json'), 'utf8'));
    if (registration.version !== 1 || registration.agentDir !== root)
        throw new Error('Invalid runtime registration');
    const module = new URL('./shared-work-client.mjs', import.meta.url).href;
    const { connectWorkClient } = await import(module);
    const directory = join(root, 'background-tool-admission');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
        throw new Error('Unsafe Background admission directory');
    const client = await connectWorkClient(join(registration.serverDir, 'pi-server.sock'), root, ['runtime-background-execution-v1'], { signal });
    const id = randomUUID(), secret = randomBytes(32).toString('hex'), path = join(directory, `${id}.json`);
    let off: unknown;
    const abort = () => client.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
        const hello = await client.ready;
        const policy = currentForegroundSandboxPolicy(pi);
        const branchIds = ctx.sessionManager.getBranch().map(entry => entry.id).filter((value): value is string => typeof value === 'string');
        const sessionId = ctx.sessionManager.getSessionId();
        if (!sessionId)
            throw new Error('Background tools require a native session identity');
        const version = hello.capabilities?.includes("runtime-background-admission-v2") ? 2 : 1;
        const start = version === 2 ? readAdmissionStartToken(process.pid) : readProcessStartTokenFresh(process.pid);
        const record = { version, id, secretHash: createHash('sha256').update(secret).digest('hex'), instanceId: hello.instanceId,
            owner: { kind: 'parent-session', sessionId, workspace: realpathSync(ctx.cwd) }, branchIds, projectTrusted: ctx.isProjectTrusted(),
            pid: process.pid, start, key, tool, params, parametersDigest: parameters === undefined ? undefined : backgroundDigest(parameters), policy };
        const staged = `${path}.tmp`;
        writeFileSync(staged, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        renameSync(staged, path);
        let checking = false;
        off = pi.events.on(FOREGROUND_SANDBOX_POLICY_CHANNEL, () => { if (checking)
            return; checking = true; try {
            if (backgroundDigest(currentForegroundSandboxPolicy(pi) ?? null) !== backgroundDigest(policy ?? null))
                rmSync(path, { force: true });
        }
        finally {
            checking = false;
        } });
        return await client.request('runtime_background_tool', { authority: { id, secret } });
    }
    finally {
        if (typeof off === 'function')
            off();
        signal?.removeEventListener('abort', abort);
        client.close();
        rmSync(path, { force: true });
    }
}
