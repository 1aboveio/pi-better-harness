/**
 * Trusted parent-hosted local transport for worker operations.
 *
 * The host runs in the parent Pi process (or a supervisor process the parent
 * owns). A child receives only an endpoint and a per-run bearer token through
 * its environment. The host binds every request to the run registered for that
 * token and conversation, validates shape, size, cwd and task ownership, and
 * invokes injectable handlers.
 *
 * This module does NOT decide permissions. The handlers are the seam where the
 * coordinator intersects the worker's captured task authority with the current
 * Background profile. Passing a token proves only that this is the registered
 * child; it does not grant the right to launch or observe anything.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import {
    OPERATION_BRIDGE_ENV_KEYS,
    OPERATION_BRIDGE_VERSION,
    OperationBridgeError,
    type JsonRecord,
    type OperationBridgeCapabilities,
    type OperationBridgeDescriptor,
    type OperationBridgeErrorBody,
    type OperationBridgeLimits,
    type OperationBridgeRequestEnvelope,
    type OperationBridgeResponse,
    type OperationToolDescriptor,
    canonicalJson,
    cloneJson,
    createBridgeDescriptor,
    descriptorsForCapabilities,
    extractResultTaskIds,
    extractTaskIds,
    findAuthorityField,
    findBridgeEnvironmentKey,
    findSecretField,
    generateOperationBridgeToken,
    hashOperationBridgeToken,
    isInsideWorkspace,
    isLaunchTool,
    isValidTaskId,
    normalizeToolDescriptors,
    normalizeWaitForOperationsResult,
    operationBridgeErrorBody,
    redactSecret,
    validateCheckpointParams,
    validateHandshakeParams,
    validateJsonSchema,
    validateJsonSchemaSupport,
    validateParkFailedParams,
    validateRequestEnvelope,
} from "./operation-bridge-types.ts";

export interface OperationBridgeLogEvent {
    event: "listen" | "close" | "request" | "reject" | "register" | "rotate" | "revoke" | "checkpoint" | "park-failed";
    runId?: string;
    method?: string;
    requestId?: string;
    code?: string;
    ok?: boolean;
    bytes?: number;
}

/** Diagnostics must never receive a request body or a token. */
export type OperationBridgeLogger = (event: OperationBridgeLogEvent) => void;

export interface OperationRequestContext {
    runId: string;
    conversationId: string;
    /** Registered workspace root. A handler must use this, not a caller-supplied authority field. */
    cwd: string;
    /** Permission/authority snapshot reference owned by the parent. Never credential material. */
    authorityReference: string;
    requestId: string;
    tool: string;
    tokenGeneration: number;
    receivedAt: number;
    /** Aborted when the host's handler timeout elapses. Handlers should stop externally visible work. */
    signal: AbortSignal;
    /** Environment names the parent must strip before spawning any background task. */
    bridgeEnvironmentKeys: readonly string[];
}

export type OperationToolHandler = (
    params: JsonRecord,
    context: OperationRequestContext,
) => unknown | Promise<unknown>;

export type OperationCheckpointHandler = (
    params: JsonRecord,
    context: OperationRequestContext,
) => unknown | Promise<unknown>;

export type OperationOwnershipCheck = (
    taskId: string,
    context: OperationRequestContext,
) => boolean | Promise<boolean>;

/** Parent policy seam for the persisted checkpoint path, prefix and identity. */
export type OperationCheckpointEvidenceCheck = (
    evidence: JsonRecord,
    context: OperationRequestContext,
) => boolean | Promise<boolean>;

export interface OperationRunHandlers {
    bg_task_spawn?: OperationToolHandler;
    bg_task_watch?: OperationToolHandler;
    bg_task_status?: OperationToolHandler;
    bg_task_log?: OperationToolHandler;
    wait_for_operations?: OperationToolHandler;
    acknowledge_operation_result?: OperationToolHandler;
    /** Required when capabilities.parking is true. */
    checkpoint?: OperationCheckpointHandler;
    /** Required when capabilities.parking is true. */
    park_failed?: OperationCheckpointHandler;
}

export interface OperationRunRegistration {
    runId: string;
    conversationId: string;
    /** Canonical local workspace. Explicit request cwd values must stay inside it. */
    workspace: string;
    /** Reference to the parent-owned worker + Background authority snapshot. */
    authorityReference: string;
    capabilities: OperationBridgeCapabilities;
    /** Parent-supplied production schemas. Missing entries get the canonical bridge schema. */
    tools?: readonly OperationToolDescriptor[];
    /** Must return false for any task id the run does not own. */
    ownership: OperationOwnershipCheck;
    /**
     * Optional parent-owned check of the claimed checkpoint evidence. Use this
     * to require the trusted native session path and validate the saved prefix
     * against the parent's own records before the checkpoint handler runs.
     */
    checkpointEvidenceValidator?: OperationCheckpointEvidenceCheck;
    handlers: OperationRunHandlers;
    /** Test-only or pre-provisioned token. Production should omit this and use the generated value. */
    token?: string;
}

export interface OperationRunHandle {
    runId: string;
    token: string;
    descriptor: OperationBridgeDescriptor;
}

export interface OperationRunInfo {
    runId: string;
    conversationId: string;
    workspace: string;
    authorityReference: string;
    capabilities: OperationBridgeCapabilities;
    descriptor: OperationBridgeDescriptor;
    tokenGeneration: number;
    revoked: boolean;
    revokedReason?: string;
    inFlight: number;
    issuedWaitIds: readonly string[];
}

export interface CreateOperationBridgeHostOptions {
    /** `unix` is the default on macOS/Linux; `tcp` is loopback-only on Windows or on explicit request. */
    transport?: "unix" | "tcp";
    /** Directory that owns the Unix socket. The host removes it only when it created it. */
    socketDir?: string;
    /** Explicit Unix socket path. Defaults to `<socketDir>/operations.sock`. */
    socketPath?: string;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    requestTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    idleTimeoutMs?: number;
    maxInflightPerRun?: number;
    maxIdempotencyEntriesPerRun?: number;
    logger?: OperationBridgeLogger;
    now?: () => number;
    tokenFactory?: () => string;
}

export interface OperationBridgeHost {
    readonly endpoint: string;
    readonly transport: "unix" | "tcp";
    readonly limits: OperationBridgeLimits;
    registerRun(registration: OperationRunRegistration): OperationRunHandle;
    /**
     * Trusted parent-only reconciliation seam. After a host reload, the parent
     * can seed a wait generation that a still-running child may checkpoint.
     */
    markWaitIssued(runId: string, waitId: string, generation: number): void;
    rotateRunToken(runId: string): string;
    revokeRun(runId: string, reason?: string): void;
    unregisterRun(runId: string): void;
    getRun(runId: string): OperationRunInfo | undefined;
    close(): Promise<void>;
}

interface FrozenRegistration {
    runId: string;
    conversationId: string;
    workspace: string;
    authorityReference: string;
    capabilities: OperationBridgeCapabilities;
    tools: readonly OperationToolDescriptor[];
    ownership: OperationOwnershipCheck;
    checkpointEvidenceValidator?: OperationCheckpointEvidenceCheck;
    handlers: OperationRunHandlers;
    descriptor: OperationBridgeDescriptor;
}

interface IssuedWait {
    generation: number;
    requestId: string;
    checkpointed: boolean;
}

interface CachedLaunch {
    fingerprint: string;
    result: unknown;
}

interface LaunchClaim {
    fingerprint: string;
    /** `unknown` means the handler timed out after it may have started work; do not replay it here. */
    state: "running" | "unknown";
}

interface RunState {
    registration: FrozenRegistration;
    tokenHash: Buffer;
    tokenGeneration: number;
    staleTokenHashes: Set<string>;
    revoked: boolean;
    revokedReason?: string;
    inFlight: number;
    idempotency: Map<string, CachedLaunch>;
    /** Compact tombstone: a consumed launch key is never cleared by cache eviction. */
    consumedLaunchKeys: Map<string, string>;
    launchClaims: Map<string, LaunchClaim>;
    issuedWaits: Map<string, IssuedWait>;
    sockets: Set<Socket>;
}

interface ConnectionState {
    buffer: Buffer;
    handshake?: { runId: string; conversationId: string; tokenGeneration: number };
    authFailures: number;
    closed: boolean;
}

const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_INFLIGHT_PER_RUN = 8;
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 512;
const UNIX_PATH_LIMIT = 100;

export async function createOperationBridgeHost(
    options: CreateOperationBridgeHostOptions = {},
): Promise<OperationBridgeHost> {
    const transport = options.transport ?? (process.platform === "win32" ? "tcp" : "unix");
    const limits: OperationBridgeLimits = Object.freeze({
        maxRequestBytes: positiveInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes"),
        maxResponseBytes: positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes"),
        requestTimeoutMs: positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs"),
    });
    const handshakeTimeoutMs = positiveInteger(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, "handshakeTimeoutMs");
    const idleTimeoutMs = positiveInteger(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, "idleTimeoutMs");
    const maxInflightPerRun = positiveInteger(options.maxInflightPerRun, DEFAULT_MAX_INFLIGHT_PER_RUN, "maxInflightPerRun");
    const maxIdempotencyEntriesPerRun = positiveInteger(
        options.maxIdempotencyEntriesPerRun, DEFAULT_MAX_IDEMPOTENCY_ENTRIES, "maxIdempotencyEntriesPerRun",
    );
    const now = options.now ?? Date.now;
    const tokenFactory = options.tokenFactory ?? generateOperationBridgeToken;
    const logger = options.logger ?? (() => {});
    const runs = new Map<string, RunState>();
    const connectionRuns = new Map<Socket, string>();
    const sockets = new Set<Socket>();
    let closing = false;
    let closePromise: Promise<void> | undefined;

    let socketDir: string | undefined;
    let ownsSocketDir = false;
    let socketPath: string | undefined;
    let endpoint: string;
    if (transport === "unix") {
        if (options.socketPath) {
            socketPath = options.socketPath;
        } else if (options.socketDir) {
            socketDir = options.socketDir;
            socketPath = join(socketDir, "operations.sock");
        } else {
            socketDir = createDefaultSocketDir();
            ownsSocketDir = true;
            socketPath = join(socketDir, "operations.sock");
        }
        if (socketDir) mkdirSync(socketDir, { recursive: true, mode: 0o700 });
        if (socketDir) {
            try { chmodSync(socketDir, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
        }
        if (Buffer.byteLength(socketPath) > UNIX_PATH_LIMIT) {
            throw new Error(`Unix socket path is too long (${Buffer.byteLength(socketPath)} bytes): ${socketPath}`);
        }
        removeStaleSocket(socketPath);
        endpoint = `unix://${socketPath}`;
    } else {
        endpoint = "tcp://127.0.0.1:0";
    }

    const server = createServer();
    server.on("connection", (socket) => {
        connectionRuns.delete(socket);
        sockets.add(socket);
        handleConnection(socket);
    });

    try {
        await listen(server, transport, socketPath);
    } catch (error) {
        if (ownsSocketDir && socketDir) {
            try { rmSync(socketDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
        throw error;
    }
    if (transport === "unix" && socketPath) {
        try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }
    } else {
        const address = server.address();
        if (address && typeof address === "object") endpoint = `tcp://127.0.0.1:${address.port}`;
    }
    logger({ event: "listen", ok: true });
    const frozenLimits = Object.freeze(limits);

    function registerRun(registration: OperationRunRegistration): OperationRunHandle {
        assertOpen();
        if (!registration || typeof registration !== "object") throw new Error("registration is required");
        if (runs.has(registration.runId)) throw new Error(`Run ${registration.runId} is already registered`);
        if (!registration.runId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(registration.runId)) {
            throw new Error("runId is invalid");
        }
        if (!registration.conversationId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(registration.conversationId)) {
            throw new Error("conversationId is invalid");
        }
        if (!registration.workspace || typeof registration.workspace !== "string") throw new Error("workspace is required");
        const requestedWorkspace = resolve(registration.workspace);
        if (!existsSync(requestedWorkspace) || !statSync(requestedWorkspace).isDirectory()) {
            throw new Error(`workspace does not exist or is not a directory: ${requestedWorkspace}`);
        }
        const workspace = realpathSync.native(requestedWorkspace);
        if (!registration.authorityReference || typeof registration.authorityReference !== "string") {
            throw new Error("authorityReference is required");
        }
        if (typeof registration.ownership !== "function") throw new Error("ownership callback is required");
        const capabilities = normalizeCapabilities(registration.capabilities);
        const sourceTools = registration.tools && registration.tools.length
            ? registration.tools
            : descriptorsForCapabilities(capabilities);
        const tools = normalizeToolDescriptors(sourceTools, capabilities);
        for (const tool of tools) {
            const support = validateJsonSchemaSupport(tool.parameters);
            if (!support.ok) {
                throw new OperationBridgeError(
                    "invalid-request",
                    `${tool.name} schema: ${support.path}: ${support.message}`,
                );
            }
        }
        validateHandlers(registration.handlers, tools, capabilities);
        const initialToken = registration.token ?? tokenFactory();
        validateToken(initialToken);
        const descriptor = createBridgeDescriptor(
            registration.runId,
            registration.conversationId,
            tools,
            capabilities,
            frozenLimits,
        );
        const frozen: FrozenRegistration = Object.freeze({
            runId: registration.runId,
            conversationId: registration.conversationId,
            workspace,
            authorityReference: registration.authorityReference,
            capabilities,
            tools,
            ownership: registration.ownership,
            ...(registration.checkpointEvidenceValidator
                ? { checkpointEvidenceValidator: registration.checkpointEvidenceValidator }
                : {}),
            handlers: Object.freeze({ ...registration.handlers }),
            descriptor,
        });
        runs.set(registration.runId, {
            registration: frozen,
            tokenHash: hashOperationBridgeToken(initialToken),
            tokenGeneration: 1,
            staleTokenHashes: new Set(),
            revoked: false,
            inFlight: 0,
            idempotency: new Map(),
            consumedLaunchKeys: new Map(),
            launchClaims: new Map(),
            issuedWaits: new Map(),
            sockets: new Set(),
        });
        logger({ event: "register", runId: registration.runId, ok: true });
        return Object.freeze({ runId: registration.runId, token: initialToken, descriptor });
    }

    function markWaitIssued(runId: string, waitId: string, generation: number): void {
        assertOpen();
        const run = requireRun(runId);
        if (run.revoked) throw new Error(`Run ${runId} is revoked`);
        if (!waitId || typeof waitId !== "string" || !Number.isSafeInteger(generation) || generation < 1) {
            throw new Error("waitId and a positive generation are required");
        }
        const existing = run.issuedWaits.get(waitId);
        if (existing && existing.generation !== generation) {
            throw new Error(`wait ${waitId} is already issued at generation ${existing.generation}`);
        }
        run.issuedWaits.set(waitId, {
            generation,
            requestId: existing?.requestId ?? "parent-reconciled",
            checkpointed: existing?.checkpointed ?? false,
        });
    }

    function rotateRunToken(runId: string): string {
        assertOpen();
        const run = requireRun(runId);
        if (run.revoked) throw new Error(`Run ${runId} is revoked`);
        const next = tokenFactory();
        validateToken(next);
        run.staleTokenHashes.add(tokenHashKey(run.tokenHash));
        run.tokenHash = hashOperationBridgeToken(next);
        run.tokenGeneration += 1;
        logger({ event: "rotate", runId, ok: true });
        return next;
    }

    function revokeRun(runId: string, reason = "run revoked by the parent"): void {
        const run = runs.get(runId);
        if (!run) return;
        if (run.revoked) return;
        run.revoked = true;
        run.revokedReason = reason;
        run.staleTokenHashes.add(tokenHashKey(run.tokenHash));
        run.tokenHash = Buffer.alloc(0);
        run.idempotency.clear();
        run.consumedLaunchKeys.clear();
        run.launchClaims.clear();
        run.issuedWaits.clear();
        logger({ event: "revoke", runId, ok: true });
        // Keep live connections so the next request can receive a structured
        // `run-revoked` refusal. No handler is reachable after this point.
    }

    function unregisterRun(runId: string): void {
        revokeRun(runId, "run unregistered");
        runs.delete(runId);
    }

    function getRun(runId: string): OperationRunInfo | undefined {
        const run = runs.get(runId);
        if (!run) return undefined;
        return Object.freeze({
            runId: run.registration.runId,
            conversationId: run.registration.conversationId,
            workspace: run.registration.workspace,
            authorityReference: run.registration.authorityReference,
            capabilities: run.registration.capabilities,
            descriptor: run.registration.descriptor,
            tokenGeneration: run.tokenGeneration,
            revoked: run.revoked,
            ...(run.revokedReason ? { revokedReason: run.revokedReason } : {}),
            inFlight: run.inFlight,
            issuedWaitIds: Object.freeze([...run.issuedWaits.keys()]),
        });
    }

    function assertOpen(): void {
        if (closing) throw new OperationBridgeError("closed", "operation bridge is closed");
    }

    function requireRun(runId: string): RunState {
        const run = runs.get(runId);
        if (!run) throw new OperationBridgeError("run-unknown", "run is not registered");
        return run;
    }

    function handleConnection(socket: Socket): void {
        connectionRuns.set(socket, "");
        const state: ConnectionState = { buffer: Buffer.alloc(0), authFailures: 0, closed: false };
        let idleTimer: NodeJS.Timeout | undefined;
        let queue = Promise.resolve();
        const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => socket.destroy(), state.handshake ? idleTimeoutMs : handshakeTimeoutMs);
            idleTimer.unref?.();
        };
        resetIdle();
        socket.setNoDelay?.(true);
        socket.on("data", (chunk: Buffer) => {
            if (state.closed) return;
            resetIdle();
            state.buffer = Buffer.concat([state.buffer, chunk]);
            if (state.buffer.length > limits.maxRequestBytes && state.buffer.indexOf(10) < 0) {
                queue = queue.then(() => {
                    sendError(socket, "", {
                        code: "request-too-large",
                        message: `request exceeds ${limits.maxRequestBytes} bytes`,
                    });
                    socket.end();
                });
                return;
            }
            let newline = state.buffer.indexOf(10);
            while (newline >= 0) {
                const line = state.buffer.subarray(0, newline);
                state.buffer = state.buffer.subarray(newline + 1);
                if (line.length > limits.maxRequestBytes) {
                    queue = queue.then(() => {
                        sendError(socket, "", {
                            code: "request-too-large",
                            message: `request exceeds ${limits.maxRequestBytes} bytes`,
                        });
                        socket.end();
                    });
                } else if (line.length > 0) {
                    const text = line.toString("utf8");
                    queue = queue.then(() => handleLine(text, socket, state));
                }
                newline = state.buffer.indexOf(10);
            }
        });
        socket.on("error", () => { state.closed = true; if (idleTimer) clearTimeout(idleTimer); });
        socket.on("close", () => {
            state.closed = true;
            if (idleTimer) clearTimeout(idleTimer);
            const runId = connectionRuns.get(socket);
            connectionRuns.delete(socket);
            sockets.delete(socket);
            if (runId) runs.get(runId)?.sockets.delete(socket);
        });
    }

    async function handleLine(text: string, socket: Socket, state: ConnectionState): Promise<void> {
        if (state.closed) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            sendError(socket, "", { code: "invalid-json", message: "request is not valid JSON" });
            return;
        }
        const envelopeResult = validateRequestEnvelope(parsed);
        if (!envelopeResult.ok) {
            sendError(socket, envelopeResult.id, {
                code: envelopeResult.message === "invalid token shape" ? "invalid-token" : "invalid-request",
                message: envelopeResult.message,
            });
            logger({ event: "reject", requestId: envelopeResult.id || undefined, code: "invalid-request" });
            return;
        }
        const envelope = envelopeResult.envelope;
        let run: RunState;
        try {
            run = authenticate(envelope);
        } catch (error) {
            state.authFailures += 1;
            const body = operationBridgeErrorBody(error, envelope.token);
            sendError(socket, envelope.id, body);
            logger({ event: "reject", runId: envelope.runId, method: envelope.method, requestId: envelope.id, code: body.code });
            if (state.authFailures >= 5) socket.destroy();
            return;
        }
        const runId = run.registration.runId;
        connectionRuns.set(socket, runId);
        run.sockets.add(socket);

        if (envelope.conversationId !== run.registration.conversationId) {
            sendError(socket, envelope.id, {
                code: "conversation-mismatch",
                message: "request conversation does not match the registered run",
            });
            logger({ event: "reject", runId, method: envelope.method, requestId: envelope.id, code: "conversation-mismatch" });
            return;
        }

        if (envelope.method === "handshake") {
            const params = validateHandshakeParams(envelope.params);
            if (!params.ok) {
                sendError(socket, envelope.id, { code: "invalid-request", message: params.message });
                return;
            }
            state.handshake = { runId, conversationId: run.registration.conversationId, tokenGeneration: run.tokenGeneration };
            sendResult(socket, envelope.id, run.registration.descriptor);
            logger({ event: "request", runId, method: envelope.method, requestId: envelope.id, ok: true });
            return;
        }

        if (envelope.method === "ping") {
            sendResult(socket, envelope.id, {
                bridgeVersion: OPERATION_BRIDGE_VERSION,
                runId,
                conversationId: run.registration.conversationId,
                tokenGeneration: run.tokenGeneration,
            });
            logger({ event: "request", runId, method: envelope.method, requestId: envelope.id, ok: true });
            return;
        }

        if (!state.handshake || state.handshake.runId !== runId ||
            state.handshake.conversationId !== run.registration.conversationId) {
            sendError(socket, envelope.id, {
                code: "handshake-required",
                message: "a compatible handshake is required before this method",
            });
            logger({ event: "reject", runId, method: envelope.method, requestId: envelope.id, code: "handshake-required" });
            return;
        }

        if (envelope.method === "close") {
            sendResult(socket, envelope.id, { closed: true });
            socket.end();
            return;
        }

        const contextBase = makeContext(run, envelope, new AbortController().signal);
        try {
            if (envelope.method === "checkpoint") {
                await handleCheckpoint(run, envelope, contextBase, socket);
                return;
            }
            if (envelope.method === "park_failed") {
                await handleParkFailed(run, envelope, contextBase, socket);
                return;
            }
            await handleTool(run, envelope, socket);
        } catch (error) {
            const body = operationBridgeErrorBody(error, envelope.token);
            sendError(socket, envelope.id, body);
            logger({ event: "reject", runId, method: envelope.method, requestId: envelope.id, code: body.code });
        }
    }

    function authenticate(envelope: OperationBridgeRequestEnvelope): RunState {
        const run = runs.get(envelope.runId);
        if (!run) throw new OperationBridgeError("run-unknown", "run is not registered");
        if (run.revoked) throw new OperationBridgeError("run-revoked", "run has been revoked");
        const presented = hashOperationBridgeToken(envelope.token);
        if (run.tokenHash.length === presented.length && timingSafeEqual(run.tokenHash, presented)) return run;
        if (run.staleTokenHashes.has(tokenHashKey(presented))) {
            throw new OperationBridgeError("stale-token", "token was rotated or revoked", false);
        }
        throw new OperationBridgeError("invalid-token", "invalid bearer token", false);
    }

    function makeContext(run: RunState, envelope: OperationBridgeRequestEnvelope, signal: AbortSignal): OperationRequestContext {
        return {
            runId: run.registration.runId,
            conversationId: run.registration.conversationId,
            cwd: run.registration.workspace,
            authorityReference: run.registration.authorityReference,
            requestId: envelope.id,
            tool: envelope.method,
            tokenGeneration: run.tokenGeneration,
            receivedAt: now(),
            signal,
            bridgeEnvironmentKeys: OPERATION_BRIDGE_ENV_KEYS,
        };
    }

    async function handleTool(run: RunState, envelope: OperationBridgeRequestEnvelope, socket: Socket): Promise<void> {
        const tool = envelope.method;
        const descriptor = run.registration.tools.find((entry) => entry.name === tool);
        if (!descriptor) {
            sendError(socket, envelope.id, { code: "unsupported-tool", message: `${tool} is not enabled for this run` });
            logger({ event: "reject", runId: run.registration.runId, method: tool, requestId: envelope.id, code: "unsupported-tool" });
            return;
        }
        const handler = run.registration.handlers[tool as keyof OperationRunHandlers];
        if (typeof handler !== "function") {
            sendError(socket, envelope.id, { code: "unsupported-tool", message: `${tool} has no handler` });
            return;
        }
        const params = (envelope.params ?? {}) as JsonRecord;
        if (findSecretField(params)) {
            sendError(socket, envelope.id, { code: "authority-field", message: "request contains a credential-shaped field" });
            return;
        }
        const bridgeEnvironmentField = findBridgeEnvironmentKey(params);
        if (bridgeEnvironmentField) {
            sendError(socket, envelope.id, {
                code: "bridge-env-leak",
                message: `${bridgeEnvironmentField} is a parent bridge credential and cannot be passed to a launched task`,
            });
            logger({ event: "reject", runId: run.registration.runId, method: tool, requestId: envelope.id, code: "bridge-env-leak" });
            return;
        }
        const authorityField = findAuthorityField(params);
        if (authorityField) {
            sendError(socket, envelope.id, {
                code: "authority-field",
                message: `caller field ${authorityField} would override parent authority`,
            });
            logger({ event: "reject", runId: run.registration.runId, method: tool, requestId: envelope.id, code: "authority-field" });
            return;
        }
        const schema = validateJsonSchema(descriptor.parameters, params);
        if (!schema.ok) {
            sendError(socket, envelope.id, {
                code: "schema-invalid",
                message: `${schema.path}: ${schema.message}`,
            });
            return;
        }
        if (params.cwd !== undefined) {
            if (typeof params.cwd !== "string" || !params.cwd) {
                sendError(socket, envelope.id, { code: "cwd-invalid", message: "cwd must be a non-empty string" });
                return;
            }
            const candidate = resolve(run.registration.workspace, params.cwd);
            let resolvedCwd: string;
            try {
                resolvedCwd = realpathSync.native(candidate);
                if (!statSync(resolvedCwd).isDirectory()) throw new Error("not a directory");
            } catch {
                sendError(socket, envelope.id, {
                    code: "cwd-invalid",
                    message: "cwd does not resolve to an existing directory",
                });
                return;
            }
            if (!isInsideWorkspace(run.registration.workspace, resolvedCwd)) {
                sendError(socket, envelope.id, {
                    code: "cwd-outside",
                    message: "cwd is outside the registered worker workspace",
                });
                logger({ event: "reject", runId: run.registration.runId, method: tool, requestId: envelope.id, code: "cwd-outside" });
                return;
            }
        }

        const launch = isLaunchTool(tool, params);
        const idempotencyKey = launch ? envelope.key : undefined;
        if (launch && !idempotencyKey) {
            sendError(socket, envelope.id, {
                code: "idempotency-key-required",
                message: "launch requests require an idempotency key",
            });
            return;
        }
        const fingerprint = launch ? createHash("sha256")
            .update(canonicalJson({ tool, params }), "utf8")
            .digest("hex") : undefined;
        if (idempotencyKey && fingerprint) {
            const cached = run.idempotency.get(idempotencyKey);
            if (cached) {
                if (cached.fingerprint !== fingerprint) {
                    sendError(socket, envelope.id, {
                        code: "idempotency-conflict",
                        message: "idempotency key was already used with different launch parameters",
                    });
                    return;
                }
                sendResult(socket, envelope.id, cloneJson(cached.result));
                logger({ event: "request", runId: run.registration.runId, method: tool, requestId: envelope.id, ok: true });
                return;
            }
            const consumed = run.consumedLaunchKeys.get(idempotencyKey);
            if (consumed) {
                if (consumed !== fingerprint) {
                    sendError(socket, envelope.id, {
                        code: "idempotency-conflict",
                        message: "idempotency key was already consumed with different launch parameters",
                    });
                    return;
                }
                // The launch completed, but its result was evicted. Never run it
                // again; the caller must reconcile the existing operation.
                sendError(socket, envelope.id, {
                    code: "idempotency-evicted",
                    message: "this launch already completed and its cached result was evicted; reconcile instead of retrying",
                });
                logger({ event: "reject", runId: run.registration.runId, method: tool, requestId: envelope.id, code: "idempotency-evicted" });
                return;
            }
        }

        let launchClaim: LaunchClaim | undefined;
        if (idempotencyKey && fingerprint) {
            const existing = run.launchClaims.get(idempotencyKey);
            if (existing) {
                if (existing.fingerprint !== fingerprint) {
                    sendError(socket, envelope.id, {
                        code: "idempotency-conflict",
                        message: "idempotency key was already used with different launch parameters",
                    });
                    return;
                }
                sendError(socket, envelope.id, existing.state === "unknown" ? {
                    code: "launch-outcome-unknown",
                    message: "the earlier launch may have started but its outcome is unknown; reconcile before retrying",
                } : {
                    code: "launch-in-progress",
                    message: "the same launch is already in progress; reuse its result instead of starting another",
                    retryable: true,
                });
                return;
            }
            launchClaim = { fingerprint, state: "running" };
            run.launchClaims.set(idempotencyKey, launchClaim);
        }

        if (run.inFlight >= maxInflightPerRun) {
            if (idempotencyKey) run.launchClaims.delete(idempotencyKey);
            sendError(socket, envelope.id, {
                code: "too-many-requests",
                message: "too many in-flight requests for this run",
                retryable: true,
            });
            return;
        }

        const controller = new AbortController();
        const context = makeContext(run, envelope, controller.signal);
        run.inFlight += 1;
        let timeout: NodeJS.Timeout | undefined;
        try {
            const taskIds = extractTaskIds(tool, params);
            for (const taskId of taskIds) {
                if (!isValidTaskId(taskId)) {
                    sendError(socket, envelope.id, { code: "task-invalid", message: "invalid task id" });
                    return;
                }
                if (!(await ownedTask(run, taskId, context))) {
                    sendError(socket, envelope.id, {
                        code: "foreign-task",
                        message: `task ${taskId} is not owned by this conversation`,
                    });
                    logger({ event: "reject", runId: run.registration.runId, method: tool, requestId: envelope.id, code: "foreign-task" });
                    return;
                }
            }
            const timed = new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    controller.abort();
                    reject(new OperationBridgeError(
                        "handler-timeout",
                        `handler did not complete within ${limits.requestTimeoutMs} ms`,
                        true,
                    ));
                }, limits.requestTimeoutMs);
                timeout.unref?.();
            });
            const result = await Promise.race([Promise.resolve(handler(params, context)), timed]);
            if (findSecretField(result)) {
                throw new OperationBridgeError("secret-in-result", "handler result contains a credential-shaped field");
            }
            const resultEnvironmentField = findBridgeEnvironmentKey(result);
            if (resultEnvironmentField) {
                throw new OperationBridgeError("bridge-env-leak", `handler result contains bridge credential ${resultEnvironmentField}`);
            }
            const cloned = cloneJson(result);
            // Every tool result is checked before any side effect (wait
            // registration, idempotency cache, or send). A read or wait handler
            // must not be able to return a foreign task the requested id did not
            // authorize.
            const resultTaskIds = extractResultTaskIds(cloned);
            for (const taskId of resultTaskIds) {
                if (!isValidTaskId(taskId)) {
                    throw new OperationBridgeError("foreign-result-task", "handler returned an invalid task id");
                }
                if (!(await ownedTask(run, taskId, context))) {
                    throw new OperationBridgeError("foreign-result-task", `handler returned foreign task ${taskId}`);
                }
            }
            if (tool === "wait_for_operations") {
                const wait = normalizeWaitForOperationsResult(cloned);
                if (!wait.ok) throw new OperationBridgeError("response-invalid", wait.message);
                if (wait.result.park && !wait.result.settled) {
                    run.issuedWaits.set(wait.result.waitId, {
                        generation: wait.result.generation,
                        requestId: envelope.id,
                        checkpointed: false,
                    });
                }
            }
            if (idempotencyKey && fingerprint) {
                if (run.idempotency.size >= maxIdempotencyEntriesPerRun) {
                    const oldest = run.idempotency.keys().next();
                    if (!oldest.done) run.idempotency.delete(oldest.value);
                }
                run.idempotency.set(idempotencyKey, { fingerprint, result: cloneJson(cloned) });
                run.consumedLaunchKeys.set(idempotencyKey, fingerprint);
                run.launchClaims.delete(idempotencyKey);
            }
            sendResult(socket, envelope.id, cloned);
            logger({ event: "request", runId: run.registration.runId, method: tool, requestId: envelope.id, ok: true });
        } catch (error) {
            const body = operationBridgeErrorBody(error, envelope.token);
            if (idempotencyKey && launchClaim) {
                // A timeout is ambiguous: the handler may already have launched.
                // Keep the claim so a transport replay cannot start a second one.
                if (body.code === "handler-timeout") launchClaim.state = "unknown";
                else run.launchClaims.delete(idempotencyKey);
            }
            sendError(socket, envelope.id, body);
            logger({ event: "reject", runId: run.registration.runId, method: tool, requestId: envelope.id, code: body.code });
        } finally {
            if (timeout) clearTimeout(timeout);
            if (idempotencyKey && launchClaim?.state === "running") run.launchClaims.delete(idempotencyKey);
            run.inFlight = Math.max(0, run.inFlight - 1);
        }
    }

    async function handleCheckpoint(
        run: RunState,
        envelope: OperationBridgeRequestEnvelope,
        context: OperationRequestContext,
        socket: Socket,
    ): Promise<void> {
        const params = validateCheckpointParams(envelope.params);
        if (!params.ok) {
            sendError(socket, envelope.id, { code: "checkpoint-invalid", message: params.message });
            return;
        }
        const waitId = params.value.wait_id;
        const generation = params.value.generation;
        const issued = typeof waitId === "string" ? run.issuedWaits.get(waitId) : undefined;
        if (!issued || issued.generation !== generation) {
            sendError(socket, envelope.id, {
                code: "unknown-wait",
                message: "checkpoint does not name a wait generation issued to this run",
            });
            return;
        }
        const evidence = params.value.evidence as JsonRecord;
        if (evidence.waitId !== waitId || evidence.generation !== generation ||
            evidence.toolCallId !== params.value.tool_call_id) {
            sendError(socket, envelope.id, {
                code: "checkpoint-invalid",
                message: "checkpoint evidence does not match the wait identity",
            });
            return;
        }
        if (run.registration.checkpointEvidenceValidator) {
            let accepted = false;
            try {
                accepted = (await run.registration.checkpointEvidenceValidator(evidence, context)) === true;
            } catch {
                accepted = false;
            }
            if (!accepted) {
                sendError(socket, envelope.id, {
                    code: "checkpoint-invalid",
                    message: "the parent rejected the checkpoint evidence",
                });
                return;
            }
        }
        const handler = run.registration.handlers.checkpoint;
        if (typeof handler !== "function") {
            sendError(socket, envelope.id, { code: "unsupported", message: "this run cannot record checkpoints" });
            return;
        }
        try {
            const result = cloneJson(await invokeCheckpointHandler(handler, params.value, context));
            if (findSecretField(result)) {
                throw new OperationBridgeError("secret-in-result", "checkpoint result contains a credential-shaped field");
            }
            issued.checkpointed = true;
            sendResult(socket, envelope.id, result);
            logger({ event: "checkpoint", runId: run.registration.runId, requestId: envelope.id, ok: true });
        } catch (error) {
            const body = operationBridgeErrorBody(error, envelope.token);
            sendError(socket, envelope.id, body);
            logger({ event: "reject", runId: run.registration.runId, method: "checkpoint", requestId: envelope.id, code: body.code });
        }
    }

    async function handleParkFailed(
        run: RunState,
        envelope: OperationBridgeRequestEnvelope,
        context: OperationRequestContext,
        socket: Socket,
    ): Promise<void> {
        const params = validateParkFailedParams(envelope.params);
        if (!params.ok) {
            sendError(socket, envelope.id, { code: "checkpoint-invalid", message: params.message });
            return;
        }
        const waitId = params.value.wait_id;
        const generation = params.value.generation;
        const issued = typeof waitId === "string" ? run.issuedWaits.get(waitId) : undefined;
        if (!issued || issued.generation !== generation) {
            sendError(socket, envelope.id, {
                code: "unknown-wait",
                message: "park failure does not name a wait generation issued to this run",
            });
            return;
        }
        const handler = run.registration.handlers.park_failed;
        if (typeof handler !== "function") {
            // A failed park is still explicit: the child has been told it may not
            // shut down. The parent log is the fallback when no handler is wired.
            sendError(socket, envelope.id, { code: "unsupported", message: "this run cannot record park failures" });
            return;
        }
        try {
            const result = cloneJson(await invokeCheckpointHandler(handler, params.value, context));
            sendResult(socket, envelope.id, result);
            logger({ event: "park-failed", runId: run.registration.runId, requestId: envelope.id, ok: true });
        } catch (error) {
            const body = operationBridgeErrorBody(error, envelope.token);
            sendError(socket, envelope.id, body);
            logger({ event: "reject", runId: run.registration.runId, method: "park_failed", requestId: envelope.id, code: body.code });
        }
    }

    async function invokeCheckpointHandler(
        handler: OperationCheckpointHandler,
        params: JsonRecord,
        context: OperationRequestContext,
    ): Promise<unknown> {
        let timeout: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                Promise.resolve(handler(params, context)),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => {
                        reject(new OperationBridgeError("handler-timeout", "checkpoint handler timed out", true));
                    }, limits.requestTimeoutMs);
                    timeout.unref?.();
                }),
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    async function ownedTask(run: RunState, taskId: string, context: OperationRequestContext): Promise<boolean> {
        try {
            return (await run.registration.ownership(taskId, context)) === true;
        } catch (error) {
            throw new OperationBridgeError(
                "ownership-error",
                `ownership check failed: ${redactSecret(error instanceof Error ? error.message : String(error))}`,
            );
        }
    }

    function sendResult(socket: Socket, id: string, result: unknown): void {
        send(socket, { v: OPERATION_BRIDGE_VERSION, id, ok: true, result });
    }

    function sendError(socket: Socket, id: string, error: OperationBridgeErrorBody): void {
        send(socket, { v: OPERATION_BRIDGE_VERSION, id, ok: false, error });
    }

    function send(socket: Socket, response: OperationBridgeResponse): void {
        if (socket.destroyed || !socket.writable) return;
        let encoded = JSON.stringify(response);
        if (Buffer.byteLength(encoded) > limits.maxResponseBytes) {
            encoded = JSON.stringify({
                v: OPERATION_BRIDGE_VERSION,
                id: response.id,
                ok: false,
                error: {
                    code: "response-too-large",
                    message: `response exceeds ${limits.maxResponseBytes} bytes`,
                },
            } satisfies OperationBridgeResponse);
        }
        socket.write(`${encoded}\n`);
    }

    function close(): Promise<void> {
        if (closePromise) return closePromise;
        closing = true;
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        for (const run of runs.values()) {
            run.sockets.clear();
        }
        closePromise = new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
        }).then(() => {
            if (socketPath) {
                try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* best effort */ }
            }
            if (ownsSocketDir && socketDir) {
                try { rmSync(socketDir, { recursive: true, force: true }); } catch { /* best effort */ }
            }
            logger({ event: "close", ok: true });
        });
        return closePromise;
    }

    return Object.freeze({
        endpoint,
        transport,
        limits: frozenLimits,
        registerRun,
        markWaitIssued,
        rotateRunToken,
        revokeRun,
        unregisterRun,
        getRun,
        close,
    });
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
}

function normalizeCapabilities(value: OperationBridgeCapabilities): OperationBridgeCapabilities {
    if (!value || typeof value !== "object") throw new Error("capabilities are required");
    const background = value.background;
    if (!background || typeof background !== "object") throw new Error("capabilities.background is required");
    const booleans = ["spawn", "watch", "status", "log"] as const;
    for (const key of booleans) {
        if (typeof background[key] !== "boolean") throw new Error(`capabilities.background.${key} must be boolean`);
    }
    for (const key of ["wait", "acknowledge", "parking"] as const) {
        if (typeof value[key] !== "boolean") throw new Error(`capabilities.${key} must be boolean`);
    }
    return Object.freeze({
        background: Object.freeze({
            spawn: background.spawn,
            watch: background.watch,
            status: background.status,
            log: background.log,
        }),
        wait: value.wait,
        acknowledge: value.acknowledge,
        parking: value.parking,
    });
}

function validateHandlers(
    handlers: OperationRunHandlers,
    tools: readonly OperationToolDescriptor[],
    capabilities: OperationBridgeCapabilities,
): void {
    if (!handlers || typeof handlers !== "object") throw new Error("handlers are required");
    for (const tool of tools) {
        if (typeof handlers[tool.name as keyof OperationRunHandlers] !== "function") {
            throw new Error(`${tool.name} requires a handler`);
        }
    }
    if (capabilities.parking) {
        if (typeof handlers.checkpoint !== "function") throw new Error("parking requires a checkpoint handler");
        if (typeof handlers.park_failed !== "function") throw new Error("parking requires a park_failed handler");
    }
}

function validateToken(token: string): void {
    if (typeof token !== "string" || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) {
        throw new Error("operation bridge token must be 32-512 characters without newlines");
    }
}

function tokenHashKey(hash: Buffer): string {
    return hash.toString("hex");
}

/** Keeps the Unix socket under the platform path limit even when TMPDIR is deeply nested. */
function createDefaultSocketDir(): string {
    const candidates = [tmpdir(), "/tmp", "/var/tmp"];
    let lastError: unknown;
    for (const base of candidates) {
        try {
            const dir = mkdtempSync(join(base, "pi-op-bridge-"));
            if (Buffer.byteLength(join(dir, "operations.sock")) <= UNIX_PATH_LIMIT) return dir;
            try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        } catch (error) {
            lastError = error;
        }
    }
    throw new Error(`cannot create a short Unix socket directory: ${lastError instanceof Error ? lastError.message : "no candidate"}`);
}

function removeStaleSocket(path: string): void {
    if (!existsSync(path)) return;
    try {
        const stat = lstatSync(path);
        if (stat.isSocket()) unlinkSync(path);
        else throw new Error(`refusing to replace a non-socket path: ${path}`);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("refusing")) throw error;
        throw new Error(`cannot prepare Unix socket path ${path}`);
    }
}

function listen(server: Server, transport: "unix" | "tcp", socketPath: string | undefined): Promise<void> {
    return new Promise((resolveListen, rejectListen) => {
        const onError = (error: Error) => {
            server.off("listening", onListening);
            rejectListen(error);
        };
        const onListening = () => {
            server.off("error", onError);
            resolveListen();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        if (transport === "unix") server.listen(socketPath);
        else server.listen(0, "127.0.0.1");
    });
}
