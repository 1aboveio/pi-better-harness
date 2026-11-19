// Generated fixed launch domain from packages/pi-better-background-tasks/src/work-observation.ts. Do not edit directly.
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
const hostedClients = new WeakSet();
const connectionAborts = new WeakMap();
const clients = new WeakMap();
const generations = new WeakMap();
const listeners = new WeakMap();
const activityScopes = new WeakMap();
/** Goal reads the subscribed observation, never a periodic full-state RPC. */
export async function backgroundGoalObservation(pi, ctx) {
    const scope = { background: true, cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId(), processId: process.pid };
    const client = await observationClient(pi, scope);
    const key = JSON.stringify(scope);
    if (activityScopes.get(client) !== key) {
        await client.subscribe(scope);
        activityScopes.set(client, key);
    }
    return client.snapshot;
}
export function onBackgroundObservation(pi, notify) {
    let set = listeners.get(pi);
    if (!set) {
        set = new Set();
        listeners.set(pi, set);
    }
    set.add(notify);
    return () => { set.delete(notify); };
}
/** A query connection grants no supervisor, transcript writer or retention authority. */
export function backgroundObservation(pi, ctx, history = false, all = false, page) {
    const scope = { background: true, cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId(), processId: process.pid };
    const generation = generations.get(pi) ?? 0;
    const read = async (retry) => {
        if ((generations.get(pi) ?? 0) !== generation)
            throw new Error("runtime-unavailable: client closed");
        const connection = observationClient(pi, scope);
        const client = await connection;
        if ((generations.get(pi) ?? 0) !== generation)
            throw new Error("runtime-unavailable: client closed");
        try {
            const deadline = Date.now() + 20000;
            for (;;) {
                checkGeneration();
                const snapshot = await client.get({ ...scope, backgroundHistory: history, backgroundAll: all, ...page });
                if (!history || snapshot.status !== "rebuilding" || Date.now() >= deadline)
                    return snapshot;
                await delay(20);
            }
        }
        catch (error) {
            if (!retry || hostedClients.has(client) || !client.closed || (generations.get(pi) ?? 0) !== generation)
                throw error;
            if (clients.get(pi) === connection)
                clients.delete(pi);
            return read(false);
        }
    };
    const checkGeneration = () => { if ((generations.get(pi) ?? 0) !== generation)
        throw new Error("runtime-unavailable: client closed"); };
    return read(true);
}
function observationClient(pi, scope) {
    const generation = generations.get(pi) ?? 0;
    const checkOpen = () => {
        if ((generations.get(pi) ?? 0) !== generation)
            throw new Error("runtime-unavailable: client closed");
    };
    let pending = clients.get(pi);
    if (!pending) {
        const controller = new AbortController();
        connectionAborts.set(pi, controller);
        pending = (async () => {
            let hosted;
            let rejected;
            pi.events?.emit("pi-better-runtime:connect", {
                accept: (client) => { hosted = client; }, reject: (error) => { rejected = error; },
            });
            if (rejected)
                throw rejected;
            if (hosted) {
                hostedClients.add(hosted);
                hosted.onChange(() => { for (const notify of listeners.get(pi) ?? [])
                    notify(); });
                try {
                    await hosted.subscribe(scope);
                    activityScopes.set(hosted, JSON.stringify({ ...scope, processId: process.pid }));
                    checkOpen();
                    return hosted;
                }
                catch (error) {
                    hosted.close();
                    throw error;
                }
            }
            const requestedRoot = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
            mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
            const root = realpathSync(requestedRoot);
            const ensure = async (timeoutMs, signal) => {
                const installer = new URL("../runtime-client/src/runtime/client.mjs", import.meta.url).href;
                const { ensureRuntime } = await import(installer);
                await ensureRuntime({ agentDir: root, serverDir: process.env.PI_SERVER_DIR, timeoutMs, signal });
            };
            let registration;
            try {
                registration = JSON.parse(readFileSync(join(root, "server-registration-v1.json"), "utf8"));
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
                await ensure(undefined, controller.signal);
                registration = JSON.parse(readFileSync(join(root, "server-registration-v1.json"), "utf8"));
            }
            if (registration.version !== 1 || registration.agentDir !== root)
                throw new Error("Invalid canonical runtime registration");
            const module = new URL("./shared-work-client.mjs", import.meta.url).href;
            const { connectWorkClient } = await import(module);
            const connect = async () => {
                checkOpen();
                const client = await connectWorkClient(join(registration.serverDir, "pi-server.sock"), root, ["runtime-background-state-v1"], {
                    signal: controller.signal, recover: ({ timeoutMs, signal }) => ensure(timeoutMs, signal),
                });
                let subscribed = false;
                client.onChange(() => {
                    if (!subscribed || clients.get(pi) !== pending)
                        return;
                    if (client.closed)
                        clients.delete(pi);
                    for (const notify of listeners.get(pi) ?? [])
                        notify();
                });
                try {
                    checkOpen();
                    await client.subscribe(scope);
                    checkOpen();
                }
                catch (error) {
                    client.close();
                    throw error;
                }
                subscribed = true;
                activityScopes.set(client, JSON.stringify({ ...scope, processId: process.pid }));
                return client;
            };
            return connect();
        })();
        clients.set(pi, pending);
        pending.catch(() => { if (clients.get(pi) === pending)
            clients.delete(pi); });
    }
    return pending;
}
export function closeBackgroundObservation(pi) {
    generations.set(pi, (generations.get(pi) ?? 0) + 1);
    connectionAborts.get(pi)?.abort();
    connectionAborts.delete(pi);
    const pending = clients.get(pi);
    clients.delete(pi);
    void pending?.then(client => client.close(), () => { });
}
