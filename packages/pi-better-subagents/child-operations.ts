/**
 * Child-side operation bridge.
 *
 * The child receives an endpoint and a per-run token from the parent through
 * its environment. It exposes only the tools named by the parent's handshake
 * descriptor and forwards each call to the trusted parent host. It loads no
 * background runner, task registry or shell-spawn path of its own, so a worker
 * cannot widen execution by importing this module.
 *
 * Parking is deliberately fail-closed. A `wait_for_operations` result that asks
 * the worker to park is not enough to exit: after the tool result is part of the
 * saved native conversation, `completePendingPark` verifies that durable
 * checkpoint, records it with the host, and only then calls the public SDK's
 * `ctx.shutdown()`. If any step cannot be proven, the child reports a park
 * failure and keeps running; it never simulates a successful park.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import * as piSdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureParkCheckpoint, type ParkCheckpoint } from "./park-checkpoint.ts";
import {
    ACKNOWLEDGE_OPERATION_TOOL,
    OPERATION_BRIDGE_ENV_KEYS,
    OPERATION_BRIDGE_TOOL_NAMES,
    OPERATION_BRIDGE_VERSION,
    OPERATIONS_ATTEMPT_ID_ENV,
    OPERATIONS_CHILD_ID_ENV,
    OPERATIONS_CONVERSATION_ID_ENV,
    OPERATIONS_ENABLED_ENV,
    OPERATIONS_ENDPOINT_ENV,
    OPERATIONS_RUN_ID_ENV,
    OPERATIONS_TOKEN_ENV,
    OPERATIONS_WRITER_LEASE_ID_ENV,
    WAIT_OPERATIONS_TOOL,
    OperationBridgeError,
    OperationToolError,
    type JsonRecord,
    type NormalizedWaitResult,
    type OperationBridgeCapabilities,
    type OperationBridgeDescriptor,
    type OperationBridgeErrorCode,
    type OperationBridgeLimits,
    type OperationBridgeMethod,
    type OperationToolDescriptor,
    type OperationBridgeToolName,
    cloneJson,
    deepFreeze,
    descriptorFingerprint,
    findBridgeEnvironmentKey,
    isLaunchTool,
    normalizeWaitForOperationsResult,
    parseBridgeEndpoint,
    validateJsonSchemaSupport,
    redactSecret,
} from "./operation-bridge-types.ts";

// ---- configuration ---------------------------------------------------------

export interface ChildOperationBridgeConfig {
    endpoint: string;
    token: string;
    runId: string;
    conversationId: string;
    attemptId?: string;
    writerLeaseId?: string;
    childId?: string;
    requestTimeoutMs?: number;
}

export type ChildOperationBridgeConfigResult =
    | { status: "disabled"; reason: string }
    | { status: "invalid"; reason: string }
    | { status: "ready"; config: ChildOperationBridgeConfig };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

/** Namespace access keeps an older SDK without a VERSION export from failing at import time. */
const PI_CODING_AGENT_VERSION = (piSdk as { VERSION?: string }).VERSION;

/** First SDK line with the public `terminate` tool-result boundary used for parking. */
export const MIN_PARKING_SDK_VERSION = "0.82.1";

export function supportsParkingBoundary(version: string | undefined = PI_CODING_AGENT_VERSION): boolean {
    if (typeof version !== "string") return false;
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    const minimum = [0, 82, 1];
    for (let index = 0; index < minimum.length; index += 1) {
        const actual = [major, minor, patch][index]!;
        if (actual > minimum[index]!) return true;
        if (actual < minimum[index]!) return false;
    }
    return true;
}

/** Reads the parent-provided child environment without touching any other session source. */
export function readChildOperationBridgeConfig(env: NodeJS.ProcessEnv = process.env): ChildOperationBridgeConfigResult {
    const required = [
        OPERATIONS_ENDPOINT_ENV,
        OPERATIONS_TOKEN_ENV,
        OPERATIONS_RUN_ID_ENV,
        OPERATIONS_CONVERSATION_ID_ENV,
    ];
    if (env[OPERATIONS_ENABLED_ENV] === "0" || env[OPERATIONS_ENABLED_ENV] === "false") {
        return { status: "disabled", reason: "parent disabled the operation bridge for this run" };
    }
    const explicitlyEnabled = env[OPERATIONS_ENABLED_ENV] === "1" || env[OPERATIONS_ENABLED_ENV] === "true";
    const present = required.filter((key) => typeof env[key] === "string" && env[key]!.length > 0);
    if (!explicitlyEnabled && present.length === 0) {
        return { status: "disabled", reason: "no parent operation bridge environment" };
    }
    if (present.length !== required.length) {
        return { status: "invalid", reason: "operation bridge environment is incomplete" };
    }
    const endpoint = env[OPERATIONS_ENDPOINT_ENV]!;
    const token = env[OPERATIONS_TOKEN_ENV]!;
    const runId = env[OPERATIONS_RUN_ID_ENV]!;
    const conversationId = env[OPERATIONS_CONVERSATION_ID_ENV]!;
    try {
        parseBridgeEndpoint(endpoint);
    } catch {
        return { status: "invalid", reason: "operation bridge endpoint is not a supported local endpoint" };
    }
    if (token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) {
        return { status: "invalid", reason: "operation bridge token has an invalid shape" };
    }
    if (!ID_PATTERN.test(runId) || !ID_PATTERN.test(conversationId)) {
        return { status: "invalid", reason: "operation bridge run identity is invalid" };
    }
    return {
        status: "ready",
        config: {
            endpoint,
            token,
            runId,
            conversationId,
            ...(env[OPERATIONS_ATTEMPT_ID_ENV] ? { attemptId: env[OPERATIONS_ATTEMPT_ID_ENV]! } : {}),
            ...(env[OPERATIONS_WRITER_LEASE_ID_ENV] ? { writerLeaseId: env[OPERATIONS_WRITER_LEASE_ID_ENV]! } : {}),
            ...(env[OPERATIONS_CHILD_ID_ENV] ? { childId: env[OPERATIONS_CHILD_ID_ENV]! } : {}),
        },
    };
}

// ---- transport client ------------------------------------------------------

interface PendingRequest {
    id: string;
    method: OperationBridgeMethod;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer?: NodeJS.Timeout;
    removeAbort?: () => void;
}

export interface OperationBridgeClientOptions {
    requestTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    maxResponseBytes?: number;
    clientName?: string;
    clientVersion?: string;
}

export interface OperationBridgeClient {
    readonly endpoint: string;
    readonly config: Readonly<ChildOperationBridgeConfig>;
    readonly descriptor: OperationBridgeDescriptor | undefined;
    handshake(): Promise<OperationBridgeDescriptor>;
    request(
        method: OperationBridgeMethod,
        params: JsonRecord,
        options?: { timeoutMs?: number; signal?: AbortSignal; idempotencyKey?: string },
    ): Promise<unknown>;
    close(): Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function createOperationBridgeClient(
    config: ChildOperationBridgeConfig,
    options: OperationBridgeClientOptions = {},
): OperationBridgeClient {
    const endpoint = parseBridgeEndpoint(config.endpoint);
    const requestTimeoutMs = positive(options.requestTimeoutMs ?? config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    const handshakeTimeoutMs = positive(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    const maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    const client = {
        name: options.clientName ?? "pi-better-subagents-child",
        version: options.clientVersion ?? "1",
    };
    let socket: Socket | undefined;
    let buffer = Buffer.alloc(0);
    let connectPromise: Promise<Socket> | undefined;
    let connectionHandshaked = false;
    let closed = false;
    let descriptor: OperationBridgeDescriptor | undefined;
    const pending = new Map<string, PendingRequest>();

    const clientApi: OperationBridgeClient = {
        endpoint: config.endpoint,
        config: Object.freeze({ ...config }),
        get descriptor() { return descriptor; },
        handshake,
        request,
        close,
    };
    return clientApi;

    async function handshake(): Promise<OperationBridgeDescriptor> {
        const raw = await sendOnce("handshake", {
            bridge_version: OPERATION_BRIDGE_VERSION,
            client,
        }, undefined, { timeoutMs: handshakeTimeoutMs });
        const verified = verifyDescriptor(raw, config);
        descriptor = verified;
        connectionHandshaked = true;
        return verified;
    }

    async function request(
        method: OperationBridgeMethod,
        params: JsonRecord,
        requestOptions: { timeoutMs?: number; signal?: AbortSignal; idempotencyKey?: string } = {},
    ): Promise<unknown> {
        if (closed) throw new OperationBridgeError("closed", "operation bridge client is closed");
        if (method === "handshake") return await handshake();
        const launch = isLaunchTool(method, params);
        const idempotencyKey = launch ? (requestOptions.idempotencyKey ?? randomBytes(18).toString("hex")) : undefined;
        let retried = false;
        for (;;) {
            try {
                if (!connectionHandshaked) await handshake();
                return await sendOnce(method, params, idempotencyKey, requestOptions);
            } catch (error) {
                // Only a transport interruption is retried. A handler timeout can
                // mean the parent already started the operation, so retrying it
                // without an authoritative launch claim could duplicate work.
                const retry = !retried && idempotencyKey && error instanceof OperationBridgeError &&
                    error.code === "closed";
                if (!retry) throw error;
                retried = true;
                socket?.destroy();
                socket = undefined;
                connectPromise = undefined;
                connectionHandshaked = false;
                buffer = Buffer.alloc(0);
            }
        }
    }

    async function sendOnce(
        method: OperationBridgeMethod,
        params: JsonRecord,
        idempotencyKey: string | undefined,
        requestOptions: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<unknown> {
        const connection = await ensureConnected();
        if (requestOptions.signal?.aborted) throw new OperationBridgeError("closed", "operation bridge request was aborted");
        const id = randomBytes(12).toString("hex");
        const envelope = {
            v: OPERATION_BRIDGE_VERSION,
            id,
            token: config.token,
            runId: config.runId,
            conversationId: config.conversationId,
            method,
            params,
            ...(idempotencyKey ? { key: idempotencyKey } : {}),
        };
        const encoded = `${JSON.stringify(envelope)}\n`;
        return await new Promise<unknown>((resolveRequest, rejectRequest) => {
            const entry: PendingRequest = {
                id,
                method,
                resolve: resolveRequest,
                reject: rejectRequest,
            };
            pending.set(id, entry);
            const timeoutMs = positive(requestOptions.timeoutMs ?? requestTimeoutMs, requestTimeoutMs);
            entry.timer = setTimeout(() => {
                if (!pending.delete(id)) return;
                entry.removeAbort?.();
                rejectRequest(new OperationBridgeError("handler-timeout", `operation bridge request timed out after ${timeoutMs} ms`, true));
            }, timeoutMs);
            entry.timer.unref?.();
            if (requestOptions.signal) {
                const onAbort = () => {
                    if (!pending.delete(id)) return;
                    if (entry.timer) clearTimeout(entry.timer);
                    rejectRequest(new OperationBridgeError("closed", "operation bridge request was aborted"));
                };
                requestOptions.signal.addEventListener("abort", onAbort, { once: true });
                entry.removeAbort = () => requestOptions.signal!.removeEventListener("abort", onAbort);
            }
            connection.write(encoded, (error) => {
                if (!error) return;
                if (!pending.delete(id)) return;
                if (entry.timer) clearTimeout(entry.timer);
                entry.removeAbort?.();
                rejectRequest(new OperationBridgeError("closed", "operation bridge connection failed", true));
            });
        });
    }

    async function ensureConnected(): Promise<Socket> {
        if (closed) throw new OperationBridgeError("closed", "operation bridge client is closed");
        if (socket && !socket.destroyed && socket.readyState === "open" && !socket.readableEnded && !socket.writableEnded) {
            return socket;
        }
        if (connectPromise) return connectPromise;
        connectPromise = new Promise<Socket>((resolveConnect, rejectConnect) => {
            const next = endpoint.kind === "unix"
                ? connect({ path: endpoint.path })
                : connect({ host: endpoint.host, port: endpoint.port });
            let settled = false;
            const fail = (message: string) => {
                if (!settled) {
                    settled = true;
                    rejectConnect(new OperationBridgeError("closed", message, true));
                }
                rejectAllPending(new OperationBridgeError("closed", message, true));
            };
            next.once("connect", () => {
                settled = true;
                socket = next;
                connectionHandshaked = false;
                resolveConnect(next);
            });
            next.on("data", (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length > maxResponseBytes && buffer.indexOf(10) < 0) {
                    fail("operation bridge response exceeded the response size limit");
                    next.destroy();
                    return;
                }
                let newline = buffer.indexOf(10);
                while (newline >= 0) {
                    const line = buffer.subarray(0, newline);
                    buffer = buffer.subarray(newline + 1);
                    if (line.length <= maxResponseBytes) handleLine(line.toString("utf8"));
                    newline = buffer.indexOf(10);
                }
            });
            next.on("error", (error: Error) => {
                fail(`operation bridge connection error: ${redactSecret(error.message)}`);
            });
            next.on("close", () => {
                socket = undefined;
                connectPromise = undefined;
                connectionHandshaked = false;
                if (!settled) {
                    settled = true;
                    rejectConnect(new OperationBridgeError("closed", "operation bridge connection closed", true));
                }
                rejectAllPending(new OperationBridgeError("closed", "operation bridge connection closed", true));
            });
        }).finally(() => {
            if (!socket || socket.destroyed) connectPromise = undefined;
        });
        return connectPromise;
    }

    function handleLine(line: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            rejectAllPending(new OperationBridgeError("invalid-json", "operation bridge returned malformed JSON"));
            return;
        }
        if (!parsed || typeof parsed !== "object") {
            rejectAllPending(new OperationBridgeError("invalid-request", "operation bridge returned a malformed response"));
            return;
        }
        const response = parsed as {
            v?: unknown; id?: unknown; ok?: unknown; result?: unknown;
            error?: { code?: unknown; message?: unknown; retryable?: unknown };
        };
        if (response.v !== OPERATION_BRIDGE_VERSION || typeof response.id !== "string") {
            rejectAllPending(new OperationBridgeError("invalid-request", "operation bridge response has no compatible version or id"));
            return;
        }
        if (response.id === "" && response.ok !== true) {
            const code = typeof response.error?.code === "string" ? response.error.code : "handler-error";
            const message = typeof response.error?.message === "string" ? response.error.message : "operation bridge request failed";
            rejectAllPending(new OperationBridgeError(code as OperationBridgeErrorCode, redactSecret(message), response.error?.retryable === true));
            // The host answers framing failures without a request id, then may
            // close the connection. Never reuse that half-closed socket for the
            // next call; reconnect and handshake first.
            socket?.destroy();
            socket = undefined;
            connectPromise = undefined;
            connectionHandshaked = false;
            return;
        }
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        if (request.timer) clearTimeout(request.timer);
        request.removeAbort?.();
        if (response.ok === true) {
            request.resolve(response.result);
            return;
        }
        const code = typeof response.error?.code === "string" ? response.error.code : "handler-error";
        const message = typeof response.error?.message === "string" ? response.error.message : "operation bridge request failed";
        request.reject(new OperationBridgeError(code as OperationBridgeErrorCode, redactSecret(message), response.error?.retryable === true));
    }

    function rejectAllPending(error: Error): void {
        for (const [id, request] of pending) {
            pending.delete(id);
            if (request.timer) clearTimeout(request.timer);
            request.removeAbort?.();
            request.reject(error);
        }
    }

    async function close(): Promise<void> {
        if (closed) return;
        closed = true;
        rejectAllPending(new OperationBridgeError("closed", "operation bridge client closed"));
        const current = socket;
        socket = undefined;
        connectPromise = undefined;
        connectionHandshaked = false;
        if (current && !current.destroyed) {
            await new Promise<void>((resolveClose) => {
                current.once("close", () => resolveClose());
                current.end(() => {
                    current.destroy();
                    resolveClose();
                });
            });
        }
    }
}

function positive(value: number | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("operation bridge timeout must be a positive integer");
    return value;
}

/** Rejects an endpoint that tries to add tools or change the advertised contract. */
export function verifyDescriptor(value: unknown, config: Pick<ChildOperationBridgeConfig, "runId" | "conversationId">): OperationBridgeDescriptor {
    if (!value || typeof value !== "object") throw new OperationBridgeError("invalid-request", "parent handshake is not an object");
    const record = value as Record<string, unknown>;
    if (record.bridgeVersion !== OPERATION_BRIDGE_VERSION) {
        throw new OperationBridgeError("invalid-request", "parent bridge version is incompatible");
    }
    if (record.runId !== config.runId || record.conversationId !== config.conversationId) {
        throw new OperationBridgeError("invalid-request", "parent handshake identity does not match this child run");
    }
    if (!Array.isArray(record.tools) || record.tools.length === 0) {
        throw new OperationBridgeError("invalid-request", "parent handshake has no tools");
    }
    const tools: OperationToolDescriptor[] = [];
    const seen = new Set<string>();
    for (const rawTool of record.tools) {
        if (!rawTool || typeof rawTool !== "object") throw new OperationBridgeError("invalid-request", "parent handshake tool is malformed");
        const tool = rawTool as Record<string, unknown>;
        if (typeof tool.name !== "string" || !OPERATION_BRIDGE_TOOL_NAMES.includes(tool.name as OperationBridgeToolName)) {
            throw new OperationBridgeError("invalid-request", "parent handshake named a tool outside the bridge allowlist");
        }
        if (seen.has(tool.name)) throw new OperationBridgeError("invalid-request", "parent handshake repeated a tool");
        seen.add(tool.name);
        if (typeof tool.label !== "string" || typeof tool.description !== "string" ||
            !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
            throw new OperationBridgeError("invalid-request", `parent handshake tool ${tool.name} is malformed`);
        }
        const support = validateJsonSchemaSupport(tool.parameters);
        if (!support.ok) {
            throw new OperationBridgeError("invalid-request", `parent handshake tool ${tool.name} schema: ${support.message}`);
        }
        tools.push(deepFreeze({
            name: tool.name as OperationToolDescriptor["name"],
            label: tool.label,
            description: tool.description,
            parameters: cloneJson(tool.parameters) as JsonRecord,
            ...(Array.isArray(tool.promptGuidelines) ? { promptGuidelines: tool.promptGuidelines.filter((entry): entry is string => typeof entry === "string") } : {}),
            ...(typeof tool.promptSnippet === "string" ? { promptSnippet: tool.promptSnippet } : {}),
        }));
    }
    const capabilities = validateCapabilities(record.capabilities);
    if (seen.has(WAIT_OPERATIONS_TOOL) && !(capabilities.wait && capabilities.parking)) {
        throw new OperationBridgeError("invalid-request", "parent exposed wait_for_operations without a parking capability");
    }
    const expectedFingerprint = descriptorFingerprint(tools, capabilities);
    if (record.fingerprint !== expectedFingerprint) {
        throw new OperationBridgeError("invalid-request", "parent handshake fingerprint does not match its tools");
    }
    return deepFreeze({
        bridgeVersion: OPERATION_BRIDGE_VERSION,
        fingerprint: expectedFingerprint,
        runId: config.runId,
        conversationId: config.conversationId,
        tools,
        capabilities,
        limits: validateLimits(record.limits),
    });
}

function validateCapabilities(value: unknown): OperationBridgeCapabilities {
    if (!value || typeof value !== "object") throw new OperationBridgeError("invalid-request", "parent handshake has no capabilities");
    const record = value as Record<string, unknown>;
    const background = record.background;
    if (!background || typeof background !== "object") throw new OperationBridgeError("invalid-request", "parent handshake has no background capabilities");
    const bg = background as Record<string, unknown>;
    for (const key of ["spawn", "watch", "status", "log"] as const) {
        if (typeof bg[key] !== "boolean") throw new OperationBridgeError("invalid-request", `parent capability background.${key} is invalid`);
    }
    for (const key of ["wait", "acknowledge", "parking"] as const) {
        if (typeof record[key] !== "boolean") throw new OperationBridgeError("invalid-request", `parent capability ${key} is invalid`);
    }
    return Object.freeze({
        background: Object.freeze({
            spawn: bg.spawn as boolean,
            watch: bg.watch as boolean,
            status: bg.status as boolean,
            log: bg.log as boolean,
        }),
        wait: record.wait as boolean,
        acknowledge: record.acknowledge as boolean,
        parking: record.parking as boolean,
    });
}

function validateLimits(value: unknown): OperationBridgeLimits {
    if (!value || typeof value !== "object") throw new OperationBridgeError("invalid-request", "parent handshake has no limits");
    const record = value as Record<string, unknown>;
    for (const key of ["maxRequestBytes", "maxResponseBytes", "requestTimeoutMs"] as const) {
        if (typeof record[key] !== "number" || !Number.isSafeInteger(record[key]) || (record[key] as number) < 1) {
            throw new OperationBridgeError("invalid-request", `parent limit ${key} is invalid`);
        }
    }
    return Object.freeze({
        maxRequestBytes: record.maxRequestBytes as number,
        maxResponseBytes: record.maxResponseBytes as number,
        requestTimeoutMs: record.requestTimeoutMs as number,
    });
}

// ---- parking and checkpoint certification ----------------------------------

/** Same evidence shape as the parent's park-checkpoint helper. */
export type OperationCheckpointEvidence = ParkCheckpoint;

/** Parent policy hook for the trusted native-session path. */
export type SessionFileValidator = (realSessionFile: string) => boolean;

export interface PendingParkRequest {
    waitId: string;
    generation: number;
    toolCallId: string;
    marker: string;
    taskIds: string[];
    continuationNote?: string;
    result: NormalizedWaitResult;
}

export type CheckpointVerification =
    | { certified: true; evidence: OperationCheckpointEvidence }
    | { certified: false; reason: string };

export interface CheckpointSessionContext {
    sessionManager: {
        getEntries(): readonly unknown[];
        getSessionId(): string;
        getSessionFile(): string | undefined;
    };
    shutdown(): void;
}

export type CheckpointVerifier = (input: {
    pending: PendingParkRequest;
    ctx: CheckpointSessionContext;
    sessionFileValidator?: SessionFileValidator;
}) => CheckpointVerification | Promise<CheckpointVerification>;

/**
 * Default verifier: the wait result must be the last persisted conversation
 * message, and the session file must contain that exact prefix. This is the same
 * evidence shape the park/finalization code uses, so the parent can verify it
 * again after a restart instead of trusting an in-memory flag.
 */
export function verifyToolResultCheckpoint(input: {
    pending: PendingParkRequest;
    ctx: CheckpointSessionContext;
    sessionFileValidator?: SessionFileValidator;
}): CheckpointVerification {
    try {
        const manager = input.ctx.sessionManager;
        const sessionId = manager.getSessionId();
        const sessionFile = manager.getSessionFile();
        if (!sessionFile) {
            return { certified: false, reason: "the native conversation is not persisted to a session file" };
        }
        const resolved = realpathSync.native(sessionFile);
        if (input.sessionFileValidator && !input.sessionFileValidator(resolved)) {
            return { certified: false, reason: "the session file is not on the trusted native-session path" };
        }
        // The persisted file is the authority. Reuse the parent's helper so
        // tool name, error state, wait generation, call/result pairing and the
        // saved prefix all come from disk, not from the in-memory view.
        const proof = captureParkCheckpoint({
            sessionId,
            sessionFile: resolved,
            toolCallId: input.pending.toolCallId,
            waitId: input.pending.waitId,
            generation: input.pending.generation,
        });
        const bytes = readFileSync(proof.sessionFile);
        const records = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
        const persisted = records.find((entry: any) => entry?.id === proof.entryId);
        if (!persisted || persisted.type !== "message" || persisted.message?.role !== "toolResult" ||
            persisted.message?.toolName !== WAIT_OPERATIONS_TOOL || persisted.message?.isError === true ||
            persisted.message?.toolCallId !== input.pending.toolCallId) {
            return { certified: false, reason: "the persisted wait tool result has the wrong tool, call id or error state" };
        }
        const details = persisted.message.details;
        const waitMarker = details?.operationWait as { waitId?: unknown; generation?: unknown } | undefined;
        if (waitMarker?.waitId !== input.pending.waitId || waitMarker?.generation !== input.pending.generation) {
            return { certified: false, reason: "the persisted wait result does not match the registered wait generation" };
        }
        const bridgeMarker = details?.operationBridge as { marker?: unknown } | undefined;
        if (bridgeMarker?.marker !== undefined && bridgeMarker.marker !== input.pending.marker) {
            return { certified: false, reason: "the persisted wait result does not match this park request" };
        }
        const entries = manager.getEntries() as Array<Record<string, any>>;
        const memoryMessages = entries.filter((entry) => entry?.type === "message" && entry.message && typeof entry.message === "object");
        const memoryLast = memoryMessages.at(-1);
        if (!memoryLast || memoryLast.id !== proof.entryId || memoryLast.message?.role !== "toolResult" ||
            memoryLast.message?.toolName !== WAIT_OPERATIONS_TOOL || memoryLast.message?.isError === true ||
            memoryLast.message?.toolCallId !== input.pending.toolCallId) {
            return { certified: false, reason: "the native session view does not match the last persisted wait result" };
        }
        return { certified: true, evidence: proof };
    } catch (error) {
        return {
            certified: false,
            reason: `checkpoint verification failed: ${redactSecret(error instanceof Error ? error.message : String(error))}`,
        };
    }
}

export interface CompletePendingParkOptions {
    pending: PendingParkRequest;
    ctx: CheckpointSessionContext;
    client: Pick<OperationBridgeClient, "request">;
    verifier?: CheckpointVerifier;
    attemptId?: string;
    writerLeaseId?: string;
    /** Parent-owned check that the real session file is the trusted native session path. */
    sessionFileValidator?: SessionFileValidator;
    onDiagnostic?: (event: ChildOperationDiagnostic) => void;
}

export interface ParkCompletion {
    parked: boolean;
    reason?: string;
    evidence?: OperationCheckpointEvidence;
    checkpointRecorded?: boolean;
}

/**
 * Called after `agent_settled`, when Pi has persisted the wait tool result.
 * The order is fixed: certify, tell the host, then request shutdown. A failure
 * before the host acknowledgement keeps the attempt alive and records why.
 */
export async function completePendingPark(options: CompletePendingParkOptions): Promise<ParkCompletion> {
    const verify = options.verifier ?? verifyToolResultCheckpoint;
    let verification: CheckpointVerification;
    try {
        verification = await verify({
            pending: options.pending,
            ctx: options.ctx,
            sessionFileValidator: options.sessionFileValidator,
        });
    } catch (error) {
        verification = {
            certified: false,
            reason: `checkpoint verifier failed: ${redactSecret(error instanceof Error ? error.message : String(error))}`,
        };
    }
    if (!verification.certified) {
        await reportParkFailure(options, verification.reason);
        options.onDiagnostic?.({ event: "park-failed", code: "checkpoint-uncertified", message: verification.reason });
        return { parked: false, reason: verification.reason };
    }
    if (verification.evidence.waitId !== options.pending.waitId ||
        verification.evidence.generation !== options.pending.generation ||
        verification.evidence.toolCallId !== options.pending.toolCallId) {
        const reason = "checkpoint evidence does not match the registered wait generation";
        await reportParkFailure(options, reason);
        options.onDiagnostic?.({ event: "park-failed", code: "checkpoint-mismatch", message: reason });
        return { parked: false, reason };
    }
    const checkpointParams: JsonRecord = {
        wait_id: options.pending.waitId,
        generation: options.pending.generation,
        tool_call_id: options.pending.toolCallId,
        evidence: verification.evidence,
        ...(options.attemptId ? { attempt_id: options.attemptId } : {}),
        ...(options.writerLeaseId ? { writer_lease_id: options.writerLeaseId } : {}),
    };
    try {
        await options.client.request("checkpoint", checkpointParams);
    } catch (error) {
        const reason = `checkpoint was not recorded by the parent: ${redactSecret(error instanceof Error ? error.message : String(error))}`;
        await reportParkFailure(options, reason);
        options.onDiagnostic?.({ event: "park-failed", code: "checkpoint-not-recorded", message: reason });
        return { parked: false, reason };
    }
    try {
        options.ctx.shutdown();
    } catch (error) {
        const reason = `clean shutdown was not accepted by the SDK: ${redactSecret(error instanceof Error ? error.message : String(error))}`;
        await reportParkFailure(options, reason);
        options.onDiagnostic?.({ event: "park-failed", code: "shutdown-not-accepted", message: reason });
        return { parked: false, reason, evidence: verification.evidence, checkpointRecorded: true };
    }
    options.onDiagnostic?.({ event: "parked", code: "checkpoint-recorded" });
    return { parked: true, evidence: verification.evidence, checkpointRecorded: true };
}

async function reportParkFailure(options: CompletePendingParkOptions, reason: string): Promise<void> {
    try {
        await options.client.request("park_failed", {
            wait_id: options.pending.waitId,
            generation: options.pending.generation,
            reason: reason.slice(0, 2_000),
        }, { timeoutMs: 5_000 });
    } catch {
        // The child still keeps running. A lost park-failure notice becomes a
        // held/monitored record on the parent side, never a simulated park.
    }
}

// ---- child extension installer --------------------------------------------

export interface ChildOperationDiagnostic {
    event: "disabled" | "invalid" | "connecting" | "ready" | "handshake-failed" | "parking" | "park-failed" | "parked" | "closed" | "tool-error" | "parking-unsupported";
    code?: string;
    message?: string;
}

export interface InstallChildOperationBridgeOptions {
    env?: NodeJS.ProcessEnv;
    config?: ChildOperationBridgeConfig;
    clientFactory?: (config: ChildOperationBridgeConfig) => OperationBridgeClient;
    verifier?: CheckpointVerifier;
    /** Parent-owned check that the real session file is the trusted native session path. */
    sessionFileValidator?: SessionFileValidator;
    /** Test seam; production uses the loaded SDK version. */
    sdkVersion?: string;
    /** Default true. Remove bridge credentials from process.env around each tool execution. */
    hideBridgeEnvironmentFromTools?: boolean;
    requestTimeoutMs?: number;
    handshakeAttempts?: number;
    handshakeRetryDelayMs?: number;
    onDiagnostic?: (event: ChildOperationDiagnostic) => void;
}

export interface ChildOperationBridgeState {
    status: "disabled" | "invalid" | "connecting" | "ready" | "handshake-failed" | "parking" | "parked" | "park-failed" | "closed";
    descriptor?: OperationBridgeDescriptor;
    pendingPark?: PendingParkRequest;
    lastError?: string;
    /** False when the installed SDK cannot stop before the next model request. */
    parkingSupported?: boolean;
    /** True while bridge credentials are removed from process.env for tool execution. */
    bridgeEnvironmentHidden?: boolean;
    /** How bridge credentials are kept away from command tools. */
    bridgeEnvironmentIsolation?: "tool-execution" | "unavailable";
    /** True when the current assistant message contains a wait plus another tool call. */
    waitBatchConflict?: boolean;
}

export interface ChildOperationBridgeHandle {
    getState(): ChildOperationBridgeState;
}

/**
 * Parent-owned integration calls this once from a child extension loader. It
 * registers no tools until a compatible parent handshake succeeds.
 */
export function installChildOperationBridge(
    pi: ExtensionAPI,
    options: InstallChildOperationBridgeOptions = {},
): ChildOperationBridgeHandle {
    const state: ChildOperationBridgeState = {
        status: "disabled",
        parkingSupported: supportsParkingBoundary(options.sdkVersion ?? PI_CODING_AGENT_VERSION),
        bridgeEnvironmentHidden: false,
        bridgeEnvironmentIsolation: options.hideBridgeEnvironmentFromTools === false ? "unavailable" : "tool-execution",
        waitBatchConflict: false,
    };
    let client: OperationBridgeClient | undefined;
    const hiddenBridgeEnvironment = new Map<string, string | undefined>();
    let activeToolExecutions = 0;
    let installed = false;
    let starting: Promise<void> | undefined;
    let completingPark = false;
    const env = options.env ?? process.env;

    const handle: ChildOperationBridgeHandle = {
        getState: () => ({ ...state, ...(state.descriptor ? { descriptor: state.descriptor } : {}) }),
    };

    function hideBridgeEnvironment(): void {
        if (state.bridgeEnvironmentIsolation !== "tool-execution" || hiddenBridgeEnvironment.size > 0) return;
        for (const key of OPERATION_BRIDGE_ENV_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(process.env, key)) continue;
            hiddenBridgeEnvironment.set(key, process.env[key]);
            delete process.env[key];
        }
        state.bridgeEnvironmentHidden = hiddenBridgeEnvironment.size > 0;
    }

    function restoreBridgeEnvironment(): void {
        for (const [key, value] of hiddenBridgeEnvironment) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        hiddenBridgeEnvironment.clear();
        state.bridgeEnvironmentHidden = false;
    }

    pi.on("tool_execution_start", () => {
        activeToolExecutions += 1;
        hideBridgeEnvironment();
    });
    pi.on("tool_execution_end", () => {
        activeToolExecutions = Math.max(0, activeToolExecutions - 1);
        if (activeToolExecutions === 0) restoreBridgeEnvironment();
    });

    pi.on("session_start", async (_event, _ctx) => {
        if (installed || starting) return starting;
        starting = (async () => {
            const read = options.config
                ? { status: "ready" as const, config: options.config }
                : readChildOperationBridgeConfig(env);
            if (read.status !== "ready") {
                state.status = read.status === "disabled" ? "disabled" : "invalid";
                state.lastError = read.reason;
                options.onDiagnostic?.({ event: state.status, message: read.reason });
                return;
            }
            state.status = "connecting";
            options.onDiagnostic?.({ event: "connecting" });
            const active = (options.clientFactory ?? ((config) => createOperationBridgeClient(config, {
                requestTimeoutMs: options.requestTimeoutMs,
            })))(read.config);
            let descriptor: OperationBridgeDescriptor;
            try {
                descriptor = await handshakeWithRetries(active, options);
            } catch (error) {
                state.status = "handshake-failed";
                state.lastError = redactSecret(error instanceof Error ? error.message : String(error));
                options.onDiagnostic?.({ event: "handshake-failed", code: "handshake", message: state.lastError });
                await active.close().catch(() => {});
                return;
            }
            client = active;
            state.descriptor = descriptor;
            try {
                registerTools(descriptor, state.parkingSupported === true);
            } catch (error) {
                state.status = "handshake-failed";
                state.lastError = redactSecret(error instanceof Error ? error.message : String(error));
                options.onDiagnostic?.({ event: "handshake-failed", code: "tool-registration", message: state.lastError });
                client = undefined;
                await active.close().catch(() => {});
                return;
            }
            state.status = "ready";
            installed = true;
            options.onDiagnostic?.({ event: "ready", code: "handshake" });
        })().finally(() => { starting = undefined; });
        return starting;
    });

    pi.on("message_end", (event) => {
        const message = event.message as { role?: string; content?: unknown };
        if (message.role !== "assistant" || !Array.isArray(message.content)) return;
        const calls = message.content.filter((part): part is { type: "toolCall"; name: string } =>
            Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "toolCall" &&
            typeof (part as { name?: unknown }).name === "string");
        const hasWait = calls.some((call) => call.name === WAIT_OPERATIONS_TOOL);
        state.waitBatchConflict = hasWait && calls.length !== 1;
    });

    pi.on("tool_call", (event) => {
        if (event.toolName === WAIT_OPERATIONS_TOOL && state.waitBatchConflict) {
            return {
                block: true,
                reason: "wait_for_operations must be the only tool call in its assistant message. Retry it alone so the SDK can stop before the next model request.",
            };
        }
        if (state.status === "parking" || state.status === "parked") {
            return { block: true, reason: "This worker is committing a park request; no further tools may run." };
        }
        return undefined;
    });

    pi.on("agent_settled", async (_event, ctx) => {
        const pending = state.pendingPark;
        if (!pending || !client || completingPark) return;
        completingPark = true;
        state.status = "parking";
        try {
            const result = await completePendingPark({
                pending,
                ctx,
                client,
                verifier: options.verifier,
                sessionFileValidator: options.sessionFileValidator,
                attemptId: options.config?.attemptId ?? env[OPERATIONS_ATTEMPT_ID_ENV],
                writerLeaseId: options.config?.writerLeaseId ?? env[OPERATIONS_WRITER_LEASE_ID_ENV],
                onDiagnostic: options.onDiagnostic,
            });
            state.status = result.parked ? "parked" : "park-failed";
            if (!result.parked) state.lastError = result.reason;
            // A failed park is not retried in a loop. The parent receives the
            // explicit failure and decides whether to hold or re-register.
            state.pendingPark = undefined;
        } finally {
            completingPark = false;
        }
    });

    pi.on("session_shutdown", () => {
        state.status = "closed";
        restoreBridgeEnvironment();
        options.onDiagnostic?.({ event: "closed" });
        void client?.close().catch(() => {});
    });

    function registerTools(descriptor: OperationBridgeDescriptor, parkingSupported: boolean): void {
        for (const tool of descriptor.tools) {
            if (tool.name === WAIT_OPERATIONS_TOOL && !parkingSupported) {
                state.lastError = "The installed SDK cannot stop before the next model request; wait_for_operations is unavailable.";
                options.onDiagnostic?.({ event: "parking-unsupported", code: "sdk-version" });
                continue;
            }
            pi.registerTool({
                name: tool.name,
                label: tool.label,
                description: tool.description,
                parameters: tool.parameters as any,
                ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
                ...(tool.promptGuidelines ? { promptGuidelines: [...tool.promptGuidelines] } : {}),
                async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) {
                    try {
                        return await invokeTool(tool, toolCallId, params, signal);
                    } catch (error) {
                        return toolErrorResult(error);
                    }
                },
            });
        }
    }

    async function invokeTool(
        tool: OperationToolDescriptor,
        toolCallId: string,
        rawParams: unknown,
        signal: AbortSignal | undefined,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
        if (!client) throw new OperationToolError("the parent operation bridge is not connected");
        if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
            throw new OperationToolError("tool parameters must be an object");
        }
        const params = rawParams as JsonRecord;
        if (isLaunchTool(tool.name, params)) {
            const bridgeEnvironmentField = findBridgeEnvironmentKey(params);
            if (bridgeEnvironmentField) {
                throw new OperationToolError(
                    `refusing to pass ${bridgeEnvironmentField} to a launched task`,
                    "bridge-env-leak",
                );
            }
        }
        const raw = await client.request(tool.name, params, { signal });
        if (tool.name === WAIT_OPERATIONS_TOOL) {
            return waitToolResult(toolCallId, raw);
        }
        return toolResult(raw);
    }

    function waitToolResult(
        toolCallId: string,
        raw: unknown,
    ): { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean; terminate?: boolean } {
        const normalized = normalizeWaitForOperationsResult(raw);
        if (!normalized.ok) throw new OperationToolError(`parent returned an invalid wait result: ${normalized.message}`);
        const marker = randomBytes(16).toString("hex");
        const details = {
            ...(raw && typeof raw === "object" ? raw as JsonRecord : {}),
            operationWait: normalized.result,
            operationBridge: {
                version: OPERATION_BRIDGE_VERSION,
                marker,
                waitId: normalized.result.waitId,
                generation: normalized.result.generation,
                toolCallId,
            },
        };
        // Settlement is independent of the writer handoff. A dependency can
        // finish while this call is registering its park, but a generation in
        // parking still needs the tool-result checkpoint and writer exit.
        const shouldPark = normalized.result.park && (!normalized.result.settled
            || normalized.result.phase === "parking" || normalized.result.phase === "registering");
        if (shouldPark) {
            if (!state.descriptor?.capabilities.parking) {
                throw new OperationToolError("the parent asked this worker to park without a parking capability");
            }
            state.pendingPark = {
                waitId: normalized.result.waitId,
                generation: normalized.result.generation,
                toolCallId,
                marker,
                taskIds: normalized.result.taskIds,
                ...(normalized.result.continuationNote ? { continuationNote: normalized.result.continuationNote } : {}),
                result: normalized.result,
            };
            state.status = "parking";
            options.onDiagnostic?.({ event: "parking", code: "wait-registered" });
        }
        return {
            content: [{ type: "text", text: formatToolText(details) }],
            details,
            // AgentToolResult.terminate stops the loop only when every result in
            // the batch sets it. installChildOperationBridge therefore refuses a
            // wait that shares an assistant message with another tool call.
            ...(shouldPark ? { terminate: true } : {}),
        };
    }

    function toolResult(raw: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
        const details = raw && typeof raw === "object"
            ? { ...(raw as JsonRecord) }
            : { result: raw };
        return {
            content: [{ type: "text", text: formatToolText(raw) }],
            details,
        };
    }

    function toolErrorResult(error: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown; isError: true } {
        const code = error instanceof OperationBridgeError || error instanceof OperationToolError ? error.code : "handler-error";
        const message = redactSecret(error instanceof Error ? error.message : String(error));
        options.onDiagnostic?.({ event: "tool-error", code, message });
        return {
            content: [{ type: "text", text: `operation bridge: ${message}` }],
            details: { operationBridgeError: { code, message } },
            isError: true,
        };
    }

    return handle;
}

async function handshakeWithRetries(
    client: OperationBridgeClient,
    options: InstallChildOperationBridgeOptions,
): Promise<OperationBridgeDescriptor> {
    const attempts = Math.max(1, Math.min(10, options.handshakeAttempts ?? 3));
    const delay = Math.max(0, Math.min(2_000, options.handshakeRetryDelayMs ?? 50));
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await client.handshake();
        } catch (error) {
            lastError = error;
            if (attempt + 1 < attempts && delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
        }
    }
    throw lastError;
}

function formatToolText(value: unknown): string {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const text = (value as JsonRecord).text;
        if (typeof text === "string") return text;
    }
    let encoded: string;
    try {
        encoded = JSON.stringify(value, null, 2) ?? "null";
    } catch {
        encoded = String(value);
    }
    const bytes = Buffer.byteLength(encoded);
    if (bytes > 64 * 1024) {
        return `${Buffer.from(encoded).subarray(0, 64 * 1024).toString("utf8")}\n… output truncated by the operation bridge`;
    }
    return encoded;
}

export default function childOperationsExtension(pi: ExtensionAPI): void {
    installChildOperationBridge(pi);
}

// Keep these exports used and available to the parent integration without
// widening the child's execution surface.
export { ACKNOWLEDGE_OPERATION_TOOL, WAIT_OPERATIONS_TOOL };
export type { OperationBridgeCapabilities, OperationBridgeLimits };
