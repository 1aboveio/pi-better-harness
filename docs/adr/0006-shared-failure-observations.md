# Shared failure observations independent of run lifecycle

## Status

Accepted.

## Problem

A subagent can remain alive after a tool fails. Its output previously preferred cached assistant progress over newer tool-error evidence. Background watchers have separately needed fixes for silently ignored condition-evaluation failures. Process lifecycle, observation health, work outcome, and notification delivery are different facts; a single running/completed status cannot represent all of them.

## Decision

A private `failure-observations` module owns the common observation contract, reducer, durable append-only journal, priority summary, and notification eligibility/receipt rules. Its implementation is vendored into subagents and background tasks through the existing shared-module sync mechanism, so independently published consumers use the same behavior without another runtime package dependency. Consumer adapters translate their native structured events and retain ownership of process lifecycle, origin routing, and callback scheduling.

The journal lives beside each run/task's metadata. A `.observed` companion marker makes a subsequently missing journal distinguishable from a run with no recorded failures, even after restart. It contains bounded summaries and evidence references, not copies of arbitrary stdout or assistant prose. It is independent of lifecycle metadata so unrelated metadata writes cannot erase failure evidence. Event IDs are stable across replay. Duplicate events do not reopen recovered incidents. A leading newline on each append isolates any previous partially written record; malformed records preserve usable evidence and produce an explicit observation-incomplete state.

An operation may be running while it has unresolved failures. A successful command may resolve an incident only through an explicitly referenced matching operation, with the adapter establishing that it is a later retry rather than a concurrent or unrelated success. Text such as “tests passed” is not recovery evidence. Repeated failures of the same unresolved operation form one incident, preserving its first observation and latest evidence.

Expected failures require explicit structured producer metadata. They remain visible but do not request attention. The system does not infer expectedness from natural language. A later unexpected failure can open an actionable incident even when earlier failures were expected.

All reporting surfaces put the common failure summary before ordinary progress text. Bounded summaries prioritize unexpected failures and explicitly count additional retained observations. Missing, unreadable, or truncated evidence cannot be reported as proof of health.

Notification receipts are separate from observation and recovery. A successful handoff records which incidents were delivered; merely preparing or attempting a callback does not. Temporary errors reading delivery or ownership state defer the handoff rather than recording permanent suppression; an explicit ownership mismatch still suppresses delivery to the wrong session. Running unresolved incidents become eligible after a grace period; terminal failures and broken observation can be eligible immediately. Existing callback batching and origin routing are reused. `callback:false` disables unsolicited delivery, not failure visibility. Reload must recover pending observations/receipts. Delivery is at least once: a crash between successful handoff and receipt persistence can cause a duplicate; it must not cause silent loss.

Failed writes retain every pending event and receipt in process memory and retry on subsequent reads. Pending receipts prevent repeated handoffs within that process; a visible observation-incomplete state remains until persistence succeeds. While storage is unavailable, this memory-only backlog cannot survive process loss. The existence marker can still report that evidence is missing when it was written successfully. Journals and markers follow existing run/task retention and explicit cleanup.

## Scope and limits

This provides assurance for supported structured evidence. It cannot prove semantic task correctness from exit zero, detect failures a producer never reports, or declare an arbitrary prose claim verified. Lifecycle remains independent of the observations. Per-consumer adapters must explicitly document which evidence they support, and classify gaps instead of silently treating unsupported evidence as success.

The shared module does not kill processes, infer arbitrary stdout errors, change task acceptance criteria, or parse prompt text into runtime deadlines.

## Verification

The common contract suite covers unrelated successes, explicit recovery, repeated incidents, replay, expected failures, interrupted journals, bounded summaries, and separate delivery receipts. Both vendored consumers execute the same contract cases. Consumer integration tests cover native events, visible surfaces, condition evaluation, retry ordering, actual session-start notification replay, failed-write recovery, unreadable metadata deferral, and the original stale-progress incident pattern.
