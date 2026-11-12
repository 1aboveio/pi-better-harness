// Generated from packages/operation-coordinator/src/types.ts. Do not edit directly.
/**
 * Public record and call shapes for the durable operation coordinator.
 *
 * The store owns dependency records, phase transitions, resume claims, evidence
 * pins and the result outbox. It owns no provider transport, no tool execution,
 * no model call and no permission decision. Callers keep launch authority,
 * continuation admission and interpretation of the evidence.
 *
 * Identity rules that the API itself enforces:
 *
 * - an operation's owner, task id and launch token are immutable after
 *   registration; a different caller writing a terminal outcome is refused;
 * - a wait belongs to exactly one owner identity, and only that owner may cancel
 *   it or acknowledge its evidence;
 * - one owner identity holds at most one pending wait generation, and every
 *   mutation names the generation it acts on;
 * - a resume attempt id and launch token are persisted before the attempt is
 *   spawned, so a crash is reconciled instead of relaunched.
 */

/** Schema version this build writes and accepts. Any other version is refused. */
export const SCHEMA_VERSION = 3;

/** Who receives an operation's result and decides what happens next. */
export type OwnerKind = "parent-session" | "worker-conversation";

/**
 * Execution owner: the parent session or worker conversation that interprets
 * terminal evidence. `workspace` is the binding that must still exist for a
 * continuation, so it is part of the recorded identity.
 */
export interface OwnerIdentity {
    kind: OwnerKind;
    /** Foreground session id or worker conversation id. Never a display label. */
    sessionId: string;
    /** Canonical workspace path the owner is bound to. */
    workspace: string;
    /** Plan/workflow branch binding, when the owner is on one. */
    branchId?: string | null;
    /** Goal binding, when the owner is on one. */
    goalId?: string | null;
}

/**
 * Observer health, reported separately from the wait phase. A wait does not
 * look healthy merely because it exists.
 */
export type ObserverHealth = "active" | "unmonitored" | "lost";

/** An operation is `terminal` once exactly one terminal revision is recorded. */
export type OperationPhase = "running" | "terminal";

/** Every terminal outcome resolves a dependency. None of them implies success. */
export type TerminalOutcome = "succeeded" | "failed" | "cancelled" | "lost";

/** Kinds of retained evidence reference. Never a credential or env value. */
export type EvidenceKind = "terminal-record" | "log" | "summary" | "artifact";

export type WaitPhase =
    | "registering"
    | "parking"
    | "waiting"
    | "ready"
    | "resuming"
    | "consumed"
    | "held"
    | "cancelled";

/** Phases that no longer accept automatic continuation. */
export const TERMINAL_WAIT_PHASES: readonly WaitPhase[] = ["consumed", "cancelled"];

// ---- operation registration ---------------------------------------------

/** Observer identity: which adapter observed the operation, and at what version. */
export interface ObserverIdentity {
    kind: string;
    version: string;
}

/**
 * Supervision identity: the host process that owns observation. It is mutable
 * (a replacement host takes over on reload) while launch identity is not.
 */
export interface SupervisionIdentity {
    /** Host that owns supervision, e.g. the Pi process id plus a start token. */
    hostId: string;
    /** Runner process identity, when a separate runner owns the operation. */
    runnerId?: string | null;
    /** Process start token of the runner, used to reject a recycled pid. */
    processStartToken?: string | null;
}

export interface RegisterOperationInput {
    /** Durable execution id, distinct from any caller-supplied intent id. */
    operationId: string;
    /** Background task id. One durable operation per task launch. */
    taskId: string;
    /**
     * Token persisted before the runner starts. The runner claims this token
     * before executing, so a lost launch acknowledgement is reconciled on the
     * same token instead of issuing a second execution.
     */
    launchToken: string;
    owner: OwnerIdentity;
    observer: ObserverIdentity;
    supervision?: SupervisionIdentity | null;
    /** Reference to the permission/authority snapshot. Never credential material. */
    authorityRef?: string | null;
    /** Caller retry-correlation id. Not an execution identity and not a grant. */
    intentRef?: string | null;
}

export interface OperationRecord {
    operationId: string;
    taskId: string;
    launchToken: string;
    owner: OwnerIdentity;
    observer: ObserverIdentity;
    supervision: SupervisionIdentity | null;
    authorityRef: string | null;
    intentRef: string | null;
    phase: OperationPhase;
    health: ObserverHealth;
    /** Why the observer is unmonitored or lost, when it is. */
    healthReason: string | null;
    /** `0` while the operation runs; `1` once its single terminal revision exists. */
    terminalRevision: number;
    terminalOutcome: TerminalOutcome | null;
    /** Terminal event id that produced the revision, for idempotent replay. */
    terminalEventId: string | null;
    /** True when retention removed detail; the outcome still stands. */
    terminalDetailLost: boolean;
    /** Why the terminal outcome was recorded; required when evidence was absent or lost. */
    terminalReason: string | null;
    createdAt: number;
    updatedAt: number;
    terminalAt: number | null;
}

export interface RegisterOperationResult {
    operation: OperationRecord;
    /** False when the same launch identity was already registered (idempotent replay). */
    created: boolean;
}

export interface RecordSupervisionInput {
    operationId: string;
    /** Must be the recorded owner; a replacement host acts for the same owner. */
    owner: OwnerIdentity;
    supervision?: SupervisionIdentity | null;
    health?: ObserverHealth;
    reason?: string | null;
    /**
     * The host id the caller observed as current, or null when no supervisor was
     * recorded. Required when supplying `supervision`. The write is refused with
     * `supervision-conflict` if another host took over after the caller read the
     * operation, so a stale contender cannot replace a newly live holder.
     */
    expectedHostId?: string | null;
}

export interface ReleaseSupervisionInput {
    operationId: string;
    /** Must be the recorded owner; a replacement host acts for the same owner. */
    owner: OwnerIdentity;
    /** The exact host whose authority is being released. A newer holder is untouched. */
    hostId: string;
    /** Why the host stopped supervising, retained on the unmonitored record. */
    reason?: string | null;
}

/** One shared discovery leader for a coordinator database and supervisor scope. */
export interface DiscoveryClaimRecord {
    /** Opaque canonical scope computed from the store path and supervisor directory. */
    scope: string;
    hostId: string;
    /** Fences acquisition and release against a stale or ABA competitor. */
    token: string;
    claimedAt: number;
    updatedAt: number;
}

export interface TryClaimDiscoveryInput {
    scope: string;
    /** The exact claim the caller observed, or null when it observed no claim. */
    expected: Pick<DiscoveryClaimRecord, "hostId" | "token"> | null;
    hostId: string;
    token: string;
}

export interface ReleaseDiscoveryClaimInput {
    scope: string;
    hostId: string;
    token: string;
}

// ---- terminal outcome ---------------------------------------------------

/**
 * One retained evidence reference. `summary` is bounded and is what an
 * interpreter may read after logs were reclaimed; `detailLost` records that
 * retention removed detail, so no exit code is ever recreated from a missing pid.
 */
export interface EvidenceRefInput {
    kind: EvidenceKind;
    /** Retained path, artifact id or record key. Never a credential or env value. */
    ref: string;
    summary?: string;
    detailLost?: boolean;
    bytes?: number;
}

export interface OperationEvidenceRecord extends EvidenceRefInput {
    operationId: string;
    terminalRevision: number;
    ordinal: number;
    detailLost: boolean;
    capturedAt: number;
}

export interface RecordTerminalOutcomeInput {
    operationId: string;
    /** Unique terminal event id from the supervisor. A retry must reuse it. */
    eventId: string;
    outcome: TerminalOutcome;
    /** The recorded owner, or the supervisor acting for it. Mismatch is refused. */
    owner: OwnerIdentity;
    evidence?: EvidenceRefInput[];
    /** True when the terminal record itself is gone (lost evidence). */
    detailLost?: boolean;
    /** Why the operation ended, required when evidence is absent or lost. */
    reason?: string;
}

export interface RecordTerminalOutcomeResult {
    operation: OperationRecord;
    /** True when this call created the terminal revision; false on idempotent replay. */
    recorded: boolean;
    /** Outbox events for this terminal revision (empty when already delivered earlier). */
    outbox: OutboxEventRecord[];
    /** Wait generations that moved to `ready` because of this revision. */
    ready: WaitRecord[];
}

/** Filter for `listOperations`. */
export interface OperationFilter {
    owner?: OwnerIdentity;
    /** Session/workspace scope spanning all branches and goals. */
    ownerScope?: Pick<OwnerIdentity, "kind" | "sessionId" | "workspace">;
    phase?: OperationPhase;
    taskId?: string;
}

// ---- waits --------------------------------------------------------------

/**
 * Dependency edge to one operation. `owner` (default) requires the operation to
 * be owned by the waiting owner. `explicit` records a cross-owner link for a
 * shared observer; it grants no authority over the operation.
 */
export interface WaitDependencyInput {
    operationId: string;
    link?: "owner" | "explicit";
}

/**
 * Checkpoint intent for a worker that will park. Recorded in `registering` and
 * required before the wait can reach `waiting` or `ready`.
 */
export interface WaitParkIntent {
    /** Attempt that committed the tool result and will exit. */
    attemptId: string;
    /** Native session checkpoint identity the tool result was committed into. */
    checkpointId: string;
    /** Conversation writer lease released after that attempt exited. */
    writerLeaseId?: string | null;
}

export interface RegisterWaitInput {
    /**
     * Stable wait identity reused across generations. Omit to mint one. A new
     * generation may only start after the previous generation is consumed or
     * cancelled.
     */
    waitId?: string;
    owner: OwnerIdentity;
    /** All-settled dependencies. Every listed operation must be terminal. */
    dependencies: WaitDependencyInput[];
    /** Next reasoning step. Cannot change tools, model, role, permissions or authorization. */
    continuationNote: string;
    /** Present for a worker parking; absent for a responsive parent. */
    park?: WaitParkIntent | null;
    origin?: {
        taskIds?: string[];
        assignmentRef?: string | null;
        attemptId?: string | null;
    };
}

export interface WaitDependencyRecord {
    operationId: string;
    link: "owner" | "explicit";
    /** `0` while unsettled; the operation's terminal revision once settled. */
    terminalRevision: number;
    terminalOutcome: TerminalOutcome | null;
    settledAt: number | null;
}

export interface WaitAcknowledgement {
    disposition: AcknowledgeDisposition;
    note: string;
    /** Exact evidence revisions interpreted by the owner. */
    revisions: Array<{ operationId: string; revision: number }>;
    acknowledgedAt: number;
}

export interface WaitRecord {
    waitId: string;
    generation: number;
    owner: OwnerIdentity;
    phase: WaitPhase;
    phaseReason: string | null;
    /** Incremented by every cancellation; invalidates claims taken before it. */
    cancelEpoch: number;
    continuationNote: string;
    park: WaitParkIntent | null;
    origin: RegisterWaitInput["origin"] | null;
    dependencies: WaitDependencyRecord[];
    /** True when every dependency has a terminal revision. */
    settled: boolean;
    settledAt: number | null;
    acknowledgement: WaitAcknowledgement | null;
    createdAt: number;
    updatedAt: number;
}

export interface RegisterWaitResult {
    wait: WaitRecord;
    /** True when every dependency was already terminal inside the registration transaction. */
    settledAtRegistration: boolean;
    /** Result delivery enqueued because the dependencies were already settled. */
    outbox: OutboxEventRecord[];
}

export interface TransitionWaitPhaseInput {
    waitId: string;
    generation: number;
    /** Current phase the caller believes it is acting on. Mismatch is refused. */
    from: WaitPhase;
    /** `consumed`/`cancelled` have their own calls; `resuming` needs a claim. */
    to: "parking" | "waiting" | "ready" | "held";
    reason?: string;
    /**
     * Required for a parked wait leaving `parking`. All three facts must hold:
     * the checkpoint was committed, the writer lease was released, and the
     * original writer process was observed gone.
     */
    proof?: {
        checkpointRecorded: boolean;
        writerLeaseReleased: boolean;
        /** Must be `true`; an absent or false value cannot prove writer quiescence. */
        writerPidGone?: boolean;
    };
}

export interface TransitionWaitPhaseResult {
    wait: WaitRecord;
    outbox: OutboxEventRecord[];
}

export interface CancelWaitInput {
    waitId: string;
    generation: number;
    /** Epoch the caller observed. A stale epoch means cancellation already happened. */
    expectedCancelEpoch: number;
    owner: OwnerIdentity;
    reason: string;
}

export interface CancelWaitResult {
    wait: WaitRecord;
    /** Resume claims invalidated by this cancellation. */
    invalidatedClaimIds: string[];
    /** Outbox deliveries voided by this cancellation. */
    voidedOutboxIds: string[];
}

export interface WaitRef {
    waitId: string;
    /** Omit for the latest generation. Mutations always require it. */
    generation?: number;
}

export interface WaitFilter {
    owner?: OwnerIdentity;
    phase?: WaitPhase | readonly WaitPhase[];
    /** Only generations that can still accept a result (`consumed`/`cancelled` excluded). */
    pendingOnly?: boolean;
}

// ---- resume claims ------------------------------------------------------

/**
 * Lease identity for the process that may publish an attempt. Validation uses
 * process identity, not elapsed time alone.
 */
export interface ResumeLeaseIdentity {
    /** Stable id of the supervising host process. */
    ownerId: string;
    pid?: number | null;
    processStartToken?: string | null;
}

export type ResumeClaimState = "claimed" | "published" | "released" | "invalidated";

export interface ResumeClaimRecord {
    claimId: string;
    /** Unique execution token the runner claims; a second claim gets a new token. */
    claimToken: string;
    waitId: string;
    generation: number;
    cancelEpoch: number;
    state: ResumeClaimState;
    /** Attempt id chosen before spawn. Null until published. */
    attemptId: string | null;
    /** Launch token the child publishes before admitting model execution. */
    launchToken: string | null;
    lease: ResumeLeaseIdentity;
    /** Native checkpoint the continuation will reopen. */
    reservedCheckpointId: string;
    claimedAt: number;
    publishedAt: number | null;
    releasedAt: number | null;
    invalidatedAt: number | null;
    reason: string | null;
}

export interface ClaimResumeInput {
    waitId: string;
    generation: number;
    /** Epoch observed immediately before claiming. */
    expectedCancelEpoch: number;
    lease: ResumeLeaseIdentity;
    reservedCheckpointId: string;
}

export interface ResumeClaimResult {
    claim: ResumeClaimRecord;
    wait: WaitRecord;
}

export interface PublishResumeAttemptInput {
    waitId: string;
    generation: number;
    claimId: string;
    claimToken: string;
    /** Attempt id persisted before spawn. */
    attemptId: string;
    /** Execution token the child publishes before admitting model execution. */
    launchToken: string;
}

export interface PublishResumeAttemptResult {
    claim: ResumeClaimRecord;
    wait: WaitRecord;
    /** False for an idempotent replay of the same attempt and token. */
    published: boolean;
}

export interface ReleaseResumeClaimInput {
    waitId: string;
    generation: number;
    claimId: string;
    claimToken: string;
    /** `ready` when admission failed before spawn; `held` when it is uncertain. */
    outcome: "ready" | "held";
    reason: string;
}

export interface ReleaseResumeClaimResult {
    claim: ResumeClaimRecord;
    wait: WaitRecord;
}

/**
 * Proof that the published resume attempt can never interpret the generation:
 * its writer process is gone and its conversation writer lease is free. A live
 * writer or an unverifiable identity must never be passed here.
 */
export interface ResumeAttemptExitProof {
    writerPidGone: boolean;
    writerLeaseReleased: boolean;
}

/**
 * Move a published resume generation to `held` after the attempt exited without
 * interpreting it. This is not a cancellation: the cancellation epoch is kept, the
 * evidence pins stay, and the generation remains visible to its owner. The claim
 * is invalidated (it can never publish again), which is what makes a second
 * automatic attempt impossible.
 */
export interface HoldFailedResumeInput {
    waitId: string;
    generation: number;
    claimId: string;
    claimToken: string;
    attemptId: string;
    launchToken: string;
    proof: ResumeAttemptExitProof;
    /** Why the attempt never interpreted the generation; retained on both records. */
    reason: string;
}

export interface HoldFailedResumeResult {
    wait: WaitRecord;
    claim: ResumeClaimRecord;
    /** False for an idempotent replay of the same held generation. */
    applied: boolean;
}

export interface ResumeClaimFilter {
    waitId?: string;
    generation?: number;
    state?: ResumeClaimState | readonly ResumeClaimState[];
}

// ---- evidence reads and pins -------------------------------------------

export interface RecordEvidenceReadInput {
    waitId: string;
    generation: number;
    /** Must be the wait owner: interpretation belongs to the owner. */
    owner: OwnerIdentity;
    operationId: string;
    /** Exact terminal revision that was read. */
    terminalRevision: number;
}

export interface EvidenceReadRecord {
    waitId: string;
    generation: number;
    operationId: string;
    terminalRevision: number;
    reader: OwnerIdentity;
    readAt: number;
}

export interface RecordEvidenceReadResult {
    read: EvidenceReadRecord;
    /** False for a repeated read of the same revision (idempotent). */
    recorded: boolean;
}

export interface RecordEvidencePinInput {
    waitId: string;
    generation: number;
    operationId: string;
    terminalRevision: number;
    kind: EvidenceKind;
    ref: string;
    summary?: string;
    detailLost?: boolean;
    bytes?: number;
}

export interface EvidencePinRecord {
    pinId: string;
    waitId: string;
    generation: number;
    operationId: string;
    terminalRevision: number;
    kind: EvidenceKind;
    ref: string;
    summary: string | null;
    detailLost: boolean;
    bytes: number | null;
    pinnedAt: number;
    releasedAt: number | null;
    releaseReason: string | null;
}

export interface RecordEvidencePinResult {
    pin: EvidencePinRecord;
    /** False when the same reference was already pinned for this generation. */
    recorded: boolean;
}

// ---- interpretation acknowledgement ------------------------------------

/** Dispositions accepted by `acknowledgeResult`. None of them completes a goal. */
export type AcknowledgeDisposition = "continue" | "blocked" | "assignment-complete";

export interface AcknowledgeResultInput {
    waitId: string;
    generation: number;
    owner: OwnerIdentity;
    disposition: AcknowledgeDisposition;
    /** Interpretation note persisted against the exact evidence revisions. */
    note: string;
    /** Exact terminal revisions claimed. A mismatch is refused. */
    terminalRevisions: Array<{ operationId: string; revision: number }>;
}

export interface AcknowledgeResultOutput {
    wait: WaitRecord;
    /** Result deliveries marked consumed by this acknowledgement. */
    acknowledgedOutboxIds: string[];
    /** Evidence pins released after consumption. */
    releasedPinIds: string[];
}

// ---- outbox -------------------------------------------------------------

export type OutboxState = "pending" | "claimed" | "delivered" | "acknowledged" | "voided";

export interface OutboxDispatchClaim {
    token: string;
    claimedBy: string;
    claimedAt: number;
}

export interface OutboxEventRecord {
    type: "dependency-ready" | "assignment-outcome";
    eventId: string;
    operationId: string;
    /** Terminal revision this event delivers. Unique per wait generation. */
    terminalRevision: number;
    waitId: string;
    generation: number;
    recipient: OwnerIdentity;
    /** Evidence pinned for this event, so a reclaimed log cannot erase the result. */
    evidence: EvidencePinRecord[];
    state: OutboxState;
    /** Delivery attempts so far, retained across releases. */
    attempts: number;
    dispatchClaim: OutboxDispatchClaim | null;
    createdAt: number;
    claimedAt: number | null;
    deliveredAt: number | null;
    acknowledgedAt: number | null;
    voidedAt: number | null;
    /** Recovery reason from a failed dispatch or a void. */
    reason: string | null;
}

export interface OutboxFilter {
    recipient?: OwnerIdentity;
    state?: OutboxState | readonly OutboxState[];
    waitId?: string;
    generation?: number;
    operationId?: string;
}

export interface ClaimOutboxInput {
    eventId?: string;
    type?: OutboxEventRecord["type"];
    /** Restrict to one wait generation. Omit to claim across a recipient. */
    waitId?: string;
    generation?: number;
    /** Restrict to deliveries addressed to this owner identity. */
    recipient?: OwnerIdentity;
    /** Unique token for this dispatch attempt. */
    claimToken: string;
    /** Who is dispatching (host/extension identity). */
    claimedBy: string;
    /** Maximum number of events to claim (default 10). */
    limit?: number;
}

export interface OutboxDispatchInput {
    eventId: string;
    claimToken: string;
}

export interface ReleaseOutboxInput {
    eventId: string;
    claimToken: string;
    /** Why the delivery was released; retained without consuming the result. */
    reason: string;
}

// ---- store options ------------------------------------------------------

export interface StoreOptions {
    /**
     * SQLite file path. Tests pass a temporary path; production passes the Pi
     * agent directory. `:memory:` is accepted for throwaway stores only.
     */
    path: string;
    /** How long SQLite waits for a competing writer. Default 5000 ms. */
    busyTimeoutMs?: number;
    /** Clock seam for deterministic tests. Defaults to `Date.now`. */
    now?: () => number;
}
