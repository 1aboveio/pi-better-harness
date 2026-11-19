// Generated fixed launch domain from packages/pi-better-subagents/work-observation.ts. Do not edit directly.
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { connectWorkClient } from "./shared-work-client.mjs";
export const TERMINAL_NAVIGATOR_RETENTION_MS = 30_000;
let client;
let snapshot;
let context;
let connecting;
let collecting;
let collectingClient;
let dirty = false;
let retry;
let backoff = 100;
let failure = "Shared runtime observation is connecting.";
let generation = 0;
let connectionAbort = new AbortController();
const details = new Map();
const pendingDetails = new Set();
let refresh = () => { };
export function workObservation() { return snapshot; }
export function workObservationFailure() { return snapshot?.reason ?? failure; }
function degraded(error) {
    failure = String(error);
    snapshot = { ...snapshot, status: "degraded", reason: failure, rows: snapshot?.rows ?? [] };
    refresh();
}
function reconnectLater(current) {
    if (retry || !context || current !== generation)
        return;
    retry = setTimeout(() => {
        retry = undefined;
        void ensureObservation().catch(error => { if (current === generation) {
            degraded(error);
            reconnectLater(current);
        } });
    }, backoff);
    retry.unref?.();
    backoff = Math.min(2000, backoff * 2);
}
// Every page is bounded; a conversation anchor fences collection across filtered queries.
async function collect(candidate, current) {
    dirty = true;
    if (collecting && collectingClient === candidate)
        return collecting;
    collectingClient = candidate;
    const scope = { ...context.origin, active: true, limit: 200 };
    collecting = (async () => {
        do {
            dirty = false;
            let completed = false;
            for (let attempt = 0; attempt < 2 && !completed; attempt++) {
                try {
                    const anchorScope = { ...context.origin, limit: 1 };
                    const anchor = await candidate.get(anchorScope);
                    const first = await candidate.get(scope);
                    if (current !== generation || candidate !== client)
                        return;
                    if (first.status === "rebuilding") {
                        snapshot = { ...first, rows: snapshot?.rows ?? [] };
                        refresh();
                        // A newer publication may already be owed while this page
                        // was in flight. Drain that demand, but never poll for it.
                        break;
                    }
                    const rows = [...first.rows];
                    let cursor = first.nextCursor;
                    while (cursor) {
                        const page = await candidate.get({ ...scope, cursor });
                        if (page.scopeRevision !== first.scopeRevision || page.instanceId !== first.instanceId)
                            throw new Error("resync_required: active pages changed");
                        rows.push(...page.rows);
                        cursor = page.nextCursor;
                    }
                    // Cover the disconnect interval, not merely the last 30 s of
                    // worker time. The navigator starts its own visibility clock.
                    const endedAfter = Math.min(Date.now() - TERMINAL_NAVIGATOR_RETENTION_MS, snapshot?.observedAtLocal ?? Date.now());
                    const history = await candidate.get({ ...context.origin, active: false, endedAfter, limit: 200 });
                    if (history.instanceId !== first.instanceId)
                        throw new Error("resync_required: history changed");
                    if (current !== generation || candidate !== client)
                        return;
                    const owed = [];
                    let owedCursor;
                    do {
                        const page = await candidate.get({ ...context.origin, pendingRecipient: true, limit: 200, ...(owedCursor ? { cursor: owedCursor } : {}) });
                        if (page.instanceId !== first.instanceId)
                            throw new Error("resync_required: recipient page changed");
                        owed.push(...page.rows);
                        owedCursor = page.nextCursor;
                    } while (owedCursor);
                    if (current !== generation || candidate !== client)
                        return;
                    const historyRows = [...history.rows];
                    let historyCursor = history.nextCursor;
                    while (historyCursor) {
                        const page = await candidate.get({ ...context.origin, active: false, endedAfter, limit: 200, cursor: historyCursor });
                        if (page.scopeRevision !== history.scopeRevision || page.instanceId !== first.instanceId)
                            throw new Error("resync_required: history pages changed");
                        historyRows.push(...page.rows);
                        historyCursor = page.nextCursor;
                    }
                    if (current !== generation || candidate !== client)
                        return;
                    const confirmed = await candidate.get(anchorScope);
                    if (current !== generation || candidate !== client)
                        return;
                    if (confirmed.instanceId !== anchor.instanceId || confirmed.scopeRevision !== anchor.scopeRevision)
                        throw new Error("resync_required: conversation changed during collection");
                    const allRows = [...new Map([...rows, ...historyRows, ...owed].map(row => [row.meta.id, row])).values()];
                    snapshot = { ...first, seq: anchor.seq, observedRevisionVector: anchor.observedRevisionVector, rows: allRows, nextCursor: undefined,
                        observedAtLocal: Date.now(),
                        totalMatching: first.totalMatching + history.totalMatching, activity: { active: rows.length } };
                    completed = true;
                    refresh();
                }
                catch (error) {
                    if (current !== generation || candidate !== client)
                        return;
                    if (attempt === 1 || candidate.closed) {
                        degraded(error);
                        if (candidate.closed)
                            return;
                        // A notification received during these page reads is
                        // still owed a coherent collection. Drain only that
                        // demand through the outer loop; do not start a poller.
                        break;
                    }
                }
            }
        } while (dirty && current === generation && candidate === client && !candidate.closed);
    })().finally(() => { if (current === generation && collectingClient === candidate)
        collecting = undefined; });
    return collecting;
}
async function connectObservation(current) {
    const saved = context;
    const signal = connectionAbort.signal;
    mkdirSync(saved.agentDir, { recursive: true, mode: 0o700 });
    saved.agentDir = realpathSync(saved.agentDir);
    let registration;
    try {
        registration = JSON.parse(readFileSync(join(saved.agentDir, "server-registration-v1.json"), "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        const path = "./runtime-client/src/runtime/client.mjs";
        const { ensureRuntime } = await import(path);
        await ensureRuntime({ agentDir: saved.agentDir, signal });
        registration = JSON.parse(readFileSync(join(saved.agentDir, "server-registration-v1.json"), "utf8"));
    }
    if (current !== generation)
        return;
    if (registration.version !== 1 || registration.agentDir !== saved.agentDir)
        throw new Error("Invalid canonical runtime registration");
    client?.close();
    const candidate = await connectWorkClient(join(registration.serverDir, "pi-server.sock"), saved.agentDir, [], {
        signal,
        recover: async ({ timeoutMs, signal }) => {
            const path = "./runtime-client/src/runtime/client.mjs";
            const { ensureRuntime } = await import(path);
            await ensureRuntime({ agentDir: saved.agentDir, serverDir: registration.serverDir, timeoutMs, signal });
        },
    });
    if (current !== generation) {
        candidate.close();
        return;
    }
    client = candidate;
    candidate.onChange(() => {
        if (current !== generation || candidate !== client)
            return;
        if (candidate.closed) {
            details.clear();
            pendingDetails.clear();
            degraded(candidate.snapshot?.reason ?? "runtime-unavailable: disconnected; resync required");
            reconnectLater(current);
        }
        else
            void collect(candidate, current).catch(error => { if (current === generation)
                degraded(error); });
    });
    await candidate.subscribe({ ...saved.origin, limit: 200 });
    if (candidate.snapshot?.status === "rebuilding")
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { stop(); reject(new Error("Runtime scope is still rebuilding; retry the observation.")); }, 5000);
            const stop = candidate.onChange(value => {
                if (value.status !== "rebuilding") {
                    stop();
                    clearTimeout(timer);
                    resolve();
                }
            });
        });
    await collect(candidate, current);
    if (candidate.closed)
        throw new Error("runtime-unavailable: disconnected; resync required");
    if (current === generation) {
        backoff = 100;
        if (retry)
            clearTimeout(retry);
        retry = undefined;
    }
}
export async function startWorkObservation(agentDir, origin, changed) {
    stopWorkObservation();
    const current = generation;
    context = { agentDir, origin };
    refresh = changed;
    try {
        await ensureObservation();
    }
    catch (error) {
        if (current === generation) {
            degraded(error);
            reconnectLater(current);
        }
    }
}
async function ensureObservation() {
    if (connecting)
        return connecting;
    if (client && !client.closed)
        return;
    context ??= { agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), origin: { cwd: process.cwd() } };
    const current = generation;
    connecting = connectObservation(current).finally(() => { if (current === generation)
        connecting = undefined; });
    return connecting;
}
async function query(scope) {
    const current = generation;
    for (let attempt = 0;; attempt++) {
        try {
            await ensureObservation();
            if (current !== generation)
                throw new Error("runtime-unavailable: observation closed");
            return await client.get(scope);
        }
        catch (error) {
            if (current !== generation || (client && !client.closed) || attempt === 1)
                throw error;
        }
    }
}
export async function observedAssignment(id) {
    const observation = await query({ id, limit: 1 });
    const row = observation.rows[0];
    if (!row)
        throw new Error(observation.status === "ready" ? `No shared observation for ${id}` : observation.reason);
    return { assignment: row.assignment, snapshot: observation };
}
export async function observedList(scope) { return query(scope); }
export function stopWorkObservation() {
    generation++;
    context = undefined;
    connectionAbort.abort();
    connectionAbort = new AbortController();
    if (retry)
        clearTimeout(retry);
    retry = undefined;
    client?.close();
    client = undefined;
    snapshot = undefined;
    connecting = undefined;
    collecting = undefined;
    collectingClient = undefined;
    dirty = false;
    details.clear();
    pendingDetails.clear();
    backoff = 100;
}
export function requestWorkDetail(id) {
    const cached = details.get(id);
    if ((cached?.seq === snapshot?.seq && cached?.instanceId === snapshot?.instanceId) || pendingDetails.has(id) || !client)
        return cached?.row;
    pendingDetails.add(id);
    const current = generation;
    void query({ id, detail: true, limit: 1 }).then(value => {
        if (current !== generation)
            return;
        details.set(id, { seq: value.seq, instanceId: value.instanceId, row: value.rows[0] });
        if (details.size > 16)
            details.delete(details.keys().next().value);
        refresh();
    }).catch(error => {
        if (current !== generation)
            return;
        failure = String(error);
        details.set(id, { seq: snapshot?.seq, instanceId: snapshot?.instanceId, row: { ...cached?.row, observationError: failure } });
        refresh();
    }).finally(() => { if (current === generation)
        pendingDetails.delete(id); });
    return cached?.row;
}
