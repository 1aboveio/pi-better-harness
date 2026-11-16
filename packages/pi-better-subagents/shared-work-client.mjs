import { connect } from "node:net";
import { performance } from "node:perf_hooks";

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
            if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) return this.fail(new Error("runtime-unhealthy: oversized stream frame"));
            while (this.buffer.includes("\n")) {
                const index = this.buffer.indexOf("\n"), line = this.buffer.slice(0, index);
                this.buffer = this.buffer.slice(index + 1);
                try {
                    const message = JSON.parse(line);
                    if (message.type === "event") {
                        if (message.event.type === "runtime_catalog_snapshot") { for (const listener of this.catalogListeners) listener(message.event.snapshot); continue; }
                        if (message.event.type === "resync_required") { this.degrade(message.event.reason); this.scheduleRecovery(); }
                        else if (message.event.type === "runtime_snapshot") this.accept(message.event.snapshot);
                    } else {
                        const request = this.pending.get(message.id);
                        if (!request) continue;
                        this.pending.delete(message.id); clearTimeout(request.timer);
                        if (message.success) request.resolve(message.data); else request.reject(new Error(message.error));
                    }
                } catch (error) { this.fail(error); }
            }
        });
        this.socket.on("error", error => this.fail(error));
        this.socket.on("close", () => this.fail(new Error("runtime-unavailable: disconnected; resync required")));
        this.ready = this.request("hello", { protocolVersion: 1, runtimeRoot: agentDir, requiredCapabilities: ["runtime-state-v1", "runtime-subscriptions-v1", ...requiredCapabilities] })
            .then(async hello => { if (typeof socketPath === "string" && hello.capabilities?.includes("runtime-client-retention-v1")) await this.request("runtime_register_client", { clientId: `work-${process.pid}` }); return hello; });
    }
    request(type, params = {}) {
        if (this.closed) return Promise.reject(new Error("runtime-unavailable: disconnected; resync required"));
        if (this.pending.size >= 32) return Promise.reject(new Error("runtime-unhealthy: too many in-flight queries"));
        const id = `work-${++this.sequence}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`runtime-unhealthy: ${type} timed out`)); }, 5000);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.write(JSON.stringify({ id, type, ...params }) + "\n");
        });
    }
    onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    onCatalog(listener) { this.catalogListeners.add(listener); return () => this.catalogListeners.delete(listener); }
    notify() { for (const listener of this.listeners) listener(this.snapshot); }
    degrade(reason) {
        this.snapshot = { ...this.snapshot, status: "degraded", reason, rows: this.snapshot?.rows ?? [] };
        this.notify();
    }
    accept(snapshot) {
        if (this.snapshot?.instanceId === snapshot.instanceId && snapshot.seq < this.snapshot.seq) return;
        if (this.snapshot?.instanceId && this.snapshot.instanceId !== snapshot.instanceId) {
            this.degrade("instance-changed: resync required");
            snapshot = { ...snapshot, resyncRequired: true, resyncReason: "instance-changed" };
        }
        // seq is global, so unrelated scopes legitimately skip values. Each
        // event is complete; only explicit resync or instance changes fence it.
        this.snapshot = Object.freeze(snapshot); this.notify();
    }
    scheduleRecovery(delay = 0) {
        if (this.closed) return;
        if (this.recoveryActive) { this.recoveryAgain = true; return; }
        if (this.recoveryTimer) return;
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
        try { await this.resync(); this.recoveryDelay = 100; }
        catch (error) {
            if (!this.closed && generation === this.scopeGeneration) {
                this.degrade(String(error));
                retry = /runtime-(?:timeout|overloaded|unhealthy)/.test(String(error));
            }
        } finally {
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
        clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
        this.recoveryAgain = false; this.recoveryDelay = 100;
        this.scope = scope;
        const snapshot = await this.request("runtime_subscribe", { scope });
        this.accept(snapshot); return snapshot;
    }
    async resync() {
        const generation = this.scopeGeneration;
        const snapshot = await this.request("runtime_subscribe", { scope: this.scope, sinceSeq: this.snapshot?.seq, instanceId: this.snapshot?.instanceId });
        if (!this.closed && generation === this.scopeGeneration) this.accept(snapshot);
        return snapshot;
    }
    async get(scope) {
        await this.ready;
        const until = performance.now() + 3500;
        for (let attempt = 0; ; attempt++) {
            const value = await this.request("runtime_get_snapshot", { scope });
            if (!scope?.id || value.status !== "rebuilding" || value.rows.length || performance.now() >= until) return value;
            // A newly written ID may join an inventory without holding the shared RPC queue.
            await new Promise(resolve => setTimeout(resolve, Math.min(250, 50 * 2 ** attempt, until - performance.now())));
        }
    }
    fail(error) {
        if (this.closed) return;
        this.closed = true;
        this.scopeGeneration++;
        clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear(); this.socket.destroy(); this.degrade(String(error));
        for (const listener of this.catalogListeners) listener({ status: "revoked" });
    }
    close() { this.fail(new Error("runtime-unavailable: client closed")); this.listeners.clear(); this.catalogListeners.clear(); }
}
