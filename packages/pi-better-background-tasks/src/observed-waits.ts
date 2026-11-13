/**
 * Parent-side observed waits: the integration between background tasks, the
 * detached local supervisor and the durable operation coordinator.
 *
 * Scope of this module:
 *
 * - launch local processes and command watches through the supervisor after the
 *   normal Background / worker sandbox admission has already admitted them;
 * - register the durable operation *before* the runner starts, using the
 *   token-derived `bgs_…` task id;
 * - reconcile terminal supervisor evidence into the coordinator store without
 *   re-running an ambiguous launch;
 * - register all-settled waits, dispatch ready deliveries to the owner, and
 *   require an exact evidence read before an acknowledgement consumes a wait;
 * - expose a versioned, in-process service for the Subagents bridge. The bridge
 *   owns its transport; this module owns authorization and the durable records.
 *
 * What it deliberately does not own: SSH/remote launches, a bridge socket, model
 * continuation, goal/workflow completion, or any permission decision beyond
 * calling the existing `resolve*SandboxPlan` helpers.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { validateCondition } from "./conditions.js";
import {
  STEP_GATE_COMMAND_ENV,
  commandExecution,
  parseStepGateFailure,
  processExists,
  stepGateScript,
  validateCommandSpec,
} from "./process.js";
import { currentProcessStartToken, readProcessStartToken } from "./process-identity.js";
import {
  assertBackgroundExecutionAllowed,
  backgroundExecutionLimits,
  confineCommandSpec,
  resolveForegroundSandboxPlan,
  resolveWorkerSandboxPlan,
  sandboxProvenance,
  type ForegroundSandboxPlan,
  type WorkerSandboxPolicy,
} from "./sandbox.js";
import {
  openStore,
  type AcknowledgeDisposition,
  type EvidenceKind,
  type OperationEvidenceRecord,
  type OperationRecord,
  type OutboxEventRecord,
  type OwnerIdentity,
  type Store,
  type SupervisionIdentity,
  type WaitRecord,
} from "./shared-operation-coordinator/index.js";
import {
  createLocalSupervisor,
  defaultSupervisorDirectory,
  supervisorPaths,
  supervisorTaskIdForToken,
  type LocalSupervisor,
  type SupervisorInspection,
  type SupervisorStartOptions,
  type SupervisorTaskStatus,
} from "./supervisor/index.js";
import type { BackgroundTaskCallbackOrigin, CommandSpec, Condition, TaskSandboxProvenance } from "./types.js";
import type { SpawnTaskParams, WatchTaskParams } from "./runtime.js";

export const OBSERVED_WAITS_SERVICE_VERSION = 2 as const;
export const OBSERVED_WAITS_SERVICE_CHANNEL = "pi-better-background-tasks:observed-waits-service";
export const OBSERVED_WAITS_SERVICE_REQUEST_CHANNEL = "pi-better-background-tasks:observed-waits-service-request";

/**
 * Request/reply compatibility surface used by the Subagents coordinator. The
 * object service above is the richer in-process API; this channel is the
 * versioned wire contract that lets a standalone Subagents build register runs,
 * execute worker tools, admit parks, and drive resume claims without importing
 * this package.
 */
export const OBSERVED_WAITS_RPC_CHANNEL = "pi-better-background-tasks:observed-waits";
export const OBSERVED_WAITS_READY_CHANNEL = "pi-better-background-tasks:observed-waits-ready";
export const OBSERVED_WAITS_RPC_VERSION = 1 as const;

export type JsonRecord = Record<string, unknown>;

export type ObservedWaitsRpcReply =
  | { ok: true; value: JsonRecord }
  | { ok: false; code: string; reason: string };

export interface ObservedWaitsRpcRequest {
  version: typeof OBSERVED_WAITS_RPC_VERSION;
  id: string;
  method: string;
  params: JsonRecord;
  reply(reply: ObservedWaitsRpcReply): void;
}

/** Structural mirror of Subagents' captured `WorkerRunPolicy`. */
export interface WorkerRunPolicyInput {
  readonly version: 1;
  readonly sandbox: WorkerSandboxPolicy | null;
  readonly tools: readonly string[];
  readonly clean: boolean;
  readonly deadlineAt: number | null;
  readonly authorityReference: string;
  readonly workspace: string;
}

const OBSERVER = Object.freeze({ kind: "local-supervisor", version: "1" });

/**
 * Process-wide host-instance ordering shared across module copies. A stale host
 * must never take over a newer same-process host's callback claim, while the
 * newer host may still recover an older instance's claim after a reload.
 */
const HOST_INSTANCE_STATE = (() => {
  const key = Symbol.for("pi-better-background-tasks:observed-waits-host-instances");
  const global = globalThis as typeof globalThis & { [key]?: { next: number; generations: Map<string, number>; closed: Set<string> } };
  return global[key] ??= { next: 0, generations: new Map<string, number>(), closed: new Set<string>() };
})();
const LOCAL_DURABLE_ID = /^bgs_[0-9a-f]{20}$/;
const DEFAULT_POLL_MS = 250;
/**
 * A cached projection survives unchanged renders. Host notifications invalidate
 * it immediately; this bound only recovers changes whose notification was lost
 * or came from a process this host never observed. It is not a render cadence.
 */
const DURABLE_PROJECTION_CACHE_MS = 5_000;

/** Observable work performed by {@link ObservedWaitHost.listDurableTasks}. */
export interface DurableProjectionMetrics {
  listCalls: number;
  queries: number;
  rowsRead: number;
  projectionsBuilt: number;
  cacheHits: number;
}

/** The active parent scope whose durable projection changed. */
export interface DurableTaskChange {
  readonly sessionId: string;
  readonly workspace: string;
}

/** A parent launch is always local; remote launches stay on the legacy task route. */
export type DurableTaskKind = "process" | "watch";

export interface DurableLaunch {
  readonly id: string;
  readonly operationId: string;
  readonly kind: DurableTaskKind;
  readonly status: "running";
  readonly name?: string;
  readonly cwd: string;
  readonly command?: string;
  readonly argv?: readonly string[];
  readonly shell: boolean;
  readonly owner: OwnerIdentity;
  readonly started: boolean;
  readonly claimed: boolean;
  readonly notices: readonly string[];
  readonly firstCheck?: DurableFirstCheck;
}

export interface DurableFirstCheck {
  readonly attempt: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Compact, model-facing view of one wait generation. */
export interface WaitView {
  readonly waitId: string;
  readonly generation: number;
  readonly phase: string;
  readonly settled: boolean;
  readonly park: boolean;
  /** Cancellation epoch the caller must echo when claiming or cancelling. */
  readonly cancelEpoch: number;
  readonly publishedClaimId?: string | null;
  readonly ownerKind: OwnerIdentity["kind"];
  readonly continuationNote: string;
  readonly taskIds: readonly string[];
  readonly dependencies: readonly WaitDependencyView[];
  readonly evidence: readonly WaitEvidenceView[];
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
  readonly kind: EvidenceKind;
  readonly ref: string;
  readonly summary?: string;
  readonly detailLost: boolean;
}

export interface WaitDispatchEvent {
  readonly waitId: string;
  readonly generation: number;
  readonly owner: OwnerIdentity;
  /** Parent session origin captured when the supervised task launched. */
  readonly parentOrigin?: BackgroundTaskCallbackOrigin;
  readonly taskIds: readonly string[];
  readonly continuationNote: string;
  readonly evidence: readonly WaitEvidenceView[];
}

/**
 * Continuation admission is owned by Subagents. The host emits a ready wait to
 * this adapter and never launches a model itself. Returning `"deferred"` (or
 * throwing) leaves the durable delivery pending, so nothing is silently lost.
 */
export interface ContinuationAdapter {
  readonly version: 1;
  readonly id: string;
  onWaitReady(event: WaitDispatchEvent): void | Promise<void | "delivered" | "deferred">;
  onWaitCancelled?(event: { waitId: string; generation: number; reason: string }): void | Promise<void>;
}

export interface ParentNotification {
  readonly taskId: string;
  /** Launching parent origin captured when the supervised task started. */
  readonly origin?: BackgroundTaskCallbackOrigin;
  /** Branch anchor captured at launch; a descendant branch is eligible. */
  readonly branchId?: string | null;
  readonly operationId: string;
  readonly waitId?: string;
  readonly generation?: number;
  readonly status: SupervisorTaskStatus;
  readonly outcome: string;
  readonly summary: string;
  readonly evidence: readonly WaitEvidenceView[];
}

/**
 * Delivery acknowledgement. A callback is not durable receipt until the host
 * calls `delivered()` from the batcher's real handoff; returning from
 * `notifyParent` is not delivery.
 */
export interface ParentDelivery {
  delivered(): void;
  defer(reason: string): void;
}

export type ParentNotifier = (notification: ParentNotification, delivery: ParentDelivery) => void;

export interface WorkerRunScope {
  readonly runId: string;
  readonly conversationId: string;
  readonly workspace: string;
  readonly authorityReference: string;
  readonly branchId?: string | null;
  readonly goalId?: string | null;
}

interface RpcRunBinding {
  readonly runId: string;
  readonly conversationId: string;
  readonly attemptId: string;
  readonly workspace: string;
  readonly authorityReference: string;
  readonly policy: WorkerRunPolicyInput;
  readonly owner: OwnerIdentity;
  readonly tools: ReadonlySet<string>;
  readonly capabilities: JsonRecord;
  readonly writerPid?: number;
  readonly writerLeaseId?: string | null;
}

export interface WorkerLaunchInput {
  readonly kind: DurableTaskKind;
  readonly params: Record<string, unknown>;
  /** Parent-captured task authority; absent means an unconfined worker. */
  readonly policy?: WorkerSandboxPolicy | null;
}

export interface WorkerWaitInput {
  readonly taskIds: readonly string[];
  readonly continuationNote: string;
  readonly attemptId: string;
  readonly checkpointId: string;
  readonly writerLeaseId?: string | null;
}

export interface WorkerCheckpointInput {
  readonly waitId: string;
  readonly generation: number;
  /**
   * The Subagents bridge verifies the native checkpoint and the original
   * writer's exit; this records that proof. All three facts are required before
   * a parked generation may leave parking.
   */
  readonly proof: { checkpointRecorded: boolean; writerLeaseReleased: boolean; writerPidGone: boolean };
}

export interface WorkerEvidenceInput {
  readonly waitId: string;
  readonly generation: number;
  readonly taskId?: string;
}

export interface WorkerAcknowledgeInput {
  readonly waitId: string;
  readonly generation: number;
  readonly terminalRevisions: unknown;
  readonly disposition: AcknowledgeDisposition;
  readonly note: string;
}

export interface ResumeClaimViewInput {
  readonly waitId: string;
  readonly generation: number;
  readonly expectedCancelEpoch: number;
  readonly lease: { ownerId: string; pid?: number; processStartToken?: string | null };
  readonly reservedCheckpointId: string;
}

export interface PublishResumeViewInput {
  readonly waitId: string;
  readonly generation: number;
  readonly claimId: string;
  readonly claimToken: string;
  readonly attemptId: string;
  readonly launchToken: string;
}

export interface ReleaseResumeViewInput {
  readonly waitId: string;
  readonly generation: number;
  readonly claimId: string;
  readonly claimToken: string;
  readonly outcome: "ready" | "held";
  readonly reason: string;
}

export interface ResumeClaimView {
  readonly claimId: string;
  readonly claimToken: string;
  readonly state: string;
  readonly attemptId: string | null;
  readonly phase: string;
  readonly cancelEpoch: number;
}

/** Exact identity and proof for holding a failed published resume. */
export interface HoldResumedAttemptInput {
  readonly waitId: string;
  readonly generation: number;
  readonly claimId: string;
  readonly claimToken: string;
  readonly attemptId: string;
  readonly launchToken: string;
  /** Proven exit: writer gone and its conversation lease free. */
  readonly proof: { readonly writerPidGone: boolean; readonly writerLeaseReleased: boolean };
  readonly reason: string;
}

export interface HoldResumedAttemptView {
  readonly waitId: string;
  readonly generation: number;
  readonly phase: string;
  readonly applied: boolean;
  readonly claim: { readonly claimId: string; readonly state: string; readonly attemptId: string | null; readonly reason?: string };
}

export interface AcknowledgeView {
  readonly waitId: string;
  readonly generation: number;
  readonly disposition: AcknowledgeDisposition;
  readonly acknowledgedOutboxIds: readonly string[];
  readonly releasedPinIds: readonly string[];
  readonly phase: string;
}

export interface StatusView {
  readonly taskId: string;
  readonly operationId: string;
  readonly kind: DurableTaskKind;
  readonly status: SupervisorTaskStatus;
  readonly phase: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reason?: string;
  readonly terminalRevision: number;
  readonly terminalOutcome: string | null;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly checks?: number;
  readonly matchedCondition?: Condition;
  readonly lastOutput?: { stdout: string; stderr: string };
  readonly stepGateFailure?: { stepExitCode: number; shellExitCode: number | null; command: string };
  readonly waits: readonly WaitView[];
  readonly sandbox?: TaskSandboxProvenance;
}

/** Read-only projection of one supervised durable task for list/navigator/Goal. */
export interface DurableTaskProjection {
  readonly id: string;
  readonly operationId: string;
  readonly kind: DurableTaskKind;
  readonly status: SupervisorTaskStatus;
  readonly active: boolean;
  readonly terminal: boolean;
  readonly attention: boolean;
  readonly name?: string;
  readonly cwd: string;
  readonly command?: string;
  readonly argv?: readonly string[];
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reason?: string;
  readonly matchedCondition?: Condition;
  readonly lastOutput?: { stdout: string; stderr: string };
  readonly stepGateFailure?: { stepExitCode: number; shellExitCode: number | null; command: string };
  readonly terminalRevision: number;
  readonly terminalOutcome: string | null;
  readonly detailLost: boolean;
  readonly dismissedAt?: number;
  readonly logDiscardedBytes?: number;
  readonly intervalSeconds?: number;
  readonly deadlineAt?: number;
  readonly logPaths: { stdout: string; stderr: string; events: string };
  readonly waits: readonly WaitView[];
  readonly sandbox?: TaskSandboxProvenance;
  readonly owner: { sessionId: string; workspace: string };
}

export interface DurableTaskLogView {
  readonly taskId: string;
  readonly status: SupervisorTaskStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: string;
  readonly truncated: boolean;
}

export interface LogView {
  readonly taskId: string;
  readonly status: SupervisorTaskStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: string;
  readonly truncated: boolean;
}

/**
 * The versioned capability published for the Subagents coordinator. Every method
 * rechecks ownership in the durable store; a caller's run id is never a grant.
 * The transport is Subagents' responsibility.
 */
export interface BackgroundOperationService {
  readonly version: typeof OBSERVED_WAITS_SERVICE_VERSION;
  readonly serviceId: string;
  readonly available: true;
  /** True when a verified continuation adapter is registered. */
  readonly assignmentContinuation: 1;
  readonly outageReconciliation: 1;
  readonly continuationReady: boolean;
  ownsTask(run: WorkerRunScope, taskId: string): boolean;
  launchForWorker(run: WorkerRunScope, input: WorkerLaunchInput): Promise<DurableLaunch>;
  statusForWorker(run: WorkerRunScope, taskId: string): StatusView;
  logForWorker(run: WorkerRunScope, taskId: string, options?: { lines?: number }): LogView;
  stopForWorker(run: WorkerRunScope, taskId: string): Promise<StatusView>;
  registerWorkerWait(run: WorkerRunScope, input: WorkerWaitInput): WaitView;
  checkpointWorkerWait(run: WorkerRunScope, input: WorkerCheckpointInput): Promise<WaitView>;
  failWorkerPark(run: WorkerRunScope, input: { waitId: string; generation: number; reason: string }): WaitView;
  readEvidence(run: WorkerRunScope, input: WorkerEvidenceInput): readonly WaitEvidenceView[];
  acknowledgeForWorker(run: WorkerRunScope, input: WorkerAcknowledgeInput): AcknowledgeView;
  claimResumeForWorker(run: WorkerRunScope, input: ResumeClaimViewInput): ResumeClaimView;
  publishResumeForWorker(run: WorkerRunScope, input: PublishResumeViewInput): ResumeClaimView;
  releaseResumeForWorker(run: WorkerRunScope, input: ReleaseResumeViewInput): ResumeClaimView;
  /**
   * Hold a published generation whose attempt exited without interpreting it.
   * Requires exact claim identity and proven writer exit; keeps the cancellation
   * epoch and evidence pins and invalidates the claim so nothing resumes again.
   */
  holdFailedResumeForWorker(run: WorkerRunScope, input: HoldResumedAttemptInput): HoldResumedAttemptView;
  repairFailedResumeForWorker(run: WorkerRunScope, input: HoldResumedAttemptInput & { checkpointId: string; expectedCancelEpoch: number }): { phase: string; repaired: boolean };
  listWorkerWaits(run: WorkerRunScope, options?: { pendingOnly?: boolean }): readonly WaitView[];
  cancelWorkerWait(run: WorkerRunScope, input: { waitId: string; generation: number; reason: string }): WaitView;
  registerContinuationAdapter(adapter: ContinuationAdapter): void;
  unregisterContinuationAdapter(id: string): void;
}

export interface BackgroundOperationCapability {
  readonly version: typeof OBSERVED_WAITS_SERVICE_VERSION;
  readonly available: false;
  readonly reason: string;
}

export type PublishedBackgroundOperationCapability = BackgroundOperationService | BackgroundOperationCapability;

function normalizeRunPolicy(value: unknown): WorkerRunPolicyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("register-run requires a policy object.");
  const policy = value as Record<string, unknown>;
  if (policy.version !== 1) throw new Error("register-run requires policy version 1.");
  if (typeof policy.workspace !== "string" || !policy.workspace) throw new Error("register-run policy.workspace is required.");
  if (typeof policy.authorityReference !== "string" || !policy.authorityReference) {
    throw new Error("register-run policy.authorityReference is required.");
  }
  const sandbox = policy.sandbox === null || policy.sandbox === undefined
    ? null
    : policy.sandbox as WorkerSandboxPolicy;
  if (sandbox !== null && (typeof sandbox !== "object" || typeof (sandbox as { root?: unknown }).root !== "string")) {
    throw new Error("register-run policy.sandbox must be null or a worker sandbox authority.");
  }
  const tools = Array.isArray(policy.tools)
    ? policy.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  return Object.freeze({
    version: 1 as const,
    sandbox,
    tools: Object.freeze(tools),
    clean: policy.clean === true,
    deadlineAt: typeof policy.deadlineAt === "number" && Number.isFinite(policy.deadlineAt) ? policy.deadlineAt : null,
    authorityReference: policy.authorityReference,
    workspace: policy.workspace,
  });
}

function normalizeRpcOwner(value: unknown, fallback: OwnerIdentity): OwnerIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const owner = value as Record<string, unknown>;
  if (typeof owner.sessionId !== "string" || typeof owner.workspace !== "string") return fallback;
  return {
    kind: "worker-conversation",
    sessionId: owner.sessionId,
    workspace: owner.workspace,
    branchId: typeof owner.branchId === "string" ? owner.branchId : null,
    goalId: typeof owner.goalId === "string" ? owner.goalId : null,
  };
}

function rpcCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? code : "refused";
}

export interface ObservedWaitHostOptions {
  /** SQLite path. Defaults under the Pi agent directory. */
  storePath?: string;
  /** Durable supervisor record directory. Defaults beside the task registry. */
  supervisorDirectory?: string;
  /** Test seam: a pre-built local supervisor. */
  supervisor?: LocalSupervisor;
  /** Reconcile cadence; `0` disables the timer (tests call `reconcileNow`). */
  pollMs?: number;
  /** Parent callback delivery. Production wires the existing callback batcher. */
  notifyParent?: ParentNotifier;
  logger?: (line: string) => void;
  now?: () => number;
}

/** Minimal event bus surface, mirrored from the sandbox policy contract. */
interface ServiceEventBus {
  on(channel: string, handler: (data: unknown) => void): unknown;
  off?(channel: string, handler: (data: unknown) => void): unknown;
  emit(channel: string, data: unknown): void;
}

function eventBusOf(pi: unknown): ServiceEventBus | undefined {
  const events = (pi as { events?: unknown } | undefined)?.events;
  if (!events || typeof events !== "object") return undefined;
  const candidate = events as Partial<ServiceEventBus>;
  if (typeof candidate.on !== "function" || typeof candidate.emit !== "function") return undefined;
  return candidate as ServiceEventBus;
}

function isService(value: unknown): value is BackgroundOperationService {
  return !!value && typeof value === "object"
    && (value as { version?: unknown }).version === OBSERVED_WAITS_SERVICE_VERSION
    && (value as { available?: unknown }).available === true
    && typeof (value as { launchForWorker?: unknown }).launchForWorker === "function";
}

const serviceMirrors = new WeakMap<ServiceEventBus, BackgroundOperationService | undefined>();
const serviceErrors = new WeakMap<ServiceEventBus, string | undefined>();

function observeServiceChannel(pi: unknown): ServiceEventBus | undefined {
  const events = eventBusOf(pi);
  if (!events || serviceMirrors.has(events)) return events;
  serviceMirrors.set(events, undefined);
  events.on(OBSERVED_WAITS_SERVICE_CHANNEL, (data) => {
    if (isService(data)) {
      serviceMirrors.set(events, data);
      serviceErrors.delete(events);
    } else if (data && typeof data === "object"
      && (data as { version?: unknown }).version === OBSERVED_WAITS_SERVICE_VERSION
      && (data as { available?: unknown }).available === false) {
      serviceMirrors.set(events, undefined);
      const reason = (data as { reason?: unknown }).reason;
      serviceErrors.set(events, typeof reason === "string" ? reason : "observed waits are unavailable");
    }
  });
  return events;
}

/**
 * Ask for the Background operation service. Pi's bus dispatches synchronously,
 * so a host that is already running answers before this returns. Returns
 * `undefined` when this package is installed alone or the host is closed.
 */
export function getObservedWaitService(pi: unknown): BackgroundOperationService | undefined {
  const events = observeServiceChannel(pi);
  if (!events) return undefined;
  events.emit(OBSERVED_WAITS_SERVICE_REQUEST_CHANNEL, { version: OBSERVED_WAITS_SERVICE_VERSION });
  return serviceMirrors.get(events);
}

/** Why a service request returned nothing, when a host refused to open. */
export function observedWaitServiceUnavailableReason(pi: unknown): string | undefined {
  observeServiceChannel(pi);
  const events = eventBusOf(pi);
  return events ? serviceErrors.get(events) : undefined;
}

const hosts = new WeakMap<object, ObservedWaitHost>();

export function createObservedWaitHost(pi: ExtensionAPI, options: ObservedWaitHostOptions = {}): ObservedWaitHost {
  const existing = hosts.get(pi as unknown as object);
  if (existing && existing !== undefined) existing.close();
  const host = new ObservedWaitHost(pi, options);
  hosts.set(pi as unknown as object, host);
  return host;
}

export function getObservedWaitHost(pi: unknown): ObservedWaitHost | undefined {
  return pi && typeof pi === "object" ? hosts.get(pi as object) : undefined;
}

interface LaunchContext {
  readonly kind: DurableTaskKind;
  readonly parentOrigin?: BackgroundTaskCallbackOrigin;
  readonly gated: boolean;
  readonly callback: boolean;
  readonly name?: string;
  readonly command?: string;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  /** Launch-time sandbox provenance; never recomputed from the current profile. */
  readonly sandbox?: TaskSandboxProvenance;
  /** Owner branch anchor captured at launch (undefined when unavailable). */
  readonly branchId?: string | null;
  callbackPendingAt?: number;
  callbackDeliveredAt?: number;
  callbackDeferredReason?: string;
  callbackClaimedBy?: string;
  callbackClaimedAt?: number;
  /** Identifies the exact callback attempt, so stale delivery callbacks are ignored. */
  callbackClaimToken?: string;
  callbackAttemptedAt?: number;
  callbackSkipReason?: string;
  terminalRecordedBy?: string;
  terminalRecordedAt?: number;
  terminalRecordedWithContext?: boolean;
  terminalActiveSessionId?: string;
  terminalActiveBranchIds?: readonly string[];
  terminalReplayObservedBy?: string;
  /** Exact outbox event handoffs whose store receipt was lost to a reload. */
  outboxDelivered?: Record<string, { waitId: string; generation: number; terminalRevision: number; deliveredAt: number }>;
  dismissedAt?: number;
}

function branchIdsOf(ctx: ExtensionContext): string[] {
  try {
    const branch = ctx.sessionManager?.getBranch?.() as readonly { id?: unknown }[] | undefined;
    if (!branch) return [];
    return branch.map((entry) => entry?.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function startTokenDigest(token: string | undefined): string {
  return token ? createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16) : "unknown";
}

function parseHostIdentity(hostId: string): { pid?: number; startTokenDigest?: string } {
  const parts = hostId.split(":");
  const pid = Number(parts[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return {};
  // New format: pid:startTokenDigest:instance. A legacy pid:instance claim has
  // no process-instance identity and is therefore treated as unknown, not dead.
  if (parts.length < 3) return { pid };
  let digest = parts[1] || undefined;
  if (digest === "unknown") return { pid };
  if (digest && !/^[0-9a-f]{16}$/.test(digest)) {
    // Tolerate an older/raw URL-encoded token form without putting its spaces or
    // percent escapes into a durable ID field.
    try { digest = startTokenDigest(decodeURIComponent(digest)); } catch { digest = undefined; }
  }
  return { pid, ...(digest ? { startTokenDigest: digest } : {}) };
}

function oneLine(value: string, max = 300): string {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function ownerKey(owner: OwnerIdentity): string {
  return [owner.kind, owner.sessionId, owner.workspace, owner.branchId ?? "", owner.goalId ?? ""].join("\u0000");
}

function sameOwner(a: OwnerIdentity, b: OwnerIdentity): boolean {
  return ownerKey(a) === ownerKey(b);
}

function ownerMatchesOperation(operation: OperationRecord, owner: OwnerIdentity): boolean {
  // The execution identity is the session (or conversation) plus workspace. The
  // branch anchor decides which continuation may resume; it must not hide a
  // task from its own session after the branch advances.
  return operation.owner.kind === owner.kind
    && operation.owner.sessionId === owner.sessionId
    && operation.owner.workspace === owner.workspace;
}

function authorityReference(seed: string): string {
  return `authority:local:${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32)}`;
}

function defaultStorePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "operation-coordinator.sqlite");
}

function tail(path: string, maxBytes = 64 * 1024): { text: string; truncated: boolean } {
  let fd: number | undefined;
  try {
    if (!existsSync(path)) return { text: "", truncated: false };
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = Math.min(maxBytes, size - start);
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString("utf8"), truncated: start > 0 };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

function lastLines(text: string, lines: number): string {
  if (lines <= 0) return "";
  const split = text.split(/\r?\n/);
  if (split.length > 0 && split[split.length - 1] === "") split.pop();
  return split.slice(-lines).join("\n");
}

function terminalOutcome(status: SupervisorTaskStatus): "succeeded" | "failed" | "cancelled" | "lost" {
  switch (status) {
    case "succeeded": return "succeeded";
    case "cancelled": return "cancelled";
    case "lost": return "lost";
    default: return "failed";
  }
}

function supervisionReasonFields(inspection: SupervisorInspection | undefined): { reason?: string } {
  const reason = inspection?.result?.reason ?? inspection?.lost?.reason;
  const cleanup = inspection?.result?.groupCleanup === "unproven"
    ? "Process-group cleanup is unproven; descendants may remain running."
    : undefined;
  const text = [reason, cleanup].filter(Boolean).join("; ");
  return text ? { reason: oneLine(text) } : {};
}

function evidenceFor(inspection: SupervisorInspection): WaitEvidenceView[] {
  const paths = inspection.logs;
  const evidence: WaitEvidenceView[] = [];
  const result = inspection.result;
  const lost = inspection.lost;
  const terminalRef = result ? "result.json" : "lost.json";
  const summary = result
    ? `status=${result.status} exit=${result.exitCode ?? "null"} timedOut=${result.timedOut ? "true" : "false"}${result.groupCleanup ? ` groupCleanup=${result.groupCleanup}` : ""}`
    : `status=lost detailLost=true`;
  evidence.push({
    operationId: "",
    terminalRevision: 0,
    kind: "terminal-record",
    ref: terminalRef,
    summary,
    detailLost: !result,
  });
  for (const [label, path] of [["stdout", paths.stdout], ["stderr", paths.stderr]] as const) {
    try {
      const size = existsSync(path) ? statSync(path).size : 0;
      if (size <= 0) continue;
      evidence.push({
        operationId: "",
        terminalRevision: 0,
        kind: "log",
        ref: path,
        summary: `${label} retained (${size} bytes)`,
        detailLost: false,
      });
    } catch { /* a reclaimed log costs detail, never the outcome */ }
  }
  return evidence;
}

function mapEvidence(
  operationId: string,
  taskId: string | undefined,
  records: readonly (OperationEvidenceRecord | WaitEvidenceView)[],
  revision: number,
): WaitEvidenceView[] {
  return records.map((entry) => ({
    operationId: "operationId" in entry ? entry.operationId || operationId : operationId,
    ...(taskId ? { taskId } : {}),
    terminalRevision: "terminalRevision" in entry ? entry.terminalRevision || revision : revision,
    kind: entry.kind,
    ref: entry.ref,
    ...(entry.summary ? { summary: entry.summary } : {}),
    detailLost: entry.detailLost,
  }));
}

export class ObservedWaitHost {
  readonly service: BackgroundOperationService;
  private store?: Store;
  private readonly supervisor: LocalSupervisor;
  private readonly directory: string;
  private readonly storePath: string;
  private readonly discoveryScope: string;
  private readonly pollMs: number;
  private readonly options: ObservedWaitHostOptions;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private unavailableReason?: string;
  private parentOrigin?: BackgroundTaskCallbackOrigin;
  private activeOrigin?: BackgroundTaskCallbackOrigin;
  /**
   * The live extension context for the active session. Branch eligibility is
   * read from this context on every check; the SDK can settle/reload session
   * history after session_start, so a start-time branch snapshot is stale.
   */
  private activeContext?: ExtensionContext;
  /** A new session/workspace context needs one seed scan of terminal callbacks. */
  private terminalRecoveryNeeded = false;
  /** Terminal callbacks awaiting their exact batcher handoff. */
  private readonly pendingTerminalCallbacks = new Set<string>();
  /** Running operations this host observed; a transition out of running can need recovery. */
  private readonly watchedRunningTasks = new Set<string>();
  /** Durable sidecars discovered in this supervisor directory. */
  private readonly discoveredTaskSidecars = new Set<string>();
  private durableProjectionCache?: {
    readonly originKey: string;
    readonly key: string;
    readonly at: number;
    readonly list: DurableTaskProjection[];
    readonly byTask: Map<string, DurableTaskProjection>;
  };
  private projectionMetrics: DurableProjectionMetrics = {
    listCalls: 0,
    queries: 0,
    rowsRead: 0,
    projectionsBuilt: 0,
    cacheHits: 0,
  };
  private continuation?: ContinuationAdapter;
  private continuationError?: string;
  private readonly launches = new Map<string, LaunchContext>();
  private readonly rpcRuns = new Map<string, RpcRunBinding>();
  private readonly waitOwners = new Map<string, OwnerIdentity>();
  private readonly stagedCheckpoints = new Map<string, { evidence: JsonRecord; toolCallId: string; checkpointRecorded: boolean }>();
  private readonly branchAnchors = new Map<string, string | null>();
  private readonly durableChangeListeners = new Set<(change: DurableTaskChange) => void>();
  private readonly serviceId = `bg-observed-${randomUUID()}`;
  /** Opaque, validation-safe process-instance identity: pid + hashed start token. */
  private readonly hostStartDigest = startTokenDigest(currentProcessStartToken());
  private readonly hostId = `${process.pid}:${this.hostStartDigest}:${randomUUID()}`;
  private hostGeneration = ++HOST_INSTANCE_STATE.next;
  private discoveryToken?: string;
  private discoveryRole?: "holder" | "follower";
  private reconcileInFlight?: Promise<void>;
  private authorityPassCache?: Map<string, "live" | "dead" | "unknown">;
  /** Running operations this follower is currently assigned to supervise. */
  private readonly followerRunningTasks = new Set<string>();
  private lastChangeRevision = -1;
  private lastOwnedTerminalAt = 0;

  constructor(private readonly pi: ExtensionAPI, options: ObservedWaitHostOptions = {}) {
    this.options = options;
    this.directory = options.supervisorDirectory ?? defaultSupervisorDirectory();
    this.storePath = options.storePath ?? defaultStorePath();
    this.discoveryScope = createHash("sha256")
      .update(`${resolve(this.storePath)}\0${resolve(this.directory)}`)
      .digest("hex");
    this.supervisor = options.supervisor ?? createLocalSupervisor({ directory: this.directory });
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const base = {
      assignmentContinuation: 1 as const,
      outageReconciliation: 1 as const,
      version: OBSERVED_WAITS_SERVICE_VERSION,
      serviceId: this.serviceId,
      available: true as const,
      ownsTask: (run: WorkerRunScope, taskId: string) => this.ownsTask(run, taskId),
      launchForWorker: (run: WorkerRunScope, input: WorkerLaunchInput) => this.launchForWorker(run, input),
      statusForWorker: (run: WorkerRunScope, taskId: string) => this.statusForWorker(run, taskId),
      logForWorker: (run: WorkerRunScope, taskId: string, logOptions?: { lines?: number }) => this.logForWorker(run, taskId, logOptions),
      stopForWorker: (run: WorkerRunScope, taskId: string) => this.stopForWorker(run, taskId),
      registerWorkerWait: (run: WorkerRunScope, input: WorkerWaitInput) => this.registerWorkerWait(run, input),
      checkpointWorkerWait: (run: WorkerRunScope, input: WorkerCheckpointInput) => this.checkpointWorkerWait(run, input),
      failWorkerPark: (run: WorkerRunScope, input: { waitId: string; generation: number; reason: string }) => this.failWorkerPark(run, input),
      readEvidence: (run: WorkerRunScope, input: WorkerEvidenceInput) => this.readEvidence(run, input),
      acknowledgeForWorker: (run: WorkerRunScope, input: WorkerAcknowledgeInput) => this.acknowledgeForWorker(run, input),
      claimResumeForWorker: (run: WorkerRunScope, input: ResumeClaimViewInput) => this.claimResumeForWorker(run, input),
      publishResumeForWorker: (run: WorkerRunScope, input: PublishResumeViewInput) => this.publishResumeForWorker(run, input),
      releaseResumeForWorker: (run: WorkerRunScope, input: ReleaseResumeViewInput) => this.releaseResumeForWorker(run, input),
      holdFailedResumeForWorker: (run: WorkerRunScope, input: HoldResumedAttemptInput) => this.holdFailedResumeForWorker(run, input),
      repairFailedResumeForWorker: (run, input) => {
        this.ownedWait(this.workerOwner(run), input.waitId, input.generation);
        return this.requireStore().repairFailedResume(input);
      },
      listWorkerWaits: (run: WorkerRunScope, listOptions?: { pendingOnly?: boolean }) => this.listWorkerWaits(run, listOptions),
      cancelWorkerWait: (run: WorkerRunScope, input: { waitId: string; generation: number; reason: string }) => this.cancelWorkerWait(run, input),
      registerContinuationAdapter: (adapter: ContinuationAdapter) => this.registerContinuationAdapter(adapter),
      unregisterContinuationAdapter: (id: string) => this.unregisterContinuationAdapter(id),
    } satisfies Omit<BackgroundOperationService, "continuationReady">;
    Object.defineProperty(base, "continuationReady", {
      enumerable: true,
      get: () => this.continuation !== undefined || this.rpcRuns.size > 0,
    });
    HOST_INSTANCE_STATE.generations.set(this.hostId, this.hostGeneration);
    this.service = Object.freeze(base) as unknown as BackgroundOperationService;
    this.listenForServiceRequests();
    this.listenForWorkerRequests();
    // Announce the capability object at extension load so a Subagents probe does
    // not depend on handler order. The store opens on session activation or on
    // the first operation, and a failure replaces this with an unavailable
    // capability instead of pretending to be durable.
    this.announce();
  }

  get available(): boolean {
    return this.store !== undefined && !this.closed;
  }

  get reason(): string | undefined {
    return this.unavailableReason;
  }

  /** Open the durable store and begin bounded reconciliation. */
  start(ctx?: ExtensionContext): void {
    if (ctx) this.setActiveOrigin(ctx);
    if (this.store) {
      // The same host instance can be activated for another session without a
      // reload. Re-evaluate pending deliveries against the new active origin.
      this.recoverAbandonedDeliveries();
      void this.reconcileNow();
      this.recoverTerminalNotifications();
      this.terminalRecoveryNeeded = false;
      return;
    }
    // session_before_switch closes the store, and the same extension instance
    // handles the next session_start. A real unload is followed by no start.
    this.closed = false;
    this.unavailableReason = undefined;
    try {
      this.store = openStore({
        path: this.storePath,
        ...(this.options.now ? { now: this.options.now } : {}),
      });
    } catch (error) {
      this.unavailableReason = oneLine(error instanceof Error ? error.message : String(error), 300);
      this.announceUnavailable(this.unavailableReason);
      return;
    }
    if (HOST_INSTANCE_STATE.closed.delete(this.hostId)) {
      // Reactivation is newer than instances created while this host was closed.
      this.hostGeneration = ++HOST_INSTANCE_STATE.next;
      HOST_INSTANCE_STATE.generations.set(this.hostId, this.hostGeneration);
    }
    this.announce();
    this.writeHostDebug();
    this.recoverAbandonedDeliveries();
    void this.reconcileNow();
    this.recoverTerminalNotifications();
    this.terminalRecoveryNeeded = false;
    if (this.pollMs > 0) {
      this.timer = setInterval(() => { void this.reconcileNow(); }, this.pollMs);
      this.timer.unref?.();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    HOST_INSTANCE_STATE.closed.add(this.hostId);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.releaseDiscoveryAuthority();
    this.releaseSupervisionAuthority();
    try { this.store?.close(); } catch { /* already closed */ }
    this.store = undefined;
    this.launches.clear();
    this.rpcRuns.clear();
    this.waitOwners.clear();
    this.stagedCheckpoints.clear();
    this.branchAnchors.clear();
    this.activeOrigin = undefined;
    this.activeContext = undefined;
    this.terminalRecoveryNeeded = false;
    this.pendingTerminalCallbacks.clear();
    this.watchedRunningTasks.clear();
    this.discoveredTaskSidecars.clear();
    this.durableProjectionCache = undefined;
    this.writeHostDebug();
    this.announceUnavailable("the Background operation host closed");
  }

  /** Recover a callback a previous host recorded terminal but never delivered. */
  private recoverTerminalNotifications(): void {
    if (!this.store) return;
    for (const operation of this.activeParentTerminalOperations()) {
      if (operation.terminalOutcome === null) continue;
      this.attemptTerminalCallback(
        operation,
        this.statusOf(operation.operationId),
        operation.terminalOutcome,
        [],
      );
    }
  }

  private activeParentTerminalOperations(): OperationRecord[] {
    const origin = this.activeOrigin;
    if (!this.store || !origin?.sessionId) return [];
    return this.store.listOperations({
      phase: "terminal",
      ownerScope: { kind: "parent-session", sessionId: origin.sessionId, workspace: origin.cwd },
    });
  }

  /**
   * Discover durable tasks launched by any host sharing this supervisor
   * directory. A host that started before a task was registered never saw it in
   * the running set; terminal discovery must not depend on that observation.
   * This is a bounded directory listing plus new-sidecar lookup, not a scan of
   * historical terminal rows on every tick.
   */
  private discoverObservedTasks(): void {
    const store = this.store;
    if (!store) return;
    let names: string[];
    try { names = readdirSync(join(this.directory, "observed")); } catch { return; }
    let visibleOwner: OwnerIdentity | undefined;
    for (const name of names) {
      if (!name.endsWith(".json") || name === "host.json") continue;
      const taskId = name.slice(0, -5);
      if (!LOCAL_DURABLE_ID.test(taskId) || this.discoveredTaskSidecars.has(taskId)) continue;
      const operation = this.operationForTask(taskId);
      if (!operation) continue; // registration may land on the next tick
      this.discoveredTaskSidecars.add(taskId);
      if (this.activeOwnerRelation(operation.owner) === "match") visibleOwner = operation.owner;
      if (operation.terminalRevision > 0) {
        this.attemptTerminalCallback(
          operation,
          this.statusOf(operation.operationId),
          operation.terminalOutcome ?? "failed",
          [],
          { pendingWithoutContext: true },
        );
      } else {
        this.watchedRunningTasks.add(taskId);
      }
    }
    // A task launched by another Pi process became visible in this host's
    // supervisor directory. The navigator must refresh without waiting for a
    // render to rediscover it, and its cached projections are now stale.
    if (visibleOwner) this.emitDurableTaskChange(visibleOwner);
  }

  /**
   * Retry only terminal callbacks that are still awaiting an exact handoff. The
   * pending set is seeded once at activation and by each terminal attempt; it is
   * not a scan of the historical terminal table on every 250 ms tick.
   */
  private retryPendingTerminalCallbacks(): void {
    if (!this.store || this.pendingTerminalCallbacks.size === 0) return;
    for (const taskId of [...this.pendingTerminalCallbacks]) {
      const operation = this.operationForTask(taskId);
      if (!operation || operation.terminalRevision === 0) {
        this.pendingTerminalCallbacks.delete(taskId);
        continue;
      }
      const context = this.launchContext(taskId);
      if (!context || context.callback === false || context.callbackDeliveredAt !== undefined || !this.options.notifyParent) {
        this.pendingTerminalCallbacks.delete(taskId);
        continue;
      }
      if (!this.activeContext) continue; // wait for an exact active owner
      const relation = this.activeOwnerRelation(operation.owner);
      if (relation === "unknown") continue; // keep pending; never guess
      if (relation === "foreign") {
        this.pendingTerminalCallbacks.delete(taskId);
        continue;
      }
      const waitPending = this.store.listWaits({ owner: operation.owner, pendingOnly: true })
        .some((wait) => wait.dependencies.some((dep) => dep.operationId === operation.operationId));
      if (waitPending) {
        this.pendingTerminalCallbacks.delete(taskId);
        continue;
      }
      this.attemptTerminalCallback(
        operation,
        this.statusOf(operation.operationId),
        operation.terminalOutcome ?? "failed",
        [],
      );
    }
  }

  /** A deterministic, awaitable reconciliation pass for tests and session activation. */
  async reconcileNow(): Promise<void> {
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const pass = this.reconcilePass();
    this.reconcileInFlight = pass;
    try {
      await pass;
    } finally {
      if (this.reconcileInFlight === pass) this.reconcileInFlight = undefined;
    }
  }

  private async reconcilePass(): Promise<void> {
    if (!this.store || this.closed) return;
    this.authorityPassCache = new Map();
    try {
      const role = this.refreshDiscoveryAuthority();
      this.noteDiscoveryRole(role);
      if (role === "holder") {
        this.discoverObservedTasks();
        this.reconcileGlobalRunning();
      } else {
        this.reconcileFollowerRunning();
        this.reconcileOwnerChanges();
      }
      this.retryPendingTerminalCallbacks();
      await this.dispatchOutbox();
    } finally {
      this.authorityPassCache = undefined;
    }
  }

  private reconcileGlobalRunning(): void {
    const store = this.store;
    if (!store) return;
    const running = store.listOperations({ phase: "running" });
    const runningIds = new Set(running.map((operation) => operation.taskId));
    let changedOwner: OwnerIdentity | undefined;
    for (const taskId of [...this.watchedRunningTasks]) {
      if (runningIds.has(taskId)) continue;
      this.watchedRunningTasks.delete(taskId);
      const operation = this.operationForTask(taskId);
      if (operation && operation.terminalRevision > 0) {
        if (this.activeOwnerRelation(operation.owner) === "match") changedOwner = operation.owner;
        // Another host may have recorded the terminal result without a live
        // owner context. This host watched the operation, so recover its callback
        // now that the active branch/identity can authorize the handoff.
        this.attemptTerminalCallback(
          operation,
          this.statusOf(operation.operationId),
          operation.terminalOutcome ?? "failed",
          [],
          { pendingWithoutContext: true },
        );
      }
    }
    if (changedOwner) this.emitDurableTaskChange(changedOwner);
    for (const operation of running) {
      this.watchedRunningTasks.add(operation.taskId);
      this.reconcileOperation(operation);
    }
  }

  private reconcileFollowerRunning(): void {
    const store = this.store;
    if (!store) return;
    const running = store.listRunningSupervisedBy(this.hostId);
    const runningIds = new Set(running.map((operation) => operation.taskId));
    for (const taskId of [...this.followerRunningTasks]) {
      if (!runningIds.has(taskId)) this.followerRunningTasks.delete(taskId);
    }
    for (const operation of running) {
      this.followerRunningTasks.add(operation.taskId);
      this.reconcileOperation(operation);
    }
  }

  /**
   * A follower does not scan foreign operations. It refreshes the exact active
   * owner's terminal records only when the shared change revision advances, so
   * callback recovery stays correct without multiplying the running-set scan.
   */
  private reconcileOwnerChanges(): void {
    const store = this.store;
    const ctx = this.activeContext;
    if (!store || !ctx) return;
    const sessionId = this.sessionIdIfAvailable(ctx);
    if (!sessionId) return;
    let revision: number;
    try {
      revision = store.getChangeRevision();
    } catch {
      return;
    }
    if (revision === this.lastChangeRevision) return;
    this.lastChangeRevision = revision;
    let operations: OperationRecord[];
    try {
      operations = store.listOperations({
        ownerScope: { kind: "parent-session", sessionId, workspace: ctx.cwd },
        phase: "terminal",
      });
    } catch {
      return;
    }
    let newest = this.lastOwnedTerminalAt;
    let visibleOwner: OwnerIdentity | undefined;
    for (const operation of operations) {
      newest = Math.max(newest, operation.terminalAt ?? operation.updatedAt);
      if (this.activeOwnerRelation(operation.owner) === "match") visibleOwner ??= operation.owner;
      this.attemptTerminalCallback(
        operation,
        this.statusOf(operation.operationId),
        operation.terminalOutcome ?? "failed",
        [],
        { pendingWithoutContext: true },
      );
    }
    if (newest > this.lastOwnedTerminalAt) {
      this.lastOwnedTerminalAt = newest;
      if (visibleOwner) this.emitDurableTaskChange(visibleOwner);
    }
  }

  private noteDiscoveryRole(role: "holder" | "follower"): void {
    if (this.discoveryRole === role) return;
    this.discoveryRole = role;
    this.followerRunningTasks.clear();
    if (role === "holder") {
      this.watchedRunningTasks.clear();
      this.discoveredTaskSidecars.clear();
    }
    this.lastChangeRevision = -1;
  }

  /**
   * Acquire or confirm the one shared discovery claim. Process identity and
   * explicit close evidence decide replacement; elapsed time is not a lease.
   */
  private refreshDiscoveryAuthority(): "holder" | "follower" {
    const store = this.store;
    if (!store) return "follower";
    let claim;
    try {
      claim = store.readDiscoveryClaim(this.discoveryScope);
    } catch {
      return "follower";
    }
    if (claim?.hostId === this.hostId) {
      this.discoveryToken = claim.token;
      return "holder";
    }
    if (claim) {
      const state = this.discoveryHolderState(claim.hostId);
      if (state === "live" || state === "unknown") {
        this.discoveryToken = undefined;
        return "follower";
      }
    }
    const token = `discovery_${randomUUID()}`;
    try {
      const claimed = store.tryClaimDiscovery({
        scope: this.discoveryScope,
        expected: claim ? { hostId: claim.hostId, token: claim.token } : null,
        hostId: this.hostId,
        token,
      });
      if (claimed) {
        this.discoveryToken = claimed.token;
        return "holder";
      }
    } catch {
      // A busy store or a lost race defers discovery to a later pass.
    }
    this.discoveryToken = undefined;
    return "follower";
  }

  private discoveryHolderState(hostId: string): "live" | "dead" | "unknown" {
    if (hostId === this.hostId) return "live";
    return this.supervisionHolderState(hostId);
  }

  isDurableTask(taskId: string): boolean {
    if (!LOCAL_DURABLE_ID.test(taskId)) return false;
    if (this.store) return this.operationForTask(taskId) !== undefined;
    return existsSync(supervisorPaths(this.directory, taskId).dir);
  }

  // ---- parent launches -------------------------------------------------

  async launchParent(input: {
    kind: DurableTaskKind;
    params: Record<string, unknown>;
    ctx: ExtensionContext;
    waitForFirstCheck?: boolean;
  }): Promise<DurableLaunch> {
    const store = this.requireStore();
    this.requireStarted(input.ctx);
    if (input.params.ssh) {
      throw new Error("Structured SSH is not supervised by the durable local host; use the legacy remote task route.");
    }
    const owner = this.ownerFor(input.ctx);
    const prepared = this.prepareLaunch(input.kind, input.params, "bg_task_spawn", owner, undefined);
    const operationId = `op_${randomUUID()}`;
    const token = `launch_${randomUUID()}`;
    const taskId = supervisorTaskIdForToken(token);
    store.registerOperation({
      operationId,
      taskId,
      launchToken: token,
      owner,
      observer: OBSERVER,
      supervision: this.supervision(),
      authorityRef: this.parentAuthority(owner, prepared.plan),
      intentRef: typeof input.params.operation_id === "string" ? input.params.operation_id : null,
    });
    const launchContext: LaunchContext = {
      kind: input.kind,
      parentOrigin: this.parentOrigin,
      gated: prepared.gated,
      callback: input.params.callback !== false,
      ...(typeof input.params.name === "string" ? { name: input.params.name } : {}),
      ...(typeof input.params.command === "string" ? { command: input.params.command } : {}),
      ...(prepared.spec.argv ? { argv: [...prepared.spec.argv] } : {}),
      cwd: prepared.cwd,
      sandbox: prepared.provenance,
      branchId: owner.branchId ?? null,
    };
    // Persist supervision metadata outside the task execution record so a
    // replacement host can still notify the right parent and never re-route a
    // worker-owned operation to the parent's callback.
    this.writeLaunchContext(taskId, launchContext);
    const started = await this.startSupervisor({
      token, taskId, kind: input.kind, params: input.params, prepared, operationId,
    });
    this.launches.set(taskId, launchContext);
    this.emitDurableTaskChange(owner);
    const launch: DurableLaunch = {
      id: taskId,
      operationId,
      kind: input.kind,
      status: "running",
      ...(typeof input.params.name === "string" ? { name: input.params.name } : {}),
      cwd: prepared.cwd,
      ...(typeof input.params.command === "string" ? { command: input.params.command } : {}),
      ...(prepared.spec.argv ? { argv: prepared.spec.argv } : {}),
      shell: prepared.spec.shell !== false,
      owner,
      started: started.started,
      claimed: started.claimed,
      notices: prepared.notices,
    };
    if (input.kind === "watch" && input.waitForFirstCheck !== false) {
      const check = await this.firstCheck(taskId);
      return { ...launch, ...(check ? { firstCheck: check } : {}) };
    }
    return launch;
  }

  formatLaunch(launch: DurableLaunch): string {
    const lines = [
      `Started durable background ${launch.kind === "watch" ? "watch" : "process"} ${launch.id} (operation ${launch.operationId}).`,
      `Owner: ${launch.owner.kind} ${launch.owner.sessionId}.${launch.owner.branchId ? ` branch ${launch.owner.branchId}` : ""}`.trim(),
      `Status: ${launch.status}; supervisor ${launch.started ? "started" : "reported the existing execution"}${launch.claimed ? ", runner claimed" : ", runner claim pending"}.`,
      `Inspect with bg_task_status ${launch.id}; read output with bg_task_log ${launch.id}; stop with bg_task_stop ${launch.id}.`,
      "Never poll in the foreground. Register wait_for_operations when no independent work remains.",
    ];
    if (launch.firstCheck) {
      lines.push(`First check: exit=${launch.firstCheck.exitCode ?? "null"}${launch.firstCheck.signal ? ` signal=${launch.firstCheck.signal}` : ""}.`);
      if (launch.firstCheck.stdout.trim()) lines.push(`stdout: ${tailText(launch.firstCheck.stdout, 10)}`);
      if (launch.firstCheck.stderr.trim()) lines.push(`stderr: ${tailText(launch.firstCheck.stderr, 10)}`);
    }
    for (const notice of launch.notices) lines.push(`Notice: ${notice}`);
    return lines.join("\n");
  }

  /**
   * Bounded first-check observation, mirroring the legacy watch launch. A watch
   * whose first check is still running returns the retained tails and says so;
   * it never invents an exit code. A check that ends without a terminal record
   * is given a short grace for the runner to publish the next attempt.
   */
  private async firstCheck(taskId: string): Promise<DurableFirstCheck | undefined> {
    const deadline = Date.now() + 15_000;
    const tails = (attempt: number): DurableFirstCheck | undefined => {
      const inspection = this.supervisor.inspect(taskId);
      if (!inspection) return undefined;
      const paths = inspection.logs;
      return {
        attempt,
        exitCode: null,
        signal: null,
        stdout: lastLines(tail(paths.stdout).text, 10),
        stderr: lastLines(tail(paths.stderr).text, 10),
      };
    };
    let endedAt: number | undefined;
    while (Date.now() < deadline) {
      const inspection = this.supervisor.inspect(taskId);
      if (inspection?.result) {
        const last = inspection.result.lastCheck;
        return {
          attempt: inspection.result.checks ?? 1,
          exitCode: last?.exitCode ?? inspection.result.exitCode,
          signal: last?.signal ?? inspection.result.signal,
          stdout: last?.stdout ?? inspection.result.lastOutput?.stdout ?? "",
          stderr: last?.stderr ?? inspection.result.lastOutput?.stderr ?? "",
        };
      }
      const command = inspection?.command;
      if (command) {
        if (command.alive) {
          endedAt = undefined;
        } else if (endedAt === undefined) {
          endedAt = Date.now();
        } else if (Date.now() - endedAt >= 250) {
          return tails(command.attempt);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Still running after the legacy first-check window: report what the logs hold.
    const inspection = this.supervisor.inspect(taskId);
    return inspection?.command ? tails(inspection.command.attempt) : undefined;
  }

  // ---- status / log / stop --------------------------------------------

  statusForParent(ctx: ExtensionContext, taskId: string): StatusView {
    this.noteParentContext(ctx);
    return this.status(taskId, this.ownerFor(ctx));
  }

  logForParent(ctx: ExtensionContext, taskId: string, options?: { lines?: number }): LogView {
    this.noteParentContext(ctx);
    return this.log(taskId, this.ownerFor(ctx), options);
  }

  async stopForParent(ctx: ExtensionContext, taskId: string): Promise<StatusView> {
    this.noteParentContext(ctx);
    return this.stop(taskId, this.ownerFor(ctx));
  }

  // ---- read-only projections for list, navigator and Goal -----------------

  /**
   * Durable operations owned by exactly this parent origin, newest first. This
   * never writes a legacy registry meta and never reconciles; it projects the
   * canonical operation store plus the supervisor's durable records.
   */
  listDurableTasks(
    origin: BackgroundTaskCallbackOrigin,
    options: { retentionMs?: number; includeDismissed?: boolean } = {},
  ): DurableTaskProjection[] {
    const store = this.store;
    if (!store || this.closed) return [];
    if (!origin.sessionId) return [];
    this.projectionMetrics.listCalls += 1;
    const now = this.options.now?.() ?? Date.now();
    const originKey = `${origin.cwd}\0${origin.sessionId}`;
    const cacheKey = `${originKey}\0${options.retentionMs ?? ""}\0${options.includeDismissed === true ? 1 : 0}`;
    const cached = this.durableProjectionCache;
    if (cached && cached.key === cacheKey && now >= cached.at && now - cached.at < DURABLE_PROJECTION_CACHE_MS) {
      this.projectionMetrics.cacheHits += 1;
      if (options.retentionMs === undefined) return cached.list;
      const live = cached.list.filter((projection) => !this.expiredProjection(projection, options, now));
      return live.length === cached.list.length ? cached.list : live;
    }
    const projections: DurableTaskProjection[] = [];
    const operations = store.listOperations({
      ownerScope: { kind: "parent-session", sessionId: origin.sessionId, workspace: origin.cwd },
    });
    this.projectionMetrics.queries += 1;
    this.projectionMetrics.rowsRead += operations.length;
    for (const operation of operations) {
      if (!this.belongsToParentOrigin(operation, origin)) continue;
      this.projectionMetrics.projectionsBuilt += 1;
      const projection = this.projectDurable(operation, now);
      if (!projection) continue;
      if (projection.dismissedAt !== undefined && options.includeDismissed !== true) continue;
      if (projection.terminal && options.retentionMs !== undefined) {
        const endedAt = projection.endedAt ?? now;
        if (now - endedAt >= options.retentionMs) continue;
      }
      projections.push(projection);
    }
    projections.sort((a, b) => b.startedAt - a.startedAt);
    this.durableProjectionCache = {
      originKey,
      key: cacheKey,
      at: now,
      list: projections,
      byTask: new Map(projections.map((projection) => [projection.id, projection])),
    };
    const live = projections.filter((projection) => !this.expiredProjection(projection, options, now));
    return live.length === projections.length ? projections : live;
  }

  readDurableTask(origin: BackgroundTaskCallbackOrigin, taskId: string): DurableTaskProjection | undefined {
    const now = this.options.now?.() ?? Date.now();
    const cached = this.durableProjectionCache;
    if (cached && cached.originKey === `${origin.cwd}\0${origin.sessionId ?? ""}`
      && now >= cached.at && now - cached.at < DURABLE_PROJECTION_CACHE_MS) {
      const projection = cached.byTask.get(taskId);
      if (projection) return projection;
    }
    const operation = this.operationForTask(taskId);
    if (!operation || !this.belongsToParentOrigin(operation, origin)) return undefined;
    this.projectionMetrics.projectionsBuilt += 1;
    return this.projectDurable(operation, now);
  }

  /** Accumulated projection work, for performance regression proof. */
  getDurableProjectionMetrics(): DurableProjectionMetrics {
    return { ...this.projectionMetrics };
  }

  resetDurableProjectionMetrics(): void {
    this.projectionMetrics = { listCalls: 0, queries: 0, rowsRead: 0, projectionsBuilt: 0, cacheHits: 0 };
  }

  private expiredProjection(
    projection: DurableTaskProjection,
    options: { retentionMs?: number },
    now: number,
  ): boolean {
    if (!projection.terminal || options.retentionMs === undefined) return false;
    const endedAt = projection.endedAt ?? now;
    return now - endedAt >= options.retentionMs;
  }

  /**
   * True only when this host's **currently active** parent session/workspace
   * owns the durable operation. The adapter contract uses this to admit a local
   * stop/clear as a registry operation; it is not a regex and cannot authorize a
   * foreign session or a worker-owned operation.
   */
  ownsDurableTask(taskId: string): boolean {
    const origin = this.activeOrigin;
    if (!origin) return false;
    return this.readDurableTask(origin, taskId) !== undefined;
  }

  /** Read-only log tails. Unlike status/log tools, this records no evidence read. */
  readDurableTaskLog(
    origin: BackgroundTaskCallbackOrigin,
    taskId: string,
    lines = 40,
  ): DurableTaskLogView | undefined {
    const projection = this.readDurableTask(origin, taskId);
    if (!projection) return undefined;
    const count = Math.max(1, Math.floor(lines));
    const stdout = tail(projection.logPaths.stdout);
    const stderr = tail(projection.logPaths.stderr);
    return {
      taskId,
      status: projection.status,
      stdout: lastLines(stdout.text, count),
      stderr: lastLines(stderr.text, count),
      events: lastLines(tail(projection.logPaths.events).text, Math.min(count, 20)),
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  /** Stop a durable task through the supervisor. Foreign ids are refused. */
  async stopDurableTask(origin: BackgroundTaskCallbackOrigin, taskId: string): Promise<DurableTaskProjection | undefined> {
    const operation = this.operationForTask(taskId);
    if (!operation || !this.belongsToParentOrigin(operation, origin)) return undefined;
    await this.stop(taskId, operation.owner);
    this.invalidateDurableProjection(operation.owner);
    return this.projectDurable(operation, this.options.now?.() ?? Date.now());
  }

  /** Dismiss one terminal durable task from list/navigator/Goal. Evidence stays readable. */
  dismissDurableTask(origin: BackgroundTaskCallbackOrigin, taskId: string): boolean {
    const operation = this.operationForTask(taskId);
    if (!operation || !this.belongsToParentOrigin(operation, origin)) return false;
    const projection = this.projectDurable(operation, this.options.now?.() ?? Date.now());
    if (!projection || !projection.terminal) return false;
    const context = this.currentLaunchContext(taskId) ?? {
      kind: projection.kind,
      gated: projection.stepGateFailure !== undefined,
      callback: false,
      ...(projection.name ? { name: projection.name } : {}),
      ...(projection.command ? { command: projection.command } : {}),
      ...(projection.argv ? { argv: [...projection.argv] } : {}),
      cwd: projection.cwd,
    };
    context.dismissedAt = Date.now();
    this.launches.set(taskId, context);
    this.writeLaunchContext(taskId, context);
    this.emitDurableTaskChange(operation.owner);
    return true;
  }

  onDurableTaskChange(listener: (change: DurableTaskChange) => void): () => void {
    this.durableChangeListeners.add(listener);
    return () => { this.durableChangeListeners.delete(listener); };
  }

  private emitDurableTaskChange(owner: OwnerIdentity): void {
    // Navigators and Goal activity only show the active parent session. A
    // worker, another session, or another workspace must not evict its cache or
    // request a repaint.
    if (owner.kind !== "parent-session" || this.activeOwnerRelation(owner) !== "match") return;
    this.invalidateDurableProjection(owner);
    const change = { sessionId: owner.sessionId, workspace: owner.workspace };
    for (const listener of [...this.durableChangeListeners]) {
      try { listener(change); } catch { /* a projection listener cannot break supervision */ }
    }
  }

  private invalidateDurableProjection(owner?: OwnerIdentity): void {
    if (owner && (owner.kind !== "parent-session" || this.activeOwnerRelation(owner) !== "match")) return;
    this.durableProjectionCache = undefined;
  }

  private belongsToParentOrigin(operation: OperationRecord, origin: BackgroundTaskCallbackOrigin): boolean {
    if (operation.owner.kind !== "parent-session") return false;
    if (operation.owner.workspace !== origin.cwd) return false;
    if (origin.sessionId || operation.owner.sessionId) return operation.owner.sessionId === origin.sessionId;
    return true;
  }

  private projectDurable(operation: OperationRecord, now: number): DurableTaskProjection | undefined {
    const context = this.launchContext(operation.taskId);
    // Projection is the rendering path: a snapshot reads the durable records
    // without taking the cross-process fence or spawning `ps`.
    const inspection = LOCAL_DURABLE_ID.test(operation.taskId)
      ? (() => { try { return this.supervisor.snapshot(operation.taskId); } catch { return undefined; } })()
      : undefined;
    const storeStatus = operation.terminalRevision > 0 ? this.statusOf(operation.operationId) : undefined;
    const status: SupervisorTaskStatus = inspection?.terminal ? inspection.status : storeStatus ?? inspection?.status ?? "running";
    const terminal = inspection?.terminal === true || operation.terminalRevision > 0;
    const active = !terminal && (status === "running" || status === "starting");
    const startedAt = inspection?.result?.startedAt ?? inspection?.launch?.createdAt ?? operation.createdAt;
    const endedAt = inspection?.result?.endedAt ?? inspection?.lost?.recordedAt ?? operation.terminalAt ?? undefined;
    const pathSet = inspection?.logs ?? supervisorPaths(this.directory, operation.taskId);
    const result = inspection?.result;
    const lost = inspection?.lost;
    const waits = (this.store?.listWaits({ owner: operation.owner, pendingOnly: true }) ?? [])
      .filter((wait) => wait.dependencies.some((dep) => dep.operationId === operation.operationId))
      .map((wait) => this.waitView(wait));
    const stepGate = result && context?.gated
      ? parseStepGateFailure(tail(pathSet.stderr).text, operation.taskId)
      : undefined;
    const timeoutSeconds = inspection?.launch.timeoutSeconds;
    return {
      id: operation.taskId,
      operationId: operation.operationId,
      kind: (context?.kind ?? inspection?.launch.kind) === "watch" ? "watch" : "process",
      status,
      active,
      terminal,
      attention: terminal && status !== "succeeded",
      ...(context?.name ?? inspection?.launch.name ? { name: context?.name ?? inspection?.launch.name } : {}),
      cwd: inspection?.launch.cwd ?? context?.cwd ?? operation.owner.workspace,
      ...(context?.command ? { command: context.command } : {}),
      ...(context?.argv ? { argv: context.argv } : {}),
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      ...supervisionReasonFields(inspection),
      ...(result?.matchedCondition ? { matchedCondition: result.matchedCondition } : {}),
      ...(result?.lastOutput ? { lastOutput: result.lastOutput } : {}),
      ...(stepGate ? { stepGateFailure: stepGate } : {}),
      terminalRevision: operation.terminalRevision,
      terminalOutcome: operation.terminalOutcome,
      detailLost: lost !== undefined || operation.terminalDetailLost,
      ...(context?.dismissedAt !== undefined ? { dismissedAt: context.dismissedAt } : {}),
      ...(result ? { logDiscardedBytes: result.stdoutDiscardedBytes + result.stderrDiscardedBytes } : {}),
      ...(inspection?.launch.intervalSeconds !== undefined ? { intervalSeconds: inspection.launch.intervalSeconds } : {}),
      ...(timeoutSeconds !== undefined && timeoutSeconds > 0 ? { deadlineAt: startedAt + timeoutSeconds * 1000 } : {}),
      logPaths: { stdout: pathSet.stdout, stderr: pathSet.stderr, events: pathSet.events },
      waits,
      ...(context?.sandbox ? { sandbox: context.sandbox } : {}),
      owner: { sessionId: operation.owner.sessionId, workspace: operation.owner.workspace },
    };
  }

  private status(taskId: string, owner: OwnerIdentity): StatusView {
    const store = this.requireStore();
    const operation = this.ownedOperation(taskId, owner);
    const inspection = this.inspect(taskId);
    this.reconcileInspection(operation, inspection);
    const current = store.getOperation(operation.operationId) ?? operation;
    if (this.watchedRunningTasks.delete(taskId) && current.terminalRevision > 0) {
      this.attemptTerminalCallback(
        current,
        this.statusOf(current.operationId),
        current.terminalOutcome ?? "failed",
        [],
        { pendingWithoutContext: true },
      );
    }
    if (current.terminalRevision > 0) {
      // Status is an explicit owner read of this exact terminal operation. It is
      // the natural recovery point when another host recorded terminal first.
      this.attemptTerminalCallback(
        current,
        this.statusOf(current.operationId),
        current.terminalOutcome ?? "failed",
        [],
        { pendingWithoutContext: true },
      );
    }
    this.recordReadsForTask(owner, current);
    const paths = supervisorPaths(this.directory, taskId);
    const gateText = inspection ? `${tail(paths.stderr).text}` : "";
    const waits = store.listWaits({ pendingOnly: true })
      .filter((wait) => sameOwner(wait.owner, owner))
      .filter((wait) => wait.dependencies.some((dep) => dep.operationId === current.operationId))
      .map((wait) => this.waitView(wait));
    const result = inspection?.result;
    const launched = this.launchContext(taskId);
    const stepGate = result && launched?.gated ? parseStepGateFailure(gateText, taskId) : undefined;
    const kind = inspection?.kind ?? launched?.kind ?? "process";
    return {
      taskId,
      operationId: current.operationId,
      kind: kind === "watch" ? "watch" : "process",
      status: inspection?.status ?? this.statusOf(current.operationId),
      phase: current.phase,
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      ...supervisionReasonFields(inspection),
      terminalRevision: current.terminalRevision,
      terminalOutcome: current.terminalOutcome,
      ...(result ? { startedAt: result.startedAt, endedAt: result.endedAt } : {}),
      ...(result?.checks !== undefined ? { checks: result.checks } : {}),
      ...(result?.matchedCondition ? { matchedCondition: result.matchedCondition } : {}),
      ...(result?.lastOutput ? { lastOutput: result.lastOutput } : {}),
      ...(stepGate ? { stepGateFailure: stepGate } : {}),
      waits,
      ...(launched?.sandbox ? { sandbox: launched.sandbox } : {}),
    };
  }

  private log(taskId: string, owner: OwnerIdentity, options: { lines?: number } = {}): LogView {
    const store = this.requireStore();
    const operation = this.ownedOperation(taskId, owner);
    const inspection = this.inspect(taskId);
    this.reconcileInspection(operation, inspection);
    this.recordReadsForTask(owner, store.getOperation(operation.operationId) ?? operation);
    const paths = supervisorPaths(this.directory, taskId);
    const lines = Math.max(1, Math.floor(options.lines ?? 40));
    const stdout = tail(paths.stdout);
    const stderr = tail(paths.stderr);
    return {
      taskId,
      status: inspection?.status ?? "running",
      stdout: lastLines(stdout.text, lines),
      stderr: lastLines(stderr.text, lines),
      events: lastLines(tail(paths.events).text, Math.min(lines, 20)),
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  private async stop(taskId: string, owner: OwnerIdentity): Promise<StatusView> {
    const store = this.requireStore();
    const operation = this.ownedOperation(taskId, owner);
    const result = await this.supervisor.stop(taskId);
    const inspection = result?.inspection ?? this.supervisor.inspect(taskId);
    this.reconcileInspection(operation, inspection);
    const current = store.getOperation(operation.operationId) ?? operation;
    if (current.terminalRevision === 0 && inspection?.terminal) {
      this.recordTerminal(current, inspection);
    }
    return this.status(taskId, owner);
  }

  formatStatus(view: StatusView): string {
    const lines = [
      `${view.taskId} ${view.kind}: ${view.status} (${view.phase})`,
      `operation: ${view.operationId}; terminal revision: ${view.terminalRevision}${view.terminalOutcome ? ` (${view.terminalOutcome})` : ""}`,
    ];
    if (view.sandbox) {
      lines.push(`sandbox: ${view.sandbox.confinement}${view.sandbox.backend ? `; ${oneLine(view.sandbox.backend, 40)}` : ""}; source: ${oneLine(view.sandbox.policySource, 80)}; later changes do not affect this task.`);
    }
    if (view.exitCode !== null || view.signal) lines.push(`exit=${view.exitCode ?? "null"}${view.signal ? ` signal=${view.signal}` : ""}${view.stepGateFailure ? " (step gate)" : ""}`);
    if (view.startedAt) lines.push(`started: ${new Date(view.startedAt).toISOString()}${view.endedAt ? `; ended: ${new Date(view.endedAt).toISOString()}` : ""}`);
    if (view.checks !== undefined) lines.push(`checks: ${view.checks}`);
    if (view.matchedCondition) lines.push(`matched: ${oneLine(JSON.stringify(view.matchedCondition))}`);
    if (view.reason) lines.push(`reason: ${view.reason}`);
    if (view.stepGateFailure) lines.push(`failing step: ${view.stepGateFailure.command}`);
    if (view.waits.length) {
      for (const wait of view.waits) {
        lines.push(`wait: ${wait.waitId} generation ${wait.generation} ${wait.phase}${wait.settled ? " (settled)" : ""}`);
      }
    } else {
      lines.push("wait: none pending for this owner");
    }
    lines.push("Read the terminal evidence with bg_task_log before acknowledging a wait.");
    return lines.join("\n");
  }

  formatLog(view: LogView): string {
    const parts = [`${view.taskId} ${view.status}`, "stdout:", view.stdout || "(empty)"];
    if (view.stderr.trim()) parts.push("stderr:", view.stderr);
    parts.push("events:", view.events || "(empty)");
    if (view.truncated) parts.push("Retention removed older output; the terminal outcome is preserved.");
    return parts.join("\n");
  }

  // ---- parent waits ----------------------------------------------------

  waitForParent(ctx: ExtensionContext, taskIds: readonly string[], continuationNote: string): WaitView {
    this.noteParentContext(ctx);
    const store = this.requireStore();
    const owner = this.ownerFor(ctx);
    const operations = this.operationsForTaskIds(owner, taskIds);
    for (const operation of operations) this.reconcileOperation(operation);
    const result = store.registerWait({
      owner,
      dependencies: operations.map((operation) => ({ operationId: operation.operationId })),
      continuationNote,
      origin: { taskIds: [...taskIds] },
    });
    void this.dispatchOutbox();
    return this.waitView(store.getWait({ waitId: result.wait.waitId }) ?? result.wait);
  }

  waitViewForParent(ctx: ExtensionContext, waitId: string, generation?: number): WaitView | undefined {
    const store = this.requireStore();
    const wait = store.getWait({ waitId, ...(generation ? { generation } : {}) });
    return wait && sameOwner(wait.owner, this.ownerFor(ctx)) ? this.waitView(wait) : undefined;
  }

  listWaitsForParent(ctx: ExtensionContext, options: { pendingOnly?: boolean } = {}): WaitView[] {
    this.noteParentContext(ctx);
    const store = this.requireStore();
    const owner = this.ownerFor(ctx);
    return store.listWaits({ owner, ...(options.pendingOnly ? { pendingOnly: true } : {}) }).map((wait) => this.waitView(wait));
  }

  cancelWaitForParent(ctx: ExtensionContext, waitId: string, generation: number, reason: string): WaitView {
    this.noteParentContext(ctx);
    return this.cancelWait(this.ownerFor(ctx), waitId, generation, reason);
  }

  acknowledgeForParent(ctx: ExtensionContext, input: {
    waitId: string;
    generation: number;
    terminalRevisions: unknown;
    disposition: AcknowledgeDisposition;
    note: string;
  }): AcknowledgeView {
    this.noteParentContext(ctx);
    return this.acknowledge(this.ownerFor(ctx), input);
  }

  // ---- worker service --------------------------------------------------

  ownsTask(run: WorkerRunScope, taskId: string): boolean {
    const operation = this.operationForTask(taskId);
    return !!operation && ownerMatchesOperation(operation, this.workerOwner(run));
  }

  async launchForWorker(run: WorkerRunScope, input: WorkerLaunchInput): Promise<DurableLaunch> {
    const store = this.requireStore();
    if (input.params.ssh) throw new Error("Worker background launches are local-only; structured SSH is unavailable through this service.");
    const owner = this.workerOwner(run);
    const prepared = this.prepareLaunch(
      input.kind,
      input.params,
      input.kind === "watch" ? "bg_task_watch" : "bg_task_spawn",
      owner,
      input.policy,
      run.workspace,
    );
    const operationId = `op_${randomUUID()}`;
    const token = `launch_${randomUUID()}`;
    const taskId = supervisorTaskIdForToken(token);
    store.registerOperation({
      operationId,
      taskId,
      launchToken: token,
      owner,
      observer: OBSERVER,
      supervision: this.supervision(),
      authorityRef: authorityReference(`worker:${run.authorityReference}`),
      intentRef: typeof input.params.operation_id === "string" ? input.params.operation_id : null,
    });
    const launchContext: LaunchContext = {
      kind: input.kind,
      parentOrigin: this.parentOrigin,
      gated: prepared.gated,
      callback: false,
      ...(typeof input.params.name === "string" ? { name: input.params.name } : {}),
      ...(typeof input.params.command === "string" ? { command: input.params.command } : {}),
      ...(prepared.spec.argv ? { argv: [...prepared.spec.argv] } : {}),
      cwd: prepared.cwd,
      sandbox: prepared.provenance,
      branchId: owner.branchId ?? null,
    };
    this.writeLaunchContext(taskId, launchContext);
    const started = await this.startSupervisor({
      token, taskId, kind: input.kind, params: input.params, prepared, operationId,
    });
    this.launches.set(taskId, launchContext);
    this.emitDurableTaskChange(owner);
    return {
      id: taskId,
      operationId,
      kind: input.kind,
      status: "running",
      ...(typeof input.params.name === "string" ? { name: input.params.name } : {}),
      cwd: prepared.cwd,
      ...(typeof input.params.command === "string" ? { command: input.params.command } : {}),
      ...(prepared.spec.argv ? { argv: prepared.spec.argv } : {}),
      shell: prepared.spec.shell !== false,
      owner,
      started: started.started,
      claimed: started.claimed,
      notices: prepared.notices,
    };
  }

  statusForWorker(run: WorkerRunScope, taskId: string): StatusView {
    return this.status(taskId, this.workerOwner(run));
  }

  logForWorker(run: WorkerRunScope, taskId: string, options?: { lines?: number }): LogView {
    return this.log(taskId, this.workerOwner(run), options);
  }

  async stopForWorker(run: WorkerRunScope, taskId: string): Promise<StatusView> {
    return this.stop(taskId, this.workerOwner(run));
  }

  registerWorkerWait(run: WorkerRunScope, input: WorkerWaitInput): WaitView {
    const store = this.requireStore();
    if (!this.continuation && this.rpcRuns.size === 0) {
      throw new Error("Worker parking requires a verified continuation adapter; start Subagents' coordinator before registering a park wait. The operation was not parked.");
    }
    const owner = this.workerOwner(run);
    const operations = this.operationsForTaskIds(owner, input.taskIds);
    const registered = store.registerWait({
      owner,
      dependencies: operations.map((operation) => ({ operationId: operation.operationId })),
      continuationNote: input.continuationNote,
      park: {
        attemptId: input.attemptId,
        checkpointId: input.checkpointId,
        ...(input.writerLeaseId ? { writerLeaseId: input.writerLeaseId } : {}),
      },
      origin: { taskIds: [...input.taskIds], attemptId: input.attemptId },
    });
    const parking = store.transitionWaitPhase({
      waitId: registered.wait.waitId,
      generation: registered.wait.generation,
      from: "registering",
      to: "parking",
      reason: "waiting for the parked worker checkpoint",
    });
    return this.waitView(parking.wait);
  }

  async checkpointWorkerWait(run: WorkerRunScope, input: WorkerCheckpointInput): Promise<WaitView> {
    const store = this.requireStore();
    const owner = this.workerOwner(run);
    const wait = this.ownedWait(owner, input.waitId, input.generation);
    // A replacement host may replay the post-exit finalization. Once the
    // generation has left parking, the checkpoint is already proven.
    if (wait.phase === "waiting" || wait.phase === "ready" || wait.phase === "resuming" || wait.phase === "consumed") {
      return this.waitView(wait);
    }
    if (wait.phase !== "parking") throw new Error(`Wait ${wait.waitId} generation ${wait.generation} is ${wait.phase}, not parking.`);
    const proof = input.proof;
    if (!proof?.checkpointRecorded || !proof.writerLeaseReleased || !proof.writerPidGone) {
      throw new Error("A parked worker wait needs proven checkpoint commit, writer-lease release and original writer process exit before it can leave parking.");
    }
    const transitioned = store.transitionWaitPhase({
      waitId: wait.waitId,
      generation: wait.generation,
      from: "parking",
      to: "waiting",
      proof,
      reason: "checkpoint committed and the original writer exited",
    });
    await this.dispatchOutbox();
    return this.waitView(transitioned.wait);
  }

  /**
   * Record that the attempt could not become safely parked. A checkpoint that
   * was never committed must never look parked; if this store version cannot
   * hold an unproven generation, the generation is cancelled with the failure
   * reason instead of being left to block every future wait.
   */
  failWorkerPark(run: WorkerRunScope, input: { waitId: string; generation: number; reason: string }): WaitView {
    const store = this.requireStore();
    const owner = this.workerOwner(run);
    const wait = this.ownedWait(owner, input.waitId, input.generation);
    try {
      const transitioned = store.transitionWaitPhase({
        waitId: input.waitId,
        generation: input.generation,
        from: wait.phase as "registering" | "parking",
        to: "held",
        reason: input.reason,
      });
      return this.waitView(transitioned.wait);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "checkpoint-proof" && code !== "wait-phase") throw error;
      return this.cancelWait(owner, input.waitId, input.generation, `park failed: ${input.reason}`);
    }
  }

  readEvidence(run: WorkerRunScope, input: WorkerEvidenceInput): WaitEvidenceView[] {
    return this.readEvidenceForOwner(this.workerOwner(run), input.waitId, input.generation, input.taskId);
  }

  acknowledgeForWorker(run: WorkerRunScope, input: WorkerAcknowledgeInput): AcknowledgeView {
    return this.acknowledge(this.workerOwner(run), input);
  }

  claimResumeForWorker(run: WorkerRunScope, input: ResumeClaimViewInput): ResumeClaimView {
    const owner = this.workerOwner(run);
    this.ownedWait(owner, input.waitId, input.generation);
    const result = this.requireStore().claimResume({
      waitId: input.waitId,
      generation: input.generation,
      expectedCancelEpoch: input.expectedCancelEpoch,
      lease: {
        ownerId: input.lease.ownerId,
        ...(input.lease.pid !== undefined ? { pid: input.lease.pid } : {}),
        ...(input.lease.processStartToken !== undefined ? { processStartToken: input.lease.processStartToken } : {}),
      },
      reservedCheckpointId: input.reservedCheckpointId,
    });
    return {
      claimId: result.claim.claimId,
      claimToken: result.claim.claimToken,
      state: result.claim.state,
      attemptId: result.claim.attemptId,
      phase: result.wait.phase,
      cancelEpoch: result.wait.cancelEpoch,
    };
  }

  publishResumeForWorker(run: WorkerRunScope, input: PublishResumeViewInput): ResumeClaimView {
    this.ownedWait(this.workerOwner(run), input.waitId, input.generation);
    const result = this.requireStore().publishResumeAttempt({
      waitId: input.waitId,
      generation: input.generation,
      claimId: input.claimId,
      claimToken: input.claimToken,
      attemptId: input.attemptId,
      launchToken: input.launchToken,
    });
    return {
      claimId: result.claim.claimId,
      claimToken: result.claim.claimToken,
      state: result.claim.state,
      attemptId: result.claim.attemptId,
      phase: result.wait.phase,
      cancelEpoch: result.wait.cancelEpoch,
    };
  }

  releaseResumeForWorker(run: WorkerRunScope, input: ReleaseResumeViewInput): ResumeClaimView {
    this.ownedWait(this.workerOwner(run), input.waitId, input.generation);
    const result = this.requireStore().releaseResumeClaim({
      waitId: input.waitId,
      generation: input.generation,
      claimId: input.claimId,
      claimToken: input.claimToken,
      outcome: input.outcome,
      reason: input.reason,
    });
    return {
      claimId: result.claim.claimId,
      claimToken: result.claim.claimToken,
      state: result.claim.state,
      attemptId: result.claim.attemptId,
      phase: result.wait.phase,
      cancelEpoch: result.wait.cancelEpoch,
    };
  }

  listWorkerWaits(run: WorkerRunScope, options: { pendingOnly?: boolean } = {}): WaitView[] {
    const store = this.requireStore();
    return store.listWaits({ owner: this.workerOwner(run), ...(options.pendingOnly ? { pendingOnly: true } : {}) })
      .map((wait) => this.waitView(wait));
  }

  cancelWorkerWait(run: WorkerRunScope, input: { waitId: string; generation: number; reason: string }): WaitView {
    return this.cancelWait(this.workerOwner(run), input.waitId, input.generation, input.reason);
  }

  /**
   * A published continuation exited without interpreting its wait.
   *
   * This is not a cancellation: the epoch and evidence pins survive and the
   * generation becomes `held` with the failure reason. The claim is invalidated so
   * a second automatic attempt can never be published. Only a proven exit is
   * accepted; an ambiguous identity is refused and stays with its live writer.
   */
  holdFailedResumeForWorker(run: WorkerRunScope, input: HoldResumedAttemptInput): HoldResumedAttemptView {
    const owner = this.workerOwner(run);
    this.ownedWait(owner, input.waitId, input.generation);
    const result = this.requireStore().holdFailedResume({
      waitId: input.waitId,
      generation: input.generation,
      claimId: input.claimId,
      claimToken: input.claimToken,
      attemptId: input.attemptId,
      launchToken: input.launchToken,
      proof: { writerPidGone: input.proof?.writerPidGone === true, writerLeaseReleased: input.proof?.writerLeaseReleased === true },
      reason: input.reason,
    });
    return {
      waitId: input.waitId,
      generation: input.generation,
      phase: result.wait.phase,
      applied: result.applied,
      claim: {
        claimId: result.claim.claimId,
        state: result.claim.state,
        attemptId: result.claim.attemptId,
        ...(result.claim.reason ? { reason: result.claim.reason } : {}),
      },
    };
  }

  registerContinuationAdapter(adapter: ContinuationAdapter): void {
    if (!adapter || adapter.version !== 1 || typeof adapter.onWaitReady !== "function" || !adapter.id) {
      throw new Error("A version-1 continuation adapter is required.");
    }
    this.continuation = adapter;
    this.continuationError = undefined;
    this.announce();
    void this.dispatchOutbox();
  }

  unregisterContinuationAdapter(id: string): void {
    if (this.continuation?.id === id) this.continuation = undefined;
    this.announce();
  }

  // ---- Subagents request/reply compatibility surface -------------------

  /** Answer the versioned request/reply channel the Subagents coordinator uses. */
  listenForWorkerRequests(): void {
    const events = eventBusOf(this.pi);
    if (!events) return;
    events.on(OBSERVED_WAITS_RPC_CHANNEL, (data) => {
      void this.handleWorkerRequest(data);
    });
  }

  private async handleWorkerRequest(data: unknown): Promise<void> {
    if (!data || typeof data !== "object") return;
    const request = data as Partial<ObservedWaitsRpcRequest>;
    if (request.version !== OBSERVED_WAITS_RPC_VERSION || typeof request.method !== "string" ||
        typeof request.reply !== "function") return;
    const reply = request.reply;
    let answered = false;
    const answer = (value: ObservedWaitsRpcReply): void => {
      if (answered) return;
      answered = true;
      try { reply(value); } catch { /* the requester timed out */ }
    };
    const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? request.params as JsonRecord
      : {};
    if (!this.available && !this.closed) {
      // A capability probe may arrive before the session_start handler that
      // normally opens the store. Worker operations are parent-owned, so the
      // store can open now; the next parent context supplies its origin.
      this.start();
    }
    if (!this.available) {
      answer({ ok: false, code: "unavailable", reason: this.unavailableReason ?? "Observed waits are unavailable." });
      return;
    }
    try {
      answer({ ok: true, value: await this.dispatchWorkerRequest(request.method, params) });
    } catch (error) {
      answer({
        ok: false,
        code: rpcCode(error),
        reason: oneLine(error instanceof Error ? error.message : String(error), 500),
      });
    }
  }

  private async dispatchWorkerRequest(method: string, params: JsonRecord): Promise<JsonRecord> {
    switch (method) {
      case "status":
        return { version: OBSERVED_WAITS_RPC_VERSION, workerOperations: true, runs: this.rpcRuns.size };
      case "register-run":
        return this.rpcRegisterRun(params);
      case "release-run":
        return this.rpcReleaseRun(params);
      case "execute-tool":
        return this.rpcExecuteTool(params);
      case "wait-admission":
        return this.rpcWaitAdmission(params);
      case "checkpoint":
        return this.rpcCheckpoint(params);
      case "park-failed":
        return this.rpcParkFailed(params);
      case "acknowledge":
        return this.rpcAcknowledge(params);
      case "wait-snapshot":
        return this.rpcWaitSnapshot(params);
      case "claim-resume":
        return this.rpcClaimResume(params);
      case "publish-resume":
        return this.rpcPublishResume(params);
      case "release-resume":
        return this.rpcReleaseResume(params);
      case "hold-resume":
        return this.rpcHoldResume(params);
      case "cancel-wait":
        return this.rpcCancelWait(params);
      default:
        throw new Error(`Unsupported observed-waits method ${JSON.stringify(method)}.`);
    }
  }

  private rpcRegisterRun(params: JsonRecord): JsonRecord {
    if (params.assignmentOutcomesVersion !== undefined && params.assignmentOutcomesVersion !== 1) throw new Error("Unsupported assignment outcome capability; this host supports version 1.");
    const runId = requireRpcString(params, "runId");
    const conversationId = requireRpcString(params, "conversationId");
    const workspace = requireRpcString(params, "workspace");
    const authorityReference = requireRpcString(params, "authorityReference");
    const policy = normalizeRunPolicy(params.policy);
    if (policy.workspace !== workspace) throw new Error("register-run policy.workspace does not match the registered workspace.");
    const attemptId = typeof params.attemptId === "string" && params.attemptId ? params.attemptId : runId;
    const owner = normalizeRpcOwner(params.owner, {
      kind: "worker-conversation",
      sessionId: conversationId,
      workspace,
      branchId: null,
      goalId: null,
    });
    if (owner.sessionId !== conversationId || owner.workspace !== workspace) {
      throw new Error("register-run owner does not match the conversation and workspace.");
    }
    const tools = new Set<string>(Array.isArray(params.tools)
      ? params.tools.filter((tool): tool is string => typeof tool === "string")
      : policy.tools);
    const capabilities = params.capabilities && typeof params.capabilities === "object" && !Array.isArray(params.capabilities)
      ? params.capabilities as JsonRecord
      : {};
    this.rpcRuns.set(runId, Object.freeze({
      runId,
      conversationId,
      attemptId,
      workspace,
      authorityReference,
      policy,
      owner,
      tools,
      capabilities,
      ...(typeof params.writerPid === "number" && params.writerPid > 0 ? { writerPid: params.writerPid } : {}),
      ...(typeof params.writerLeaseId === "string" ? { writerLeaseId: params.writerLeaseId } : {}),
    }));
    return { runId, conversationId, workspace, attemptId, workerOperations: true, assignmentOutcomesVersion: 1 };
  }

  private rpcReleaseRun(params: JsonRecord): JsonRecord {
    const runId = requireRpcString(params, "runId");
    this.rpcRuns.delete(runId);
    if (this.rpcRuns.size === 0) this.waitOwners.clear();
    return { runId, released: true };
  }

  private async rpcExecuteTool(params: JsonRecord): Promise<JsonRecord> {
    const binding = this.requireRpcRun(params);
    const tool = requireRpcString(params, "tool");
    const toolParams = params.params && typeof params.params === "object" && !Array.isArray(params.params)
      ? params.params as JsonRecord
      : {};
    if (!binding.tools.has(tool)) {
      throw new Error(`Tool ${tool} is not in this run's captured tool allowlist.`);
    }
    const run = this.rpcScope(binding);
    const deadlineParams = this.withAssignmentDeadline(binding, toolParams);
    switch (tool) {
      case "bg_task_spawn":
      case "bg_task_watch": {
        const launch = await this.launchForWorker(run, {
          kind: tool === "bg_task_watch" ? "watch" : "process",
          params: deadlineParams,
          policy: binding.policy.sandbox,
        });
        return {
          id: launch.id,
          taskId: launch.id,
          operationId: launch.operationId,
          kind: launch.kind,
          status: launch.status,
          name: launch.name,
          cwd: launch.cwd,
          owner: launch.owner as unknown as JsonRecord,
          durable: true,
          started: launch.started,
          claimed: launch.claimed,
          notices: launch.notices,
          ...(launch.firstCheck ? { firstCheck: launch.firstCheck as unknown as JsonRecord } : {}),
        };
      }
      case "bg_task_status": {
        const taskId = this.requireOwnedRpcTask(binding, toolParams);
        return this.statusForWorker(run, taskId) as unknown as JsonRecord;
      }
      case "bg_task_log": {
        const taskId = this.requireOwnedRpcTask(binding, toolParams);
        return this.logForWorker(run, taskId, {
          ...(typeof toolParams.lines === "number" ? { lines: toolParams.lines } : {}),
        }) as unknown as JsonRecord;
      }
      case "bg_task_stop": {
        const taskId = this.requireOwnedRpcTask(binding, toolParams);
        return await this.stopForWorker(run, taskId) as unknown as JsonRecord;
      }
      default:
        throw new Error(`Tool ${tool} is not supported by the observed-waits execute-tool surface.`);
    }
  }

  private rpcWaitAdmission(params: JsonRecord): JsonRecord {
    const binding = this.requireRpcRun(params);
    const taskIds = Array.isArray(params.taskIds)
      ? params.taskIds.filter((taskId): taskId is string => typeof taskId === "string")
      : Array.isArray(params.task_ids)
        ? params.task_ids.filter((taskId): taskId is string => typeof taskId === "string")
        : [];
    if (taskIds.length === 0) throw new Error("wait-admission needs at least one task id.");
    for (const taskId of taskIds) this.requireOwnedRpcTask(binding, { id: taskId });
    const note = typeof params.continuationNote === "string" ? params.continuationNote
      : typeof params.continuation_note === "string" ? params.continuation_note : "";
    if (!note.trim()) throw new Error("wait-admission needs a continuation note.");
    const owner = normalizeRpcOwner(params.owner, binding.owner);
    if (owner.sessionId !== binding.conversationId || owner.workspace !== binding.workspace) {
      throw new Error("wait-admission owner does not match the registered conversation and workspace.");
    }
    const attemptId = typeof params.attemptId === "string" && params.attemptId ? params.attemptId : binding.attemptId;
    const run: WorkerRunScope = {
      runId: binding.runId,
      conversationId: binding.conversationId,
      workspace: binding.workspace,
      authorityReference: binding.authorityReference,
      branchId: owner.branchId ?? null,
      goalId: owner.goalId ?? null,
    };
    const wait = this.registerWorkerWait(run, {
      taskIds,
      continuationNote: note,
      attemptId,
      checkpointId: `park:${attemptId}`,
      ...(binding.writerLeaseId ? { writerLeaseId: binding.writerLeaseId } : {}),
    });
    this.waitOwners.set(waitKey(wait.waitId, wait.generation), this.workerOwner(run));
    return { ...wait as unknown as JsonRecord, park: true };
  }

  private rpcCheckpoint(params: JsonRecord): JsonRecord {
    const binding = this.requireRpcRun(params);
    const waitId = requireRpcString(params, "waitId");
    const generation = requireRpcCounter(params, "generation");
    const { wait, owner } = this.ownedRpcWait(binding, waitId, generation);
    if (wait.phase === "waiting" || wait.phase === "ready" || wait.phase === "resuming") {
      return { checkpointed: true, phase: wait.phase, staged: false };
    }
    if (wait.phase !== "parking") {
      throw new Error(`Wait ${waitId} generation ${generation} is ${wait.phase}; a checkpoint can only be recorded while parking.`);
    }
    const key = waitKey(waitId, generation);
    const evidence = params.evidence && typeof params.evidence === "object" && !Array.isArray(params.evidence)
      ? params.evidence as JsonRecord
      : undefined;
    const staged = this.stagedCheckpoints.get(key);
    if (!evidence && !staged) throw new Error("A park checkpoint needs the verified native checkpoint evidence.");
    if (evidence) {
      this.stagedCheckpoints.set(key, {
        evidence,
        toolCallId: typeof params.toolCallId === "string" ? params.toolCallId
          : typeof params.tool_call_id === "string" ? params.tool_call_id : "",
        checkpointRecorded: true,
      });
    }
    const proofParam = params.proof && typeof params.proof === "object" && !Array.isArray(params.proof)
      ? params.proof as JsonRecord
      : undefined;
    const writerLeaseReleased = params.writerLeaseReleased === true || proofParam?.writerLeaseReleased === true;
    const writerPidGone = params.writerPidGone === true || proofParam?.writerPidGone === true
      || (binding.writerPid !== undefined && !processExists(binding.writerPid));
    if (!writerLeaseReleased || !writerPidGone) {
      // Staged while the child is alive. The trusted writer-exit observation
      // must make a second call; the wait never looks parked before that.
      return { checkpointed: true, phase: "parking", staged: true };
    }
    const transitioned = this.requireStore().transitionWaitPhase({
      waitId,
      generation,
      from: "parking",
      to: "waiting",
      proof: { checkpointRecorded: true, writerLeaseReleased: true, writerPidGone: true },
      reason: "trusted park checkpoint and writer process exit",
    });
    this.stagedCheckpoints.delete(key);
    void this.dispatchOutbox();
    return { checkpointed: true, phase: transitioned.wait.phase, staged: false };
  }

  private rpcParkFailed(params: JsonRecord): JsonRecord {
    const binding = this.requireRpcRun(params);
    const waitId = requireRpcString(params, "waitId");
    const generation = requireRpcCounter(params, "generation");
    const reason = requireRpcString(params, "reason");
    const { wait, owner } = this.ownedRpcWait(binding, waitId, generation);
    const run: WorkerRunScope = {
      runId: binding.runId,
      conversationId: binding.conversationId,
      workspace: binding.workspace,
      authorityReference: binding.authorityReference,
      branchId: owner.branchId ?? null,
      goalId: owner.goalId ?? null,
    };
    const failed = this.failWorkerPark(run, { waitId, generation, reason });
    this.stagedCheckpoints.delete(waitKey(waitId, generation));
    return { waitId, generation, phase: failed.phase, held: failed.phase === "held" };
  }

  private rpcAcknowledge(params: JsonRecord): JsonRecord {
    const binding = this.requireRpcRun(params);
    const waitId = requireRpcString(params, "waitId" in params ? "waitId" : "wait_id");
    const generation = requireRpcCounter(params, "generation");
    const { owner } = this.ownedRpcWait(binding, waitId, generation);
    const disposition = params.disposition;
    if (disposition !== "continue" && disposition !== "blocked" && disposition !== "assignment-complete") {
      throw new Error("acknowledge disposition must be continue, blocked or assignment-complete.");
    }
    const note = typeof params.note === "string" ? params.note : "";
    const ack = this.acknowledge(owner, {
      waitId,
      generation,
      terminalRevisions: params.terminal_revisions ?? params.terminalRevisions,
      disposition,
      note,
    });
    return ack as unknown as JsonRecord;
  }

  private rpcWaitSnapshot(params: JsonRecord): JsonRecord {
    const waitId = requireRpcString(params, "waitId");
    const generation = requireRpcCounter(params, "generation");
    const wait = this.requireStore().getWait({ waitId, generation });
    if (!wait) throw new Error(`Unknown wait ${waitId} generation ${generation}.`);
    if (wait.owner.kind !== "worker-conversation") throw new Error(`Wait ${waitId} does not belong to a worker conversation.`);
    const registered = [...this.rpcRuns.values()].some((run) =>
      run.conversationId === wait.owner.sessionId && run.workspace === wait.owner.workspace);
    if (!registered) throw new Error(`Wait ${waitId} belongs to a conversation with no registered worker run.`);
    const claims = this.requireStore().listResumeClaims({ waitId, generation });
    const active = claims.find((claim) => claim.state === "claimed" || claim.state === "published");
    const view = this.waitView(wait);
    return {
      ...view as unknown as JsonRecord,
      cancelEpoch: wait.cancelEpoch,
      claim: active ? {
        claimId: active.claimId,
        state: active.state,
        attemptId: active.attemptId,
        reservedCheckpointId: active.reservedCheckpointId,
      } : null,
    };
  }

  private rpcClaimResume(params: JsonRecord): JsonRecord {
    const binding = this.requireRpcRun(params);
    const waitId = requireRpcString(params, "waitId");
    const generation = requireRpcCounter(params, "generation");
    const { owner } = this.ownedRpcWait(binding, waitId, generation);
    const lease = params.lease && typeof params.lease === "object" && !Array.isArray(params.lease)
      ? params.lease as JsonRecord
      : undefined;
    if (!lease || typeof lease.ownerId !== "string" || !lease.ownerId) throw new Error("claim-resume requires a lease ownerId.");
    const result = this.requireStore().claimResume({
      waitId,
      generation,
      expectedCancelEpoch: requireRpcCounter(params, "expectedCancelEpoch"),
      lease: {
        ownerId: lease.ownerId,
        ...(typeof lease.pid === "number" ? { pid: lease.pid } : {}),
        ...(typeof lease.processStartToken === "string" ? { processStartToken: lease.processStartToken } : {}),
      },
      reservedCheckpointId: requireRpcString(params, "reservedCheckpointId"),
    });
    void owner;
    return {
      claimId: result.claim.claimId,
      claimToken: result.claim.claimToken,
      waitId,
      generation,
      phase: result.wait.phase,
      cancelEpoch: result.wait.cancelEpoch,
    };
  }

  private rpcPublishResume(params: JsonRecord): JsonRecord {
    const binding = this.requireRpcRun(params);
    const waitId = requireRpcString(params, "waitId");
    const generation = requireRpcCounter(params, "generation");
    this.ownedRpcWait(binding, waitId, generation);
    const result = this.requireStore().publishResumeAttempt({
      waitId,
      generation,
      claimId: requireRpcString(params, "claimId"),
      claimToken: requireRpcString(params, "claimToken"),
      attemptId: requireRpcString(params, "attemptId"),
      launchToken: requireRpcString(params, "launchToken"),
    });
    return {
      claimId: result.claim.claimId,
      state: result.claim.state,
      attemptId: result.claim.attemptId,
      published: result.published,
      phase: result.wait.phase,
    };
  }

  private rpcReleaseResume(params: JsonRecord): JsonRecord {
    const binding = this.requireRpcRun(params);
    const waitId = requireRpcString(params, "waitId");
    const generation = requireRpcCounter(params, "generation");
    this.ownedRpcWait(binding, waitId, generation);
    const outcome = params.outcome;
    if (outcome !== "ready" && outcome !== "held") throw new Error("release-resume outcome must be ready or held.");
    const result = this.requireStore().releaseResumeClaim({
      waitId,
      generation,
      claimId: requireRpcString(params, "claimId"),
      claimToken: requireRpcString(params, "claimToken"),
      outcome,
      reason: requireRpcString(params, "reason"),
    });
    return { claimId: result.claim.claimId, state: result.claim.state, phase: result.wait.phase };
  }

  private rpcHoldResume(params: JsonRecord): JsonRecord {
    const binding = this.requireRpcRun(params);
    const waitId = requireRpcString(params, "waitId");
    const generation = requireRpcCounter(params, "generation");
    this.ownedRpcWait(binding, waitId, generation);
    const owner = this.workerOwner(this.rpcScope(binding));
    const proof = params.proof && typeof params.proof === "object" && !Array.isArray(params.proof)
      ? params.proof as JsonRecord
      : {};
    const result = this.holdFailedResumeForWorker(this.rpcScope(binding), {
      waitId,
      generation,
      claimId: requireRpcString(params, "claimId"),
      claimToken: requireRpcString(params, "claimToken"),
      attemptId: requireRpcString(params, "attemptId"),
      launchToken: requireRpcString(params, "launchToken"),
      proof: {
        writerPidGone: proof.writerPidGone === true,
        writerLeaseReleased: proof.writerLeaseReleased === true,
      },
      reason: requireRpcString(params, "reason"),
    });
    void owner;
    return result as unknown as JsonRecord;
  }

  private rpcCancelWait(params: JsonRecord): JsonRecord {
    const binding = this.requireRpcRun(params);
    const waitId = requireRpcString(params, "waitId");
    const generation = requireRpcCounter(params, "generation");
    const { wait } = this.ownedRpcWait(binding, waitId, generation);
    const reason = requireRpcString(params, "reason");
    const expected = typeof params.expectedCancelEpoch === "number"
      ? params.expectedCancelEpoch
      : wait.cancelEpoch;
    const result = this.requireStore().cancelWait({
      waitId,
      generation,
      expectedCancelEpoch: expected,
      owner: wait.owner,
      reason,
    });
    this.stagedCheckpoints.delete(waitKey(waitId, generation));
    try {
      void Promise.resolve(this.continuation?.onWaitCancelled?.({ waitId, generation, reason })).catch(() => {});
    } catch { /* persisted cancellation stands */ }
    return { waitId, generation, phase: result.wait.phase, cancelEpoch: result.wait.cancelEpoch };
  }

  private requireRpcRun(params: JsonRecord): RpcRunBinding {
    const runId = requireRpcString(params, "runId");
    const binding = this.rpcRuns.get(runId);
    if (!binding) throw new Error(`Run ${runId} is not registered with the Background observed-waits service.`);
    if (typeof params.conversationId === "string" && params.conversationId !== binding.conversationId) {
      throw new Error(`Run ${runId} belongs to a different conversation.`);
    }
    return binding;
  }

  private rpcScope(binding: RpcRunBinding): WorkerRunScope {
    return {
      runId: binding.runId,
      conversationId: binding.conversationId,
      workspace: binding.workspace,
      authorityReference: binding.authorityReference,
      branchId: binding.owner.branchId ?? null,
      goalId: binding.owner.goalId ?? null,
    };
  }

  private requireOwnedRpcTask(binding: RpcRunBinding, params: JsonRecord): string {
    const taskId = requireRpcString(params, "id");
    if (!LOCAL_DURABLE_ID.test(taskId)) throw new Error(`Task ${taskId} is not a durable local operation.`);
    const operation = this.operationForTask(taskId);
    if (!operation) throw new Error(`Unknown durable task ${taskId}.`);
    if (operation.owner.kind !== "worker-conversation" ||
        operation.owner.sessionId !== binding.conversationId ||
        operation.owner.workspace !== binding.workspace) {
      throw new Error(`Task ${taskId} is not owned by this worker conversation.`);
    }
    return taskId;
  }

  private ownedRpcWait(binding: RpcRunBinding, waitId: string, generation: number): { wait: WaitRecord; owner: OwnerIdentity } {
    const wait = this.requireStore().getWait({ waitId, generation });
    if (!wait) throw new Error(`Unknown wait ${waitId} generation ${generation}.`);
    if (wait.owner.kind !== "worker-conversation" ||
        wait.owner.sessionId !== binding.conversationId ||
        wait.owner.workspace !== binding.workspace) {
      throw new Error(`Wait ${waitId} is not owned by this worker conversation.`);
    }
    return { wait, owner: wait.owner };
  }

  private withAssignmentDeadline(binding: RpcRunBinding, params: JsonRecord): JsonRecord {
    const deadlineAt = binding.policy.deadlineAt;
    if (deadlineAt === null) return params;
    const remaining = (deadlineAt - (this.options.now?.() ?? Date.now())) / 1000;
    if (!(remaining > 0)) throw new Error("The assignment deadline has expired; no background task was launched.");
    const requested = typeof params.timeout_seconds === "number" ? params.timeout_seconds : undefined;
    const timeout = requested === undefined || requested === 0
      ? remaining
      : Math.min(requested, remaining);
    return { ...params, timeout_seconds: timeout };
  }

  // ---- launch preparation and admission --------------------------------

  private prepareLaunch(
    kind: DurableTaskKind,
    params: Record<string, unknown>,
    tool: string,
    owner: OwnerIdentity,
    workerPolicy: WorkerSandboxPolicy | null | undefined,
    workerWorkspace?: string,
  ): {
    plan: ForegroundSandboxPlan;
    spec: CommandSpec;
    cwd: string;
    env?: Record<string, string>;
    notices: string[];
    gated: boolean;
    provenance: TaskSandboxProvenance;
    commandTimeoutSeconds?: number;
  } {
    const cwd = workerWorkspace !== undefined
      ? this.resolveWorkerCwd(workerWorkspace, params.cwd)
      : typeof params.cwd === "string" && params.cwd.length > 0
        ? params.cwd
        : this.parentOrigin?.cwd ?? owner.workspace;
    const spec: CommandSpec = {
      ...(typeof params.command === "string" ? { command: params.command } : {}),
      ...(Array.isArray(params.argv) && params.argv.every((entry) => typeof entry === "string") ? { argv: params.argv as string[] } : {}),
      shell: params.shell !== false,
      ...(typeof params.loginShell === "boolean" ? { loginShell: params.loginShell } : {}),
      cwd,
      ...(params.env && typeof params.env === "object" && !Array.isArray(params.env)
        ? { env: params.env as Record<string, string> } : {}),
    };
    validateCommandSpec(spec);
    if (kind === "watch") {
      if (!params.success_when) throw new Error("Invalid parameters: watch requires success_when.");
      for (const [name, condition] of [["success_when", params.success_when], ["failure_when", params.failure_when]] as const) {
        const error = condition && validateCondition(condition as Condition);
        if (error) throw new Error(`${name}: ${error}`);
      }
      if (params.require_successful_steps === true) {
        throw new Error("Invalid step gate: require_successful_steps is for a spawned shell command; a watch poll reports its own exit code as the outcome. The task was not started.");
      }
    }
    const plan = workerPolicy !== undefined || owner.kind === "worker-conversation"
      ? resolveWorkerSandboxPlan(this.pi, workerPolicy, params, tool)
      : resolveForegroundSandboxPlan(this.pi, false, params, tool);
    assertBackgroundExecutionAllowed(spec, plan, { remote: false, cwd });
    const limits = backgroundExecutionLimits(plan);
    const gated = kind === "process" && params.require_successful_steps === true;
    if (gated) {
      if (spec.shell === false) {
        throw new Error("Invalid step gate: require_successful_steps needs a shell command; argv with shell:false already reports the real exit code. The task was not started.");
      }
      if (!spec.command || spec.command.trim().length === 0) {
        throw new Error("Invalid step gate: require_successful_steps needs a non-empty shell command. The task was not started.");
      }
    }
    return {
      plan,
      spec,
      cwd,
      ...(spec.env ? { env: spec.env } : {}),
      notices: [],
      gated,
      provenance: sandboxProvenance(plan, false),
      ...(limits.commandTimeoutSeconds !== undefined ? { commandTimeoutSeconds: limits.commandTimeoutSeconds } : {}),
    };
  }

  private async startSupervisor(input: {
    token: string;
    taskId: string;
    kind: DurableTaskKind;
    params: Record<string, unknown>;
    prepared: ReturnType<ObservedWaitHost["prepareLaunch"]>;
    operationId: string;
  }): Promise<{ started: boolean; claimed: boolean }> {
    const { token, taskId, kind, params, prepared, operationId } = input;
    const profilePath = join(supervisorPaths(this.directory, taskId).dir, "sandbox.sb");
    let spec = prepared.spec;
    if (prepared.gated) {
      spec = {
        ...spec,
        command: stepGateScript(taskId),
        env: { ...spec.env, [STEP_GATE_COMMAND_ENV]: prepared.spec.command! },
      };
    }
    const notices: string[] = [];
    const confined = confineCommandSpec(spec, prepared.plan, profilePath, {}, (line) => notices.push(line));
    prepared.notices.push(...notices);
    const { execPath, execArgs } = commandExecution(confined);
    const options: SupervisorStartOptions = {
      token,
      argv: [execPath, ...execArgs],
      cwd: confined.cwd ?? prepared.cwd,
      kind: kind === "watch" ? "watch" : "process",
      ...(typeof params.name === "string" ? { name: params.name } : {}),
      operationId,
      ...(prepared.commandTimeoutSeconds !== undefined ? { commandTimeoutSeconds: prepared.commandTimeoutSeconds } : {}),
      ...(confined.env ? { env: confined.env } : prepared.env ? { env: prepared.env } : {}),
      ...(typeof params.max_log_bytes === "number" ? { maxLogBytes: params.max_log_bytes } : {}),
      ...(kind === "watch" ? this.watchOptions(params) : this.processTimeout(params)),
    };
    const started = await this.supervisor.start(options);
    return { started: started.started, claimed: started.claimed };
  }

  private processTimeout(params: Record<string, unknown>): { timeoutSeconds?: number } {
    return typeof params.timeout_seconds === "number" ? { timeoutSeconds: params.timeout_seconds } : {};
  }

  private watchOptions(params: Record<string, unknown>): {
    intervalSeconds: number;
    timeoutSeconds: number;
    successWhen: Condition;
    failureWhen?: Condition;
  } {
    return {
      intervalSeconds: Math.max(0.001, typeof params.interval_seconds === "number" ? params.interval_seconds : 30),
      timeoutSeconds: typeof params.timeout_seconds === "number" ? params.timeout_seconds : 900,
      successWhen: params.success_when as Condition,
      ...(params.failure_when ? { failureWhen: params.failure_when as Condition } : {}),
    };
  }

  /**
   * Resolve a worker launch directory against the **registered worker
   * workspace**, never the parent's current directory. Omitted cwd means the
   * workspace itself; a relative path and symlinks are resolved before the
   * containment check so the policy and the executed command see one absolute
   * path.
   */
  private resolveWorkerCwd(workspace: string, requested: unknown): string {
    const base = resolve(workspace);
    let workspaceReal = base;
    try { workspaceReal = realpathSync.native(base); } catch { /* the bridge already validated existence */ }
    const raw = typeof requested === "string" && requested.trim().length > 0 ? requested : ".";
    let candidate = resolve(base, raw);
    try { candidate = realpathSync.native(candidate); } catch { /* a missing cwd fails at supervisor start */ }
    const inside = relative(workspaceReal, candidate);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error("Worker launch cwd is outside the registered workspace.");
    }
    return candidate;
  }

  // ---- reconciliation --------------------------------------------------

  private reconcileOperation(operation: OperationRecord): void {
    if (operation.terminalRevision > 0) return;
    const authority = this.supervisionAuthority(operation);
    if (authority === "foreign") return;
    let claimed = false;
    if (authority === "replace") {
      try {
        this.store?.recordSupervision({
          operationId: operation.operationId,
          owner: operation.owner,
          expectedHostId: operation.supervision?.hostId ?? null,
          supervision: this.supervision(),
          health: "active",
        });
        claimed = true;
      } catch (error) {
        // Another host can hold the write lock, or it can take over between the
        // snapshot and this write. Leave the observed record alone and let the
        // next reconciliation tick re-read it.
        if (rpcCode(error) === "store-busy" || rpcCode(error) === "supervision-conflict") return;
        throw error;
      }
    }
    const inspection = this.inspect(operation.taskId);
    if (!inspection) {
      const now = this.options.now?.() ?? Date.now();
      if (now - operation.createdAt >= 30_000) {
        // The supervisor writes its launch record before spawning. No record
        // after the claim grace means no execution can be witnessed; this is
        // `lost`, never a success and never a silent retry.
        try {
          this.requireStore().recordTerminalOutcome({
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
        } catch { /* a concurrent terminal record wins */ }
        void this.dispatchOutbox();
        return;
      }
      try {
        if (claimed || operation.health !== "unmonitored" || operation.healthReason !== "no durable supervisor record exists for this operation") {
          this.store?.recordSupervision({
            operationId: operation.operationId,
            owner: operation.owner,
            expectedHostId: this.hostId,
            health: "unmonitored",
            reason: "no durable supervisor record exists for this operation",
          });
        }
      } catch { /* the owner may have been superseded; health is observational */ }
      return;
    }
    if (inspection.terminal) {
      this.recordTerminal(operation, inspection);
      return;
    }
    if (!claimed && (operation.health !== "active" || operation.supervision?.hostId !== this.hostId)) {
      // Health is observational; write it only when the supervising host or the
      // reported health actually changed. A 250 ms tick must not churn SQLite.
      try {
        this.store?.recordSupervision({
          operationId: operation.operationId,
          owner: operation.owner,
          expectedHostId: this.hostId,
          supervision: this.supervision(),
          health: "active",
        });
      } catch (error) {
        // Another host can hold the write lock or have taken over. Leave health
        // unchanged and let the next tick re-read the operation.
        if (rpcCode(error) !== "store-busy" && rpcCode(error) !== "supervision-conflict") throw error;
      }
    }
  }

  /**
   * Whether this host may inspect the operation. The recorded `supervision`
   * identity is the cross-process authority marker: a live holder keeps it, and
   * only a closed or dead holder is replaced. Process identity is checked before
   * elapsed time, and an unprovable holder is never stolen from.
   */
  private supervisionAuthority(operation: OperationRecord): "self" | "foreign" | "replace" {
    const hostId = operation.supervision?.hostId;
    if (!hostId) return "replace";
    if (hostId === this.hostId) return "self";
    if (HOST_INSTANCE_STATE.closed.has(hostId)) return "replace";
    const cached = this.authorityPassCache?.get(hostId);
    const state = cached ?? this.supervisionHolderState(hostId);
    if (cached === undefined) this.authorityPassCache?.set(hostId, state);
    return state === "live" || state === "unknown" ? "foreign" : "replace";
  }

  /** Process-identity check for a recorded holder, cached per pass by callers. */
  private supervisionHolderState(hostId: string): "live" | "dead" | "unknown" {
    const { pid, startTokenDigest: claimedDigest } = parseHostIdentity(hostId);
    if (!pid) return "unknown";
    if (pid === process.pid) {
      const generation = HOST_INSTANCE_STATE.generations.get(hostId);
      // Another instance in this process still owns its record. Creation order
      // alone is not death: a reload predecessor is marked closed above.
      return generation === undefined ? "dead" : "live";
    }
    if (!processExists(pid)) return "dead";
    if (!claimedDigest) return "unknown";
    const current = readProcessStartToken(pid);
    if (!current) return "unknown";
    return startTokenDigest(current) === claimedDigest ? "live" : "dead";
  }

  /**
   * A graceful close releases only this host's running authority. A crash leaves
   * the same record for the next host to replace after process identity proves it
   * dead; a newer holder is never cleared by a late close.
   */
  private releaseSupervisionAuthority(): void {
    const store = this.store;
    if (!store) return;
    let running: OperationRecord[];
    try {
      running = store.listOperations({ phase: "running" });
    } catch {
      return;
    }
    for (const operation of running) {
      if (operation.supervision?.hostId !== this.hostId) continue;
      try {
        store.releaseSupervision({
          operationId: operation.operationId,
          owner: operation.owner,
          hostId: this.hostId,
          reason: "the supervising host closed; another host may take over",
        });
      } catch {
        // Closing must not fail on a busy or already replaced record.
      }
    }
  }

  /** Release only this host's exact discovery claim; a successor keeps its own. */
  private releaseDiscoveryAuthority(): void {
    const store = this.store;
    const token = this.discoveryToken;
    this.discoveryToken = undefined;
    this.discoveryRole = undefined;
    if (!store || !token) return;
    try {
      store.releaseDiscoveryClaim({ scope: this.discoveryScope, hostId: this.hostId, token });
    } catch {
      // Closing must not fail on a busy or already replaced claim.
    }
  }

  private reconcileInspection(operation: OperationRecord, inspection: SupervisorInspection | undefined): void {
    if (inspection?.terminal && operation.terminalRevision === 0) this.recordTerminal(operation, inspection);
  }

  private recordTerminal(operation: OperationRecord, inspection: SupervisorInspection): void {
    const store = this.requireStore();
    const status = inspection.status;
    const outcome = terminalOutcome(status);
    const eventId = `${operation.taskId}:${inspection.result?.endedAt ?? inspection.lost?.recordedAt ?? inspection.observedAt}:${status}`;
    const refs = evidenceFor(inspection);
    let recorded;
    try {
      recorded = store.recordTerminalOutcome({
        operationId: operation.operationId,
        eventId,
        outcome,
        owner: operation.owner,
        evidence: refs.map((ref) => ({
          kind: ref.kind,
          ref: ref.ref,
          ...(ref.summary ? { summary: ref.summary } : {}),
          detailLost: ref.detailLost,
        })),
        ...(outcome === "lost" ? { detailLost: true } : {}),
        reason: inspection.result
          ? `supervisor ${status} exit=${inspection.result.exitCode ?? "null"}`
          : "supervisor lost: no terminal evidence",
      });
    } catch (error) {
      // A timer and a tool call can observe the same terminal record. The store
      // keeps the first revision; a replay is never a second execution.
      this.options.logger?.(`observed waits: terminal replay for ${operation.taskId}: ${oneLine(String(error), 160)}`);
      return;
    }
    const recordContext = this.currentLaunchContext(operation.taskId);
    if (recordContext) {
      if (recorded.recorded) {
        recordContext.terminalRecordedBy = this.hostId;
        recordContext.terminalRecordedAt = Date.now();
        recordContext.terminalRecordedWithContext = !!this.activeContext;
        recordContext.terminalActiveSessionId = this.activeContext ? this.sessionId(this.activeContext) : undefined;
        recordContext.terminalActiveBranchIds = this.activeContext ? branchIdsOf(this.activeContext) : [];
      } else {
        recordContext.terminalReplayObservedBy = this.hostId;
      }
      this.launches.set(operation.taskId, recordContext);
      this.writeLaunchContext(operation.taskId, recordContext);
    }
    if (!recorded.recorded) {
      // A concurrent host recorded this terminal revision. This host may still be
      // the one with the live owner context; evaluate the callback against it.
      this.attemptTerminalCallback(
        recorded.operation,
        status,
        outcome,
        refs,
        { pendingWithoutContext: true },
      );
      // The local projection cache may still show this operation as running even
      // though another process committed its terminal revision. Invalidate and
      // notify so the navigator repaints on this reconcile pass.
      this.emitDurableTaskChange(recorded.operation.owner);
      return;
    }
    this.options.logger?.(`observed waits: ${operation.taskId} ${status} (revision ${recorded.operation.terminalRevision})`);
    this.attemptTerminalCallback(operation, status, outcome, refs, { pendingWithoutContext: true });
    this.emitDurableTaskChange(operation.owner);
    // The parent callback is independent from the worker's wait: a worker may be
    // parked, while the parent session still learns that the supervised task ended.
    void this.dispatchOutbox();
  }

  /**
   * A parent-owned launch with callbacks on is notified once at its terminal
   * revision. A registered wait carries the same information and is delivered by
   * the outbox, so the two paths do not double-notify. A callback is only
   * receipted after the batcher's real handoff; returning from `notifyParent`
   * leaves it pending, and a replacement host recovers it.
   */
  private attemptTerminalCallback(
    operation: OperationRecord,
    status: SupervisorTaskStatus,
    outcome: string,
    refs: readonly WaitEvidenceView[],
    options: { pendingWithoutContext?: boolean } = {},
  ): void {
    const context = this.currentLaunchContext(operation.taskId);
    const skip = (reason: string): void => {
      if (!context) return;
      if (context.callbackSkipReason === reason && context.callbackAttemptedAt !== undefined) return;
      context.callbackAttemptedAt = Date.now();
      context.callbackSkipReason = oneLine(reason, 200);
      this.launches.set(operation.taskId, context);
      this.writeLaunchContext(operation.taskId, context);
    };
    if (!this.options.notifyParent) return;
    if (operation.owner.kind !== "parent-session") return;
    if (!context) return;
    if (context.callback === false) return;
    // Never write any journal field while a newer or unprovable other host owns
    // the claim. In particular, a stale host's reconcile must not rewrite its
    // cached claim token over the current shared one.
    const claim = this.claimState(context.callbackClaimedBy);
    if (claim === "live" || claim === "unknown") return;
    if (context.callbackDeliveredAt !== undefined) {
      this.pendingTerminalCallbacks.delete(operation.taskId);
      skip("already delivered");
      return;
    }
    const waitPending = this.store?.listWaits({ owner: operation.owner, pendingOnly: true })
      .some((wait) => wait.dependencies.some((dep) => dep.operationId === operation.operationId)) ?? false;
    if (waitPending) {
      this.pendingTerminalCallbacks.delete(operation.taskId);
      skip("a registered wait owns delivery");
      return;
    }
    if (claim === "self") return; // this host's event is already in flight
    if (!this.activeContext) {
      // This host recorded terminal before a session context was restored. Keep
      // the callback pending so the next activation/tool call can hand it off;
      // never notify without an exact active owner.
      skip("no active context; pending");
      if (options.pendingWithoutContext) this.markCallbackPending(operation.taskId, context);
      return;
    }
    // A shared coordinator store can contain other sessions' operations. They are
    // never this host's callback work, even when they are terminal. An active
    // context without a readable session identity is unknown, so keep pending.
    const relation = this.activeOwnerRelation(operation.owner);
    if (relation === "unknown") {
      skip("active session identity is unavailable; pending");
      if (options.pendingWithoutContext) this.markCallbackPending(operation.taskId, context);
      return;
    }
    if (relation === "foreign") {
      // Another session owns this operation. This host may have recorded the
      // terminal revision while reconciling the shared store, but it must not
      // write callback journal state or clear the owner's pending work.
      this.pendingTerminalCallbacks.delete(operation.taskId);
      return;
    }
    // A terminal result can become eligible later: the live session may have
    // been settling when the record was produced, or the owner may navigate
    // back to an eligible descendant branch. Keep retrying only this id.
    this.pendingTerminalCallbacks.add(operation.taskId);
    const origin = context.parentOrigin ?? { cwd: operation.owner.workspace, sessionId: operation.owner.sessionId };
    const branchId = context.branchId ?? operation.owner.branchId;
    if (!this.isParentOriginActive(origin, branchId)) {
      skip("recorded branch anchor is not on the active branch; pending");
      this.markCallbackPending(operation.taskId, context);
      return;
    }
    context.callbackAttemptedAt = Date.now();
    context.callbackSkipReason = undefined;
    context.callbackPendingAt ??= Date.now();
    context.callbackClaimedBy = this.hostId;
    context.callbackClaimedAt = Date.now();
    context.callbackClaimToken = randomUUID();
    context.callbackDeferredReason = undefined;
    this.launches.set(operation.taskId, context);
    this.writeLaunchContext(operation.taskId, context);
    const claimToken = context.callbackClaimToken;
    let settled = false;
    const delivery: ParentDelivery = {
      delivered: () => {
        if (settled) return;
        settled = true;
        this.completeTerminalCallback(operation.taskId, claimToken);
      },
      defer: (reason: string) => {
        if (settled) return;
        settled = true;
        this.deferTerminalCallback(operation.taskId, reason, true, claimToken);
      },
    };
    try {
      this.options.notifyParent({
        taskId: operation.taskId,
        origin,
        branchId,
        operationId: operation.operationId,
        status,
        outcome,
        summary: refs[0]?.summary ?? `terminal revision ${operation.terminalRevision}`,
        evidence: refs.map((ref) => ({
          ...ref,
          operationId: operation.operationId,
          taskId: operation.taskId,
          terminalRevision: operation.terminalRevision,
        })),
      }, delivery);
    } catch (error) {
      // A notifier that threw synchronously must not spin the microtask retry.
      this.deferTerminalCallback(operation.taskId, error instanceof Error ? error.message : String(error), false, claimToken);
    }
  }

  /**
   * Exact owner relation for the live context. An active context without a
   * readable session identity is `unknown`, never `foreign`: a terminal result
   * stays pending until the real session identity is restored.
   */
  private activeOwnerRelation(owner: OwnerIdentity): "match" | "foreign" | "unknown" {
    const ctx = this.activeContext;
    if (!ctx) return "unknown";
    let cwd: string;
    try { cwd = ctx.cwd; } catch { return "unknown"; }
    if (cwd !== owner.workspace) return "foreign";
    const known = this.sessionIdIfAvailable(ctx);
    if (known) return owner.sessionId === known ? "match" : "foreign";
    const fallback = this.sessionId(ctx);
    if (owner.sessionId === fallback) return "match";
    // A real owner and an anonymous active context cannot prove each other.
    return owner.sessionId.startsWith("anonymous:") ? "foreign" : "unknown";
  }

  private markCallbackPending(taskId: string, context = this.currentLaunchContext(taskId)): void {
    if (!context || context.callbackDeliveredAt !== undefined) return;
    const claim = this.claimState(context.callbackClaimedBy);
    if (claim === "live" || claim === "unknown") {
      this.pendingTerminalCallbacks.add(taskId);
      return; // preserve the current owner's claim without any write
    }
    context.callbackPendingAt ??= Date.now();
    this.launches.set(taskId, context);
    this.writeLaunchContext(taskId, context);
    this.pendingTerminalCallbacks.add(taskId);
  }

  private completeTerminalCallback(taskId: string, claimToken?: string): void {
    // The sidecar is shared across hosts and is authoritative for the claim.
    // Never validate a stale delivery against this host's cached launch object.
    const context = this.currentLaunchContext(taskId);
    if (!context) return;
    // A stale handoff from an older attempt must not receipt a newer attempt.
    if (claimToken !== undefined && context.callbackClaimToken !== claimToken) return;
    this.pendingTerminalCallbacks.delete(taskId);
    context.callbackDeliveredAt ??= Date.now();
    context.callbackAttemptedAt = Date.now();
    delete context.callbackSkipReason;
    delete context.callbackPendingAt;
    delete context.callbackClaimedBy;
    delete context.callbackClaimedAt;
    delete context.callbackClaimToken;
    delete context.callbackDeferredReason;
    this.launches.set(taskId, context);
    this.writeLaunchContext(taskId, context);
    const operation = this.operationForTask(taskId);
    if (operation) this.emitDurableTaskChange(operation.owner);
  }

  private deferTerminalCallback(taskId: string, reason: string, retry = true, claimToken?: string): void {
    const context = this.currentLaunchContext(taskId);
    if (!context || context.callbackDeliveredAt !== undefined) return;
    // A stale suppression must not clear the claim of a newer attempt.
    if (claimToken !== undefined && context.callbackClaimToken !== claimToken) return;
    this.pendingTerminalCallbacks.add(taskId);
    context.callbackDeferredReason = oneLine(reason, 200);
    context.callbackAttemptedAt = Date.now();
    context.callbackSkipReason = `deferred: ${oneLine(reason, 160)}`;
    delete context.callbackClaimedBy;
    delete context.callbackClaimedAt;
    delete context.callbackClaimToken;
    this.launches.set(taskId, context);
    this.writeLaunchContext(taskId, context);
    if (retry) {
      // A batcher suppression can land after a session_tree retry already saw
      // the old claim. Re-evaluate the live branch after the claim is cleared.
      queueMicrotask(() => {
        if (!this.closed) this.retryPendingTerminalCallbacks();
      });
    }
  }

  private outboxHandoffProof(
    taskId: string,
    event: OutboxEventRecord,
  ): boolean {
    const proof = this.currentLaunchContext(taskId)?.outboxDelivered?.[event.eventId];
    return !!proof && proof.waitId === event.waitId && proof.generation === event.generation
      && proof.terminalRevision === event.terminalRevision;
  }

  private recordOutboxHandoffProof(taskId: string, event: OutboxEventRecord): void {
    const context = this.currentLaunchContext(taskId);
    if (!context) return;
    const map = { ...(context.outboxDelivered ?? {}) };
    const at = this.options.now?.() ?? Date.now();
    map[event.eventId] = {
      waitId: event.waitId,
      generation: event.generation,
      terminalRevision: event.terminalRevision,
      deliveredAt: at,
    };
    const kept = Object.entries(map)
      .sort((a, b) => b[1].deliveredAt - a[1].deliveredAt)
      .slice(0, 20);
    context.outboxDelivered = Object.fromEntries(kept);
    this.launches.set(taskId, context);
    this.writeLaunchContext(taskId, context);
  }

  private clearOutboxHandoffProof(taskId: string, eventId: string): void {
    const context = this.currentLaunchContext(taskId);
    if (!context?.outboxDelivered || !(eventId in context.outboxDelivered)) return;
    const map = { ...context.outboxDelivered };
    delete map[eventId];
    context.outboxDelivered = map;
    this.launches.set(taskId, context);
    this.writeLaunchContext(taskId, context);
  }

  /**
   * Identity of a claiming host. Liveness uses the process start token, not
   * elapsed time. `unknown` is held: an unprovable owner is never stolen from.
   */
  private claimState(hostId: string | undefined): "none" | "self" | "live" | "dead" | "unknown" {
    if (!hostId) return "none";
    if (hostId === this.hostId) return "self";
    const { pid, startTokenDigest: claimedDigest } = parseHostIdentity(hostId);
    if (!pid) return "unknown";
    if (HOST_INSTANCE_STATE.closed.has(hostId)) return "dead";
    const generation = HOST_INSTANCE_STATE.generations.get(hostId);
    if (generation !== undefined) {
      if (pid === process.pid) {
        // A newer live instance owns the claim; an older one is a reload
        // predecessor whose claim this host may recover.
        return generation > this.hostGeneration ? "live" : "dead";
      }
    }
    // A different instance with this process's pid is a previous instance in the
    // same process (a reload) or a host this process cannot prove is current.
    if (pid === process.pid) return "dead";
    if (!processExists(pid)) return "dead";
    if (!claimedDigest) return "unknown";
    const current = readProcessStartToken(pid);
    if (!current) return "unknown";
    return startTokenDigest(current) === claimedDigest ? "live" : "dead";
  }

  /**
   * Recover deliveries whose claiming host disappeared (reload, crash, or a
   * session switch). A claim owned by a live or unprovable host is left alone.
   */
  private recoverAbandonedDeliveries(): void {
    const store = this.store;
    if (!store) return;
    for (const event of store.listOutbox({ state: "claimed" })) {
      const claim = event.dispatchClaim;
      if (!claim || claim.claimedBy === this.hostId) continue;
      if (this.claimState(claim.claimedBy) !== "dead") continue;
      try {
        store.releaseOutbox({
          eventId: event.eventId,
          claimToken: claim.token,
          reason: "abandoned callback delivery claim recovered",
        });
      } catch { /* another host already recovered it */ }
    }
    for (const operation of this.activeParentTerminalOperations()) {
      const context = this.currentLaunchContext(operation.taskId);
      if (!context?.callbackClaimedBy || context.callbackClaimedBy === this.hostId) continue;
      if (this.claimState(context.callbackClaimedBy) !== "dead") continue;
      delete context.callbackClaimedBy;
      delete context.callbackClaimedAt;
      delete context.callbackClaimToken;
      this.launches.set(operation.taskId, context);
      this.writeLaunchContext(operation.taskId, context);
    }
  }

  private inspect(taskId: string): SupervisorInspection | undefined {
    if (!LOCAL_DURABLE_ID.test(taskId)) return undefined;
    try {
      return this.supervisor.inspect(taskId, { recordLost: true });
    } catch {
      return undefined;
    }
  }

  private async dispatchOutbox(): Promise<void> {
    const store = this.store;
    if (!store || this.closed) return;
    const pending = store.listOutbox({ state: "pending" });
    if (pending.length === 0) return;
    const byRecipient = new Map<string, { owner: OwnerIdentity; events: OutboxEventRecord[] }>();
    for (const event of pending) {
      const key = ownerKey(event.recipient);
      const entry = byRecipient.get(key) ?? { owner: event.recipient, events: [] };
      entry.events.push(event);
      byRecipient.set(key, entry);
    }
    for (const { owner, events } of byRecipient.values()) {
      // Foreign parents cannot receive a handoff here. Leave their events pending
      // without taking a write lock on every reconciliation pass.
      if (owner.kind === "parent-session") {
        const origin = { cwd: owner.workspace, sessionId: owner.sessionId };
        if (!this.options.notifyParent || !this.isParentOriginActive(origin, owner.branchId)) continue;
      }
      if (owner.kind === "worker-conversation" && !this.continuation && this.rpcRuns.size === 0) continue;
      const claimToken = `dispatch_${randomUUID()}`;
      let claimed: OutboxEventRecord[];
      try {
        claimed = store.claimOutbox({
          type: "dependency-ready",
          recipient: owner,
          claimToken,
          claimedBy: this.hostId,
          limit: Math.min(events.length, 20),
        });
      } catch (error) {
        this.options.logger?.(`observed waits: outbox claim failed: ${oneLine(String(error), 160)}`);
        continue;
      }
      for (const event of claimed) {
        const operation = store.getOperation(event.operationId);
        const taskId = operation?.taskId;
        const evidence = mapEvidence(
          event.operationId,
          taskId,
          event.evidence.map((pin) => ({
            operationId: pin.operationId,
            ...(taskId ? { taskId } : {}),
            terminalRevision: pin.terminalRevision,
            kind: pin.kind,
            ref: pin.ref,
            ...(pin.summary ? { summary: pin.summary } : {}),
            detailLost: pin.detailLost,
          })),
          event.terminalRevision,
        );
        try {
          if (owner.kind === "worker-conversation" && this.continuation) {
            const adapter = this.continuation;
            const wait = store.getWait({ waitId: event.waitId, generation: event.generation });
            const outcome = await adapter.onWaitReady({
              waitId: event.waitId,
              generation: event.generation,
              owner,
              ...(taskId && this.launches.get(taskId)?.parentOrigin
                ? { parentOrigin: this.launches.get(taskId)!.parentOrigin }
                : {}),
              taskIds: wait ? this.waitTaskIds(wait) : [],
              continuationNote: wait?.continuationNote ?? "",
              evidence,
            });
            if (outcome === "deferred") {
              store.releaseOutbox({ eventId: event.eventId, claimToken, reason: "continuation owner is inactive; delivery deferred" });
              continue;
            }
          } else if (owner.kind === "worker-conversation") {
            const wait = store.getWait({ waitId: event.waitId, generation: event.generation });
            eventBusOf(this.pi)?.emit(OBSERVED_WAITS_READY_CHANNEL, {
              version: OBSERVED_WAITS_RPC_VERSION,
              waitId: event.waitId,
              generation: event.generation,
              owner,
              taskIds: wait ? this.waitTaskIds(wait) : [],
              continuationNote: wait?.continuationNote ?? "",
            });
          } else {
            if (!this.options.notifyParent) {
              store.releaseOutbox({ eventId: event.eventId, claimToken, reason: "no parent notification channel is available" });
              continue;
            }
            const context = taskId ? this.launchContext(taskId) : undefined;
            // A handoff that landed just as the store closed is recorded against
            // this exact event, wait generation and terminal revision. A task-wide
            // standalone callback receipt is never proof for a later wait.
            if (taskId && this.outboxHandoffProof(taskId, event)) {
              try { store.markOutboxDelivered({ eventId: event.eventId, claimToken }); } catch { /* already receipted */ }
              this.clearOutboxHandoffProof(taskId, event.eventId);
              continue;
            }
            const origin = context?.parentOrigin ?? { cwd: owner.workspace, sessionId: owner.sessionId };
            const branchId = context?.branchId ?? owner.branchId ?? null;
            if (!this.isParentOriginActive(origin, branchId)) {
              // Keep the durable delivery pending: the owning session may activate
              // (or regain the eligible branch) later. Never route it to whoever is
              // currently in front of the UI.
              store.releaseOutbox({
                eventId: event.eventId,
                claimToken,
                reason: "owning session or branch is not active",
              });
              continue;
            }
            let settled = false;
            const delivery: ParentDelivery = {
              delivered: () => {
                if (settled) return;
                settled = true;
                let receipted = false;
                try {
                  store.markOutboxDelivered({ eventId: event.eventId, claimToken });
                  receipted = true;
                } catch { /* the store closed between handoff and receipt */ }
                // Key the recovered receipt to this exact event. Never use the
                // standalone task callback's receipt as proof for a wait.
                if (!receipted && taskId) this.recordOutboxHandoffProof(taskId, event);
              },
              defer: (reason: string) => {
                if (settled) return;
                settled = true;
                try {
                  store.releaseOutbox({
                    eventId: event.eventId,
                    claimToken,
                    reason: oneLine(reason, 200) || "callback delivery deferred",
                  });
                } catch { /* another host recovered it */ }
                if (taskId) this.markCallbackPending(taskId);
              },
            };
            try {
              this.options.notifyParent({
                taskId: taskId ?? event.operationId,
                origin,
                branchId,
                operationId: event.operationId,
                waitId: event.waitId,
                generation: event.generation,
                status: this.statusOf(event.operationId),
                outcome: operation?.terminalOutcome ?? "failed",
                summary: evidence[0]?.summary ?? "terminal evidence is available",
                evidence,
              }, delivery);
            } catch (error) {
              delivery.defer(error instanceof Error ? error.message : String(error));
            }
            // The callback remains claimed until the batcher's actual handoff
            // calls `delivered()`; a reload recovers the abandoned claim.
            continue;
          }
          store.markOutboxDelivered({ eventId: event.eventId, claimToken });
        } catch (error) {
          if (this.closed) return;
          try {
            store.releaseOutbox({
              eventId: event.eventId,
              claimToken,
              reason: oneLine(error instanceof Error ? error.message : String(error), 200) || "delivery failed",
            });
          } catch { /* the store closed while the delivery was in flight */ }
        }
      }
    }
  }

  private statusOf(operationId: string): SupervisorTaskStatus {
    const operation = this.store?.getOperation(operationId);
    if (!operation) return "lost";
    if (operation.terminalRevision === 0) return "running";
    switch (operation.terminalOutcome) {
      case "succeeded": return "succeeded";
      case "cancelled": return "cancelled";
      case "lost": return "lost";
      default: return "failed";
    }
  }

  // ---- wait helpers ----------------------------------------------------

  private waitView(wait: WaitRecord): WaitView {
    const store = this.requireStore();
    const dependencies = wait.dependencies.map((dep): WaitDependencyView => {
      const operation = store.getOperation(dep.operationId);
      return {
        ...(operation?.taskId ? { taskId: operation.taskId } : {}),
        operationId: dep.operationId,
        terminalRevision: dep.terminalRevision,
        terminalOutcome: dep.terminalOutcome,
      };
    });
    const evidence: WaitEvidenceView[] = [];
    for (const dep of wait.dependencies) {
      if (dep.terminalRevision <= 0) continue;
      const operation = store.getOperation(dep.operationId);
      evidence.push(...mapEvidence(
        dep.operationId,
        operation?.taskId,
        store.listOperationEvidence(dep.operationId, dep.terminalRevision),
        dep.terminalRevision,
      ));
    }
    return {
      waitId: wait.waitId,
      generation: wait.generation,
      phase: wait.phase,
      settled: wait.settled,
      park: wait.park !== null,
      cancelEpoch: wait.cancelEpoch,
      publishedClaimId: store.listResumeClaims({ waitId: wait.waitId, generation: wait.generation, state: "published" })[0]?.claimId ?? null,
      ownerKind: wait.owner.kind,
      continuationNote: wait.continuationNote,
      taskIds: dependencies
        .map((dep) => dep.taskId)
        .filter((taskId): taskId is string => typeof taskId === "string"),
      dependencies,
      evidence,
    };
  }

  private waitTaskIds(wait: WaitRecord): string[] {
    return wait.dependencies
      .map((dep) => this.store?.getOperation(dep.operationId)?.taskId)
      .filter((taskId): taskId is string => typeof taskId === "string");
  }

  private readEvidenceForOwner(owner: OwnerIdentity, waitId: string, generation: number, taskId?: string): WaitEvidenceView[] {
    const store = this.requireStore();
    const wait = this.ownedWait(owner, waitId, generation);
    const reads: WaitEvidenceView[] = [];
    for (const dep of wait.dependencies) {
      if (dep.terminalRevision <= 0) continue;
      const operation = store.getOperation(dep.operationId);
      if (!operation) continue;
      if (taskId && operation.taskId !== taskId) continue;
      store.recordEvidenceRead({
        waitId,
        generation,
        owner,
        operationId: dep.operationId,
        terminalRevision: dep.terminalRevision,
      });
      reads.push(...mapEvidence(
        dep.operationId,
        operation.taskId,
        store.listOperationEvidence(dep.operationId, dep.terminalRevision),
        dep.terminalRevision,
      ));
    }
    return reads;
  }

  /** A status/log read is the evidence read the acknowledgement requires. */
  private recordReadsForTask(owner: OwnerIdentity, operation: OperationRecord): void {
    const store = this.store;
    if (!store || operation.terminalRevision <= 0) return;
    for (const wait of store.listWaits({ owner, pendingOnly: true })) {
      const dep = wait.dependencies.find((entry) => entry.operationId === operation.operationId);
      if (!dep || dep.terminalRevision <= 0) continue;
      try {
        store.recordEvidenceRead({
          waitId: wait.waitId,
          generation: wait.generation,
          owner,
          operationId: operation.operationId,
          terminalRevision: dep.terminalRevision,
        });
      } catch { /* a consumed or foreign generation is not this read's business */ }
    }
  }

  private cancelWait(owner: OwnerIdentity, waitId: string, generation: number, reason: string): WaitView {
    const store = this.requireStore();
    const wait = this.ownedWait(owner, waitId, generation);
    const cancelled = store.cancelWait({
      waitId,
      generation,
      expectedCancelEpoch: wait.cancelEpoch,
      owner,
      reason,
    });
    try {
      void Promise.resolve(this.continuation?.onWaitCancelled?.({ waitId, generation, reason })).catch(() => {});
    } catch { /* a continuation adapter failure cannot undo a persisted cancellation */ }
    return this.waitView(cancelled.wait);
  }

  private acknowledge(owner: OwnerIdentity, input: WorkerAcknowledgeInput): AcknowledgeView {
    const store = this.requireStore();
    const wait = this.ownedWait(owner, input.waitId, input.generation);
    const revisions = this.normalizeRevisions(wait, input.terminalRevisions);
    const result = store.acknowledgeResult({
      waitId: wait.waitId,
      generation: wait.generation,
      owner,
      disposition: input.disposition,
      note: input.note,
      terminalRevisions: revisions,
    });
    return {
      waitId: result.wait.waitId,
      generation: result.wait.generation,
      disposition: input.disposition,
      acknowledgedOutboxIds: result.acknowledgedOutboxIds,
      releasedPinIds: result.releasedPinIds,
      phase: result.wait.phase,
    };
  }

  private normalizeRevisions(wait: WaitRecord, input: unknown): Array<{ operationId: string; revision: number }> {
    const store = this.requireStore();
    const resolved: Array<{ operationId: string; revision: number }> = [];
    const add = (operationId: unknown, taskId: unknown, revision: unknown) => {
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
        throw new Error("terminal_revisions must carry positive integer revisions.");
      }
      let operationIdValue = typeof operationId === "string" ? operationId : undefined;
      if (!operationIdValue && typeof taskId === "string") {
        operationIdValue = this.operationForTask(taskId)?.operationId;
      }
      if (!operationIdValue) throw new Error("terminal_revisions must name an operation_id (or a known task_id).");
      const dependency = wait.dependencies.find((dep) => dep.operationId === operationIdValue);
      if (!dependency) throw new Error(`Operation ${operationIdValue} is not a dependency of wait ${wait.waitId}.`);
      if (dependency.terminalRevision !== revision) {
        throw new Error(`Operation ${operationIdValue} is at terminal revision ${dependency.terminalRevision}, not ${revision}.`);
      }
      resolved.push({ operationId: operationIdValue, revision });
    };
    if (Array.isArray(input)) {
      for (const entry of input) {
        if (!entry || typeof entry !== "object") throw new Error("terminal_revisions entries must be objects.");
        const record = entry as Record<string, unknown>;
        add(record.operation_id ?? record.operationId, record.task_id ?? record.taskId, record.revision);
      }
    } else if (input && typeof input === "object") {
      for (const [key, revision] of Object.entries(input)) {
        const operation = store.getOperation(key) ? key : this.operationForTask(key)?.operationId;
        add(operation, key, revision);
      }
    } else {
      throw new Error("terminal_revisions is required.");
    }
    const unique = new Map(resolved.map((entry) => [entry.operationId, entry.revision]));
    if (unique.size === 0) throw new Error("terminal_revisions is empty.");
    return [...unique].map(([operationId, revision]) => ({ operationId, revision }));
  }

  // ---- identity and ownership -----------------------------------------

  private sessionId(ctx: ExtensionContext): string {
    try {
      const id = ctx.sessionManager?.getSessionId();
      if (typeof id === "string" && id.length > 0) return id;
    } catch { /* unavailable */ }
    return this.fallbackSessionId();
  }

  private fallbackSessionId(): string {
    // A synthetic id keeps one host's launches owned by that host; it is stable
    // only for this process, which matches the missing-session contract.
    return `anonymous:${this.hostId}`;
  }

  private ownerFor(ctx: ExtensionContext): OwnerIdentity {
    const sessionId = this.sessionId(ctx);
    const workspace = ctx.cwd;
    const key = `${sessionId}\u0000${workspace}`;
    let branchId = this.branchAnchors.get(key);
    if (branchId === undefined) {
      branchId = this.latestBranchId(ctx);
      // Reuse a pending wait's anchor after a reload so the store owner matches
      // the anchor recorded in the previous process.
      const existing = this.store?.listWaits({ pendingOnly: true })
        .find((wait) => wait.owner.kind === "parent-session"
          && wait.owner.sessionId === sessionId && wait.owner.workspace === workspace);
      if (existing) branchId = existing.owner.branchId ?? null;
      this.branchAnchors.set(key, branchId);
    }
    return {
      kind: "parent-session",
      sessionId,
      workspace,
      branchId,
      goalId: null,
    };
  }

  private latestBranchId(ctx: ExtensionContext): string | null {
    try {
      const branch = ctx.sessionManager?.getBranch?.() as readonly { id?: unknown }[] | undefined;
      if (!branch || branch.length === 0) return null;
      const id = branch[branch.length - 1]?.id;
      return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }

  private workerOwner(run: WorkerRunScope): OwnerIdentity {
    return {
      kind: "worker-conversation",
      sessionId: run.conversationId,
      workspace: run.workspace,
      branchId: run.branchId ?? null,
      goalId: run.goalId ?? null,
    };
  }

  /**
   * Refresh the active session/branch snapshot. Called at start, at launch and
   * on every session_tree/branch navigation. Branch changes must be visible to
   * a queued callback *before* the batcher decides whether to deliver it.
   */
  noteParentContext(ctx: ExtensionContext): void {
    this.setActiveOrigin(ctx);
    if (!this.store) return;
    this.recoverAbandonedDeliveries();
    if (this.terminalRecoveryNeeded) {
      this.terminalRecoveryNeeded = false;
      this.recoverTerminalNotifications();
    }
    void this.dispatchOutbox();
    this.retryPendingTerminalCallbacks();
    this.writeHostDebug();
  }

  private setActiveOrigin(ctx: ExtensionContext): void {
    const previous = this.activeContext;
    const previousKey = previous ? this.contextKey(previous) : undefined;
    const nextSessionId = this.sessionIdIfAvailable(ctx);
    const previousSessionId = previous ? this.sessionIdIfAvailable(previous) : undefined;
    // A partial tool/event context (no readable session identity) must not
    // replace a context that still proves the real session.
    if (!nextSessionId && previousSessionId) return;
    const origin = { cwd: ctx.cwd, sessionId: nextSessionId ?? this.sessionId(ctx) };
    const nextKey = this.contextKey(ctx);
    this.parentOrigin = origin;
    this.activeOrigin = origin;
    this.activeContext = ctx;
    // A tool call or activation for a different session/workspace must seed the
    // terminal callback journal once. Same-session calls keep the live context
    // current without rescanning historical terminal records.
    if (!previous || previousKey !== nextKey) {
      this.terminalRecoveryNeeded = true;
      this.lastChangeRevision = -1;
    }
    this.writeHostDebug();
  }

  private contextKey(ctx: ExtensionContext): string | undefined {
    try { return `${this.sessionId(ctx)}\u0000${ctx.cwd}`; } catch { return undefined; }
  }

  /**
   * Exact session/workspace match plus an eligible branch anchor. A descendant
   * branch contains the recorded anchor; an abandoned fork does not.
   */
  isParentOriginActive(origin: BackgroundTaskCallbackOrigin | undefined, branchId?: string | null): boolean {
    const ctx = this.activeContext;
    if (!ctx || !origin) return false;
    let cwd: string;
    try { cwd = ctx.cwd; } catch { return false; }
    if (cwd !== origin.cwd) return false;
    const sessionId = this.sessionId(ctx);
    if (origin.sessionId || sessionId) {
      if (origin.sessionId !== sessionId) return false;
    }
    if (!branchId) return true;
    // Read the branch live: the SDK may settle reload history after session_start.
    return branchIdsOf(ctx).includes(branchId);
  }

  get parentSessionOrigin(): BackgroundTaskCallbackOrigin | undefined {
    return this.parentOrigin;
  }

  private requireStarted(ctx?: ExtensionContext): void {
    if (!ctx) return;
    this.noteParentContext(ctx);
  }

  /** Bounded host-level diagnostics for root reload investigations. */
  private writeHostDebug(): void {
    if (process.env.PI_BG_OBSERVED_WAITS_DEBUG !== "1") return;
    try {
      const dir = join(this.directory, "observed");
      mkdirSync(dir, { recursive: true });
      const ctx = this.activeContext;
      writeFileSync(join(dir, "host.json"), JSON.stringify({
        hostId: this.hostId,
        storeOpen: !!this.store,
        closed: this.closed,
        activeContext: !!ctx,
        activeSessionId: ctx ? this.sessionIdIfAvailable(ctx) ?? this.sessionId(ctx) : undefined,
        activeCwd: ctx ? ctx.cwd : undefined,
        activeBranchIds: ctx ? branchIdsOf(ctx) : [],
        terminalRecoveryNeeded: this.terminalRecoveryNeeded,
        pendingTerminalCallbacks: [...this.pendingTerminalCallbacks],
        writtenAt: Date.now(),
      }), { mode: 0o600 });
    } catch { /* diagnostics only */ }
  }

  private sessionIdIfAvailable(ctx: ExtensionContext): string | undefined {
    try {
      const id = ctx.sessionManager?.getSessionId();
      return typeof id === "string" && id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  private sidecarPath(taskId: string): string {
    return join(this.directory, "observed", `${taskId}.json`);
  }

  private writeLaunchContext(taskId: string, context: LaunchContext): void {
    try {
      const path = this.sidecarPath(taskId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(context), { mode: 0o600 });
    } catch { /* notification metadata is best-effort; durable state is in SQLite */ }
  }

  private readLaunchContext(taskId: string): LaunchContext | undefined {
    try {
      const value = JSON.parse(readFileSync(this.sidecarPath(taskId), "utf8")) as Partial<LaunchContext>;
      if (value.kind !== "process" && value.kind !== "watch") return undefined;
      return {
        kind: value.kind,
        ...(value.parentOrigin && typeof value.parentOrigin === "object"
          ? { parentOrigin: value.parentOrigin as BackgroundTaskCallbackOrigin } : {}),
        gated: value.gated === true,
        callback: value.callback !== false,
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.command === "string" ? { command: value.command } : {}),
        ...(Array.isArray(value.argv) && value.argv.every((entry) => typeof entry === "string")
          ? { argv: value.argv as string[] } : {}),
        ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
        ...(value.sandbox && typeof value.sandbox === "object" && !Array.isArray(value.sandbox)
          ? { sandbox: value.sandbox as TaskSandboxProvenance } : {}),
        ...(typeof value.branchId === "string" || value.branchId === null ? { branchId: value.branchId } : {}),
        ...(typeof value.callbackPendingAt === "number" ? { callbackPendingAt: value.callbackPendingAt } : {}),
        ...(typeof value.callbackDeliveredAt === "number" ? { callbackDeliveredAt: value.callbackDeliveredAt }
          : typeof (value as { callbackNotifiedAt?: unknown }).callbackNotifiedAt === "number"
            ? { callbackDeliveredAt: (value as { callbackNotifiedAt: number }).callbackNotifiedAt }
            : {}),
        ...(typeof value.callbackDeferredReason === "string" ? { callbackDeferredReason: value.callbackDeferredReason } : {}),
        ...(typeof value.callbackClaimedBy === "string" ? { callbackClaimedBy: value.callbackClaimedBy } : {}),
        ...(typeof value.callbackClaimedAt === "number" ? { callbackClaimedAt: value.callbackClaimedAt } : {}),
        ...(typeof value.callbackClaimToken === "string" ? { callbackClaimToken: value.callbackClaimToken } : {}),
        ...(typeof value.callbackAttemptedAt === "number" ? { callbackAttemptedAt: value.callbackAttemptedAt } : {}),
        ...(typeof value.callbackSkipReason === "string" ? { callbackSkipReason: value.callbackSkipReason } : {}),
        ...(typeof value.terminalRecordedBy === "string" ? { terminalRecordedBy: value.terminalRecordedBy } : {}),
        ...(typeof value.terminalRecordedAt === "number" ? { terminalRecordedAt: value.terminalRecordedAt } : {}),
        ...(typeof value.terminalRecordedWithContext === "boolean" ? { terminalRecordedWithContext: value.terminalRecordedWithContext } : {}),
        ...(typeof value.terminalActiveSessionId === "string" ? { terminalActiveSessionId: value.terminalActiveSessionId } : {}),
        ...(Array.isArray(value.terminalActiveBranchIds) ? { terminalActiveBranchIds: value.terminalActiveBranchIds } : {}),
        ...(typeof value.terminalReplayObservedBy === "string" ? { terminalReplayObservedBy: value.terminalReplayObservedBy } : {}),
        ...(value.outboxDelivered && typeof value.outboxDelivered === "object" && !Array.isArray(value.outboxDelivered)
          ? { outboxDelivered: value.outboxDelivered as LaunchContext["outboxDelivered"] } : {}),
        ...(typeof value.dismissedAt === "number" ? { dismissedAt: value.dismissedAt } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private launchContext(taskId: string): LaunchContext | undefined {
    return this.launches.get(taskId) ?? this.readLaunchContext(taskId);
  }

  /**
   * The shared sidecar is authoritative for callback claims. Every callback
   * mutation and diagnostic write uses this fresh copy, never a cached object
   * that another host may have already superseded.
   */
  private currentLaunchContext(taskId: string): LaunchContext | undefined {
    const persisted = this.readLaunchContext(taskId);
    if (persisted) { this.launches.set(taskId, persisted); return persisted; }
    // An unreadable journal cannot establish ownership of a delivery claim.
    this.launches.delete(taskId);
    return undefined;
  }

  private requireStore(): Store {
    if (!this.store && !this.closed) this.start();
    if (!this.store || this.closed) {
      throw new Error(this.unavailableReason ?? "Observed waits are unavailable; the durable store is not open.");
    }
    return this.store;
  }

  private operationsForTaskIds(owner: OwnerIdentity, taskIds: readonly string[]): OperationRecord[] {
    if (!Array.isArray(taskIds) || taskIds.length === 0) throw new Error("At least one task id is required.");
    const operations: OperationRecord[] = [];
    for (const taskId of taskIds) {
      if (typeof taskId !== "string" || !LOCAL_DURABLE_ID.test(taskId)) {
        throw new Error(`Task ${String(taskId)} is not a durable local operation; results are observed only for supervised local tasks.`);
      }
      const operation = this.operationForTask(taskId);
      if (!operation) throw new Error(`Unknown durable task ${taskId}.`);
      if (!ownerMatchesOperation(operation, owner)) {
        throw new Error(`Task ${taskId} belongs to another execution owner; a wait may only depend on an owned operation.`);
      }
      if (operations.some((entry) => entry.operationId === operation.operationId)) continue;
      operations.push(operation);
    }
    return operations;
  }

  private operationForTask(taskId: string): OperationRecord | undefined {
    return this.store?.listOperations({ taskId })[0];
  }

  private ownedOperation(taskId: string, owner: OwnerIdentity): OperationRecord {
    const operation = this.operationForTask(taskId);
    if (!operation) throw new Error(`Unknown durable task ${taskId}.`);
    if (!ownerMatchesOperation(operation, owner)) {
      throw new Error(`Task ${taskId} belongs to another execution owner (${operation.owner.kind} ${operation.owner.sessionId}).`);
    }
    return operation;
  }

  private ownedWait(owner: OwnerIdentity, waitId: string, generation: number): WaitRecord {
    const wait = this.requireStore().getWait({ waitId, generation });
    if (!wait) throw new Error(`Unknown wait ${waitId} generation ${generation}.`);
    if (!sameOwner(wait.owner, owner)) throw new Error(`Wait ${waitId} belongs to another execution owner.`);
    return wait;
  }

  private supervision(): SupervisionIdentity {
    return { hostId: this.hostId, runnerId: null, processStartToken: null };
  }

  private parentAuthority(owner: OwnerIdentity, plan: ForegroundSandboxPlan): string {
    const levels = plan.confined && plan.permissions
      ? `${plan.permissions.projectFiles}/${plan.permissions.outsideProject}/${plan.permissions.storedCredentials}/${plan.permissions.commands ? "commands" : "no-commands"}/${plan.permissions.network ? "network" : "no-network"}`
      : plan.confined ? "write-confinement" : "unconfined";
    return authorityReference(`parent:${owner.sessionId}:${levels}`);
  }

  private announce(): void {
    const events = eventBusOf(this.pi);
    if (!events) return;
    events.emit(OBSERVED_WAITS_SERVICE_CHANNEL, this.service);
  }

  private announceUnavailable(reason: string): void {
    const events = eventBusOf(this.pi);
    if (!events) return;
    events.emit(OBSERVED_WAITS_SERVICE_CHANNEL, {
      version: OBSERVED_WAITS_SERVICE_VERSION,
      available: false,
      reason: oneLine(reason, 300),
    } satisfies BackgroundOperationCapability);
  }

  /** Answer a late service request without requiring the requester to know the host. */
  listenForServiceRequests(): void {
    const events = eventBusOf(this.pi);
    if (!events) return;
    events.on(OBSERVED_WAITS_SERVICE_REQUEST_CHANNEL, () => {
      if (this.closed) {
        this.announceUnavailable(this.unavailableReason ?? "the Background operation host closed");
      } else if (this.store || this.unavailableReason === undefined) {
        // A load-order probe may arrive before session_start. The capability
        // object exists; its methods open the store on first use.
        this.announce();
      } else {
        this.announceUnavailable(this.unavailableReason);
      }
    });
  }
}

function tailText(text: string, lines: number): string {
  return lastLines(text, lines).replace(/\n+/g, " ⏎ ").slice(0, 400);
}

function requireRpcString(params: JsonRecord, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required.`);
  return value;
}

function requireRpcCounter(params: JsonRecord, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer.`);
  return value;
}

function waitKey(waitId: string, generation: number): string {
  return `${waitId}:${generation}`;
}

/** Model-facing summary of one wait generation. */
export function formatWaitView(view: WaitView): string {
  const lines = [
    `${view.waitId} generation ${view.generation}: ${view.phase}${view.settled ? " (all dependencies settled)" : " (waiting)"}`,
    `owner: ${view.ownerKind}`,
  ];
  for (const dep of view.dependencies) {
    lines.push(`- ${dep.taskId ?? dep.operationId}: revision ${dep.terminalRevision}${dep.terminalOutcome ? ` ${dep.terminalOutcome}` : " unsettled"}`);
  }
  if (view.evidence.length) {
    lines.push(`evidence: ${view.evidence.map((entry) => `${entry.kind}:${entry.ref}`).join(", ")}`);
  }
  lines.push(view.park
    ? "Parked worker wait: resumption belongs to the registered continuation adapter."
    : "The parent stays responsive; this registration never blocks the model.");
  if (view.settled) {
    lines.push("Read the terminal evidence with bg_task_status and bg_task_log, then call acknowledge_operation_result with the exact revisions.");
  }
  return lines.join("\n");
}
