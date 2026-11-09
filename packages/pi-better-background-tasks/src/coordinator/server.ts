/**
 * The shared Background Tasks coordinator.
 *
 * One leader per canonical operation store + supervisor directory observes
 * running operations, records their terminal revisions, runs safety recovery,
 * and owns legacy/durable maintenance. Clients connect to a local socket and
 * subscribe only to their execution owners; the coordinator never broadcasts a
 * clock tick and never asks every client to scan the shared database.
 */
import { randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    watch,
    type FSWatcher,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseSync, type DatabaseLike } from "../shared-operation-coordinator/src/sqlite.ts";

import {
    openStore,
    type CoordinatorChange,
    type OwnerIdentity,
    type Store,
} from "../shared-operation-coordinator/index.ts";
import {
    currentProcessStartToken,
    readProcessStartToken,
} from "../process-identity.ts";
import { processExists } from "../process.ts";
import { supervisorPaths } from "../supervisor/store.ts";
import {
    createLocalSupervisor,
    defaultSupervisorDirectory,
    type LocalSupervisor,
    type SupervisorInspection,
    type SupervisorTaskStatus,
} from "../supervisor/index.ts";
import {
    COORDINATOR_PROTOCOL_VERSION,
    ownerFromJson,
    ownerKey,
    type CoordinatorReply,
    type CoordinatorRequest,
    type CoordinatorSpawnOptions,
    type CoordinatorStats,
} from "./protocol.ts";
import { coordinatorPaths, type CoordinatorPaths } from "./paths.ts";
import {
    applyTaskRetention,
    previewTaskRetention,
    recoverInterruptedTaskRetention,
    runScheduledTaskMaintenance,
} from "./retention.ts";

export const COORDINATOR_DEFAULT_SAFETY_INTERVAL_MS = 1_000;
export const COORDINATOR_DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;

interface LockRecord {
    version: 1;
    pid: number;
    startToken: string | null;
    startedAt: number;
    socket: string;
    stateDirectory: string;
    nonce: string;
}

export interface CoordinatorServerOptions extends CoordinatorSpawnOptions {
    /** Fault injection after exclusion is held, before diagnostic publication. */
    onElectionLocked?: () => void;
    now?: () => number;
    safetyIntervalMs?: number;
    maintenanceIntervalMs?: number;
    supervisor?: LocalSupervisor;
    logger?: (line: string) => void;
}

export interface StartedCoordinator {
    leader: boolean;
    server?: CoordinatorServer;
    paths: CoordinatorPaths;
}

function readLock(path: string): LockRecord | undefined {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
        if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return undefined;
        if (parsed.version !== 1) return undefined;
        return {
            version: 1,
            pid: parsed.pid,
            startToken: typeof parsed.startToken === "string" ? parsed.startToken : null,
            startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
            socket: typeof parsed.socket === "string" ? parsed.socket : "",
            stateDirectory: typeof parsed.stateDirectory === "string" ? parsed.stateDirectory : "",
            nonce: typeof parsed.nonce === "string" ? parsed.nonce : "",
        };
    } catch {
        return undefined;
    }
}

/**
 * Verified instance identity, not elapsed time: a live pid alone does not prove
 * the recorded leader. If no start token is readable, the lock is held as
 * unknown and never stolen.
 */
export function coordinatorLockAlive(record: LockRecord | undefined): boolean {
    if (!record) return false;
    if (!processExists(record.pid)) return false;
    if (!record.startToken) return true;
    const current = readProcessStartToken(record.pid);
    if (!current) return true;
    return current === record.startToken;
}

function acquireLeadership(lockPath: string, socket: string, stateDirectory: string, electionPath: string, onLocked?: () => void): { leader: boolean; record?: LockRecord; db?: DatabaseLike } {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    // This is a separate database: the lifetime writer lock must never block
    // operation writes. The OS releases it even if publication or shutdown dies.
    mkdirSync(dirname(electionPath), { recursive: true, mode: 0o700 });
    for (const path of [stateDirectory, dirname(electionPath), electionPath, lockPath]) {
        if (!existsSync(path)) continue;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & (stat.isDirectory() ? 0o077 : 0o022)) !== 0))) {
            throw new Error(`unsafe coordinator path: ${path}`);
        }
    }
    const Ctor = databaseSync();
    if (!Ctor) throw new Error("coordinator election requires node:sqlite");
    const db = new Ctor(electionPath);
    try {
        db.exec("BEGIN IMMEDIATE");
        // Refuse coexistence with a pre-election coordinator. Malformed legacy
        // records are unknown, not proof that a peer is dead.
        if (existsSync(lockPath)) {
            const previous = readLock(lockPath);
            if (!previous || coordinatorLockAlive(previous)) {
                db.close();
                return { leader: false };
            }
        }
        onLocked?.();
    } catch (error) {
        db.close();
        if (/locked|SQLITE_BUSY/i.test(String(error))) return { leader: false };
        throw error;
    }
    const record: LockRecord = {
        version: 1, pid: process.pid, startToken: currentProcessStartToken() ?? null,
        startedAt: Date.now(), socket, stateDirectory, nonce: randomUUID(),
    };
    try {
        // Diagnostic only. No contender reads or renames this file to elect.
        const temporary = `${lockPath}.${record.nonce}.tmp`;
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
        try { renameSync(temporary, lockPath); }
        finally { try { unlinkSync(temporary); } catch { /* renamed */ } }
        return { leader: true, record, db };
    } catch (error) {
        db.close();
        throw error;
    }
}

function releaseLeadership(lockPath: string, nonce: string): void {
    const current = readLock(lockPath);
    if (current?.pid !== process.pid || current.nonce !== nonce) return;
    try { unlinkSync(lockPath); } catch { /* already gone */ }
}

function tailEvidence(inspection: SupervisorInspection): Array<{
    kind: "terminal-record" | "log";
    ref: string;
    summary: string;
    detailLost: boolean;
    bytes?: number;
}> {
    const refs: Array<{
        kind: "terminal-record" | "log";
        ref: string;
        summary: string;
        detailLost: boolean;
        bytes?: number;
    }> = [];
    const result = inspection.result;
    refs.push({
        kind: "terminal-record",
        ref: result ? "result.json" : "lost.json",
        summary: result
            ? `status=${result.status} exit=${result.exitCode ?? "null"} timedOut=${result.timedOut ? "true" : "false"}${result.groupCleanup ? ` groupCleanup=${result.groupCleanup}` : ""}`
            : "status=lost detailLost=true",
        detailLost: !result,
    });
    for (const [label, path] of [["stdout", inspection.logs.stdout], ["stderr", inspection.logs.stderr]] as const) {
        try {
            const size = existsSync(path) ? statSync(path).size : 0;
            if (size <= 0) continue;
            refs.push({
                kind: "log",
                ref: `${label}.log`,
                summary: `${label} retained (${size} bytes)`,
                detailLost: false,
                bytes: size,
            });
        } catch { /* a missing log costs detail, not the outcome */ }
    }
    return refs;
}

function terminalOutcome(status: SupervisorTaskStatus): "succeeded" | "failed" | "cancelled" | "lost" {
    switch (status) {
        case "succeeded": return "succeeded";
        case "cancelled": return "cancelled";
        case "lost": return "lost";
        default: return "failed";
    }
}

interface ClientState {
    socket: Socket;
    buffer: string;
    clientId: string;
    owners: Set<string>;
}

let logSink: ((line: string) => void) | undefined;

function log(line: string): void {
    try { logSink?.(line); } catch { /* diagnostics only */ }
}

/**
 * The emitted coordinator lives one directory deeper than the source server,
 * while the supervisor runner keeps its own emitted closure. Try both relative
 * locations so the same module works from source and from the shipped bundle.
 */
function defaultSupervisorRunnerPath(): string | undefined {
    const candidates = [
        new URL("../supervisor/generated/runner.mjs", import.meta.url),
        new URL("../../supervisor/generated/runner.mjs", import.meta.url),
    ];
    for (const candidate of candidates) {
        try {
            const path = fileURLToPath(candidate);
            if (existsSync(path)) return path;
        } catch { /* try the next layout */ }
    }
    return undefined;
}

export class CoordinatorServer {
    readonly paths: CoordinatorPaths;
    private readonly store: Store;
    private readonly supervisor: LocalSupervisor;
    private readonly supervisorDirectory: string;
    private readonly now: () => number;
    private readonly safetyIntervalMs: number;
    private readonly maintenanceIntervalMs: number;
    private readonly startedAt = Date.now();
    private readonly hostId = `${process.pid}:coordinator:${randomUUID()}`;
    private readonly clients = new Set<ClientState>();
    private readonly timers: NodeJS.Timeout[] = [];
    private netServer?: Server;
    private lastChangeSeq = 0;
    private stats: CoordinatorStats;
    private closed = false;
    private scanRunning = false;
    private lockAcquired = false;
    private election?: DatabaseLike;
    private electionNonce = "";
    private readonly inputWatchers = new Map<string, FSWatcher>();
    private readonly taskWatchers = new Map<string, FSWatcher>();
    private hintTimer?: NodeJS.Timeout;
    private readonly storePath: string;

    private constructor(
        paths: CoordinatorPaths,
        store: Store,
        supervisor: LocalSupervisor,
        supervisorDirectory: string,
        options: CoordinatorServerOptions,
    ) {
        this.paths = paths;
        this.storePath = options.storePath;
        this.store = store;
        this.supervisor = supervisor;
        this.supervisorDirectory = supervisorDirectory;
        this.now = options.now ?? (() => Date.now());
        this.safetyIntervalMs = Math.max(100, options.safetyIntervalMs ?? COORDINATOR_DEFAULT_SAFETY_INTERVAL_MS);
        this.maintenanceIntervalMs = Math.max(500, options.maintenanceIntervalMs ?? COORDINATOR_DEFAULT_MAINTENANCE_INTERVAL_MS);
        logSink = options.logger;
        this.stats = {
            pid: process.pid,
            startedAt: this.startedAt,
            connectedClients: 0,
            runningScans: 0,
            terminalScans: 0,
            changeReads: 0,
            reconciledTerminal: 0,
            lastScanAt: null,
            lastChangeSeq: 0,
        };
    }

    static async start(options: CoordinatorServerOptions): Promise<StartedCoordinator> {
        const supervisorDirectory = options.supervisorDirectory ?? defaultSupervisorDirectory();
        const paths = coordinatorPaths(options.storePath, supervisorDirectory, options.stateDirectory);
        mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
        const leadership = acquireLeadership(paths.lock, paths.socket, paths.stateDirectory, paths.leaderDb, options.onElectionLocked);
        if (!leadership.leader) return { leader: false, paths };
        let store: Store | undefined;
        let server: CoordinatorServer | undefined;
        try {
            store = openStore({ path: options.storePath });
            const supervisor = options.supervisor ?? createLocalSupervisor({
                directory: supervisorDirectory,
                ...(defaultSupervisorRunnerPath() ? { runnerPath: defaultSupervisorRunnerPath() } : {}),
            });
            server = new CoordinatorServer(paths, store, supervisor, supervisorDirectory, options);
            server.lockAcquired = true;
            server.election = leadership.db;
            server.electionNonce = leadership.record!.nonce;
            await server.listen();
            return { leader: true, server, paths };
        } catch (error) {
            server?.close();
            try { store?.close(); } catch { /* preserve the start failure */ }
            releaseLeadership(paths.lock, leadership.record!.nonce);
            try { leadership.db?.close(); } catch { /* already closed */ }
            throw error;
        }
    }

    get storeHandle(): Store {
        return this.store;
    }

    get changeSeq(): number {
        return this.lastChangeSeq;
    }

    get currentStats(): CoordinatorStats {
        return { ...this.stats, connectedClients: this.clients.size, lastChangeSeq: this.lastChangeSeq };
    }

    get activeWatchCount(): number {
        return this.inputWatchers.size + this.taskWatchers.size;
    }

    private queueHint(): void {
        if (this.closed || this.hintTimer) return;
        this.hintTimer = setTimeout(() => {
            this.hintTimer = undefined;
            void this.reconcileOnce().catch((error) => log(`hint reconcile failed: ${String(error)}`));
        }, 50);
        this.hintTimer.unref?.();
    }

    private watchInput(watchers: Map<string, FSWatcher>, path: string, relevant: (name: string | null) => boolean, file = false): void {
        if (this.closed || watchers.has(path)) return;
        try {
            const watcher = watch(path, { persistent: false }, (event, filename) => {
                if (file && event === "rename") {
                    watcher.close();
                    if (watchers.get(path) === watcher) watchers.delete(path);
                }
                if (relevant(filename)) {
                    this.queueHint();
                }
            });
            watchers.set(path, watcher);
            log(`input watch ready: ${path}`);
            watcher.on("error", (error) => {
                log(`input watch failed: ${path}: ${String(error)}`);
                watcher.close();
                if (watchers.get(path) === watcher) watchers.delete(path);
                // The central safety scan retries missing watches and recovers
                // evidence even on filesystems that cannot deliver hints.
            });
        } catch (error) { log(`input watch unavailable: ${path}: ${String(error)}`); }
    }

    private watchInputs(): void {
        const database = basename(this.storePath);
        this.watchInput(this.inputWatchers, dirname(this.storePath), (name) =>
            name === null || name === database || name === `${database}-wal`);
        // Directory watches can miss in-place WAL writes (reproduced on macOS).
        // Watch existing files directly; rename invalidates the inode watch and
        // the coalesced scan reattaches it. The parent watch discovers new WALs.
        for (const path of [this.storePath, `${this.storePath}-wal`]) {
            if (existsSync(path)) this.watchInput(this.inputWatchers, path, () => true, true);
        }
        const tasks = join(this.supervisorDirectory, "tasks");
        try { mkdirSync(tasks, { recursive: true, mode: 0o700 }); } catch { return; }
        // Nonrecursive: membership changes discover new tasks, not log writes.
        this.watchInput(this.inputWatchers, tasks, () => true);
    }

    private unwatchTask(directory: string): void {
        this.taskWatchers.get(directory)?.close();
        this.taskWatchers.delete(directory);
    }

    private async listen(): Promise<void> {
        if (process.platform !== "win32") {
            const directory = dirname(this.paths.socket);
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const stat = lstatSync(directory);
            if (stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
                throw new Error(`unsafe coordinator socket directory: ${directory}`);
            }
        }
        if (process.platform !== "win32") {
            try { unlinkSync(this.paths.socket); } catch { /* no stale socket */ }
        }
        const server = createServer((socket) => this.accept(socket));
        this.netServer = server;
        await new Promise<void>((resolvePromise, reject) => {
            server.once("error", reject);
            server.listen(this.paths.socket, () => {
                server.off("error", reject);
                resolvePromise();
            });
        });
        this.lastChangeSeq = this.store.latestChangeSeq();
        // Recovery before serving: incomplete retention and the safety scan catch
        // any terminal evidence a crashed host did not record.
        try {
            recoverInterruptedTaskRetention({
                store: this.store,
                supervisorDirectory: this.supervisorDirectory,
                now: this.now(),
            });
        } catch (error) {
            log(`retention recovery failed: ${String(error)}`);
        }
        this.reconcileOnce().catch((error) => log(`initial reconcile failed: ${String(error)}`));
        this.schedule();
    }

    private schedule(): void {
        const safety = setInterval(() => {
            void this.reconcileOnce().catch((error) => log(`safety reconcile failed: ${String(error)}`));
        }, this.safetyIntervalMs);
        safety.unref?.();
        this.timers.push(safety);
        const maintenance = setInterval(() => {
            try {
                runScheduledTaskMaintenance({
                    store: this.store,
                    supervisorDirectory: this.supervisorDirectory,
                    now: this.now(),
                });
                this.store.pruneChangesBefore(this.now(), 10_000);
            } catch (error) {
                log(`maintenance failed: ${String(error)}`);
            }
        }, this.maintenanceIntervalMs);
        maintenance.unref?.();
        this.timers.push(maintenance);
        try {
            runScheduledTaskMaintenance({
                store: this.store,
                supervisorDirectory: this.supervisorDirectory,
                now: this.now(),
            });
        } catch (error) {
            log(`initial maintenance failed: ${String(error)}`);
        }
    }

    private accept(socket: Socket): void {
        const state: ClientState = { socket, buffer: "", clientId: `client-${randomUUID()}`, owners: new Set() };
        this.clients.add(state);
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            state.buffer += chunk;
            if (state.buffer.length > 1024 * 1024) {
                this.send(socket, { type: "error", code: "protocol", reason: "coordinator request exceeded 1 MiB" });
                socket.destroy();
                return;
            }
            let newline = state.buffer.indexOf("\n");
            while (newline >= 0) {
                const line = state.buffer.slice(0, newline);
                state.buffer = state.buffer.slice(newline + 1);
                if (line.trim()) this.handle(state, line);
                newline = state.buffer.indexOf("\n");
            }
        });
        socket.on("error", () => { /* disconnect is recovery, not a coordinator failure */ });
        socket.on("close", () => { this.clients.delete(state); });
        this.send(socket, {
            type: "hello",
            version: COORDINATOR_PROTOCOL_VERSION,
            pid: process.pid,
            startedAt: this.startedAt,
            latestSeq: this.lastChangeSeq,
        });
    }

    private send(socket: Socket, reply: CoordinatorReply): void {
        if (socket.destroyed) return;
        try { socket.write(`${JSON.stringify(reply)}\n`); } catch { /* peer disappeared */ }
    }

    private handle(state: ClientState, line: string): void {
        let request: CoordinatorRequest;
        try {
            request = JSON.parse(line) as CoordinatorRequest;
        } catch {
            this.send(state.socket, { type: "error", code: "protocol", reason: "malformed JSON request" });
            return;
        }
        if (request.version !== COORDINATOR_PROTOCOL_VERSION) {
            this.send(state.socket, {
                type: "error",
                code: "protocol-version",
                reason: `coordinator protocol ${COORDINATOR_PROTOCOL_VERSION} is required`,
            });
            return;
        }
        if (typeof request.clientId === "string" && request.clientId.length > 0) state.clientId = request.clientId;
        switch (request.type) {
            case "hello":
                this.send(state.socket, {
                    type: "hello",
                    version: COORDINATOR_PROTOCOL_VERSION,
                    pid: process.pid,
                    startedAt: this.startedAt,
                    latestSeq: this.store.latestChangeSeq(),
                    ...(request.requestId ? { requestId: request.requestId } : {}),
                });
                return;
            case "subscribe": {
                const owners = Array.isArray(request.owners)
                    ? request.owners.map(ownerFromJson).filter((owner): owner is OwnerIdentity => owner !== undefined)
                    : [];
                state.owners = new Set(owners.map(ownerKey));
                const latestSeq = this.store.latestChangeSeq();
                for (const owner of owners) {
                    const key = ownerKey(owner);
                    const supplied = request.cursors?.[key] ?? 0;
                    let cursor = Number.isSafeInteger(supplied) ? Math.max(0, supplied) : 0;
                    const oldest = this.store.oldestChangeSeq();
                    const reset = oldest === null || cursor > latestSeq || cursor < oldest - 1;
                    if (reset) {
                        // A trimmed journal is not evidence that the owner has no
                        // results. Rebuild individual hints from owner-scoped state.
                        const operations = this.store.listOperations({ owner });
                        for (let offset = 0; offset < operations.length; offset += 500) {
                            const changes: CoordinatorChange[] = operations.slice(offset, offset + 500).map((operation) => ({
                                seq: latestSeq, at: this.now(), kind: operation.phase === "terminal" ? "terminal" : "snapshot",
                                owner, operationId: operation.operationId, taskId: operation.taskId,
                                terminalRevision: operation.terminalRevision, waitId: null, generation: null,
                            }));
                            this.send(state.socket, { type: "catchup", changes, latestSeq, ownerKey: key, cursor, reset: true });
                        }
                        cursor = latestSeq;
                    }
                    while (cursor < latestSeq) {
                        const changes = this.store.listChanges({ owner, afterSeq: cursor, throughSeq: latestSeq, limit: 500 });
                        if (changes.length === 0) break;
                        cursor = changes[changes.length - 1]!.seq;
                        this.send(state.socket, { type: "catchup", changes, latestSeq, ownerKey: key, cursor });
                    }
                    this.send(state.socket, { type: "catchup", changes: [], latestSeq, ownerKey: key, cursor: latestSeq, reset });
                }
                this.send(state.socket, {
                    type: "subscribed",
                    owners: owners.length,
                    latestSeq,
                    ...(request.requestId ? { requestId: request.requestId } : {}),
                });
                return;
            }
            case "reconcile":
                void this.reconcileOnce()
                    .then(() => this.send(state.socket, {
                        type: "reconciled",
                        latestSeq: this.lastChangeSeq,
                        ...(request.requestId ? { requestId: request.requestId } : {}),
                    }))
                    .catch((error) => this.send(state.socket, {
                        type: "error",
                        code: "reconcile",
                        reason: error instanceof Error ? error.message : String(error),
                    }));
                return;
            case "stats":
                this.send(state.socket, {
                    type: "stats",
                    stats: this.currentStats,
                    ...(request.requestId ? { requestId: request.requestId } : {}),
                });
                return;
            case "retention-preview": {
                this.stats.terminalScans += 1;
                try {
                    const preview = previewTaskRetention({
                        store: this.store,
                        supervisorDirectory: this.supervisorDirectory,
                        cutoff: request.cutoff,
                        limit: request.limit,
                    });
                    this.send(state.socket, {
                        type: "retention-preview",
                        preview: preview.preview,
                        artifactProtected: preview.artifactProtected,
                        ...(request.requestId ? { requestId: request.requestId } : {}),
                    });
                } catch (error) {
                    this.send(state.socket, {
                        type: "error",
                        code: "retention",
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
                return;
            }
            case "retention-apply": {
                this.stats.terminalScans += 1;
                try {
                    const result = applyTaskRetention({
                        store: this.store,
                        supervisorDirectory: this.supervisorDirectory,
                        cutoff: request.cutoff,
                        limit: request.limit,
                    });
                    this.send(state.socket, {
                        type: "retention-apply",
                        preview: result.preview,
                        units: result.units,
                        failed: result.failed,
                        ...(request.requestId ? { requestId: request.requestId } : {}),
                    });
                } catch (error) {
                    this.send(state.socket, {
                        type: "error",
                        code: "retention",
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
                return;
            }
            default:
                this.send(state.socket, { type: "error", code: "protocol", reason: "unknown coordinator request" });
        }
    }

    /**
     * One central running-set scan. This is the only high-frequency DB path and
     * its cost does not depend on how many clients are connected.
     */
    async reconcileOnce(): Promise<void> {
        if (this.closed || this.scanRunning) return;
        this.scanRunning = true;
        try {
            this.watchInputs();
            this.stats.runningScans += 1;
            this.stats.lastScanAt = this.now();
            const running = this.store.listOperations({ phase: "running" });
            const active = new Set<string>();
            for (const operation of running) {
                try { active.add(supervisorPaths(this.supervisorDirectory, operation.taskId).dir); }
                catch { /* malformed task paths never become watches */ }
            }
            for (const path of this.taskWatchers.keys()) {
                if (!active.has(path)) this.unwatchTask(path);
            }
            for (const operation of running) {
                if (this.closed) break;
                try {
                    const path = supervisorPaths(this.supervisorDirectory, operation.taskId).dir;
                    // The map is keyed by task directory; logs are deliberately ignored.
                    this.watchInput(this.taskWatchers, path, (name) => name === null || name === "result.json" || name === "lost.json");
                } catch { /* malformed task paths never become watches */ }
                let inspection: SupervisorInspection | undefined;
                try {
                    inspection = this.supervisor.inspect(operation.taskId, { recordLost: true });
                } catch {
                    inspection = undefined;
                }
                if (!inspection) {
                    if (this.now() - operation.createdAt >= 30_000) {
                        try {
                            this.store.recordTerminalOutcome({
                                operationId: operation.operationId,
                                eventId: `${operation.taskId}:missing:lost`,
                                outcome: "lost",
                                owner: operation.owner,
                                evidence: [{
                                    kind: "summary",
                                    ref: "lost.json",
                                    summary: "status=lost detailLost=true",
                                    detailLost: true,
                                }],
                                detailLost: true,
                                reason: "launch produced no durable supervisor record",
                            });
                            this.stats.reconciledTerminal += 1;
                        } catch { /* another host recorded the same terminal revision */ }
                    }
                    continue;
                }
                if (inspection.terminal) {
                    try {
                        const path = supervisorPaths(this.supervisorDirectory, operation.taskId).dir;
                        this.unwatchTask(path);
                    } catch { /* invalid path */ }
                    const status = inspection.status;
                    const outcome = terminalOutcome(status);
                    try {
                        const recorded = this.store.recordTerminalOutcome({
                            operationId: operation.operationId,
                            eventId: `${operation.taskId}:${inspection.result?.endedAt ?? inspection.lost?.recordedAt ?? inspection.observedAt}:${status}`,
                            outcome,
                            owner: operation.owner,
                            evidence: tailEvidence(inspection),
                            ...(outcome === "lost" ? { detailLost: true } : {}),
                            reason: inspection.result
                                ? `supervisor ${status} exit=${inspection.result.exitCode ?? "null"}`
                                : "supervisor lost: no terminal evidence",
                        });
                        if (recorded.recorded) this.stats.reconciledTerminal += 1;
                    } catch { /* a concurrent terminal record wins; the central scan is not an executor */ }
                    continue;
                }
                if (operation.health !== "active" || operation.supervision?.hostId !== this.hostId) {
                    try {
                        this.store.recordSupervision({
                            operationId: operation.operationId,
                            owner: operation.owner,
                            supervision: { hostId: this.hostId },
                            health: "active",
                        });
                    } catch { /* observational */ }
                }
            }
            this.broadcastChanges();
        } finally {
            this.scanRunning = false;
        }
    }

    private broadcastChanges(): void {
        if (this.clients.size === 0) {
            // No subscriber needs these yet; catch-up reads the durable log by owner.
            this.lastChangeSeq = this.store.latestChangeSeq();
            return;
        }
        const changes = this.store.listChanges({ afterSeq: this.lastChangeSeq, limit: 2_000 });
        if (changes.length === 0) return;
        this.stats.changeReads += 1;
        this.lastChangeSeq = changes[changes.length - 1]!.seq;
        for (const change of changes) {
            const key = ownerKey(change.owner);
            for (const client of this.clients) {
                if (!client.owners.has(key)) continue;
                this.send(client.socket, { type: "change", change });
            }
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.hintTimer) clearTimeout(this.hintTimer);
        this.hintTimer = undefined;
        for (const watchers of [this.inputWatchers, this.taskWatchers]) {
            for (const watcher of watchers.values()) watcher.close();
            watchers.clear();
        }
        for (const timer of this.timers.splice(0)) clearInterval(timer);
        for (const client of this.clients) {
            try { client.socket.destroy(); } catch { /* already gone */ }
        }
        this.clients.clear();
        try { this.netServer?.close(); } catch { /* already closed */ }
        if (process.platform !== "win32") {
            try { unlinkSync(this.paths.socket); } catch { /* already removed */ }
        }
        try { this.store.close(); } catch { /* already closed */ }
        if (this.lockAcquired) releaseLeadership(this.paths.lock, this.electionNonce);
        try { this.election?.close(); } catch { /* already closed */ }
        this.lockAcquired = false;
    }

}

/** Entry used by the emitted coordinator executable. */
export async function runCoordinatorProcess(options: CoordinatorServerOptions): Promise<number> {
    const started = await CoordinatorServer.start(options);
    if (!started.leader) return 0;
    const server = started.server!;
    const shutdown = (): void => {
        server.close();
        process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGHUP", shutdown);
    // The listening socket keeps the process alive. There is deliberately no
    // self-termination timer: an idle coordinator costs one bounded scan per
    // interval, while churning leaders would race every reconnect.
    await new Promise<never>(() => {});
    return 0;
}
