// Generated fixed launch domain from packages/pi-better-background-tasks/src/shared-work-client.mjs. Do not edit directly.
import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
/** SDK-free observation stream. Cached snapshots are the only synchronous read API. */
export class WorkClient {
    socket;
    snapshot;
    pending = new Map();
    listeners = new Set();
    catalogListeners = new Set();
    sequence = 0;
    scope;
    buffer = "";
    closed = false;
    recoveryTimer;
    recoveryActive = false;
    recoveryAgain = false;
    recoveryDelay = 100;
    scopeGeneration = 0;
    constructor(socketPath, agentDir, requiredCapabilities = []) {
        this.socket = typeof socketPath === "string" ? connect(socketPath) : socketPath;
        this.socket.setEncoding("utf8");
        this.socket.on("data", chunk => {
            this.buffer += chunk;
            if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024)
                return this.fail(new Error("runtime-unhealthy: oversized stream frame"));
            while (this.buffer.includes("\n")) {
                const index = this.buffer.indexOf("\n"), line = this.buffer.slice(0, index);
                this.buffer = this.buffer.slice(index + 1);
                try {
                    const message = JSON.parse(line);
                    if (message.type === "event") {
                        if (message.event.type === "runtime_catalog_snapshot") {
                            for (const listener of this.catalogListeners)
                                listener(message.event.snapshot);
                            continue;
                        }
                        if (message.event.type === "resync_required") {
                            this.degrade(message.event.reason);
                            this.scheduleRecovery();
                        }
                        else if (message.event.type === "runtime_snapshot")
                            this.accept(message.event.snapshot, message.event.previousSeq);
                    }
                    else {
                        const request = this.pending.get(message.id);
                        if (!request)
                            continue;
                        this.pending.delete(message.id);
                        clearTimeout(request.timer);
                        if (message.success)
                            request.resolve(message.data);
                        else
                            request.reject(new Error(message.error));
                    }
                }
                catch (error) {
                    this.fail(error);
                }
            }
        });
        this.socket.on("error", error => this.fail(["ECONNRESET", "EPIPE"].includes(error.code)
            ? Object.assign(new Error(`runtime-unavailable: disconnected (${error.code}); resync required`, { cause: error }), { code: error.code })
            : error));
        this.socket.on("close", () => this.fail(new Error("runtime-unavailable: disconnected; resync required")));
        this.ready = this.request("hello", { protocolVersion: 1, runtimeRoot: agentDir, requiredCapabilities: ["runtime-state-v1", "runtime-subscriptions-v1", ...requiredCapabilities] })
            .then(async (hello) => { if (typeof socketPath === "string" && hello.capabilities?.includes("runtime-client-retention-v1"))
            await this.request("runtime_register_client", { clientId: `work-${process.pid}` }); return hello; });
    }
    request(type, params = {}) {
        if (this.closed)
            return Promise.reject(new Error("runtime-unavailable: disconnected; resync required"));
        if (this.pending.size >= 32)
            return Promise.reject(new Error("runtime-unhealthy: too many in-flight queries"));
        const id = `work-${++this.sequence}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`runtime-unhealthy: ${type} timed out`)); }, 5000);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.write(JSON.stringify({ id, type, ...params }) + "\n");
        });
    }
    onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    onCatalog(listener) { this.catalogListeners.add(listener); return () => this.catalogListeners.delete(listener); }
    notify() { for (const listener of this.listeners)
        listener(this.snapshot); }
    degrade(reason) {
        this.snapshot = { ...this.snapshot, status: "degraded", reason, rows: this.snapshot?.rows ?? [] };
        this.notify();
    }
    accept(snapshot, previousSeq) {
        if (this.snapshot?.instanceId === snapshot.instanceId && snapshot.seq < this.snapshot.seq)
            return;
        if (this.snapshot?.instanceId && this.snapshot.instanceId !== snapshot.instanceId) {
            this.degrade("instance-changed: resync required");
            snapshot = { ...snapshot, resyncRequired: true, resyncReason: "instance-changed" };
        }
        else if (this.snapshot?.seq !== undefined && Number.isSafeInteger(previousSeq) && previousSeq > this.snapshot.seq) {
            this.degrade("sequence-gap: replacing with a full authoritative snapshot");
            snapshot = { ...snapshot, resyncRequired: true, resyncReason: "sequence-gap" };
        }
        // Global seq may skip unrelated changes; only a missing subscription
        // predecessor indicates loss. The received snapshot is still complete.
        this.snapshot = Object.freeze(snapshot);
        this.notify();
    }
    scheduleRecovery(delay = 0) {
        if (this.closed)
            return;
        if (this.recoveryActive) {
            this.recoveryAgain = true;
            return;
        }
        if (this.recoveryTimer)
            return;
        this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined;
            void this.recover();
        }, delay);
        this.recoveryTimer.unref?.();
    }
    async recover() {
        const generation = this.scopeGeneration;
        this.recoveryActive = true;
        let retry = false;
        try {
            await this.resync();
            this.recoveryDelay = 100;
        }
        catch (error) {
            if (!this.closed && generation === this.scopeGeneration) {
                this.degrade(String(error));
                retry = /runtime-(?:timeout|overloaded|unhealthy)/.test(String(error));
            }
        }
        finally {
            this.recoveryActive = false;
            const again = this.recoveryAgain;
            this.recoveryAgain = false;
            if (!this.closed && (again || retry && generation === this.scopeGeneration)) {
                this.scheduleRecovery(again ? 0 : this.recoveryDelay);
                this.recoveryDelay = Math.min(1000, this.recoveryDelay * 2);
            }
        }
    }
    async subscribe(scope) {
        await this.ready;
        this.scopeGeneration++;
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
        this.recoveryAgain = false;
        this.recoveryDelay = 100;
        this.scope = scope;
        const snapshot = await this.request("runtime_subscribe", { scope });
        this.accept(snapshot);
        return snapshot;
    }
    async resync() {
        const generation = this.scopeGeneration;
        const snapshot = await this.request("runtime_subscribe", { scope: this.scope, sinceSeq: this.snapshot?.seq, instanceId: this.snapshot?.instanceId });
        if (!this.closed && generation === this.scopeGeneration)
            this.accept(snapshot);
        return snapshot;
    }
    async get(scope) {
        await this.ready;
        const until = performance.now() + 3500;
        for (let attempt = 0;; attempt++) {
            const value = await this.request("runtime_get_snapshot", { scope });
            if (!scope?.id || value.status !== "rebuilding" || value.rows.length || performance.now() >= until)
                return value;
            // A newly written ID may join an inventory without holding the shared RPC queue.
            await new Promise(resolve => setTimeout(resolve, Math.min(250, 50 * 2 ** attempt, until - performance.now())));
        }
    }
    fail(error) {
        if (this.closed)
            return;
        this.closed = true;
        this.scopeGeneration++;
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        this.socket.destroy();
        this.degrade(String(error));
        for (const listener of this.catalogListeners)
            listener({ status: "revoked" });
    }
    close() { this.fail(new Error("runtime-unavailable: client closed")); this.listeners.clear(); this.catalogListeners.clear(); }
}
// Shared across the standalone extension copies, but never across agent roots.
const recoveryKey = Symbol.for("pi-better-runtime.connection-recovery.v2");
const recoveries = globalThis[recoveryKey] ??= new Map();
const connectionDemands = globalThis[Symbol.for("pi-better-runtime.connection-demand.v2")] ??= new Map();
const recoveryTasks = globalThis[Symbol.for("pi-better-runtime.recovery-tasks.v1")] ??= new Map();
/** After stopping consumers, a root owner can wait for cancelled installers to finish writing. */
export async function waitForWorkClientRecovery(socketPath, agentDir) {
    const tasks = recoveryTasks.get(JSON.stringify([agentDir, socketPath]));
    if (tasks)
        await Promise.allSettled(tasks);
}
/** Establish a transport only. Never replay an application request after dispatch. */
export async function connectWorkClient(socketPath, agentDir, capabilities = [], options = {}) {
    const timeoutMs = options.timeoutMs ?? 60000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("Invalid connection timeout");
    const deadline = performance.now() + timeoutMs;
    const started = performance.now();
    let backoff = 100, recovered = false, lastError, recoveryError, ownedRecovery;
    const remaining = () => Math.max(1, deadline - performance.now());
    const key = JSON.stringify([agentDir, socketPath]);
    connectionDemands.set(key, (connectionDemands.get(key) ?? 0) + 1);
    try {
        while (performance.now() < deadline) {
            options.signal?.throwIfAborted();
            const client = new WorkClient(socketPath, agentDir, capabilities);
            const abort = () => client.close();
            options.signal?.addEventListener("abort", abort, { once: true });
            const timer = setTimeout(() => client.close(), remaining());
            try {
                await client.ready;
                options.signal?.throwIfAborted();
                return client;
            }
            catch (error) {
                client.close();
                options.signal?.throwIfAborted();
                lastError = error;
                if (recoveryError)
                    throw recoveryError;
                if (!["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error?.code)
                    && !/runtime-unavailable: (?:disconnected|server closed)/.test(String(error)))
                    throw error;
            }
            finally {
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", abort);
            }
            // Most replacement gaps need only a reconnect. Startup remains owner-safe.
            if (!recovered && options.recover && performance.now() - started >= 250 && performance.now() < deadline) {
                recovered = true;
                let recovery = recoveries.get(key);
                if (!recovery) {
                    const controller = new AbortController();
                    const budget = Math.ceil(remaining());
                    const timer = setTimeout(() => {
                        controller.abort(new Error("runtime-unavailable: reconnect deadline exceeded during recovery"));
                    }, budget);
                    const task = Promise.resolve().then(() => options.recover({ timeoutMs: budget, signal: controller.signal }));
                    const tasks = recoveryTasks.get(key) ?? new Set();
                    tasks.add(task);
                    recoveryTasks.set(key, tasks);
                    const retire = () => {
                        tasks.delete(task);
                        if (tasks.size === 0)
                            recoveryTasks.delete(key);
                    };
                    void task.then(retire, retire);
                    const promise = waitForRecovery(task, controller.signal)
                        .finally(() => clearTimeout(timer));
                    recovery = { promise, controller, key };
                    recoveries.set(key, recovery);
                    void recovery.promise.finally(() => { if (recoveries.get(key) === recovery)
                        recoveries.delete(key); }).catch(() => { });
                }
                // A caller can cancel its wait without cancelling another caller's recovery.
                // Keep trying the transport while the owner-safe installer waits.
                // A replacement can accept compatible clients before the pinned
                // installer finishes; waiting for it would stall all subscribers.
                ownedRecovery = recovery;
                void recovery.promise.catch(error => { recoveryError = error; });
            }
            if (performance.now() >= deadline)
                break;
            await delay(Math.min(backoff, remaining()), undefined, { signal: options.signal });
            backoff = Math.min(1000, backoff * 2);
        }
        throw new Error("runtime-unavailable: reconnect deadline exceeded; task state is unknown, retry after recovery", { cause: lastError });
    }
    finally {
        const remainingDemand = connectionDemands.get(key) - 1;
        if (remainingDemand)
            connectionDemands.set(key, remainingDemand);
        else {
            connectionDemands.delete(key);
            const recovery = recoveries.get(key) ?? ownedRecovery;
            if (recovery) {
                recoveries.delete(key);
                recovery.controller.abort();
            }
        }
    }
}
function waitForRecovery(recovery, signal) {
    return new Promise((resolve, reject) => {
        const finish = (callback, value) => { signal.removeEventListener("abort", abort); callback(value); };
        const abort = () => finish(reject, signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        recovery.then(value => finish(resolve, value), error => finish(reject, error));
        if (signal.aborted)
            abort();
    });
}
