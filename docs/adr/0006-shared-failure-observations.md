# Shared failure observations independent of run lifecycle

## Status

Accepted. Amended 2026-09-27 by the incident lifecycle decision below (#315): explicit dispositions, separate actionability, and pending-only notifications. Follow-ups in the #325 amendment: background-task intent, parent-authored trust provenance, orphaned-run gap delivery, and budget-safe terminal notes.

## Problem

A subagent can remain alive after a tool fails. Its output previously preferred cached assistant progress over newer tool-error evidence. Background watchers have separately needed fixes for silently ignored condition-evaluation failures. Process lifecycle, observation health, work outcome, and notification delivery are different facts; a single running/completed status cannot represent all of them.

## Decision

A private `failure-observations` module owns the common observation contract, reducer, durable append-only journal, priority summary, and notification eligibility/receipt rules. Its implementation is vendored into subagents and background tasks through the existing shared-module sync mechanism, so independently published consumers use the same behavior without another runtime package dependency. Consumer adapters translate their native structured events and retain ownership of process lifecycle, origin routing, and callback scheduling.

The journal lives beside each run/task's metadata. A `.observed` companion marker makes a subsequently missing journal distinguishable from a run with no recorded failures, even after restart. It contains bounded summaries and evidence references, not copies of arbitrary stdout or assistant prose. It is independent of lifecycle metadata so unrelated metadata writes cannot erase failure evidence. Event IDs are stable across replay. Duplicate events do not reopen recovered incidents. A leading newline on each append isolates any previous partially written record; malformed records preserve usable evidence and produce an explicit observation-incomplete state.

An operation may be running while it has unresolved failures. A successful command may resolve an incident only through an explicitly referenced matching operation, with the adapter establishing that it is a later retry rather than a concurrent or unrelated success. Text such as “tests passed” is not recovery evidence. Repeated failures of the same unresolved operation form one incident, preserving its first observation and latest evidence.

Expected failures require explicit structured producer metadata. They remain visible but do not request attention. The system does not infer expectedness from natural language. A later unexpected failure can open an actionable incident even when earlier failures were expected.

All reporting surfaces put the common failure summary before ordinary progress text. Bounded summaries prioritize unexpected failures and explicitly count additional retained observations. Missing, unreadable, or truncated evidence cannot be reported as proof of health.

Notification receipts are separate from observation and recovery. A successful handoff records which incidents were delivered; merely preparing or attempting a callback does not. Temporary errors reading delivery or ownership state defer the handoff rather than recording permanent suppression; an explicit ownership mismatch still suppresses delivery to the wrong session. Running actionable incidents become eligible after a grace period (see the amendment for which incidents are actionable); terminal failures and broken observation can be eligible immediately. Existing callback batching and origin routing are reused. `callback:false` disables unsolicited delivery, not failure visibility. Reload must recover pending observations/receipts. Delivery is at least once: a crash between successful handoff and receipt persistence can cause a duplicate; it must not cause silent loss.

Failed writes retain every pending event and receipt in process memory and retry on subsequent reads. Pending receipts prevent repeated handoffs within that process; a visible observation-incomplete state remains until persistence succeeds. While storage is unavailable, this memory-only backlog cannot survive process loss. The existence marker can still report that evidence is missing when it was written successfully. Journals and markers follow existing run/task retention and explicit cleanup.

## Amendment: incident lifecycle (#315)

### Problem

Agents adapt: they change a command's scope or timeout, remediate a merge conflict with different commands, or run probes whose non-zero exit is the answer. Exact-retry recovery cannot close those incidents, so completed runs kept dozens of stale unresolved incidents. Every new due incident also re-rendered up to five older ones. In production sessions this woke an orchestrator for about 60% of its turns (for example 271 alerts drove 644 of 1,028 turns), and the typical reaction was to inspect the log and do nothing.

### Decision

Failure history and current actionability are separate facts derived from the same reduced state.

- **Actionability.** An agent tool failure (category `tool`) belongs to the agent that made the call. It is *unclassified* until disposed, and it becomes actionable only when the same operation has failed three times with no recovery, or when the agent disposes it as `open`. Other producers' failures (exit, model, supervision, watch) stay actionable at once. Lifecycle is still not an input.
- **Labels.** `Action required`, `Unclassified failure observation`, `Expected failure`, and `Observation incomplete`. Recovered and superseded incidents leave active summaries and remain in history, counted.
- **Delivery.** Running attention covers actionable incidents and observation gaps only, once each; a consumer may defer running observation gaps to its terminal or health callback, and subagents do, because the parent cannot act on a malformed or oversized child log record mid-run. Terminal delivery reports every still-unresolved incident once, in the completion or health callback, with unclassified tool failures as a count and a statement that work correctness was not inferred from lifecycle. A notification renders exactly its pending incidents; earlier deliveries are counted, never repeated. Receipts keep their meaning.
- **Explicit dispositions.** An append-only `disposition` event names incident ids, a reason, and (for `recovered` and `superseded`) evidence: `recovered` (the same operation later passed), `superseded` (a different verification or remediation established the outcome), `expected` (intentional), `open` (still needs action; makes it actionable). An incident receives at most one closing disposition; `open` does not reopen a closed incident. Invalid, unknown, already-disposed, evidence-free, or partially invalid requests are rejected whole and are neither journaled nor marked seen. A later failure of a closed operation opens a new incident; the old one moves to history.
- **Structured intent.** Adapters may accept `operationId` (stable across modified retries; a later success of the same declared operation recovers it), `attemptId` (evidence identity only), and `expectedExitCodes` (declared before execution and matched only against a structured exit code). Without an `operationId` the exact identity rule stands. No command, output, or prose is pattern-matched.
- **Subagent adapter.** Structured intent and dispositions are honoured only for runs the parent recorded as launched on the trusted task runtime (`taskRuntime` metadata); elsewhere the exact rule applies. The trusted task runtime's bash accepts the intent fields and validates them before the command runs (a rejected intent never runs and is recorded as its own non-escalating observation); a declared code returns a non-error result whose details carry the exit code. The guard admits one additional inline tool, `failure_disposition`, which performs no file or command I/O. It validates against the same incident model the parent replays from the child's log, and the parent re-validates at the request's log position before journaling. Unconfined children keep the exact rule.

### Consequences

Replaying the session from issue #315 (29 children, 181 tool failures) yields 171 retained unresolved observations, of which 1 is actionable while running. History and journal events are unchanged. Background tasks share the reducer, labels, and pending-only rendering; their structured intent was added in #325 (below).

## Amendment: follow-ups (#325)

- **Unconfined subagents keep the exact rule, by design.** A child that is not on the trusted task runtime can rewrite its own log and metadata, so the parent cannot trust intent fields or dispositions it reports. Structured intent and `failure_disposition` stay gated on the trusted task runtime; this is intentional, not a gap to close later.
- **Trust is parent-authored provenance.** `meta.taskRuntime` alone lives in the run directory. The parent also writes a provenance record before the child starts, outside every run directory, under the registry root the task runtime's policy denies to the child. Structured intent is honoured only when both agree. A child that could write its run directory still cannot forge trust.
- **Trust is read, not assumed, and the wait is bounded.** While metadata or provenance cannot be read, the scan waits rather than folding under the exact rule and caching it. At a terminal read, or once trust has been unreadable for 30 seconds, the log is scanned under the exact-retry rule (untrusted) so real failures stay visible, with an observation gap saying the metadata could not be read. The provenance record is removed on every run-removal path, including a failed launch, and records whose run is gone are swept.
- **One view of attempt reuse.** The parent scans the child's whole process log; the child checks `attemptId` reuse and validates dispositions against its whole session record, not one branch. Session entries are a superset of the log's tool starts, so a reuse the parent predicts is always one the child refused.
- **Rejected intent is read, not re-derived.** The parent files `rejected-intent` only when the child's `tool_execution_end` carries the child's own pre-run refusal (`Invalid command intent: … The command was not run.`, or Pi's schema refusal of intent fields the shared validator also rejects). A prediction from the logged arguments never decides it: the log keeps the model's raw arguments, while Pi may normalize them before `execute` (0.87 drops optional nulls; it coerces `42` to `"42"`). A command that ran is always an ordinary failure. An explicit `null` intent field means "not declared" in the shared validator, and the intent schemas admit it, so both sides read the same input.
- **Orphaned and lost runs.** Subagents defer running observation gaps only while the run is `running`. After an orphaned or lost run's health callback, later gaps are delivered promptly (once, by receipt), because no further callback may follow.
- **Background-task intent.** `bg_task_spawn`, `bg_task_watch`, and `bg_task` accept `operation_id` and `expected_exit_codes`. The parent agent launches these commands itself, so the declaration is trusted. They are validated before launch with the shared validator. A declared exit code is recorded as expected. A later task that succeeds with the same `operation_id` (same kind, cwd, and SSH target, and the same owner: an equal non-empty session id, or for sessionless tasks the same spawning process, #312's rule), and that started after the failure, recovers the earlier task's unresolved failures; observation gaps and expected failures are left alone.
- **Budget-safe terminal notes.** The terminal summary never exceeds its budget and is made of whole lines. It drops, in order: incident rows, lower-priority notes (history, expected, earlier reported), the cursor's retrieval hint, the unclassified count, the cursor, and the count line. The correctness note is kept whenever it fits.

## Scope and limits

This provides assurance for supported structured evidence. It cannot prove semantic task correctness from exit zero, detect failures a producer never reports, or declare an arbitrary prose claim verified. Lifecycle remains independent of the observations. Per-consumer adapters must explicitly document which evidence they support, and classify gaps instead of silently treating unsupported evidence as success.

The shared module does not kill processes, infer arbitrary stdout errors, change task acceptance criteria, or parse prompt text into runtime deadlines.

## Verification

The common contract suite covers unrelated successes, explicit recovery, repeated incidents, replay, expected failures, interrupted journals, bounded summaries, and separate delivery receipts. Both vendored consumers execute the same contract cases. Consumer integration tests cover native events, visible surfaces, condition evaluation, retry ordering, actual session-start notification replay, failed-write recovery, unreadable metadata deferral, and the original stale-progress incident pattern.
