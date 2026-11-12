/**
 * Autonomous worker park/resume for Subagents.
 *
 * A supervised worker conversation may launch background operations, register an
 * all-settled wait on them, and park: its attempt completes cleanly with a
 * durable park disposition while the assignment keeps its native conversation,
 * launch recipe and saved history. When the dependency settles, the Background
 * host delivers the ready wait to this module's continuation adapter, which
 * admits exactly one continuation through the ordinary continuation launch path.
 *
 * Ownership split (ADR 0020, observed-waits design):
 *
 * - **Subagents (this module)** owns the trusted bridge host each worker child
 *   talks to, the per-run transport token, the child extension arguments,
 *   native-checkpoint validation against the trusted launch recipe, the park
 *   disposition on the run record, and resume admission/launch.
 * - **Background Tasks** owns the durable operation/wait/outbox records, the
 *   supervisor transport, permission intersection and dispatch. This module never
 *   opens that database and never imports Background code: it consumes the
 *   service object Background publishes on its versioned event channel.
 * - **Goal** controls parent execution only; assignment admission does not ask it.
 *
 * The service contract mirror below is intentionally structural: it names only
 * the members this module calls, so either package can load first and a missing
 * host reads as an unavailable capability instead of a broken import.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    OPERATIONS_ATTEMPT_ID_ENV,
    OPERATIONS_CHILD_ID_ENV,
    OPERATIONS_CONVERSATION_ID_ENV,
    OPERATIONS_ENABLED_ENV,
    OPERATIONS_ENDPOINT_ENV,
    OPERATIONS_RUN_ID_ENV,
    OPERATIONS_TOKEN_ENV,
    OPERATIONS_WRITER_LEASE_ID_ENV,
    WAIT_OPERATIONS_TOOL,
    createToolDescriptor,
    extractResultTaskIds,
    normalizeWaitForOperationsResult,
    normalizeToolDescriptors,
    OperationBridgeError,
    type JsonRecord,
    type OperationBridgeCapabilities,
    type OperationBridgeToolName,
    type OperationToolDescriptor,
} from "./operation-bridge-types.ts";
import {
    createOperationBridgeHost,
    type OperationBridgeHost,
    type OperationBridgeLogger,
    type OperationRunHandlers,
    type OperationRunInfo,
} from "./worker-operations-host.ts";
import { captureParkCheckpoint, verifyParkCheckpoint, type ParkCheckpoint } from "./park-checkpoint.ts";
import { findSavedConversation, readConversationLease } from "./continuation.ts";
import { commitAssignmentTerminal } from "./assignment-outcomes.ts";
import {
    effectiveStatus,
    isPendingPark,
    listMetas,
    listPendingParkedRuns,
    readMeta,
    readParkRecord,
    processStartToken,
    updateParkRecord,
    writeParkRecord,
    type ParkRecord,
    type RunMeta,
} from "./registry.ts";
import { processExists } from "./spawn.ts";
import { realProcessProbe, type ProcessProbe } from "./health.ts";
import { stopRun } from "./stop.ts";

export type { ParkRecord };

// ---- Background service contract (versioned event bus) --------------------

/**
 * Background publishes its operation service object here and answers a request
 * for it on the request channel. The shape mirrors `BackgroundOperationService`
 * in `pi-better-background-tasks/src/observed-waits.ts`; only the members this
 * module calls are declared.
 */
export const OBSERVED_WAITS_SERVICE_CHANNEL = "pi-better-background-tasks:observed-waits-service";
export const OBSERVED_WAITS_SERVICE_REQUEST_CHANNEL = "pi-better-background-tasks:observed-waits-service-request";
export const OBSERVED_WAITS_SERVICE_VERSION = 2 as const;

/**
 * Request/reply surface Background publishes for the Subagents coordinator. It
 * carries the pieces the object service does not: run bindings for the worker's
 * captured policy, checkpoint staging, and the resume claim/publish/release fence.
 */
export const WORKER_OPERATIONS_RPC_CHANNEL = "pi-better-background-tasks:observed-waits";
export const WORKER_OPERATIONS_RPC_VERSION = 1 as const;

export class WorkerOperationsRefusal extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = "WorkerOperationsRefusal";
        this.code = code;
    }
}

export class WorkerOperationsUnavailable extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkerOperationsUnavailable";
    }
}

export interface WorkerOperationsRpc {
    call(method: string, params: JsonRecord, timeoutMs?: number): Promise<JsonRecord>;
}

/**
 * Bounded request/reply client. A missing or slow host is an explicit
 * unavailability, never an assumed success; a late reply is ignored.
 */
export function createWorkerOperationsRpc(pi: unknown, options: { timeoutMs?: number } = {}): WorkerOperationsRpc {
    const budgetFor = (override?: number): number => Math.max(
        50,
        Math.min(120_000, override ?? options.timeoutMs ?? 30_000),
    );
    const call = (method: string, params: JsonRecord, overrideMs?: number): Promise<JsonRecord> => {
        const bus = serviceBusOf(pi);
        if (!bus) {
            return Promise.reject(new WorkerOperationsUnavailable(
                "This Pi runtime exposes no extension event bus, so worker operations are unavailable.",
            ));
        }
        const budget = budgetFor(overrideMs);
        return new Promise<JsonRecord>((resolve, reject) => {
            let settled = false;
            const finish = (action: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                action();
            };
            const timer = setTimeout(() => {
                finish(() => reject(new WorkerOperationsUnavailable(
                    `The Background observed-waits host did not answer ${method} within ${budget} ms. No wait, checkpoint or resume was recorded.`,
                )));
            }, budget);
            timer.unref?.();
            const request = {
                version: WORKER_OPERATIONS_RPC_VERSION,
                id: `ow_${randomUUID()}`,
                method,
                params,
                reply: (reply: unknown) => {
                    if (!reply || typeof reply !== "object") {
                        finish(() => reject(new WorkerOperationsUnavailable("The observed-waits host returned a malformed reply.")));
                        return;
                    }
                    const value = reply as { ok?: unknown; value?: unknown; code?: unknown; reason?: unknown };
                    if (value.ok === true) {
                        finish(() => resolve(value.value && typeof value.value === "object" ? value.value as JsonRecord : {}));
                        return;
                    }
                    finish(() => reject(new WorkerOperationsRefusal(
                        typeof value.code === "string" ? value.code : "refused",
                        typeof value.reason === "string" && value.reason ? value.reason : "The observed-waits host refused the request.",
                    )));
                },
            };
            try {
                bus.emit(WORKER_OPERATIONS_RPC_CHANNEL, request);
            } catch (error) {
                finish(() => reject(new WorkerOperationsUnavailable(
                    `The observed-waits request failed: ${error instanceof Error ? error.message : String(error)}`,
                )));
            }
        });
    };
    return { call };
}

/** Goal's admission gate; this module only asks, never decides. */
export const OPERATION_RESUME_ADMISSION_EVENT = "pi-better-goal:operation-resume-admission";

export type WorkerOwnerIdentity = {
    kind: "worker-conversation";
    sessionId: string;
    workspace: string;
    branchId?: string | null;
    goalId?: string | null;
};

/** What one worker attempt is allowed to ask Background to record. */
export interface WorkerRunScope {
    readonly runId: string;
    readonly conversationId: string;
    readonly workspace: string;
    readonly authorityReference: string;
    readonly branchId?: string | null;
    readonly goalId?: string | null;
}

export interface WorkerSandboxAuthority {
    readonly root: string;
    readonly permissions?: Readonly<{
        projectFiles: "off" | "read" | "write" | "read-write";
        outsideProject: "off" | "read" | "write" | "read-write";
        storedCredentials: "off" | "read" | "read-write";
        commands: boolean;
        network: boolean;
        shell?: boolean;
        commandTimeoutSeconds?: number | null;
    }>;
    readonly denyWrite?: readonly string[];
}

export interface WorkerLaunchResult {
    readonly id: string;
    readonly operationId: string;
    readonly kind: "process" | "watch";
    readonly status: string;
    readonly name?: string;
    readonly cwd: string;
    readonly command?: string;
    readonly argv?: readonly string[];
    readonly shell: boolean;
    readonly owner: WorkerOwnerIdentity;
    readonly started: boolean;
    readonly claimed: boolean;
    readonly notices: readonly string[];
}

export interface WaitDependencyView {
    readonly taskId?: string;
    readonly operationId: string;
    readonly terminalRevision: number;
    readonly terminalOutcome: string | null;
}

export interface WaitEvidenceView {
    readonly operationId: string;
    readonly taskId?: string;
    readonly terminalRevision: number;
    readonly kind: string;
    readonly ref: string;
    readonly summary?: string;
    readonly detailLost: boolean;
}

export interface WorkerWaitView {
    readonly waitId: string;
    readonly generation: number;
    readonly phase: string;
    readonly settled: boolean;
    readonly park: boolean;
    /** Cancellation epoch the caller must echo; part of the synchronous release guard. */
    readonly cancelEpoch: number;
    readonly ownerKind: string;
    readonly continuationNote: string;
    readonly taskIds: readonly string[];
    readonly dependencies: readonly WaitDependencyView[];
    readonly evidence: readonly WaitEvidenceView[];
}

export interface WorkerStatusView {
    readonly taskId: string;
    readonly operationId: string;
    readonly kind: "process" | "watch";
    readonly status: string;
    readonly phase: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly reason?: string;
    readonly terminalRevision: number;
    readonly terminalOutcome: string | null;
    readonly waits: readonly WorkerWaitView[];
    readonly [key: string]: unknown;
}

export interface WorkerLogView {
    readonly taskId: string;
    readonly status: string;
    readonly stdout: string;
    readonly stderr: string;
    readonly events: string;
    readonly truncated: boolean;
}

export interface WorkerHoldResumeInput {
    waitId: string;
    generation: number;
    claimId: string;
    claimToken: string;
    attemptId: string;
    launchToken: string;
    proof: { writerPidGone: boolean; writerLeaseReleased: boolean };
    reason: string;
}

export interface WorkerHoldResumeView {
    readonly waitId: string;
    readonly generation: number;
    readonly phase: string;
    readonly applied: boolean;
    readonly claim: { readonly claimId: string; readonly state: string; readonly attemptId: string | null };
}

export interface WorkerAcknowledgeView {
    readonly waitId: string;
    readonly generation: number;
    readonly disposition: string;
    readonly acknowledgedOutboxIds: readonly string[];
    readonly releasedPinIds: readonly string[];
    readonly phase: string;
}

/** The ready-wait delivery Background hands to its continuation adapter. */
export interface WorkerWaitReadyEvent {
    readonly waitId: string;
    readonly generation: number;
    readonly owner: { kind: string; sessionId: string; workspace: string; branchId?: string | null; goalId?: string | null };
    readonly parentOrigin?: { cwd: string; sessionId?: string };
    readonly taskIds: readonly string[];
    readonly continuationNote: string;
    readonly evidence: readonly WaitEvidenceView[];
}

export interface WorkerContinuationAdapter {
    readonly version: 1;
    readonly id: string;
    onWaitReady(event: WorkerWaitReadyEvent): void | Promise<void | "delivered" | "deferred">;
    onWaitCancelled?(event: { waitId: string; generation: number; reason: string }): void | Promise<void>;
}

/**
 * The published Background operation service. Every method rechecks ownership in
 * the durable store; the run id is an identity, never a grant.
 */
export interface WorkerOperationService {
    readonly version: typeof OBSERVED_WAITS_SERVICE_VERSION;
    readonly serviceId: string;
    readonly available: true;
    readonly assignmentContinuation?: 1;
    readonly continuationReady: boolean;
    ownsTask(run: WorkerRunScope, taskId: string): boolean;
    launchForWorker(run: WorkerRunScope, input: { kind: "process" | "watch"; params: JsonRecord; policy?: WorkerSandboxAuthority | null }): Promise<WorkerLaunchResult>;
    statusForWorker(run: WorkerRunScope, taskId: string): WorkerStatusView;
    logForWorker(run: WorkerRunScope, taskId: string, options?: { lines?: number }): WorkerLogView;
    stopForWorker(run: WorkerRunScope, taskId: string): Promise<WorkerStatusView>;
    registerWorkerWait(run: WorkerRunScope, input: {
        taskIds: readonly string[];
        continuationNote: string;
        attemptId: string;
        checkpointId: string;
        writerLeaseId?: string | null;
    }): WorkerWaitView;
    checkpointWorkerWait(run: WorkerRunScope, input: {
        waitId: string;
        generation: number;
        proof: { checkpointRecorded: boolean; writerLeaseReleased: boolean; writerPidGone: boolean };
    }): Promise<WorkerWaitView>;
    failWorkerPark(run: WorkerRunScope, input: { waitId: string; generation: number; reason: string }): WorkerWaitView;
    acknowledgeForWorker(run: WorkerRunScope, input: {
        waitId: string;
        generation: number;
        terminalRevisions: unknown;
        disposition: "continue" | "blocked" | "assignment-complete";
        note: string;
    }): WorkerAcknowledgeView;
    listWorkerWaits(run: WorkerRunScope, options?: { pendingOnly?: boolean }): readonly WorkerWaitView[];
    cancelWorkerWait(run: WorkerRunScope, input: { waitId: string; generation: number; reason: string }): WorkerWaitView;
    /**
     * Hold a proven failed published attempt. Optional in older hosts; without it
     * the caller reports the local hold and leaves the durable generation with its
     * live claim instead of cancelling it.
     */
    holdFailedResumeForWorker?(run: WorkerRunScope, input: WorkerHoldResumeInput): WorkerHoldResumeView;
    repairFailedResumeForWorker?(run: WorkerRunScope, input: WorkerHoldResumeInput & { checkpointId: string; expectedCancelEpoch: number }): { phase: string; repaired: boolean };
    registerContinuationAdapter(adapter: WorkerContinuationAdapter): void;
    unregisterContinuationAdapter(id: string): void;
}

interface ServiceBus {
    on(channel: string, handler: (data: unknown) => void): unknown;
    off?(channel: string, handler: (data: unknown) => void): unknown;
    emit(channel: string, data: unknown): void;
}

const serviceMirrors = new WeakMap<object, { service?: WorkerOperationService; reason?: string }>();

function serviceBusOf(pi: unknown): ServiceBus | undefined {
    const events = (pi as { events?: unknown } | undefined)?.events;
    if (!events || typeof events !== "object") return undefined;
    const candidate = events as Partial<ServiceBus>;
    if (typeof candidate.on !== "function" || typeof candidate.emit !== "function") return undefined;
    return candidate as ServiceBus;
}

function isPublishedService(value: unknown): value is WorkerOperationService {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<WorkerOperationService>;
    return candidate.version === OBSERVED_WAITS_SERVICE_VERSION
        && candidate.available === true
        && typeof candidate.launchForWorker === "function"
        && typeof candidate.statusForWorker === "function"
        && typeof candidate.logForWorker === "function"
        && typeof candidate.registerWorkerWait === "function"
        && typeof candidate.checkpointWorkerWait === "function"
        && typeof candidate.failWorkerPark === "function"
        && typeof candidate.acknowledgeForWorker === "function"
        && typeof candidate.listWorkerWaits === "function"
        && typeof candidate.cancelWorkerWait === "function"
        && typeof candidate.ownsTask === "function"
        && typeof candidate.registerContinuationAdapter === "function"
        && (candidate.holdFailedResumeForWorker === undefined || typeof candidate.holdFailedResumeForWorker === "function");
}

function mirrorOf(pi: unknown): { mirror: { service?: WorkerOperationService; reason?: string }; bus: ServiceBus } | undefined {
    const bus = serviceBusOf(pi);
    if (!bus) return undefined;
    let mirror = serviceMirrors.get(bus as object);
    if (!mirror) {
        mirror = {};
        serviceMirrors.set(bus as object, mirror);
        bus.on(OBSERVED_WAITS_SERVICE_CHANNEL, (data) => {
            const current = serviceMirrors.get(bus as object);
            if (!current) return;
            if (data && typeof data === "object" && (data as { version?: unknown }).version !== OBSERVED_WAITS_SERVICE_VERSION) {
                current.service = undefined;
                current.reason = "The Background host does not support observed-waits service v2 assignment continuation";
                return;
            }
            if (isPublishedService(data)) {
                current.service = data;
                current.reason = undefined;
                return;
            }
            if (data && typeof data === "object"
                && (data as { version?: unknown }).version === OBSERVED_WAITS_SERVICE_VERSION
                && (data as { available?: unknown }).available === false) {
                current.service = undefined;
                const reason = (data as { reason?: unknown }).reason;
                current.reason = typeof reason === "string" ? reason : "the Background operation host is unavailable";
            }
        });
    }
    return { mirror, bus };
}

/**
 * Resolve the Background operation service through its versioned channel. Pi's
 * bus dispatches synchronously, so a host that is already running answers before
 * this returns; `undefined` means this package runs alone (or the host closed).
 */
export function getWorkerOperationService(pi: unknown): WorkerOperationService | undefined {
    const resolved = mirrorOf(pi);
    if (!resolved) return undefined;
    try {
        resolved.bus.emit(OBSERVED_WAITS_SERVICE_REQUEST_CHANNEL, { version: OBSERVED_WAITS_SERVICE_VERSION });
    } catch {
        return undefined;
    }
    return resolved.mirror.service;
}

/** Why the service request returned nothing, when a host refused to open. */
export function workerOperationsUnavailableReason(pi: unknown): string | undefined {
    const resolved = mirrorOf(pi);
    if (!resolved) return "this Pi runtime exposes no extension event bus";
    if (!resolved.mirror.service) {
        try {
            resolved.bus.emit(OBSERVED_WAITS_SERVICE_REQUEST_CHANNEL, { version: OBSERVED_WAITS_SERVICE_VERSION });
        } catch { /* keep the previous reason */ }
    }
    return resolved.mirror.reason;
}

// ---- captured worker policy ----------------------------------------------

/**
 * What the worker was launched with, captured by Subagents before the child
 * exists. Background intersects it with the current Background profile; the
 * child can never supply or widen it.
 */
export interface WorkerRunPolicy {
    version: 1;
    mandatoryPermissions?: boolean;
    /** Confinement root and levels, or null for the `sandbox:false` opt-out. */
    sandbox: WorkerSandboxAuthority | null;
    /** Effective child tool allowlist (after exclusions). */
    tools: readonly string[];
    /** Clean-mode children get no ambient operation capability. */
    clean: boolean;
    /** Assignment deadline preserved across parking and resumption. */
    deadlineAt: number | null;
    /** Reference to the permission snapshot; never credential material. */
    authorityReference: string;
    /** Workspace the worker is confined to (canonical). */
    workspace: string;
}

/** Build the policy Background needs; `taskPolicy` is the immutable task launch contract. */
export function captureWorkerPolicy(input: {
    mandatoryPermissions?: boolean;
    sandbox: boolean;
    tools: readonly string[];
    clean: boolean;
    workspace: string;
    authorityReference: string;
    deadlineAt?: number | null;
    taskPolicy?: {
        readonly root: string;
        readonly permissions?: WorkerSandboxAuthority["permissions"];
        readonly denyWrite?: readonly string[];
    } | null;
}): WorkerRunPolicy {
    const sandbox = input.sandbox && input.taskPolicy
        ? {
            root: input.taskPolicy.root,
            ...(input.taskPolicy.permissions ? { permissions: input.taskPolicy.permissions } : {}),
            ...(input.taskPolicy.denyWrite ? { denyWrite: [...input.taskPolicy.denyWrite] } : {}),
        }
        : null;
    return {
        version: 1,
        mandatoryPermissions: input.mandatoryPermissions === true,
        sandbox,
        tools: [...input.tools],
        clean: input.clean,
        deadlineAt: input.deadlineAt ?? null,
        authorityReference: input.authorityReference,
        workspace: input.workspace,
    };
}

/** Refuse permission loss or widening when reconstructing a captured assignment. */
export function assertAssignmentPermissionScope(
    captured: { sandbox: unknown; mandatoryPermissions?: boolean } | undefined,
    current: { sandbox: unknown; mandatoryPermissions: boolean },
): void {
    if (!captured) throw new PreSpawnResumeError("Captured assignment permissions are missing");
    const requiresAuthority = captured.mandatoryPermissions === true
        || (captured.mandatoryPermissions === undefined && captured.sandbox !== null);
    if (requiresAuthority && !current.mandatoryPermissions) {
        throw new PreSpawnResumeError("Expected mandatory permission authority is unavailable");
    }
    const normalize = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === "object") return Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]),
        );
        return value;
    };
    const oldSandbox = captured.sandbox as WorkerSandboxAuthority | null;
    const newSandbox = current.sandbox as WorkerSandboxAuthority | null;
    if (oldSandbox?.denyWrite?.some((path) => !newSandbox?.denyWrite?.includes(path))) {
        throw new PreSpawnResumeError("Current permissions would remove captured assignment protected paths");
    }
    const authority = (sandbox: WorkerSandboxAuthority | null) => sandbox ? { root: sandbox.root, permissions: sandbox.permissions } : null;
    if (JSON.stringify(normalize(authority(oldSandbox))) !== JSON.stringify(normalize(authority(newSandbox)))) {
        throw new PreSpawnResumeError("Current permissions would change the captured assignment scope");
    }
}

// ---- child capability planning -------------------------------------------

/** Fallback tool set for a supervised worker; user restrictions still subtract. */
export const DEFAULT_WORKER_BRIDGE_TOOLS: readonly OperationBridgeToolName[] = [
    "bg_task_spawn",
    "bg_task_watch",
    "bg_task_status",
    "bg_task_log",
    WAIT_OPERATIONS_TOOL,
    "acknowledge_operation_result",
];

export interface WorkerBridgeToolPlan {
    tools: readonly OperationBridgeToolName[];
    capabilities: OperationBridgeCapabilities;
    /** Withheld tools and why. A withheld tool is never advertised to the child. */
    withheld: readonly { name: OperationBridgeToolName; reason: string }[];
}

/**
 * Decide the worker's operation tools.
 *
 * - `clean` children keep their explicit no-ambient-capability loadout.
 * - An explicit `tools` allowlist only passes bridge tools the caller named.
 * - `exclude_tools` always wins.
 * - A sandboxed child is not treated differently here: its task policy enables
 *   the guarded bridge only when the fixed bridge adapter is present, and the
 *   task guard admits the tools by exact source. Withholding them here would
 *   silently disable a capability the sandbox already supports.
 * - Without any restriction, defaults get the full set; the Background host
 *   still intersects the run's captured task authority with the current profile
 *   before anything launches.
 */
export function planWorkerBridgeTools(input: {
    allow: readonly string[];
    excluded: readonly string[];
    clean: boolean;
    explicitTools: boolean;
    /** Production `--tools`/tool schemas published by the parent, when known. */
    productionSchemas?: ReadonlySet<string> | null;
}): WorkerBridgeToolPlan {
    const excluded = new Set(input.excluded.map((name) => name.trim()).filter(Boolean));
    const allow = new Set(input.allow.map((name) => name.trim()).filter(Boolean));
    const withheld: { name: OperationBridgeToolName; reason: string }[] = [];
    const tools: OperationBridgeToolName[] = [];
    for (const name of DEFAULT_WORKER_BRIDGE_TOOLS) {
        if (excluded.has(name)) {
            withheld.push({ name, reason: "excluded by the launch's exclude_tools" });
            continue;
        }
        if (input.clean) {
            withheld.push({ name, reason: "clean mode disables ambient operation capabilities" });
            continue;
        }
        if (input.explicitTools && !allow.has(name)) {
            withheld.push({ name, reason: "not in the launch's explicit tools list" });
            continue;
        }
        // Background tools must be described by the production schemas the parent
        // publishes; the bridge's own two tools carry their own contract.
        const backgroundTool = name !== WAIT_OPERATIONS_TOOL && name !== "acknowledge_operation_result";
        if (backgroundTool && input.productionSchemas && !input.productionSchemas.has(name)) {
            withheld.push({ name, reason: "the parent Background extension publishes no production schema for this tool" });
            continue;
        }
        tools.push(name);
    }
    const has = (name: OperationBridgeToolName): boolean => tools.includes(name);
    return {
        tools,
        withheld,
        capabilities: {
            background: {
                spawn: has("bg_task_spawn"),
                watch: has("bg_task_watch"),
                status: has("bg_task_status"),
                log: has("bg_task_log"),
            },
            wait: has(WAIT_OPERATIONS_TOOL),
            acknowledge: has("acknowledge_operation_result"),
            // The bridge derives `wait_for_operations` from `wait && parking`.
            parking: has(WAIT_OPERATIONS_TOOL),
        },
    };
}

/** Production tool descriptors for bridge tools, from the parent's registrations. */
export function resolveProductionSchemas(
    pi: unknown,
    names: readonly OperationBridgeToolName[] = DEFAULT_WORKER_BRIDGE_TOOLS,
): { schemas: Map<string, OperationToolDescriptor>; missing: OperationBridgeToolName[] } {
    const inventory = (pi as {
        getAllTools?: () => Array<{ name?: unknown; label?: unknown; description?: unknown; parameters?: unknown }>;
    }).getAllTools?.() ?? [];
    const schemas = new Map<string, OperationToolDescriptor>();
    const missing: OperationBridgeToolName[] = [];
    for (const name of names) {
        if (name === WAIT_OPERATIONS_TOOL || name === "acknowledge_operation_result") {
            schemas.set(name, createToolDescriptor(name));
            continue;
        }
        const tool = inventory.find((entry) => entry?.name === name);
        if (!tool || !tool.parameters || typeof tool.parameters !== "object") {
            missing.push(name);
            continue;
        }
        schemas.set(name, {
            name,
            label: tool.label && typeof tool.label === "string" ? tool.label : createToolDescriptor(name).label,
            description: typeof tool.description === "string" && tool.description ? tool.description : createToolDescriptor(name).description,
            parameters: tool.parameters as JsonRecord,
        });
    }
    return { schemas, missing };
}

// ---- bridge host --------------------------------------------------------

/** Checkpoint evidence supplied by the child, before the parent trusts it. */
export interface CheckpointEvidenceInput {
    runId: string;
    conversationId: string;
    waitId: string;
    generation: number;
    evidence: ParkCheckpoint;
    workspace: string;
}

export type CheckpointEvidenceValidator = (input: CheckpointEvidenceInput) => ParkCheckpoint | Promise<ParkCheckpoint>;

function canonical(path: string): string {
    try {
        return realpathSync.native(path);
    } catch {
        return path;
    }
}

/**
 * Default validator: the persisted point must be the trusted launch recipe's own
 * saved conversation (same directory, session id and workspace), and the captured
 * checkpoint must match the evidence the child reported. A file path plus a hash
 * the child chose is not proof.
 */
export const recipeCheckpointEvidenceValidator: CheckpointEvidenceValidator = (input) => {
    const meta = readMeta(input.runId);
    const recipe = meta?.recipe;
    if (!recipe) {
        throw new Error(`Cannot verify a park checkpoint for ${input.runId}: its trusted launch recipe is missing.`);
    }
    if (recipe.sessionId !== input.conversationId) {
        throw new Error(
            `Cannot verify a park checkpoint for ${input.runId}: the launch recipe belongs to conversation ${recipe.sessionId}, not ${input.conversationId}.`,
        );
    }
    if (canonical(recipe.cwd) !== canonical(input.workspace)) {
        throw new Error(
            `Cannot verify a park checkpoint for ${input.runId}: the launch recipe belongs to workspace ${recipe.cwd}, not ${input.workspace}.`,
        );
    }
    const lookup = findSavedConversation({
        sessionDir: recipe.sessionDir,
        sessionId: recipe.sessionId,
        expectedCwd: recipe.cwd,
    });
    switch (lookup.kind) {
        case "ok":
            break;
        case "missing":
            throw new Error(`Cannot verify a park checkpoint for ${input.runId}: its saved conversation is gone.`);
        case "ambiguous":
            throw new Error(`Cannot verify a park checkpoint for ${input.runId}: its saved conversation is ambiguous (${lookup.paths.length} files).`);
        case "invalid":
        case "mismatch":
            throw new Error(`Cannot verify a park checkpoint for ${input.runId}: ${lookup.detail}`);
    }
    if (canonical(lookup.conversation.path) !== canonical(input.evidence.sessionFile)) {
        throw new Error(
            `Cannot verify a park checkpoint for ${input.runId}: the evidence names ${input.evidence.sessionFile}, not this conversation's saved session ${lookup.conversation.path}.`,
        );
    }
    if (input.evidence.sessionId !== recipe.sessionId) {
        throw new Error(`Cannot verify a park checkpoint for ${input.runId}: the evidence names another session id.`);
    }
    const captured = captureParkCheckpoint({
        sessionId: recipe.sessionId,
        sessionFile: lookup.conversation.path,
        toolCallId: input.evidence.toolCallId,
        waitId: input.waitId,
        generation: input.generation,
    });
    verifyParkCheckpoint(captured);
    if (captured.prefixSha256 !== input.evidence.prefixSha256
        || captured.prefixBytes !== input.evidence.prefixBytes
        || captured.entryId !== input.evidence.entryId) {
        throw new Error(`Cannot verify a park checkpoint for ${input.runId}: the reported evidence does not describe the persisted session.`);
    }
    return captured;
};

export interface WorkerOperationRegistration {
    /** Subagent attempt id. Equal to the bridge run id. */
    runId: string;
    /** Native conversation id (the saved session). */
    conversationId: string;
    workspace: string;
    authorityReference: string;
    branchId?: string | null;
    goalId?: string | null;
    policy: WorkerRunPolicy;
    capabilities: OperationBridgeCapabilities;
    tools: readonly OperationBridgeToolName[];
    /** Production descriptors; a tool without one is not advertised. */
    schemas: readonly OperationToolDescriptor[];
    /** Continuation attempt this run will become when it parks. */
    attemptId: string;
    /** Conversation writer lease held for this attempt, if any. */
    writerLeaseId?: string | null;
    /** Foreground owner recorded for resume admission. */
    owner?: WaitOwnerBinding;
}

export interface WorkerOperationHandle {
    runId: string;
    conversationId: string;
    token: string;
    endpoint: string;
    capabilities: OperationBridgeCapabilities;
    tools: readonly OperationBridgeToolName[];
    /** Child extension arguments (one `--extension <path>` pair). */
    childExtensionArgs: string[];
    /** Parent-to-child environment. Contains the per-run token; never persisted. */
    env: Record<string, string>;
    descriptorFingerprint: string;
}

export class WorkerOperationsHostUnavailable extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "WorkerOperationsHostUnavailable";
    }
}

export interface WorkerOperationsHostOptions {
    pi: unknown;
    /** Request/reply fence calls. Injectable for tests. */
    rpc?: WorkerOperationsRpc;
    /** Path to the child bridge extension inside this package. */
    childExtensionPath: string;
    /** Test/replacement seam for native-checkpoint validation. */
    checkpointEvidenceValidator?: CheckpointEvidenceValidator;
    logger?: OperationBridgeLogger;
    /** Test seam for the transport. */
    hostFactory?: typeof createOperationBridgeHost;
    now?: () => number;
}

export interface WorkerOperationsHost {
    readonly available: boolean;
    /** The published object service, once resolved. */
    readonly service: WorkerOperationService | undefined;
    /** Request/reply fence calls used by resume orchestration. */
    readonly rpc: WorkerOperationsRpc;
    start(): Promise<boolean>;
    register(registration: WorkerOperationRegistration): Promise<WorkerOperationHandle>;
    release(runId: string, reason: string): void;
    getRun(runId: string): OperationRunInfo | undefined;
    close(): Promise<void>;
}

function scopeOf(registration: {
    runId: string;
    conversationId: string;
    workspace: string;
    authorityReference: string;
    branchId?: string | null;
    goalId?: string | null;
}): WorkerRunScope {
    return {
        runId: registration.runId,
        conversationId: registration.conversationId,
        workspace: registration.workspace,
        authorityReference: registration.authorityReference,
        branchId: registration.branchId ?? null,
        goalId: registration.goalId ?? null,
    };
}

/**
 * Trusted parent-side bridge host.
 *
 * One host per Pi process. It owns no task runner and no database: every launch,
 * observation, wait, checkpoint and interpretation call goes to the Background
 * service with the run's captured policy, and ownership is re-derived from the
 * durable store on each request (so an attempt resumed into a conversation still
 * sees the tasks that conversation launched earlier).
 */
export function createWorkerOperationsHost(options: WorkerOperationsHostOptions): WorkerOperationsHost {
    const created: { host?: OperationBridgeHost } = {};
    const starting: { promise?: Promise<boolean> } = {};
    const capability: { available: boolean; service?: WorkerOperationService } = { available: false };
    const runs = new Map<string, WorkerRunScope>();
    const waitNotes = new Map<string, string>();
    const rpc = options.rpc ?? createWorkerOperationsRpc(options.pi);
    const validate = options.checkpointEvidenceValidator ?? recipeCheckpointEvidenceValidator;

    const ensureHost = async (): Promise<OperationBridgeHost> => {
        if (created.host) return created.host;
        const factory = options.hostFactory ?? createOperationBridgeHost;
        created.host = await factory({
            ...(options.logger ? { logger: options.logger } : {}),
            ...(options.now ? { now: options.now } : {}),
        });
        return created.host;
    };

    const start = async (): Promise<boolean> => {
        if (starting.promise) return starting.promise;
        starting.promise = (async () => {
            const service = getWorkerOperationService(options.pi);
            if (!service) {
                capability.available = false;
                return false;
            }
            await ensureHost();
            capability.service = service;
            capability.available = true;
            return true;
        })();
        return starting.promise;
    };

    const requireService = (): WorkerOperationService => {
        if (!capability.service) {
            throw new WorkerOperationsHostUnavailable(
                "The Background observed-waits service is not available, so this worker cannot be given supervised operation tools or parking. Install pi-better-background-tasks, or launch without them.",
            );
        }
        return capability.service;
    };

    const register = async (registration: WorkerOperationRegistration): Promise<WorkerOperationHandle> => {
        if (!capability.available) {
            const ready = await start();
            if (!ready) throw new WorkerOperationsHostUnavailable(workerOperationsUnavailableReason(options.pi) ?? "The Background observed-waits service is not available.");
        }
        const service = requireService();
        const host = await ensureHost();
        const scope = scopeOf(registration);
        runs.set(registration.runId, scope);
        const owner = {
            kind: "worker-conversation" as const,
            sessionId: registration.conversationId,
            workspace: registration.workspace,
            branchId: registration.branchId ?? null,
            goalId: registration.goalId ?? null,
        };
        // The durable run binding captures the worker's task authority and the
        // conversation identity. Every later tool call, checkpoint and resume fence
        // is checked against it by the Background host.
        const registered = await rpc.call("register-run", {
            runId: registration.runId,
            conversationId: registration.conversationId,
            attemptId: registration.attemptId,
            workspace: registration.workspace,
            authorityReference: registration.authorityReference,
            policy: registration.policy as unknown as JsonRecord,
            tools: [...registration.tools],
            capabilities: registration.capabilities as unknown as JsonRecord,
            assignmentOutcomesVersion: 1,
            owner,
            ...(registration.writerLeaseId ? { writerLeaseId: registration.writerLeaseId } : {}),
        });
        if (registered.assignmentOutcomesVersion !== 1) {
            runs.delete(registration.runId);
            try { await rpc.call("release-run", { runId: registration.runId, reason: "assignment outcome capability mismatch" }); } catch { /* preserve the capability refusal */ }
            throw new WorkerOperationsRefusal("service-unavailable", "Background host does not support durable assignment outcomes v1; upgrade the standalone packages together.");
        }

        /**
         * Ownership is re-derived from the durable store (by conversation), so an
         * attempt resumed into this conversation still owns the tasks an earlier
         * attempt launched. This is a transport guard; Background rechecks too.
         */
        const ownsTask = (taskId: string): boolean => {
            try {
                return service.ownsTask(scope, taskId);
            } catch {
                return false;
            }
        };
        const handlers: OperationRunHandlers = {};
        const execute = (tool: string, params: JsonRecord): Promise<JsonRecord> => rpc.call("execute-tool", {
            runId: registration.runId,
            conversationId: registration.conversationId,
            tool,
            params,
        });
        if (registration.capabilities.background.spawn) {
            handlers.bg_task_spawn = async (params) => execute("bg_task_spawn", params);
        }
        if (registration.capabilities.background.watch) {
            handlers.bg_task_watch = async (params) => execute("bg_task_watch", params);
        }
        if (registration.capabilities.background.status) {
            handlers.bg_task_status = async (params) => execute("bg_task_status", params);
        }
        if (registration.capabilities.background.log) {
            handlers.bg_task_log = async (params) => execute("bg_task_log", params);
        }
        if (registration.capabilities.wait && registration.capabilities.parking) {
            handlers.wait_for_operations = async (params: JsonRecord) => {
                const taskIds = Array.isArray(params.task_ids)
                    ? params.task_ids.filter((value): value is string => typeof value === "string")
                    : [];
                if (taskIds.length === 0) {
                    throw new WorkerOperationsRefusal("task-invalid", "wait_for_operations needs at least one task id");
                }
                const note = typeof params.continuation_note === "string" ? params.continuation_note : "";
                if (!note) {
                    throw new WorkerOperationsRefusal("task-invalid", "wait_for_operations needs a continuation note");
                }
                const view = await rpc.call("wait-admission", {
                    runId: registration.runId,
                    conversationId: registration.conversationId,
                    taskIds,
                    continuationNote: note,
                    attemptId: registration.attemptId,
                    owner,
                }) as unknown as WorkerWaitView;
                if (!view.park) {
                    throw new WorkerOperationsRefusal("wait-invalid", "the Background host did not register a park wait for this worker");
                }
                waitNotes.set(`${view.waitId}:${view.generation}`, note);
                const normalized = normalizeWaitForOperationsResult({ ...view, park: true, taskIds: view.taskIds.length ? view.taskIds : taskIds });
                if (!normalized.ok) {
                    throw new WorkerOperationsRefusal("wait-invalid", `wait admission returned an invalid result: ${normalized.message}`);
                }
                return { ...view, ...normalized.result, park: true };
            };
        }
        if (registration.capabilities.acknowledge) {
            handlers.acknowledge_operation_result = async (params: JsonRecord) => {
                const waitId = typeof params.wait_id === "string" ? params.wait_id : "";
                const generation = typeof params.generation === "number" ? params.generation : 0;
                const disposition = params.disposition;
                if (!waitId || !generation || typeof disposition !== "string" || !["continue", "blocked", "assignment-complete"].includes(disposition)) {
                    throw new WorkerOperationsRefusal("schema-invalid", "acknowledge_operation_result needs wait_id, generation and a disposition");
                }
                const view = await rpc.call("acknowledge", {
                    runId: registration.runId,
                    conversationId: registration.conversationId,
                    waitId,
                    generation,
                    terminalRevisions: params.terminal_revisions,
                    disposition: disposition as "continue" | "blocked" | "assignment-complete",
                    note: typeof params.note === "string" ? params.note : "",
                    owner,
                }) as unknown as WorkerAcknowledgeView;
                const parked = parkedWaitByGeneration(waitId, generation);
                if (parked) updateParkRecord(parked.runId, { phase: "consumed" });
                return view;
            };
        }
        if (registration.capabilities.parking) {
            handlers.checkpoint = async (params: JsonRecord) => {
                const waitId = typeof params.wait_id === "string" ? params.wait_id : "";
                const generation = typeof params.generation === "number" ? params.generation : 0;
                const evidence = params.evidence as ParkCheckpoint | undefined;
                if (!waitId || !generation || !evidence || typeof evidence !== "object") {
                    throw new WorkerOperationsRefusal("checkpoint-invalid", "checkpoint needs wait_id, generation and evidence");
                }
                // Validate against the trusted recipe (session location, id and
                // workspace) and re-capture the checkpoint from the file itself.
                let captured: ParkCheckpoint;
                try {
                    captured = await validate({
                        runId: registration.runId,
                        conversationId: registration.conversationId,
                        waitId,
                        generation,
                        evidence,
                        workspace: registration.workspace,
                    });
                } catch (error) {
                    throw new OperationBridgeError("checkpoint-invalid", reasonOf(error));
                }
                const note = waitNotes.get(`${waitId}:${generation}`);
                const at = options.now?.() ?? Date.now();
                // STAGED: the original writer is still alive, so the generation stays
                // `parking`; Background records the evidence and the exit path proves
                // writer exit before the wait can leave parking.
                const staged = await rpc.call("checkpoint", {
                    runId: registration.runId,
                    conversationId: registration.conversationId,
                    waitId,
                    generation,
                    toolCallId: captured.toolCallId,
                    attemptId: registration.attemptId,
                    evidence: captured as unknown as JsonRecord,
                });
                if (staged.phase !== "parking" && staged.staged !== true) {
                    throw new WorkerOperationsRefusal("checkpoint-invalid", `the Background host reported ${String(staged.phase)} for a staged park checkpoint`);
                }
                writeParkRecord(registration.runId, {
                    version: 1,
                    waitId,
                    generation,
                    phase: "parking",
                    attemptId: registration.attemptId,
                    ...(note ? { continuationNote: note } : {}),
                    ...(registration.owner ? {
                        ownerSessionId: registration.owner.sessionId,
                        ownerWorkspace: registration.owner.workspace,
                        ownerBranchId: registration.owner.branchId,
                        ownerGoalId: registration.owner.goalId,
                    } : {}),
                    checkpoint: {
                        sessionId: captured.sessionId,
                        sessionFile: captured.sessionFile,
                        toolCallId: captured.toolCallId,
                        entryId: captured.entryId,
                        prefixBytes: captured.prefixBytes,
                        prefixSha256: captured.prefixSha256,
                    },
                    parkedAt: at,
                    updatedAt: at,
                });
                return { checkpointed: true, staged: true, phase: "parking", waitId, generation };
            };
            handlers.park_failed = async (params: JsonRecord) => {
                const waitId = typeof params.wait_id === "string" ? params.wait_id : "";
                const generation = typeof params.generation === "number" ? params.generation : 0;
                const reason = typeof params.reason === "string" && params.reason ? params.reason : "the worker could not certify its park checkpoint";
                if (!waitId || !generation) {
                    throw new WorkerOperationsRefusal("schema-invalid", "park_failed needs wait_id and generation");
                }
                const view = await rpc.call("park-failed", {
                    runId: registration.runId,
                    conversationId: registration.conversationId,
                    waitId,
                    generation,
                    reason,
                });
                updateParkRecord(registration.runId, { phase: phaseOf(String(view.phase)), heldReason: reason });
                return { held: true, phase: view.phase };
            };
        }

        const handle = host.registerRun({
            runId: registration.runId,
            conversationId: registration.conversationId,
            workspace: registration.workspace,
            authorityReference: registration.authorityReference,
            capabilities: registration.capabilities,
            tools: normalizeToolDescriptors(registration.schemas, registration.capabilities),
            ownership: (taskId) => ownsTask(taskId),
            handlers,
        });
        return {
            runId: registration.runId,
            conversationId: registration.conversationId,
            token: handle.token,
            endpoint: host.endpoint,
            capabilities: registration.capabilities,
            tools: registration.tools,
            childExtensionArgs: ["--extension", options.childExtensionPath],
            env: childEnvironment(handle.token, host.endpoint, registration),
            descriptorFingerprint: handle.descriptor.fingerprint,
        };
    };

    const release = (runId: string, reason: string): void => {
        runs.delete(runId);
        try { created.host?.unregisterRun(runId); } catch { /* already gone */ }
        void rpc.call("release-run", { runId, reason }).catch(() => {});
    };

    const close = async (): Promise<void> => {
        const host = created.host;
        created.host = undefined;
        starting.promise = undefined;
        capability.available = false;
        capability.service = undefined;
        runs.clear();
        waitNotes.clear();
        if (!host) return;
        await host.close();
    };

    return {
        get available() {
            return capability.available;
        },
        get service() {
            return capability.service;
        },
        rpc,
        start,
        register,
        release,
        getRun: (runId) => created.host?.getRun(runId),
        close,
    };
}

/** Environment handed to the child; the token is the only secret and is never persisted. */
export function childEnvironment(
    token: string,
    endpoint: string,
    registration: { runId: string; conversationId: string; attemptId: string },
): Record<string, string> {
    return {
        [OPERATIONS_ENABLED_ENV]: "1",
        [OPERATIONS_ENDPOINT_ENV]: endpoint,
        [OPERATIONS_TOKEN_ENV]: token,
        [OPERATIONS_RUN_ID_ENV]: registration.runId,
        [OPERATIONS_CONVERSATION_ID_ENV]: registration.conversationId,
        [OPERATIONS_ATTEMPT_ID_ENV]: registration.attemptId,
        [OPERATIONS_CHILD_ID_ENV]: `${registration.runId}:${randomUUID()}`,
    };
}

/** Writer-lease id for a parked attempt, when the continuation path holds one. */
export function childWriterLeaseEnv(leaseId: string | undefined): Record<string, string> {
    return leaseId ? { [OPERATIONS_WRITER_LEASE_ID_ENV]: leaseId } : {};
}

// ---- park record, disposition and post-exit finalization ------------------

/** Phases a wait can report, mirrored into the park record. */
export function phaseOf(phase: string): ParkRecord["phase"] {
    switch (phase) {
        case "parking":
        case "waiting":
        case "ready":
        case "resuming":
        case "held":
        case "consumed":
        case "cancelled":
            return phase;
        default:
            return "held";
    }
}

export interface ParkDisposition {
    /** True when this exit is a clean park: the attempt finished, not the assignment. */
    parked: boolean;
    record?: ParkRecord;
    reason?: string;
}

/** True when the recorded exit is a clean completed attempt. */
export function isCleanParkExit(meta: RunMeta | undefined): boolean {
    if (!meta) return false;
    if (meta.exitCode !== 0) return false;
    if (meta.failureReason !== undefined) return false;
    if (meta.lifecycleClassification === "incomplete_no_terminal_event") return false;
    if (meta.lifecycleClassification === "incomplete_open_tools") return false;
    if (meta.lifecycleClassification === "failed_model_error") return false;
    return meta.status === "completed";
}

/**
 * Decide the exit disposition for a run.
 *
 * A park is recognized only when the exit was clean, a durable park record
 * exists, its wait generation is still live, and the recorded checkpoint still
 * verifies against the saved conversation. A staged record (`parking`) counts:
 * the durable wait is finalized separately, after the writer exit is proven.
 */
export function evaluateParkDisposition(input: {
    runId: string;
    cleanExit: boolean;
    verifyCheckpoint?: (checkpoint: ParkCheckpoint) => void;
}): ParkDisposition {
    const record = readParkRecord(input.runId);
    if (!record) return { parked: false };
    if (!isPendingPark(record)) {
        return { parked: false, reason: `wait ${record.waitId} generation ${record.generation} is ${record.phase}` };
    }
    if (record.phase === "held" || record.phase === "resuming") {
        return { parked: false, record, reason: record.heldReason ?? `the wait is ${record.phase}` };
    }
    if (!input.cleanExit) {
        return { parked: false, record, reason: "the child did not exit cleanly" };
    }
    if (!record.checkpoint) return { parked: false, record, reason: "no verified park checkpoint was recorded" };
    const verify = input.verifyCheckpoint ?? verifyParkCheckpoint;
    try {
        verify({
            version: 1,
            sessionId: record.checkpoint.sessionId,
            sessionFile: record.checkpoint.sessionFile,
            toolCallId: record.checkpoint.toolCallId,
            waitId: record.waitId,
            generation: record.generation,
            entryId: record.checkpoint.entryId,
            prefixBytes: record.checkpoint.prefixBytes,
            prefixSha256: record.checkpoint.prefixSha256,
        });
    } catch (error) {
        return { parked: false, record, reason: `checkpoint no longer verifies: ${reasonOf(error)}` };
    }
    return { parked: true, record };
}

export interface ParkFinalizationInput {
    runId: string;
    service: WorkerOperationService | undefined;
    /** True when the caller knows the conversation writer lease was released. */
    writerLeaseReleased: boolean;
    /** Defaults to the recorded pid no longer existing. */
    writerPidGone?: boolean;
    /**
     * Restart recovery: the parent that observed the exit is gone, so the exit
     * code may be unknown. A staged checkpoint whose writer is proven gone and
     * whose lease is free still describes a finished attempt; the assignment
     * result is unchanged (nothing is reported as succeeded).
     */
    interrupted?: boolean;
    now?: () => number;
}

export interface ParkFinalization {
    outcome: "parked" | "held" | "cancelled" | "skipped";
    reason?: string;
    wait?: WorkerWaitView;
    proof?: { checkpointRecorded: boolean; writerLeaseReleased: boolean; writerPidGone: boolean };
}

/**
 * The Background owner scope for a parked worker attempt.
 *
 * `record.ownerWorkspace` belongs to the FOREGROUND parent that owns the
 * assignment and is only used for resume admission. Background registered this
 * worker conversation under the WORKER's workspace (the `sandbox_dir` or clone the
 * child actually ran in), so ownership must use that; mixing the two makes every
 * post-exit operation foreign to the durable record.
 */
export function backgroundScopeForMeta(meta: RunMeta, record: ParkRecord): WorkerRunScope | null {
    const operations = meta.operations;
    const conversationId = operations?.conversationId ?? meta.sessionId;
    const workspace = operations?.workspace ?? meta.cwd;
    if (!conversationId || !workspace) return null;
    return {
        runId: meta.id,
        conversationId,
        workspace,
        authorityReference: operations?.authorityReference ?? `worker:${meta.id}`,
        branchId: record.ownerBranchId ?? null,
        goalId: record.ownerGoalId ?? null,
    };
}

/**
 * Finalize a staged park AFTER the child exited.
 *
 * Background requires three facts before a generation may leave `parking`:
 * the checkpoint was recorded (staged by the bridge while the child was alive),
 * the writer lease was released, and the original writer process is gone. This is
 * the only place that sends that proof; a missing or unproven fact holds the
 * generation instead of claiming a park.
 */
export async function finalizeWorkerParkAfterExit(input: ParkFinalizationInput): Promise<ParkFinalization> {
    const meta = readMeta(input.runId);
    const record = readParkRecord(input.runId);
    if (!meta || !record) return { outcome: "skipped" };
    const service = input.service;
    const hold = (reason: string): ParkFinalization => {
        updateParkRecord(input.runId, { phase: "held", heldReason: reason });
        return { outcome: "held", reason };
    };
    if (!service) return hold("the Background operation service is unavailable; the park wait cannot be finalized");

    const scope = backgroundScopeForMeta(meta, record);
    if (!scope) return hold("this run records no conversation workspace for its park wait");

    // A restart has no exit observation. The staged checkpoint plus a proven-dead
    // writer is the strongest available evidence; an unknown exit code alone is
    // never treated as success, but it does not strand a finished attempt either.
    const writerGone = input.writerPidGone ?? !processExists(meta.pid);
    const cleanExit = isCleanParkExit(meta) || (input.interrupted === true && writerGone);
    const disposition = evaluateParkDisposition({ runId: input.runId, cleanExit });
    if (!disposition.parked) {
        const reason = disposition.reason ?? "the attempt did not park cleanly";
        try {
            const view = service.failWorkerPark(scope, { waitId: record.waitId, generation: record.generation, reason });
            const phase = phaseOf(view.phase);
            updateParkRecord(input.runId, { phase, heldReason: phase === "cancelled" ? reason : undefined });
            return { outcome: phase === "cancelled" ? "cancelled" : "held", reason, wait: view };
        } catch (error) {
            return hold(`${reason}; releasing the wait failed: ${reasonOf(error)}`);
        }
    }

    const proof = {
        checkpointRecorded: record.checkpoint !== undefined,
        writerLeaseReleased: input.writerLeaseReleased,
        writerPidGone: input.writerPidGone ?? !processExists(meta.pid),
    };
    if (!proof.checkpointRecorded || !proof.writerLeaseReleased || !proof.writerPidGone) {
        const missing = [
            proof.checkpointRecorded ? undefined : "the checkpoint was not recorded",
            proof.writerLeaseReleased ? undefined : "the writer lease was not released",
            proof.writerPidGone ? undefined : "the original writer process is still alive",
        ].filter(Boolean).join("; ");
        return hold(`the parked wait needs proven exit: ${missing}`);
    }
    try {
        const view = await service.checkpointWorkerWait(scope, {
            waitId: record.waitId,
            generation: record.generation,
            proof,
        });
        updateParkRecord(input.runId, {
            phase: phaseOf(view.phase),
            heldReason: view.phase === "held" ? "the Background host held the wait after checkout" : undefined,
        });
        return { outcome: "parked", wait: view, proof };
    } catch (error) {
        return hold(`the Background host refused the park checkpoint: ${reasonOf(error)}`);
    }
}

// ---- resume orchestration ------------------------------------------------

export interface WaitOwnerBinding {
    sessionId: string;
    workspace: string;
    branchId: string | null;
    goalId: string | null;
}

/** Read-only mirror of Goal's public session-entry shape (no Goal import). */
const GOAL_SESSION_ENTRY = "pi-better-goal";
const LEGACY_GOAL_SESSION_ENTRY = "pi-codex-goal";

/**
 * Current Goal binding for a foreground context, or null when no goal is
 * recorded. Only the id is read: status, holds and workflow gates stay Goal's
 * decision, answered through the admission event. An unreadable branch yields
 * `null`, so admission refuses instead of resuming against a guessed goal.
 */
export function readGoalBinding(ctx: ExtensionContext | undefined): { goalId: string | null; branchId: string | null } {
    if (!ctx) return { goalId: null, branchId: null };
    try {
        const branch = ctx.sessionManager.getBranch() as Array<{ id?: unknown; type?: unknown; customType?: unknown; data?: unknown }>;
        let goalId: string | null = null;
        for (const entry of branch) {
            if (entry?.type !== "custom") continue;
            if (entry.customType !== GOAL_SESSION_ENTRY && entry.customType !== LEGACY_GOAL_SESSION_ENTRY) continue;
            const data = entry.data as { kind?: unknown; goal?: unknown } | undefined;
            if (!data || typeof data !== "object") continue;
            if (data.kind === "clear") goalId = null;
            if (data.kind === "set") {
                const goal = data.goal as { goalId?: unknown } | undefined;
                goalId = typeof goal?.goalId === "string" ? goal.goalId : goalId;
            }
        }
        const last = branch.at(-1);
        return { goalId, branchId: typeof last?.id === "string" ? last.id : null };
    } catch {
        return { goalId: null, branchId: null };
    }
}

/** True when the recorded branch anchor is still on the current branch. */
export function branchContains(ctx: ExtensionContext, anchor: string): boolean {
    try {
        return (ctx.sessionManager.getBranch() as Array<{ id?: unknown }>).some((entry) => entry.id === anchor);
    } catch {
        return false;
    }
}

/** Owner binding recorded at launch for a foreground context. */
export function ownerBindingFromContext(ctx: ExtensionContext): WaitOwnerBinding {
    const { goalId, branchId } = readGoalBinding(ctx);
    let sessionId: string;
    try {
        sessionId = ctx.sessionManager.getSessionId();
    } catch {
        sessionId = "";
    }
    return { sessionId, workspace: ctx.cwd, branchId, goalId };
}

export interface ResumeAdmissionRequest {
    version: 1;
    owner: { sessionId: string; workspace: string; branchId?: string | null; goalId?: string | null };
    reply(gate: { allowed: boolean; reason?: string; revision: number; isCurrent?: () => boolean }): void;
}

export type ResumeAdmission =
    | { allowed: true; revision: number; isCurrent?: () => boolean }
    | { allowed: false; reason: string; revision: number };

/**
 * Legacy parent Goal admission helper. Delegated assignments do not call this.
 * The owner binding is the one captured when the worker parked.
 */
export async function requestResumeAdmission(
    pi: unknown,
    owner: WaitOwnerBinding,
    options: { timeoutMs?: number } = {},
): Promise<ResumeAdmission> {
    const bus = serviceBusOf(pi);
    if (!bus) {
        return { allowed: false, reason: "No Goal admission channel is available; a resume needs an active owning parent.", revision: -1 };
    }
    const timeoutMs = Math.max(50, Math.min(60_000, options.timeoutMs ?? 10_000));
    const answer = await new Promise<ResumeAdmission | null>((resolve) => {
        let settled = false;
        const finish = (value: ResumeAdmission | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        timer.unref?.();
        const request: ResumeAdmissionRequest = {
            version: 1,
            owner: {
                sessionId: owner.sessionId,
                workspace: owner.workspace,
                branchId: owner.branchId,
                goalId: owner.goalId,
            },
            reply: (gate) => {
                if (!gate || typeof gate.allowed !== "boolean") {
                    finish({ allowed: false, reason: "Goal returned a malformed resume admission", revision: -1 });
                    return;
                }
                finish(gate.allowed
                    ? { allowed: true, revision: typeof gate.revision === "number" ? gate.revision : 0,
                        ...(typeof gate.isCurrent === "function" ? { isCurrent: gate.isCurrent } : {}) }
                    : {
                        allowed: false,
                        reason: typeof gate.reason === "string" && gate.reason ? gate.reason : "Goal refused the resume",
                        revision: typeof gate.revision === "number" ? gate.revision : 0,
                    });
            },
        };
        try {
            bus.emit(OPERATION_RESUME_ADMISSION_EVENT, request);
        } catch {
            finish({ allowed: false, reason: "The Goal admission channel failed", revision: -1 });
        }
    });
    if (answer) return answer;
    return {
        allowed: false,
        reason: "No Goal admission answer arrived; a resume needs an active owning parent and Goal gate.",
        revision: -1,
    };
}

/** A parked generation this process may resume. */
export interface ParkedWait {
    runId: string;
    conversationId: string;
    attemptId: string;
    waitId: string;
    generation: number;
    phase: ParkRecord["phase"];
    meta: RunMeta;
    record: ParkRecord;
}

function parkedEntry(meta: RunMeta, record: ParkRecord): ParkedWait {
    return {
        runId: meta.id,
        conversationId: meta.sessionId,
        attemptId: meta.id,
        waitId: record.waitId,
        generation: record.generation,
        phase: record.phase,
        meta,
        record,
    };
}

/** Parked runs whose wait can still resume (including held ones). */
export function parkedWaits(): ParkedWait[] {
    const parked: ParkedWait[] = [];
    for (const meta of listPendingParkedRuns()) {
        const record = readParkRecord(meta.id);
        if (!record || !isPendingPark(record)) continue;
        parked.push(parkedEntry(meta, record));
    }
    return parked;
}

export function parkedWaitForRun(runId: string): ParkedWait | null {
    return parkedWaits().find((entry) => entry.runId === runId) ?? null;
}

/** A parked attempt's record for one wait generation, in any phase. */
export function parkedWaitByGeneration(waitId: string, generation: number): ParkedWait | null {
    for (const meta of listMetas()) {
        const record = readParkRecord(meta.id);
        if (!record || record.waitId !== waitId || record.generation !== generation) continue;
        return parkedEntry(meta, record);
    }
    return null;
}

/** Refusal text for a manual continuation of a conversation parked on a wait. */
export function manualResumeRefusal(parked: ParkedWait): string {
    return `Cannot continue ${parked.runId} manually: it is parked on wait ${parked.waitId} generation ${parked.generation} (${parked.phase}) and will resume automatically when its dependency settles. ` +
        `To take over, run subagent_stop ${parked.runId} first; that cancels the pending automatic resume.`;
}

/** Capacity admission injected by the launcher (the ordinary Subagents gate). */
export interface ResumeCapacity {
    tryReserve(): boolean;
    /** Conservative recheck after reserving, for a cap reduced in the meantime. */
    recheck(): boolean;
    commit(): void;
    release(): void;
}

export interface ResumeLaunchInput {
    park: ParkedWait;
    /** Attempt id and token published durably before the child is spawned. */
    assignedRunId: string;
    launchToken: string;
    /** Durable claim identity the publication must still match at dispatch. */
    claim: { claimId: string; claimToken: string; cancelEpoch: number; attemptId: string; launchToken: string };
    /** Goal admission revision the owner was admitted at. */
    admissionRevision: number;
}

/**
 * Stop one attempt this process owns. Implemented by the host with the ordinary
 * `subagent_stop` path; it must verify ownership itself and must never signal a
 * pid it cannot attribute (return `"foreign"` instead).
 */
export type StopPublishedAttempt = (input: {
    attemptId: string;
    /** Token persisted with the attempt before spawn; identifies the publication. */
    launchToken?: string;
    waitId: string;
    generation: number;
    reason: string;
}) => Promise<"aborted" | "stopped" | "foreign"> | "aborted" | "stopped" | "foreign";

/**
 * Default owner-checked stopper: only a child this parent spawned, whose recorded
 * publication token matches, may be stopped. Anything else is reported as
 * `foreign` so no pid is signalled on a guess.
 */
export function createOwnedAttemptStopper(options: {
    parentPid?: number;
    /** Replacement stop implementation (tests, or a host with different semantics). */
    stop?: (attemptId: string) => { action: string };
} = {}): StopPublishedAttempt {
    const parentPid = options.parentPid ?? process.pid;
    const stop = options.stop ?? ((attemptId: string) => stopRun(attemptId));
    return (input) => {
        const meta = readMeta(input.attemptId);
        if (!meta) return "aborted";
        if (meta.spawnPid !== parentPid) return "foreign";
        if (input.launchToken && meta.operations?.resumeLaunchToken !== input.launchToken) return "foreign";
        const outcome = stop(input.attemptId);
        return outcome.action === "stopped" || outcome.action === "finalized" ? "stopped" : "aborted";
    };
}

export interface ResumeOrchestrationOptions {
    pi: unknown;
    service: () => WorkerOperationService | undefined;
    rpc: WorkerOperationsRpc;
    context(): ExtensionContext | undefined;
    capacity: ResumeCapacity;
    /** Launch one continuation through the existing admission path. */
    launch(input: ResumeLaunchInput): Promise<void>;
    /** Follow a cancelled generation to the attempt it already published. */
    stopAttempt?: StopPublishedAttempt;
    notify?(message: string, level: "info" | "warning"): void;
    now?: () => number;
}

export interface ResumeOrchestration {
    /** Try to resume one parked generation. */
    resume(park: ParkedWait): Promise<"resumed" | "held" | "skipped">;
    /** Ready/cancelled delivery adapter to register with the Background host. */
    readonly adapter: WorkerContinuationAdapter;
    stop(): void;
}

/**
 * A continuation refused before any child could exist (planning, capacity,
 * current permission admission, writer lease). The launcher throws this only for
 * a proven pre-spawn failure; anything else is ambiguous and is held.
 */
export class PreSpawnResumeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PreSpawnResumeError";
    }
}

/**
 * Release one child: the synchronous dispatch guard runs with no await (and no
 * other code) between it and the spawn, so nothing can slip in after the guard.
 */
export function releaseChild<T>(guard: DispatchGuard | undefined | void, spawn: () => T): T {
    if (typeof guard === "function") guard();
    return spawn();
}

/** A proven pre-spawn refusal from the final dispatch fence. */
export class FinalDispatchRefusal extends PreSpawnResumeError {
    constructor(message: string) {
        super(message);
        this.name = "FinalDispatchRefusal";
    }
}

/** Synchronous guard invoked immediately before the child is released. */
export type DispatchGuard = () => void;

export interface FinalDispatchInput {
    pi: unknown;
    rpc: WorkerOperationsRpc;
    /** The object service, read synchronously for the final durable confirmation. */
    service: () => WorkerOperationService | undefined;
    /** Live foreground context getter: never a value captured before the awaits. */
    context: () => ExtensionContext | undefined;
    park: ParkedWait;
    claim: { claimId: string; claimToken: string; cancelEpoch: number; attemptId: string; launchToken: string };
    /** Foreground owner binding captured when the worker parked. */
    owner: WaitOwnerBinding;
    /** Goal admission revision the resume was admitted at. */
    admissionRevision: number;
    /** Fresh permission resolution compared with the captured one. */
    permissionsUnchanged(): boolean;
    /** Ordinary capacity gate recheck. */
    capacityAvailable(): boolean;
    admissionTimeoutMs?: number;
    /** Extra host-specific synchronous check (for example a generation counter). */
    extraCheck?: () => void;
}

/**
 * Final dispatch fence.
 *
 * Final dispatch checks the compatible host, captured permission scope, durable
 * claim, cancellation epoch, launch identity and capacity. Parent Goal, session
 * and branch changes do not revoke an existing assignment.
 */
export async function assertFinalResumeDispatch(input: FinalDispatchInput): Promise<DispatchGuard> {
    const refusal = (message: string): never => {
        throw new FinalDispatchRefusal(message);
    };
    const assertIdentity = (_phase: string): void => {
        const ctx = input.context();
        if (!ctx) refusal("No compatible supervisor host is available");
        if (canonical(ctx!.cwd) !== canonical(input.owner.workspace)) {
            refusal("The supervisor workspace is incompatible with the assignment");
        }
        if (input.service()?.assignmentContinuation !== 1) {
            refusal("The Background host does not support assignment-local continuation");
        }
    };
    /**
     * The only durable confirmation that matters at release time.
     *
     * `listWorkerWaits` is synchronous, so it runs after every await and directly
     * before the spawn with no window for cancellation, a claim change or a parent
     * switch to hide inside. The store enforces one active claim per generation, and
     * the async part above already replayed `publish-resume` with the exact token,
     * so phase + cancellation epoch identify this publication.
     */
    const durableGuard = (): void => {
        const service = input.service();
        if (!service) refusal("The Background operation service is unavailable at dispatch; the continuation was not started");
        const scope = backgroundScopeForMeta(input.park.meta, input.park.record);
        if (!scope) refusal("The parked attempt records no worker conversation scope; the continuation was not started");
        let view: WorkerWaitView | undefined;
        try {
            view = (service as WorkerOperationService).listWorkerWaits(scope!, { pendingOnly: true })
                .find((entry) => entry.waitId === input.park.waitId && entry.generation === input.park.generation);
        } catch (error) {
            refusal(`The durable wait could not be read at dispatch: ${reasonOf(error)}`);
        }
        if (!view) {
            refusal("The durable wait is gone at dispatch (consumed or cancelled); the continuation was not started");
        }
        if (view!.phase !== "resuming") {
            refusal(`The durable wait is ${view!.phase} at dispatch, not resuming; the continuation was not started`);
        }
        if (view!.cancelEpoch !== input.claim.cancelEpoch) {
            refusal("The wait was cancelled or replaced at dispatch; the continuation was not started");
        }
    };
    const guard = (): void => {
        assertIdentity("dispatch");
        if (!input.permissionsUnchanged()) {
            refusal("The worker's permissions changed before dispatch; the continuation was not started");
        }
        if (!input.capacityAvailable()) {
            refusal("Capacity changed before dispatch; the continuation was not started");
        }
        durableGuard();
        input.extraCheck?.();
        // Identity can only change synchronously through this process, so one final
        // read after the durable check closes the guard.
        assertIdentity("release");
    };

    // Synchronous identity and captured policy first: cheap and fail-closed.
    assertIdentity("preparation");
    if (!input.permissionsUnchanged()) {
        refusal("The worker's permissions changed while the resume was being prepared; the continuation was not started");
    }
    if (!input.capacityAvailable()) {
        refusal("Capacity changed while the resume was being prepared; the continuation was not started");
    }

    // Durable claim, phase and cancellation epoch (async pre-check).
    const snapshot = await input.rpc.call("wait-snapshot", {
        waitId: input.park.waitId,
        generation: input.park.generation,
    });
    if (snapshot.phase !== "resuming") {
        refusal(`The durable wait is ${String(snapshot.phase)}, not resuming; the continuation was not started`);
    }
    if (Number(snapshot.cancelEpoch ?? -1) !== input.claim.cancelEpoch) {
        refusal("The wait was cancelled or replaced while the resume was being prepared; the continuation was not started");
    }
    const active = snapshot.claim as { state?: unknown; attemptId?: unknown; claimId?: unknown } | null | undefined;
    if (!active || active.state !== "published" || active.attemptId !== input.claim.attemptId) {
        refusal("The published resume claim no longer names this attempt; the continuation was not started");
    }

    // Exact launch token: replaying the publication is idempotent only for the
    // same (claim, token, attempt, launch token) tuple.
    await input.rpc.call("publish-resume", {
        runId: input.park.runId,
        waitId: input.park.waitId,
        generation: input.park.generation,
        claimId: input.claim.claimId,
        claimToken: input.claim.claimToken,
        attemptId: input.claim.attemptId,
        launchToken: input.claim.launchToken,
    });

    // Parent workflow state is provenance, not assignment authority.
    // Validate the synchronous guard once here (so the returned guard is known to
    // hold after the last await) and hand it back for the release point.
    guard();
    return guard;
}

/**
 * One resume at a time, through the existing continuation launch path.
 *
 * Order is fixed: capacity is reserved with the ordinary gate, captured assignment
 * scope is restored, the durable wait is
 * re-read, the attempt id/token are written to the park record, and only then is
 * a child spawned. A full capacity defers delivery without touching the wait, so
 * a queued resume never becomes "held". A proven pre-spawn failure holds the wait
 * with its reason; an ambiguous failure holds without relaunching.
 */
export function createResumeOrchestration(options: ResumeOrchestrationOptions): ResumeOrchestration {
    const inFlight = new Set<string>();
    const now = options.now ?? (() => Date.now());

    const hold = (park: ParkedWait, reason: string): "held" => {
        updateParkRecord(park.runId, { phase: "held", heldReason: reason });
        try {
            options.service()?.failWorkerPark(backgroundScopeForMeta(park.meta, park.record) ?? {
                runId: park.runId,
                conversationId: park.conversationId,
                workspace: park.meta.operations?.workspace ?? park.meta.cwd,
                authorityReference: park.meta.operations?.authorityReference ?? `worker:${park.runId}`,
            }, { waitId: park.waitId, generation: park.generation, reason });
        } catch { /* the park record still shows the hold */ }
        if (park.meta.assignment) commitAssignmentTerminal({ ...park.meta, status: "failed", failureReason: reason }, true);
        try {
            options.notify?.(`Subagent ${park.runId} wait ${park.waitId} is held: ${reason}`, "warning");
        } catch { /* ignore UI failures */ }
        return "held";
    };

    const resume = async (park: ParkedWait): Promise<"resumed" | "held" | "skipped"> => {
        const key = `${park.waitId}:${park.generation}`;
        if (inFlight.has(key)) return "skipped";
        inFlight.add(key);
        let reserved = false;
        try {
            // The durable wait is the authority for readiness (checked below). A
            // record that is in flight or already held must never start another
            // automatic attempt: `resuming` has a published attempt, and `held`
            // waits for its owner's interpretation.
            if (park.record.phase === "resuming" || park.record.phase === "held") return "skipped";
            const ctx = options.context();
            if (!ctx) return "skipped";
            const current = ownerBindingFromContext(ctx);
            if (park.record.ownerWorkspace && canonical(park.record.ownerWorkspace) !== canonical(current.workspace)) return "skipped";
            const prior = readMeta(park.runId);
            if (prior && prior.status === "running" && processExists(prior.pid)) return "skipped";

            const service = options.service();
            if (!service) return "skipped";
            if (service.assignmentContinuation !== 1) return hold(park, "The Background host does not support assignment-local continuation");
            if (!park.meta.operations?.policy) return hold(park, "The captured assignment permission policy is missing; migration refused");
            if (park.meta.operations.policy.deadlineAt !== null && park.meta.operations.policy.deadlineAt <= now()) return hold(park, "The assignment-local deadline expired");
            const scope = backgroundScopeForMeta(park.meta, park.record);
            if (!scope) return "skipped";
            if (!park.record.ownerSessionId && !park.meta.callbackOrigin?.sessionId) {
                return hold(park, "The captured assignment recipient is missing; migration refused");
            }
            // Capacity FIRST: a saturated pool leaves the generation ready and the
            // delivery pending, so a queued resume never becomes "held" and no
            // unresumable claim is published.
            if (!options.capacity.tryReserve()) return "skipped";
            reserved = true;
            if (!options.capacity.recheck()) {
                options.capacity.release();
                reserved = false;
                return "skipped";
            }

            // Captured recipient metadata is never replaced by the host's session.
            const owner: WaitOwnerBinding = {
                sessionId: park.record.ownerSessionId ?? park.meta.callbackOrigin!.sessionId!,
                workspace: park.record.ownerWorkspace ?? park.meta.callbackOrigin?.cwd ?? current.workspace,
                branchId: park.record.ownerBranchId ?? null,
                goalId: park.record.ownerGoalId ?? null,
            };
            const admission = { revision: 0 };

            // Rehydrate the parked attempt's run binding: the claim fence is
            // addressed by run id and requires a binding for this conversation.
            await options.rpc.call("register-run", {
                runId: park.runId,
                conversationId: scope.conversationId,
                attemptId: park.runId,
                workspace: scope.workspace,
                authorityReference: scope.authorityReference,
                policy: {
                    version: 1,
                    sandbox: park.meta.operations?.policy?.sandbox ?? null,
                    tools: park.meta.operations?.policy?.tools ?? [],
                    clean: park.meta.operations?.policy?.clean === true,
                    deadlineAt: park.meta.operations?.policy?.deadlineAt ?? null,
                    authorityReference: scope.authorityReference,
                    workspace: scope.workspace,
                },
                tools: park.meta.operations?.tools ?? [],
                capabilities: {},
                owner: {
                    kind: "worker-conversation",
                    sessionId: scope.conversationId,
                    workspace: scope.workspace,
                    branchId: owner.branchId,
                    goalId: owner.goalId,
                },
            });
            const snapshot = await options.rpc.call("wait-snapshot", {
                waitId: park.waitId,
                generation: park.generation,
            });
            if (snapshot.phase !== "ready") {
                options.capacity.release();
                reserved = false;
                if (snapshot.phase === "waiting" || snapshot.phase === "parking" || snapshot.phase === "resuming") {
                    if (snapshot.phase !== park.phase) updateParkRecord(park.runId, { phase: phaseOf(String(snapshot.phase)) });
                    return "skipped";
                }
                updateParkRecord(park.runId, { phase: phaseOf(String(snapshot.phase)) });
                return "skipped";
            }
            if (snapshot.claim) {
                // Another supervisor holds or published this generation.
                options.capacity.release();
                reserved = false;
                return "skipped";
            }
            const expectedCancelEpoch = typeof snapshot.cancelEpoch === "number" ? snapshot.cancelEpoch : 0;
            const claim = await options.rpc.call("claim-resume", {
                runId: park.runId,
                waitId: park.waitId,
                generation: park.generation,
                expectedCancelEpoch,
                lease: { ownerId: `subagents:${process.pid}`, pid: process.pid },
                reservedCheckpointId: park.record.checkpoint?.entryId ?? park.waitId,
            });
            const claimId = String(claim.claimId ?? "");
            const claimToken = String(claim.claimToken ?? "");
            const assignedRunId = `sa_${now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
            const launchToken = `slt_${randomUUID()}`;
            if (!claimId || !claimToken) {
                options.capacity.release();
                reserved = false;
                return hold(park, "the Background host returned no usable resume claim");
            }
            try {
                await options.rpc.call("publish-resume", {
                    runId: park.runId,
                    waitId: park.waitId,
                    generation: park.generation,
                    claimId,
                    claimToken,
                    attemptId: assignedRunId,
                    launchToken,
                });
            } catch (error) {
                options.capacity.release();
                reserved = false;
                try {
                    await options.rpc.call("release-resume", {
                        runId: park.runId,
                        waitId: park.waitId,
                        generation: park.generation,
                        claimId,
                        claimToken,
                        outcome: "ready",
                        reason: reasonOf(error),
                    });
                } catch { /* the claim stays for reconciliation */ }
                return hold(park, reasonOf(error));
            }
            // Mirror the published attempt identity into the park record. The store
            // claim is the cross-process fence; this keeps the local record readable.
            updateParkRecord(park.runId, {
                phase: "resuming",
                resumedAt: now(),
                resumedBy: assignedRunId,
                resumeLaunchToken: launchToken,
                resumeClaimId: claimId,
                resumeClaimToken: claimToken,
                heldReason: undefined,
            });
            try {
                await options.launch({
                    park,
                    assignedRunId,
                    launchToken,
                    claim: {
                        claimId,
                        claimToken,
                        cancelEpoch: expectedCancelEpoch,
                        attemptId: assignedRunId,
                        launchToken,
                    },
                    admissionRevision: admission.revision,
                });
            } catch (error) {
                const reason = reasonOf(error);
                // A published claim cannot be released; the durable record holds it
                // for recovery. Capacity and admission already succeeded, so this is a
                // spawn-time failure, not a queue condition.
                updateParkRecord(park.runId, { phase: "held", heldReason: reason });
                if (park.meta.assignment) commitAssignmentTerminal({ ...park.meta, status: "lost", failureReason: `Published launch could not be proved: ${reason}` }, true);
                return "held";
            }
            options.capacity.commit();
            reserved = false;
            void options.rpc.call("release-run", { runId: park.runId, reason: "resumed into a new attempt" }).catch(() => {});
            return "resumed";
        } catch (error) {
            return hold(park, reasonOf(error));
        } finally {
            if (reserved) options.capacity.release();
            inFlight.delete(key);
        }
    };

    const adapter: WorkerContinuationAdapter = {
        version: 1,
        id: `subagents-continuation:${randomUUID()}`,
        async onWaitReady(event) {
            const park = parkedWaitByGeneration(event.waitId, event.generation);
            if (!park) return "delivered";
            const outcome = await resume(park);
            return outcome === "skipped" ? "deferred" : "delivered";
        },
        async onWaitCancelled(event) {
            const park = parkedWaitByGeneration(event.waitId, event.generation);
            if (!park || park.record.phase === "cancelled") return;
            const cancellation = await stopPublishedAttempt(park, event.reason, options.stopAttempt, options.now);
            updateParkRecord(park.runId, {
                phase: "cancelled",
                cancelReason: cancellation === "stopped"
                    ? `${event.reason} (the published continuation ${park.record.resumedBy} was stopped)`
                    : cancellation === "foreign"
                        ? `${event.reason} (the published continuation could not be attributed to this parent and was left running)`
                        : event.reason,
                cancelledAt: now(),
            });
        },
    };

    return {
        resume,
        adapter,
        stop() {
            try { options.service()?.unregisterContinuationAdapter(adapter.id); } catch { /* host already gone */ }
        },
    };
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Cancel a parked assignment's automatic resume. Called by `subagent_stop`.
 * The durable wait is cancelled first; the run record is marked so nothing
 * resumes it.
 */
export async function cancelParkedWait(
    service: WorkerOperationService | undefined,
    park: ParkedWait,
    reason: string,
    options: { now?: () => number; stopAttempt?: StopPublishedAttempt } = {},
): Promise<void> {
    // Cancel the durable wait first: no new claim can be published after this.
    // The registered continuation adapter is notified by the host and performs the
    // same follow-up, so an already-recorded cancellation is left alone.
    const scope = backgroundScopeForMeta(park.meta, park.record);
    const at = (options.now ?? Date.now)();
    if (park.meta.assignment) {
        commitAssignmentTerminal({ ...park.meta, status: "killed" });
        const cancellation = await stopPublishedAttempt(park, reason, options.stopAttempt, options.now);
        updateParkRecord(park.runId, { phase: "cancelled", cancelReason: cancellation === "foreign" ? `${reason} (published writer termination remains unproven)` : reason, cancelledAt: at });
        return;
    }
    if (service && scope) {
        let view;
        try {
            view = service.cancelWorkerWait(scope, { waitId: park.waitId, generation: park.generation, reason });
        } catch (error) {
            updateParkRecord(park.runId, {
                phase: "held",
                cancelReason: `${reason} (the durable cancellation failed: ${reasonOf(error)})`,
                cancelledAt: at,
            });
            return;
        }
        const settled = readParkRecord(park.runId);
        if (settled?.phase === "cancelled" && settled.cancelReason) return;
        const cancellation = await stopPublishedAttempt(park, reason, options.stopAttempt, options.now);
        updateParkRecord(park.runId, {
            phase: phaseOf(view.phase),
            cancelReason: cancellation === "stopped"
                ? `${reason} (the published continuation ${park.record.resumedBy} was stopped)`
                : cancellation === "foreign"
                    ? `${reason} (the published continuation could not be attributed to this parent and was left running)`
                    : reason,
            cancelledAt: at,
        });
        return;
    }
    const cancellation = await stopPublishedAttempt(park, reason, options.stopAttempt, options.now);
    updateParkRecord(park.runId, {
        phase: "cancelled",
        cancelReason: cancellation === "foreign"
            ? `${reason} (the published continuation could not be attributed to this parent and was left running)`
            : reason,
        cancelledAt: at,
    });
}

/**
 * Follow a cancelled generation to the attempt it already published.
 *
 * A `resuming` record with no registered attempt is a pre-dispatch abort: nothing
 * was spawned. A record whose attempt exists is stopped only through the injected
 * owner-checked seam; an unattributable identity is reported as `foreign` and left
 * alone, never signalled by pid guesswork.
 */
async function stopPublishedAttempt(
    park: ParkedWait,
    reason: string,
    stopAttempt: StopPublishedAttempt | undefined,
    now: (() => number) | undefined,
): Promise<"aborted" | "stopped" | "foreign" | "none"> {
    const attemptId = park.record.resumedBy;
    if (!attemptId) return "none";
    const meta = readMeta(attemptId);
    if (!meta) {
        updateParkRecord(park.runId, { phase: "cancelled", cancelReason: reason, cancelledAt: (now ?? Date.now)() });
        return "aborted";
    }
    if (!stopAttempt) return "foreign";
    try {
        return await stopAttempt({
            attemptId,
            launchToken: park.record.resumeLaunchToken,
            waitId: park.waitId,
            generation: park.generation,
            reason,
        });
    } catch {
        return "foreign";
    }
}

/**
 * Reconcile parked generations at session start.
 *
 * A `resuming` record with no attempt metadata is the crash window between the
 * durable pre-spawn write and the spawn: it is held, never relaunched. A ready
 * generation whose delivery was missed (inactive owner, host restart) is resumed
 * here. Everything else mirrors the durable phase.
 */
/**
 * Retry a staged park after a restart.
 *
 * Evidence required: the staged checkpoint still verifies, the recorded writer
 * process is gone, and no live conversation writer lease remains. A live writer,
 * a lease held by a live process, or a missing/foreign identity is reported as an
 * explicit hold, never left indistinguishable from a healthy `parking` wait.
 */
/**
 * Whether the recorded writer process is still alive, proven independently of the
 * recorded status. `unverified` means a live pid exists but its process-start
 * identity cannot be compared, so neither "gone" nor "the same writer" is proven.
 */
export function writerPresence(meta: RunMeta, probe: ProcessProbe = realProcessProbe): "absent" | "alive" | "unverified" {
    if (!Number.isInteger(meta.pid) || meta.pid <= 0) return "absent";
    if (!probe.pidExists(meta.pid)) return "absent";
    if (meta.pidStartTime === undefined) return "unverified";
    const token = probe.startToken?.(meta.pid);
    if (token === undefined) return "unverified";
    // A different start token is a recycled pid: the recorded writer is gone.
    return token === meta.pidStartTime ? "alive" : "absent";
}

export async function recoverStagedPark(
    park: ParkedWait,
    service: WorkerOperationService,
    options: {
        writerLeaseLocked?: (sessionId: string) => boolean;
        probe?: ProcessProbe;
    } = {},
): Promise<"parked" | "ready" | "held" | "skipped"> {
    const writer = writerPresence(park.meta, options.probe ?? realProcessProbe);
    if (writer === "alive") {
        // A supervised running attempt still has its exit handler; anything else
        // may still be appending to the saved conversation, and a fresh writer has
        // no lease, so a live process is the only reliable evidence.
        if (park.meta.status === "running") return "skipped";
        updateParkRecord(park.runId, {
            phase: "held",
            heldReason: `the staged park cannot be finalized while writer pid ${park.meta.pid} is still alive (${park.meta.status})`,
        });
        return "held";
    }
    if (writer === "unverified") {
        updateParkRecord(park.runId, {
            phase: "held",
            heldReason: `the recorded writer pid ${park.meta.pid} is alive but its process identity cannot be verified, so its exit is unproven`,
        });
        return "held";
    }
    const lease = readConversationLease(park.meta.sessionId);
    const leaseStart = lease ? processStartToken(lease.pid) : undefined;
    const leaseLive = lease !== undefined
        && (options.writerLeaseLocked?.(park.meta.sessionId)
            ?? (processExists(lease.pid) && (lease.start === undefined || leaseStart === undefined || lease.start === leaseStart)));
    if (leaseLive) {
        updateParkRecord(park.runId, {
            phase: "held",
            heldReason: "the staged park cannot be finalized while a live conversation writer lease is held",
        });
        return "held";
    }
    const scope = backgroundScopeForMeta(park.meta, park.record);
    if (!scope) {
        updateParkRecord(park.runId, { phase: "held", heldReason: "the staged park records no worker conversation workspace" });
        return "held";
    }
    const result = await finalizeWorkerParkAfterExit({
        runId: park.runId,
        service,
        writerLeaseReleased: true,
        writerPidGone: true,
        interrupted: true,
    });
    if (result.outcome !== "parked") return "held";
    if (result.wait?.phase === "ready") return "ready";
    return "parked";
}

/** Every park record (any phase) that published `attemptId` as its resume. */
export function parkedWaitsForResumedAttempt(attemptId: string): ParkedWait[] {
    const found: ParkedWait[] = [];
    for (const meta of listMetas()) {
        const record = readParkRecord(meta.id);
        if (!record || record.resumedBy !== attemptId) continue;
        found.push(parkedEntry(meta, record));
    }
    return found;
}

/** Terminal for the purposes of "this attempt will never interpret the wait again". */
export function isTerminalAttempt(meta: RunMeta): boolean {
    const status = effectiveStatus(meta);
    return status !== "running" && status !== "orphaned";
}

export interface ResumedAttemptExitInput {
    /** The attempt id published by the resume claim (NOT the parked attempt). */
    attemptId: string;
    service: WorkerOperationService | undefined;
    /** Recorded status for the reason text. */
    status?: string;
    /** Overrides the generated reason. */
    reason?: string;
    /** The exit observer already released the writer lease before calling. */
    writerLeaseReleased?: boolean;
    notify?(message: string, level: "warning"): void;
    now?: () => number;
}

export interface ResumedAttemptExitResult {
    outcome: "settled" | "ignored" | "foreign" | "deferred";
    /** Durable wait phase, when it was read or changed. */
    waitPhase?: string;
    reason?: string;
}

/** True when a lease payload still names a live writer for the conversation. */
export function conversationWriterLeaseLive(
    sessionId: string,
    probe: Pick<ProcessProbe, "pidExists" | "startToken"> = { pidExists: processExists, startToken: processStartToken },
): boolean {
    const lease = readConversationLease(sessionId);
    if (!lease) return false;
    if (!probe.pidExists(lease.pid)) return false;
    if (lease.start === undefined) return true;
    const current = probe.startToken?.(lease.pid);
    return current === undefined || current === lease.start;
}

/**
 * Hold the unconsumed generation that a published resume attempt was admitted for,
 * after that attempt exited without interpreting it.
 *
 * This is a HOLD, not a cancellation: the store keeps the cancellation epoch and
 * the evidence pins, records the failure reason, and invalidates the publish-only
 * claim. Assignment-capable hosts instead atomically admit one bounded repair or
 * retain terminal failure through the coordinator. This requires the exact
 * published identity (generation, claim id/token persisted with the attempt,
 * attempt id, launch token) and proven writer exit plus a free writer lease. An
 * ambiguous identity (live or unverifiable writer, live lease, missing claim
 * identity, missing host capability) is reported as a local hold and the durable
 * generation is left untouched with its live writer — never a fallback cancel.
 */
export async function settleResumedAttemptExit(input: ResumedAttemptExitInput): Promise<ResumedAttemptExitResult> {
    const candidates = parkedWaitsForResumedAttempt(input.attemptId);
    if (candidates.length === 0) return { outcome: "ignored" };
    const attempt = readMeta(input.attemptId);
    const at = (input.now ?? Date.now)();
    let result: ResumedAttemptExitResult = { outcome: "ignored" };
    for (const park of candidates) {
        if (park.record.phase === "consumed" || (park.record.phase === "cancelled" && !park.meta.assignment)) {
            result = { outcome: "ignored", waitPhase: park.record.phase };
            continue;
        }
        const reason = input.reason
            ?? `the published resume attempt ${input.attemptId} exited (${input.status ?? attempt?.status ?? "unknown"}) without interpreting the wait`;
        const holdLocally = (cause: string, outcome: "deferred" | "settled" = "deferred"): void => {
            updateParkRecord(park.runId, { phase: park.record.phase === "cancelled" ? "cancelled" : "held", heldReason: `${reason}; ${cause}` });
            const report = attempt ?? park.meta;
            if (input.service && report.assignment) {
                commitAssignmentTerminal({ ...report, status: "lost", failureReason: `${reason}; ${cause}` }, true);
            }
            result = { outcome, reason };
        };
        // The publication token is what identifies THIS resume of the record.
        const recordedToken = park.record.resumeLaunchToken;
        const attemptToken = attempt?.operations?.resumeLaunchToken;
        if (recordedToken && attemptToken && recordedToken !== attemptToken) {
            updateParkRecord(park.runId, {
                phase: park.record.phase === "cancelled" ? "cancelled" : "held",
                heldReason: `attempt ${input.attemptId} does not match the launch token published for this wait; the wait was left for its owner`,
            });
            input.notify?.(`Subagent ${park.runId}: resume attempt ${input.attemptId} does not match the published launch token; the wait is held for inspection.`, "warning");
            result = { outcome: "foreign" };
            continue;
        }
        if (!input.service) {
            holdLocally("the Background operation service is unavailable");
            continue;
        }
        if (typeof input.service.holdFailedResumeForWorker !== "function") {
            holdLocally("this Background host has no proven-exit hold capability yet");
            continue;
        }
        const claimId = park.record.resumeClaimId;
        const claimToken = park.record.resumeClaimToken;
        if (!claimId || !claimToken) {
            holdLocally("the resume claim identity was not recorded with the attempt, so the durable claim cannot be matched");
            continue;
        }
        if (!attempt) {
            holdLocally("the published continuation's metadata is missing; its writer identity and exit cannot be proved");
            continue;
        }
        const writer = writerPresence(attempt);
        const writerPidGone = writer === "absent";
        if (!writerPidGone) {
            holdLocally(`writer pid ${attempt?.pid} is still alive, so its exit is unproven`);
            continue;
        }
        if (writer === "unverified" && attempt) {
            holdLocally(`the recorded writer pid ${attempt.pid} is alive but its process identity cannot be verified`);
            continue;
        }
        const writerLeaseReleased = input.writerLeaseReleased
            ?? !conversationWriterLeaseLive(attempt?.sessionId ?? park.conversationId);
        if (!writerLeaseReleased) {
            holdLocally("a live conversation writer lease still holds the history, so writer exit is unproven");
            continue;
        }
        const scope = backgroundScopeForMeta(park.meta, park.record);
        if (!scope) {
            holdLocally("the parked attempt records no worker conversation scope");
            continue;
        }
        try {
            const wait = input.service.listWorkerWaits(scope).find((w) => w.waitId === park.waitId && w.generation === park.generation);
            // A held terminal writer needs proof-only reconciliation, not admission.
            const reconcileOnly = park.record.phase === "cancelled" || wait?.phase === "held";
            if (!reconcileOnly && attempt.assignment && !input.service.repairFailedResumeForWorker) {
                holdLocally("this Background host does not support bounded autonomous repair");
                continue;
            }
            if (!reconcileOnly && park.meta.operations?.policy?.deadlineAt != null && park.meta.operations.policy.deadlineAt <= at) {
                holdLocally("the assignment-local deadline expired");
                continue;
            }
            const exitInput = {
                waitId: park.waitId,
                generation: park.generation,
                claimId,
                claimToken,
                attemptId: input.attemptId,
                launchToken: park.record.resumeLaunchToken ?? attemptToken ?? "",
                proof: { writerPidGone: writerPidGone && writer !== "unverified", writerLeaseReleased },
                reason,
            };
            let held: { phase: string };
            if (!reconcileOnly && input.service.repairFailedResumeForWorker && attempt.assignment) {
                if (!park.record.checkpoint) throw new Error("Required saved checkpoint is missing");
                verifyParkCheckpoint({ ...park.record.checkpoint, version: 1, waitId: park.waitId, generation: park.generation });
                if (!wait) throw new Error("Required authoritative wait history is missing");
                held = input.service.repairFailedResumeForWorker(scope, { ...exitInput,
                    checkpointId: `park:${park.record.attemptId}`,
                    expectedCancelEpoch: wait.cancelEpoch });
            } else {
                held = input.service.holdFailedResumeForWorker(scope, exitInput);
            }
            const phase = phaseOf(held.phase);
            updateParkRecord(park.runId, {
                phase: park.record.phase === "cancelled" ? "cancelled" : phase,
                ...(phase === "held" && park.record.phase !== "cancelled" ? { heldReason: reason } : {}),
            });
            input.notify?.(`Subagent ${park.runId}: ${reason}. The reconciled wait is ${phase}.`, "warning");
            result = { outcome: "settled", waitPhase: phase, reason };
        } catch (error) {
            // The store refused (stale identity, terminal generation, unproven exit).
            // Never fall back to cancellation: report the local hold and leave the
            // durable generation exactly as it is.
            let durablePhase: string | undefined;
            try {
                durablePhase = input.service.listWorkerWaits(scope)
                    .find((entry) => entry.waitId === park.waitId && entry.generation === park.generation)?.phase;
            } catch { /* durable state unreadable */ }
            if (durablePhase === "consumed" || durablePhase === "cancelled") {
                updateParkRecord(park.runId, { phase: phaseOf(durablePhase) });
                result = { outcome: "ignored", waitPhase: durablePhase };
                continue;
            }
            holdLocally(`the durable hold was refused (${reasonOf(error)})`);
            if (durablePhase) result = { ...result, waitPhase: durablePhase };
        }
    }
    void at;
    return result;
}

export async function reconcileParkedWaits(
    service: WorkerOperationService | undefined,
    options: {
        resume(park: ParkedWait): Promise<"resumed" | "held" | "skipped">;
        notify?(message: string, level: "warning"): void;
    },
): Promise<{ resumed: number; held: number; skipped: number }> {
    let resumed = 0;
    let held = 0;
    let skipped = 0;
    for (const park of parkedWaits()) {
        try {
            if (park.record.phase === "resuming") {
                const attemptId = park.record.resumedBy ?? "";
                const attempt = attemptId ? readMeta(attemptId) : undefined;
                if (!attemptId || !attempt) {
                    updateParkRecord(park.runId, {
                        phase: "held",
                        heldReason: `Resume attempt ${attemptId || "(unknown)"} was published but launch and writer identity remain unproven.`,
                    });
                    if (park.meta.assignment) commitAssignmentTerminal({ ...park.meta, status: "lost", failureReason: "Published continuation metadata is missing; launch and writer termination remain unproven." }, true);
                    options.notify?.(
                        `Subagent ${park.runId}: resume attempt ${attemptId || "(unknown)"} has no verifiable launch metadata. The writer fence is retained.`,
                        "warning",
                    );
                    held += 1;
                    continue;
                }
                // The published attempt already ended without acknowledging: settle the
                // unconsumed generation now instead of leaving it `resuming` forever.
                if (isTerminalAttempt(attempt)) {
                    const settled = await settleResumedAttemptExit({
                        attemptId,
                        service,
                        status: effectiveStatus(attempt),
                        ...(options.notify ? { notify: options.notify } : {}),
                    });
                    if (settled.outcome === "settled") held += 1;
                    else skipped += 1;
                    continue;
                }
            }
            if (!service) {
                skipped += 1;
                continue;
            }
            const scope = backgroundScopeForMeta(park.meta, park.record);
            if (!scope) {
                skipped += 1;
                continue;
            }
            const wait = service.listWorkerWaits(scope)
                .find((entry) => entry.waitId === park.waitId && entry.generation === park.generation);
            if (!wait) {
                // The generation was consumed, cancelled or superseded elsewhere.
                updateParkRecord(park.runId, { phase: "consumed" });
                skipped += 1;
                continue;
            }
            if (wait.phase === "resuming" || (wait.phase === "held" && park.record.resumedBy)) {
                // A published attempt owns this generation. If it already ended (or
                // its record vanished), the unconsumed generation is settled
                // explicitly; nothing else may resume or mirror it.
                const attemptId = park.record.resumedBy ?? "";
                const attempt = attemptId ? readMeta(attemptId) : undefined;
                if (!attempt || isTerminalAttempt(attempt)) {
                    const settled = await settleResumedAttemptExit({
                        attemptId: attemptId || park.runId,
                        service,
                        status: attempt ? effectiveStatus(attempt) : "missing",
                        ...(options.notify ? { notify: options.notify } : {}),
                    });
                    // `deferred` means the local record was held while the durable
                    // generation could not be proven (ambiguous identity/capability);
                    // it is never a silent success.
                    if (settled.outcome === "settled" || settled.outcome === "deferred") held += 1;
                    else skipped += 1;
                    continue;
                }
                // The attempt is still live; it will acknowledge or exit.
                skipped += 1;
                continue;
            }
            if (wait.phase === "ready") {
                const outcome = await options.resume(park);
                if (outcome === "resumed") resumed += 1;
                else if (outcome === "held") held += 1;
                else skipped += 1;
                continue;
            }
            if (wait.phase === "parking") {
                // The exit proof is normally sent by the run's exit handler. After a
                // restart that handler is gone, so the staged checkpoint is retried
                // here against real writer and lease evidence. Anything ambiguous is
                // held explicitly instead of parking forever.
                const recovered = await recoverStagedPark(park, service);
                if (recovered === "parked" || recovered === "ready") resumed += 1;
                else if (recovered === "held") held += 1;
                else skipped += 1;
                continue;
            }
            if (phaseOf(wait.phase) !== park.phase) updateParkRecord(park.runId, { phase: phaseOf(wait.phase) });
            skipped += 1;
        } catch (error) {
            updateParkRecord(park.runId, { phase: "held", heldReason: reasonOf(error) });
            options.notify?.(`Subagent ${park.runId}: wait reconciliation failed (${reasonOf(error)}).`, "warning");
            held += 1;
        }
    }
    return { resumed, held, skipped };
}

/**
 * Prompt for the continuation attempt. It restates the durable wait identity and
 * the next reasoning step only: it changes no tool, model, role, permission,
 * workspace or authorization, and it does not tell the worker the outcome.
 */
export function resumePrompt(park: ParkedWait): string {
    const note = park.record.continuationNote ?? "Continue the assignment you were working on.";
    return [
        "Your previous execution attempt parked while it waited on background operations, and they have now all reached a terminal outcome.",
        `Durable wait: ${park.waitId} generation ${park.generation}.`,
        "Read the terminal evidence for every task listed in that wait (bg_task_status / bg_task_log), interpret it yourself, and then acknowledge the result with acknowledge_operation_result naming the exact terminal revisions you read.",
        "Then continue the original assignment. The evidence decides what to do; it does not by itself mean the assignment succeeded.",
        `Next reasoning step recorded when you parked: ${note}`,
    ].join("\n");
}

/** Child bridge extension path inside this package. */
export function childBridgeExtensionPath(packageDir: string): string {
    return join(packageDir, "child-operations.ts");
}

/** True when `taskId` appeared in a launch result (used by the host's ownership seam). */
export function launchedTaskIds(result: unknown): string[] {
    return extractResultTaskIds(result);
}
