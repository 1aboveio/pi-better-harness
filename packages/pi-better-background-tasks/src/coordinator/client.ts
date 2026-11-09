/**
 * Pi-side discovery/reconnect client for the shared coordinator.
 *
 * The client subscribes with execution owners; it never asks the coordinator to
 * wake a model. A change reply causes a scoped local read of that owner's
 * operation/wait/outbox state, followed by the existing callback and evidence
 * rules. If the socket disappears, the client reconnects and reads durable
 * catch-up hints for its owners.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import type { CoordinatorChange, OwnerIdentity } from "../shared-operation-coordinator/index.ts";
import {
    COORDINATOR_PROTOCOL_VERSION,
    ownerKey,
    type CoordinatorReply,
    type CoordinatorRequest,
    type CoordinatorSpawnOptions,
    type CoordinatorStats,
} from "./protocol.ts";
import { coordinatorInvocation } from "./invocation.ts";
import { coordinatorPaths } from "./paths.ts";

export interface CoordinatorClientOptions extends CoordinatorSpawnOptions {
    clientId?: string;
    /** Test seam: disable spawning so a connection failure is observable. */
    spawnServer?: boolean;
    onLog?: (line: string) => void;
}

interface PendingReply {
    resolve: (reply: CoordinatorReply) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class CoordinatorClient {
    private readonly options: CoordinatorClientOptions;
    private readonly clientId: string;
    private socket?: Socket;
    private buffer = "";
    private owners = new Map<string, OwnerIdentity>();
    private readonly cursors = new Map<string, number>();
    private closed = false;
    private connecting?: Promise<void>;
    private reconnectTimer?: NodeJS.Timeout;
    private reconnectAttempts = 0;
    private lastSpawnAt = 0;
    private recoveryTimer?: NodeJS.Timeout;
    private cancelRecovery?: () => void;
    private connectionSocket?: Socket;
    private unavailableReason?: string;
    private readonly pending = new Map<string, PendingReply>();
    private readonly changeListeners = new Set<(change: CoordinatorChange) => void>();
    private readonly catchupListeners = new Set<(changes: CoordinatorChange[]) => void>();

    constructor(options: CoordinatorClientOptions) {
        this.options = options;
        this.clientId = options.clientId ?? `client-${process.pid}-${randomUUID()}`;
    }

    get connected(): boolean {
        return !!this.socket && !this.socket.destroyed;
    }

    get unavailable(): string | undefined { return this.unavailableReason; }

    onChange(listener: (change: CoordinatorChange) => void): () => void {
        this.changeListeners.add(listener);
        return () => { this.changeListeners.delete(listener); };
    }

    onCatchup(listener: (changes: CoordinatorChange[]) => void): () => void {
        this.catchupListeners.add(listener);
        return () => { this.catchupListeners.delete(listener); };
    }

    /** Connect (spawning a leader when needed) and subscribe to the owners. */
    async start(owners: readonly OwnerIdentity[]): Promise<void> {
        this.closed = false;
        for (const owner of owners) this.owners.set(ownerKey(owner), owner);
        await this.ensureConnected();
        await this.subscribe();
    }

    async updateOwners(owners: readonly OwnerIdentity[]): Promise<void> {
        const next = new Map<string, OwnerIdentity>();
        for (const owner of owners) next.set(ownerKey(owner), owner);
        const changed = next.size !== this.owners.size
            || [...next.keys()].some((key) => !this.owners.has(key));
        this.owners = next;
        if (!changed || this.closed) return;
        await this.ensureConnected();
        await this.subscribe();
    }

    addOwner(owner: OwnerIdentity): void {
        const key = ownerKey(owner);
        if (this.owners.has(key)) return;
        this.owners.set(key, owner);
        if (this.connected) void this.subscribe().catch(() => { /* reconnect catches up */ });
    }

    removeOwner(owner: OwnerIdentity): void {
        if (!this.owners.delete(ownerKey(owner))) return;
        if (this.connected) void this.subscribe().catch(() => { /* reconnect catches up */ });
    }

    async stats(): Promise<CoordinatorStats> {
        const reply = await this.request({ type: "stats", version: COORDINATOR_PROTOCOL_VERSION, clientId: this.clientId });
        if (reply.type !== "stats") throw new Error(`expected stats reply, received ${reply.type}`);
        return reply.stats;
    }

    async reconcile(): Promise<void> {
        const reply = await this.request({ type: "reconcile", version: COORDINATOR_PROTOCOL_VERSION, clientId: this.clientId });
        if (reply.type !== "reconciled") throw new Error(`expected reconcile reply, received ${reply.type}`);
    }

    async previewRetention(cutoff: number, limit: number) {
        const reply = await this.request({
            type: "retention-preview",
            version: COORDINATOR_PROTOCOL_VERSION,
            clientId: this.clientId,
            cutoff,
            limit,
        });
        if (reply.type !== "retention-preview") throw new Error(`expected retention preview, received ${reply.type}`);
        return reply;
    }

    async applyRetention(cutoff: number, limit: number) {
        const reply = await this.request({
            type: "retention-apply",
            version: COORDINATOR_PROTOCOL_VERSION,
            clientId: this.clientId,
            cutoff,
            limit,
        });
        if (reply.type !== "retention-apply") throw new Error(`expected retention apply, received ${reply.type}`);
        return reply;
    }

    close(): void {
        this.closed = true;
        this.cancelRecovery?.();
        if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
        this.connectionSocket?.destroy();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("coordinator client closed"));
        }
        this.pending.clear();
        try { this.socket?.destroy(); } catch { /* already gone */ }
        this.socket = undefined;
        this.owners.clear();
        this.cursors.clear();
    }

    private async request(request: CoordinatorRequest): Promise<CoordinatorReply> {
        await this.ensureConnected();
        const socket = this.socket;
        if (!socket || socket.destroyed) throw new Error("coordinator is not connected");
        const requestId = `req-${randomUUID()}`;
        const withId = { ...request, requestId } as CoordinatorRequest;
        // Only explicit in-flight work owns process lifetime. An idle advisory
        // subscription must not prevent a CLI or SDK process from exiting.
        socket.ref();
        try {
            return await new Promise<CoordinatorReply>((resolvePromise, reject) => {
                const timer = setTimeout(() => {
                    this.pending.delete(requestId);
                    reject(new Error("coordinator request timed out"));
                }, 5_000);
                timer.unref?.();
                this.pending.set(requestId, { resolve: resolvePromise, reject, timer });
                try {
                    socket.write(`${JSON.stringify(withId)}\n`);
                } catch (error) {
                    clearTimeout(timer);
                    this.pending.delete(requestId);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        } finally {
            if (this.pending.size === 0) socket.unref();
        }
    }

    private async subscribe(): Promise<void> {
        if (!this.connected) return;
        const owners = [...this.owners.values()];
        await this.request({
            type: "subscribe",
            version: COORDINATOR_PROTOCOL_VERSION,
            clientId: this.clientId,
            owners,
            cursors: Object.fromEntries(this.cursors),
        });
        this.reconnectAttempts = 0;
        this.lastSpawnAt = 0;
    }

    private async ensureConnected(): Promise<void> {
        if (this.closed) throw new Error("coordinator client closed");
        if (this.connected) return;
        if (this.connecting) return this.connecting;
        this.connecting = this.connectWithRecovery()
            .catch((error) => { this.scheduleReconnect(); throw error; })
            .finally(() => { this.connecting = undefined; });
        return this.connecting;
    }

    private connectWithRecovery(): Promise<void> {
        return new Promise<void>((resolvePromise, reject) => {
            let settled = false;
            const finish = (error?: Error): void => {
                if (settled) return;
                settled = true;
                if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
                this.recoveryTimer = undefined;
                this.cancelRecovery = undefined;
                this.unavailableReason = error?.message;
                if (error) reject(error);
                else resolvePromise();
            };
            this.cancelRecovery = () => finish(new Error("coordinator client closed"));
            const attempt = (remaining: number): void => {
                if (this.closed) return finish(new Error("coordinator client closed"));
                const paths = coordinatorPaths(
                    this.options.storePath,
                    this.options.supervisorDirectory,
                    this.options.stateDirectory,
                );
                const socket = connect(paths.socket);
                this.connectionSocket = socket;
                socket.setTimeout(1_000, () => socket.destroy(new Error("coordinator connection timed out")));
                socket.setEncoding("utf8");
                const onError = (error: Error): void => {
                    socket.destroy();
                    if (remaining <= 1) {
                        return finish(new Error(`coordinator unavailable after 8 attempts: ${error.message}`));
                    }
                    if (remaining === 8) this.spawnLeader();
                    this.recoveryTimer = setTimeout(() => attempt(remaining - 1), Math.min(1_000, 60 * 2 ** (8 - remaining)));
                };
                socket.once("connect", () => {
                    socket.off("error", onError);
                    socket.setTimeout(0);
                    this.connectionSocket = undefined;
                    this.attach(socket);
                    finish();
                });
                socket.once("error", onError);
            };
            attempt(8);
        });
    }

    private spawnLeader(): void {
        if (this.closed || this.options.spawnServer === false) return;
        const now = Date.now();
        if (now - this.lastSpawnAt < 30_000) return;
        this.lastSpawnAt = now;
        try {
            const paths = coordinatorPaths(
                this.options.storePath,
                this.options.supervisorDirectory,
                this.options.stateDirectory,
            );
            mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
            const logFd = openSync(paths.log, "a", 0o600);
            try {
                const invocation = coordinatorInvocation(this.options);
                const child = spawn(invocation.execPath, invocation.args, {
                    cwd: this.options.cwd ?? process.cwd(),
                    env: { ...process.env },
                    detached: true,
                    stdio: ["ignore", logFd, logFd],
                    windowsHide: true,
                });
                child.on("error", (error) => this.options.onLog?.(`could not spawn coordinator: ${error.message}`));
                child.unref();
            } finally {
                closeSync(logFd);
            }
        } catch (error) {
            this.options.onLog?.(`could not spawn coordinator: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private attach(socket: Socket): void {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.socket = socket;
        socket.unref();
        this.buffer = "";
        socket.on("data", (chunk: string) => {
            this.buffer += chunk;
            let newline = this.buffer.indexOf("\n");
            while (newline >= 0) {
                const line = this.buffer.slice(0, newline);
                this.buffer = this.buffer.slice(newline + 1);
                if (line.trim()) this.handleLine(line);
                newline = this.buffer.indexOf("\n");
            }
        });
        socket.on("error", () => { /* close handler schedules recovery */ });
        socket.on("close", () => {
            if (this.socket === socket) this.socket = undefined;
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error("coordinator disconnected"));
            }
            this.pending.clear();
            if (!this.closed) this.scheduleReconnect();
        });
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer) return;
        this.reconnectAttempts += 1;
        const delay = Math.min(30_000, 250 * 2 ** Math.min(7, this.reconnectAttempts));
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.closed) return;
            void this.ensureConnected()
                .then(() => this.subscribe())
                .catch(() => this.scheduleReconnect());
        }, delay);
        this.reconnectTimer.unref?.();
    }

    private handleLine(line: string): void {
        let reply: CoordinatorReply;
        try {
            reply = JSON.parse(line) as CoordinatorReply;
        } catch {
            return;
        }
        const requestId = "requestId" in reply && typeof reply.requestId === "string" ? reply.requestId : undefined;
        if (requestId) {
            const waiting = this.pending.get(requestId);
            if (waiting) {
                clearTimeout(waiting.timer);
                this.pending.delete(requestId);
                    if (reply.type === "error") waiting.reject(new Error(reply.reason));
                else waiting.resolve(reply);
            }
            return;
        }
        switch (reply.type) {
            case "hello":
                if (reply.version !== COORDINATOR_PROTOCOL_VERSION) {
                    this.unavailableReason = `incompatible coordinator protocol ${reply.version}`;
                    this.socket?.destroy(new Error(this.unavailableReason));
                }
                // Do not advance the cursor here: subscribe(sinceSeq) is what
                // replays the durable owner-scoped catch-up. Advancing on hello
                // would silently skip hints written while this client was down.
                return;
            case "change":
                this.cursors.set(ownerKey(reply.change.owner), Math.max(this.cursors.get(ownerKey(reply.change.owner)) ?? 0, reply.change.seq));
                for (const listener of this.changeListeners) {
                    try { listener(reply.change); } catch { /* a listener cannot break reconnect */ }
                }
                return;
            case "catchup":
                this.cursors.set(reply.ownerKey, reply.reset ? reply.cursor : Math.max(this.cursors.get(reply.ownerKey) ?? 0, reply.cursor));
                for (const listener of this.catchupListeners) {
                    try { listener(reply.changes); } catch { /* best effort */ }
                }
                return;
            default:
                return;
        }
    }
}
