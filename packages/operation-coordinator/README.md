# operation-coordinator

Durable operation, dependency, resume-claim and outbox records for observed
waits (ADR [0020](../../docs/adr/0020-observed-waits-retain-an-owner.md), design
[observed-waits-design.md](../../docs/plans/observed-waits-design.md), glossary
[GLOSSARY.md](../../GLOSSARY.md)).

This package is a small shared library, not an extension. It records what a
harness is waiting for and who owns the result. It performs no process launch, no
tool execution, no model call, no provider transport and no permission decision.

## Requirements and configuration

Storage schema 5 adds exact operation-to-attempt bindings, with transactional
upgrades from schemas 1 through 4. `registerAssignment` captures immutable worker/recipient and
attempt bindings before dispatch. `recordAssignmentOutcome` atomically commits
the terminal decision, typed parent event, dispatch disarming and evidence-pin
transfer. Published writer claims require independent exit proof; neither delivery
nor outcome consumption releases them. `receiptAssignmentOutcome`,
`inspectAssignmentOutcome` and `consumeAssignmentOutcome` record separate facts.
Dependency-ready and assignment-outcome outbox claims must be routed separately.

- Node 24 or newer: the store uses the built-in `node:sqlite`. On a runtime
  without it, `openStore` refuses with `sqlite-unavailable`; there is no in-memory
  fallback, because these records exist to survive a restart.
- The database path is explicit, so tests use a temporary file and production
  passes a path under the Pi agent directory:

```ts
import { openStore } from "operation-coordinator";

const store = openStore({
    path: join(agentDir, "operation-coordinator.sqlite"),
    // busyTimeoutMs: 5_000 (default), now: () => Date.now() (test seam)
});
```

One `Store` per process path. Reopen after a restart to read the same records.
Calls are synchronous and transactional; each refusal throws `StoreError` with a
typed `code` and leaves no partial record.

## Records

| Table | Holds | Invariant |
| --- | --- | --- |
| operation | execution id, task id, launch token, owner identity, observer, supervision, phase, one terminal revision, evidence references | launch identity and owner are immutable; one operation per task id |
| wait | wait id + generation, owner identity (session, workspace, branch, goal), phase, cancellation epoch, continuation note, park intent | at most one pending generation per owner identity |
| wait dependency | operation id, link kind, settled revision and outcome | all-settled; a settled revision is never un-settled |
| resume claim | claim token, lease identity, reserved checkpoint, attempt id, launch token | one active claim per generation; attempt ids are unique |
| evidence read | who read which terminal revision | one read per revision per owner |
| evidence pin | retained reference, bounded summary, `detailLost`, release reason | released on consumption or dismissal, never overwritten |
| outbox event | terminal revision + wait generation + recipient + evidence | one event per revision per generation |
| discovery claim | one host id and fencing token per store/supervisor scope | compare-and-swap acquisition; an exact-token release cannot erase a successor |

Schema version 1 is extended additively. Older readers ignore the discovery
tables and the indexed supervision-host column, so a live session on the
previous build keeps its records during a rolling upgrade.

Wait phases: `registering → parking → waiting → ready → resuming → consumed`,
plus `held` and `cancelled`. The store refuses any other transition, refuses a
`from` phase that is not current (`stale-phase`), and refuses a superseded
generation (`stale-generation`).

## Lifecycle contract

### Server Cancellation (#759)

`acceptTaskCancellation` stores the fixed `cancel_task` request in the existing
coordinator database. An immediate transaction checks the operation's full owner,
launch token, terminal revision and supervision host before accepting the intent.
The owner and idempotency key identify the receipt. Identical retries return that
receipt before checking current operation state; changed content raises
`request-conflict`. `getTaskCancellation` reads the same receipt after reconnect.

The additive `task_cancellation_requests` table implements the persisted-intent
requirement from ADR 0023 without creating another operation or terminal authority.
`recordTaskStopRequested` records the host's durable stop-file publication after
acceptance. Neither state proves process exit, publishes a terminal outcome,
changes waits or releases evidence and writer fences.

The registered Background stop tool obtains authority from `ObservedWaitHost`'s
actual tool context. The host refuses foreign ownership and a live legacy or
unknown supervisor, drains local cancellation admission, and records a hashed,
exact-request credential before handing cancellation to the server. Subsequent
local stop calls refuse that managed task. Launch and wait supervision stay with
their existing hosts. An owner string or socket access grants no authority.

`acceptAuthorizedTaskCancellation` verifies the current management epoch, the
task cancellation epoch and an opaque semantic revision in the same transaction
as journal acceptance. Health timestamps do not change that revision. Accepted
requests are looked up before epoch checks, so reconnecting clients recover the
original receipt rather than submitting an old envelope in a new epoch.

The fixed server adapter calls the canonical supervisor's stop implementation.
Before a file or process action, the journal is durable. Recovery verifies the
original launch token. An existing durable stop file is observed rather than
replayed, because its process action may already have happened. Unverifiable
identity records `outcome_unknown`, retaining existing fences. Terminal evidence
uses the host's shared publication contract and commits with the request receipt
through the existing coordinator terminal transaction. No callback receipt or
wait interpretation is manufactured.

The wire commands are `runtime_cancellation_status`, `runtime_cancel_task` and
`runtime_query_cancellation`; they require hello and accept only the fixed
credential-bearing schema. The tool displays its request identity and accepts
`request_id` for reconnect retries. A timeout before submission is `not_accepted`;
a lost response after submission is `outcome_unknown`. A durable accepted request
without a result remains `accepted`, and must be queried with the same key.

**Launch.** `registerOperation` records the launch intent and unique execution
token before a runner starts. Re-registering the same launch is idempotent; a
changed task id, launch token, owner, observer or assignment attempt is refused, so a store cannot be
used to prove ownership of a launch that was swapped underneath it.
`recordSupervision` replaces the supervising host and reports observer health
(`active`, `unmonitored`, `lost`) separately from the wait phase.
A host that closes calls `releaseSupervision` with its exact host id; a newer
takeover is left untouched, and running work becomes explicitly unmonitored for
the next host.

**Assignment cleanup (ADR [0025](../../docs/adr/0025-assignment-terminal-task-cleanup.md)).**
Pass `assignmentAttemptId` when the launch comes from an exact registered worker
attempt. The store checks the captured owner and refuses new launches after that
assignment has a terminal outcome. An exact replay returns `created: false`;
it does not admit another launch. Operations without the field, including
existing operations at migration, remain unbound.
`listAssignmentCleanupOperations(limit, afterOperationId?)` lists bound operations
without a terminal revision whose assignment has a committed outcome. It returns
at most 256 rows in ascending operation ID order. Use the last returned operation
ID as the exclusive cursor and start each new sweep without a cursor. Parking,
dependency links, and a shared conversation do not create obligations. Only a
recorded operation terminal revision closes an obligation; a stop request or
parent outcome receipt does not. The caller owns supervised stop and verification.

**Registering a wait.** `registerWait` reads each dependency's current terminal
revision *inside* its transaction, so a task that finished before registration is
not missed: the generation starts `ready` with delivery already enqueued. A
second pending generation for the same owner identity is refused with
`pending-wait-generation`; unknown ids are refused with `unknown-operation`; a
dependency owned by someone else is refused unless it is passed as
`{ link: "explicit" }`, which records a reference and grants no authority.

**Parking.** A worker wait carries `park: { attemptId, checkpointId }` and starts
in `registering`. It cannot leave `parking` for `waiting`/`ready` without
`proof: { checkpointRecorded: true, writerLeaseReleased: true, writerPidGone: true }`
(`checkpoint-proof` otherwise). The gate applies only at that parking boundary: a
generation that already left `parking` with proof can later be held and recovered
without re-proving the checkpoint. A dependency that settled during parking
resolves straight to `ready` with reason `settled-while-parking`.

**Terminal outcome.** `recordTerminalOutcome` records exactly one terminal
revision per operation and settles dependent generations in the same transaction,
before any delivery can be dispatched. A replay with the same `eventId` is
idempotent (`recorded: false`); a different terminal event is refused
(`terminal-conflict`). An outcome with no evidence must record a `reason`, which
is persisted on the operation record and survives reopen, and a
`lost` outcome never invents an exit code: `detailLost` is stored instead.

**Delivery.** Every settled dependency produces one outbox event addressed to the
wait's owner identity (including workspace and branch). `claimOutbox` takes a
dispatch attempt (`attempts` is retained), `markOutboxDelivered` records delivery,
`releaseOutbox` returns it to the queue with a recovery reason. Delivery is
at-least-once: the event is unique, but a crash between emission and
`markOutboxDelivered` can emit it again, so recipients de-duplicate on the event
id. None of these calls consume the result.

**Continuation.** `claimResume` requires a `ready` generation and the observed
cancellation epoch; it returns a claim token and moves the generation to
`resuming`. `publishResumeAttempt` persists the chosen attempt id and launch token
*before* spawn; an identical replay is idempotent, a different attempt is refused
(`claim-state`), a reused attempt id is refused (`attempt-conflict`), and a
cancellation after the claim invalidates it (`stale-cancel-epoch`).
`releaseResumeClaim` returns a pre-spawn admission failure to `ready` or holds an
uncertain one in `held`; a published claim can never be released.

**Interpretation.** `recordEvidenceRead` records that the owner read one exact
terminal revision (idempotent per revision, foreign owners refused).
`acknowledgeResult` requires all of that: the exact revision set, a recorded read
by the same owner, a non-empty note and a disposition (`continue`, `blocked`,
`assignment-complete`). It then marks the generation `consumed`, acknowledges the
outbox events and releases the evidence pins. A second acknowledgement is refused,
and the acknowledgement does not complete a goal or assignment by itself.

**Cancellation.** `cancelWait` increments the cancellation epoch, invalidates the
active claim, voids unconsumed deliveries and releases pins. Stopping an
operation is separate: record its terminal outcome as `cancelled` so the
dependency still resolves for interpretation.

## API surface

```ts
registerOperation / recordSupervision / releaseSupervision / recordTerminalOutcome
getOperation / listOperations / listOperationEvidence
listAssignmentCleanupOperations
listRunningSupervisedBy / readDiscoveryClaim / tryClaimDiscovery / releaseDiscoveryClaim
getChangeRevision

registerWait / transitionWaitPhase / cancelWait
getWait / listWaits / listDependencies / findPendingWait

claimResume / publishResumeAttempt / releaseResumeClaim
listResumeClaims / listUnreconciledClaims

recordEvidenceRead / listEvidenceReads
recordEvidencePin / listEvidencePins / releaseEvidencePins

acknowledgeResult

listOutbox / claimOutbox / markOutboxDelivered / releaseOutbox
```

All record and call shapes are exported from `index.ts` with per-field
documentation; see `src/types.ts` for the full contract and `src/store.ts` for the
`Store` interface. `SCHEMA_VERSION` and `StoreError` / `isStoreError` are exported
too.

## Refusal codes

`schema-version`, `sqlite-unavailable`, `store-busy`, `store-corruption`,
`validation`, `unknown-operation`, `operation-conflict`, `task-ownership`,
`foreign-owner`, `supervision-conflict`, `terminal-conflict`, `pending-wait-generation`, `unknown-wait`,
`wait-phase`, `stale-phase`, `stale-generation`, `stale-cancel-epoch`,
`dependencies-unsettled`, `checkpoint-proof`, `concurrent-claim`, `claim-state`,
`attempt-conflict`, `evidence-read-required`, `stale-evidence`, `outbox-state`,
`closed`.

A schema refusal never rewrites or deletes records: a database written by a newer
build is refused with the versions named, and an unversioned database is refused
rather than reused.

## Secrets

The API has no field for a token, key or environment value. Free text (`note`,
`reason`, `summary`, `continuationNote`) and references (`ref`, `authorityRef`)
are bounded, single-line, and refused when they contain obvious credential
material (private-key blocks, bearer tokens, provider key prefixes, AWS key ids,
JWTs, credential-shaped `NAME=value` assignments, credential file paths). Ordinary
status text such as `HTTP_STATUS=500` or `AUTH: rejected by upstream` is accepted.

## Integration notes

- Background Tasks hosts one coordinator instance per Pi process and owns the
  supervisor transport and coordinator lease; Subagents registers a versioned
  continuation-admission capability with that host. Both can load in either
  order. Those capabilities, the child-to-supervisor transport and the tool
  surfaces are **not** part of this package.
- On startup, reconcile: `listUnreconciledClaims()` for claims a previous host may
  have published, `listWaits({ pendingOnly: true })` for outstanding generations,
  and `listOutbox({ state: "pending" })` for undelivered results. Replaying a
  terminal event with its original `eventId` is safe.
- A replacement host calls `recordSupervision` with the same owner identity after
  the previous authority is released or proven dead; a different owner is refused.
- Retail decisions the store deliberately avoids: whether an operation may launch,
  how a continuation is admitted, whether a goal or assignment is complete, and
  what a domain adapter must observe.

## Tests

```sh
npm run typecheck -w packages/operation-coordinator
npm run test -w packages/operation-coordinator
```

The suite runs against real SQLite files and covers store reopen and replay
(including a writer in a separate process), completion before registration,
duplicate claims and cancellation, duplicate acknowledgement, evidence-read
requirements, foreign-ownership refusal, schema and secret refusals, and two
supervisors racing for one resume claim.
