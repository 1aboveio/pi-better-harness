// Generated from packages/operation-coordinator/index.ts. Do not edit directly.
/**
 * Durable operation coordinator.
 *
 * A small, reusable library that records what a harness is waiting for and who
 * owns the result. It provides no provider transport, no process launch, no tool
 * execution and no model call: Background Tasks, Subagents and the parent
 * harness share these records instead of duplicating a journal.
 *
 * The contracts here implement the accepted invariant in
 * `docs/adr/0020-observed-waits-retain-an-owner.md` and the record shapes in
 * `docs/plans/observed-waits-design.md`.
 *
 * ```ts
 * import { openStore } from "operation-coordinator";
 *
 * const store = openStore({ path: join(agentDir, "operation-coordinator.sqlite") });
 * store.registerOperation({ operationId, taskId, launchToken, owner, observer });
 * // later, from the supervisor:
 * store.recordTerminalOutcome({ operationId, eventId, outcome: "succeeded", owner, evidence });
 * // the owner interprets the evidence it read, then consumes the wait:
 * store.recordEvidenceRead({ waitId, generation, owner, operationId, terminalRevision: 1 });
 * store.acknowledgeResult({ waitId, generation, owner, disposition: "continue", note, terminalRevisions });
 * ```
 *
 * Rules the store enforces by itself:
 *
 * - an owner, task id and launch token are immutable once registered;
 * - one durable operation per background task, and one pending wait generation
 *   per owner identity;
 * - a parked worker reaches `waiting`/`ready` only with checkpoint and writer
 *   exit proof, and a dependency that settled earlier is never missed;
 * - duplicate terminal events and replayed reconciliation produce one terminal
 *   revision and one delivery per wait generation;
 * - resume attempt ids and launch tokens are persisted before spawn, and one
 *   generation has one active claim;
 * - cancellation increments a fencing epoch and invalidates the pending claim;
 * - an acknowledgement requires a recorded read of the exact evidence revision by
 *   the owner, and only then are evidence pins released;
 * - no credential, token value or environment value is stored; obvious secret
 *   material in a note or reference is refused.
 *
 * `node:sqlite` (Node 24+) is required. There is no in-memory fallback: an
 * unavailable or unreadable database disables the feature instead of pretending
 * to be durable.
 */
export { SCHEMA_VERSION, TERMINAL_WAIT_PHASES } from "./src/types.ts";
export type {
    AcknowledgeDisposition,
    AcknowledgeResultInput,
    AcknowledgeResultOutput,
    CancelWaitInput,
    CancelWaitResult,
    ClaimOutboxInput,
    ClaimResumeInput,
    DiscoveryClaimRecord,
    EvidenceKind,
    EvidencePinRecord,
    EvidenceReadRecord,
    EvidenceRefInput,
    HoldFailedResumeInput,
    HoldFailedResumeResult,
    ObserverHealth,
    ObserverIdentity,
    OperationEvidenceRecord,
    OperationFilter,
    OperationPhase,
    OperationRecord,
    OutboxDispatchClaim,
    OutboxDispatchInput,
    OutboxEventRecord,
    OutboxFilter,
    OutboxState,
    OwnerIdentity,
    OwnerKind,
    PublishResumeAttemptInput,
    PublishResumeAttemptResult,
    RecordEvidencePinInput,
    RecordEvidencePinResult,
    RecordEvidenceReadInput,
    RecordEvidenceReadResult,
    RecordSupervisionInput,
    RecordTerminalOutcomeInput,
    RecordTerminalOutcomeResult,
    RegisterOperationInput,
    RegisterOperationResult,
    RegisterWaitInput,
    RegisterWaitResult,
    ReleaseDiscoveryClaimInput,
    ReleaseSupervisionInput,
    ReleaseOutboxInput,
    ReleaseResumeClaimInput,
    ReleaseResumeClaimResult,
    ResumeClaimFilter,
    ResumeClaimRecord,
    ResumeClaimResult,
    ResumeClaimState,
    ResumeLeaseIdentity,
    StoreOptions,
    SupervisionIdentity,
    TerminalOutcome,
    TransitionWaitPhaseInput,
    TransitionWaitPhaseResult,
    TryClaimDiscoveryInput,
    WaitAcknowledgement,
    WaitDependencyInput,
    WaitDependencyRecord,
    WaitFilter,
    WaitParkIntent,
    WaitPhase,
    WaitRecord,
    WaitRef,
} from "./src/types.ts";
export { StoreError, isStoreError } from "./src/errors.ts";
export type { StoreErrorCode } from "./src/errors.ts";
export { openStore, ownerDiff } from "./src/store.ts";
export type { Store } from "./src/store.ts";
