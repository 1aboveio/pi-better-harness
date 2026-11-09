# operation-coordinator

Durable operation, dependency, resume-claim and outbox records for observed
waits (ADR [0020](../../docs/adr/0020-observed-waits-retain-an-owner.md), design
[observed-waits-design.md](../../docs/plans/observed-waits-design.md), glossary
[GLOSSARY.md](../../GLOSSARY.md)).

This package is a small shared library, not an extension. It records what a
harness is waiting for and who owns the result. It performs no process launch, no
tool execution, no model call, no provider transport and no permission decision.

## Requirements and configuration

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

Wait phases: `registering → parking → waiting → ready → resuming → consumed`,
plus `held` and `cancelled`. The store refuses any other transition, refuses a
`from` phase that is not current (`stale-phase`), and refuses a superseded
generation (`stale-generation`).

## Lifecycle contract

**Launch.** `registerOperation` records the launch intent and unique execution
token before a runner starts. Re-registering the same launch is idempotent; a
changed task id, launch token, owner or observer is refused, so a store cannot be
used to prove ownership of a launch that was swapped underneath it.
`recordSupervision` replaces the supervising host and reports observer health
(`active`, `unmonitored`, `lost`) separately from the wait phase.

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
registerOperation / recordSupervision / recordTerminalOutcome
getOperation / listOperations / listOperationEvidence

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
`foreign-owner`, `terminal-conflict`, `pending-wait-generation`, `unknown-wait`,
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
- A replacement host calls `recordSupervision` with the same owner identity; a
  different owner is refused.
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
