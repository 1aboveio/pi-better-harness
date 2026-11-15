import { connect } from "node:net";

/** SDK-free observation stream. Cached snapshots are the only synchronous read API. */
export class WorkClient {
    socket;
    snapshot;
    pending = new Map();
    listeners = new Set();
    sequence = 0;
    scope;
    buffer = "";
    closed = false;

    constructor(socketPath, agentDir) {
        this.socket = connect(socketPath);
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
                        if (message.event.type === "resync_required") { this.degrade(message.event.reason); void this.resync().catch(error => this.degrade(String(error))); }
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
        this.ready = this.request("hello", { protocolVersion: 1, runtimeRoot: agentDir, requiredCapabilities: ["runtime-state-v1", "runtime-subscriptions-v1"] });
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
        } else if (this.snapshot?.seq !== undefined && snapshot.seq > this.snapshot.seq + 1) {
            this.degrade("sequence-gap: replacing with a full authoritative snapshot");
            snapshot = { ...snapshot, resyncRequired: true, resyncReason: "sequence-gap" };
        }
        // Every event contains a complete bounded snapshot; gaps do not require inferred deltas.
        this.snapshot = Object.freeze(snapshot); this.notify();
    }
    async subscribe(scope) {
        await this.ready;
        this.scope = scope;
        const snapshot = await this.request("runtime_subscribe", { scope });
        this.accept(snapshot); return snapshot;
    }
    async resync() {
        const snapshot = await this.request("runtime_subscribe", { scope: this.scope, sinceSeq: this.snapshot?.seq, instanceId: this.snapshot?.instanceId });
        this.accept(snapshot); return snapshot;
    }
    async get(scope) { await this.ready; return this.request("runtime_get_snapshot", { scope }); }
    fail(error) {
        if (this.closed) return;
        this.closed = true;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear(); this.socket.destroy(); this.degrade(String(error));
    }
    close() { this.fail(new Error("runtime-unavailable: client closed")); this.listeners.clear(); }
}
