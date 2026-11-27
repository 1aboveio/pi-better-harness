# Background task policy

## Status

Accepted. This ADR owns Background task execution, progress, waits and the conditions that produce notifications. The shared delivery contract governs routing, retries and receipts. [Notification delivery](0029-notification-delivery.md)

## Core invariants

- **Keep the original execution and owner.** A task has a stable identity, an execution owner and retrievable status, logs and terminal evidence. For supervised local work, reconnect to the recorded runner. An uncertain launch or a frontend restart cannot authorize rerunning the command.
- **Use observed progress.** New output or a changed watch result can demonstrate progress. Silence, a failed check and a terminal task outcome have distinct meanings. A stall alert or a periodic wait review leaves the task running and the wait pending. A configured task timeout is a separate execution limit.
- **Every wait has an owner.** Keep the dependency identities, wait generation and terminal revisions. Once all dependencies settle, the owner can inspect and acknowledge their outcomes, including failure, cancellation, timeout or loss. Cancelling a wait withdraws the wait only.
- **Keep evidence through handoff and cleanup.** A callback receipt records a notification handoff. The owner's acknowledgement records its interpretation of the wait. Parked assignments retain their tasks. At a terminal assignment outcome, stop only verified owned tasks and keep unfinished cleanup recoverable. [Observed waits](0020-observed-waits-retain-an-owner.md) · [Assignment cleanup](0025-assignment-terminal-task-cleanup.md)

## Execution and ownership

Use a Background process for a long-running command and a Background watch for repeated checks of an external condition. The parent can do independent work and then register a wait. The session or worker that owns the result interprets it. For example, a watch that observes CI reach a terminal state can succeed even when the CI run failed. [Execution concurrency](0016-unified-execution-concurrency.md) and [observed wait ownership](0020-observed-waits-retain-an-owner.md) define the shared rules.

For a supervised local task (`bgs_`), the detached runner executes the command. The canonical local server observes progress, imports terminal evidence, and arranges delivery to the recorded recipient. A frontend can close and later recover the same task. An ambiguous launch is reported as lost when the evidence warrants it. Starting another command requires a new launch. SSH and legacy `bg_` tasks use their existing execution adapters. [Unified server runtime](0023-unified-server-runtime.md)

Each new local launch uses the Background sandbox permissions captured at admission. The same permissions apply when observation resumes. [Sandbox policy](0027-sandbox-tools-and-permissions.md)

When a subagent assignment ends, the coordinator records a durable obligation to stop its still-running tasks. The supervisor verifies ownership before signalling a process, preserves its logs and reports cleanup as pending until it can establish the result. Cleanup survives restarts and applies only to tasks owned by that assignment. A parked worker retains its assignment and its tasks. [Original assignment cleanup decision](0025-assignment-terminal-task-cleanup.md)

## Progress and suspected stalls

Measure silence from the last observed progress, or from task start until the first observation. New process output advances progress. For a watch, a change in the observed result advances progress. Repeated identical results, poll timestamps, and log maintenance leave that time unchanged. Status and the navigator use the same progress evidence. The owning session's navigator shows active tasks throughout a wait, including when the server also has a pending callback to deliver.

By default, a running task becomes quiet after 60 seconds without progress and reaches suspected stall at 5 minutes. If the stall persists for a further 60 seconds and callbacks are enabled, notify the owning session once for that continuous period of silence. Include the task identity, elapsed silence, last available output or evidence reference, and the state of other dependencies in the same wait. New progress closes the incident. Another period of silence can then raise a new incident.

For a callback-enabled supervised local task in a parent wait, send a review
when the wait has seen no progress for the configured interval. Repeat at that
interval from the most recent review handoff while the same wait is pending.
`/harness-settings` exposes **Background wait review interval**. The default
is 10 minutes. `piBetterHarness.backgroundReviewIntervalMinutes` in the agent's
`settings.json` accepts whole minutes from 1 to 1440.

A review includes the task's total run time, time since observed progress, last
watch check and retained evidence. The parent decides how to respond. The
supervisor's review receipt is bound to the exact wait generation and progress
checkpoint. A restart can recover an overdue review without replaying all
elapsed intervals. Progress, cancellation, or termination retires the pending
review. The review leaves the wait and its terminal deadline in place.

## Waits and callbacks

| Event | What the owning session receives | Effect on a registered wait |
| --- | --- | --- |
| A running task qualifies for a stall alert | A health notification under the task's callback setting | The task stays running and the wait stays pending. |
| A pending wait reaches its review interval without progress | A review of the current evidence for that wait generation | The owner can inspect or act. The wait and its deadline stay in place. |
| Some dependencies finish | Their outcomes become available for inspection. The wait owns their completion delivery. | The wait stays pending while any dependency is running. |
| All dependencies reach a terminal state | The wait's completion notification, including failed, cancelled, timed-out, or lost outcomes | The owner inspects the exact terminal revisions and acknowledges the result. |

A callback-enabled task outside a registered wait sends its own completion notification. Cancelling a wait withdraws the wait. Stopping a task is a separate operation. A stall alert grants no authority to stop, retry, or acknowledge a task.

On reattachment, check that a pending stall alert still applies. Retire it if the task has progressed or finished. `callback: false` suppresses unsolicited task alerts while status and evidence remain available. The shared server and notification contract governs recipient selection, handoff, receipts and replay. [Notification invariants](0029-notification-delivery.md#notification-invariants)

## Failure evidence

A watch can remain running while its check fails. Record the failed observation and expose it to the owner. Before accepting a success match, verify that any configured failure condition could be evaluated and did not match. Missing or unreadable evidence is reported as incomplete.

The launching parent may declare `operation_id` and `expected_exit_codes` on `bg_task_spawn`, `bg_task_watch`, or `bg_task`. Validate intent before launch. A declared exit code counts as expected. A later successful task recovers earlier unresolved failures when it started after the failure and matches the operation ID, task kind, working directory, SSH target and owner. Ownership matches by nonempty session ID, or by spawning process for sessionless tasks. Expected failures and observation gaps retain their dispositions. [Shared failure observations](0006-shared-failure-observations.md)

## Acceptance criteria

- **Single dependency (fmm-express#2727).** A Gradle build emits one line and stays running. Advance time through the stall threshold and grace period. Verify the owning session receives the alert with that line while its wait is still pending. Reload after receipt and verify the same stall alert is delivered only once.
- **Periodic review.** Keep that supervised local task silent in a callback-enabled parent wait. Advance through two review intervals. Verify the parent receives a review at each interval and the wait retains its generation and deadline. Restart after several missed intervals and verify the supervisor delivers one overdue review. End the wait before the next handoff and verify the pending review is retired.
- **Multiple dependencies (fmm-express#2732).** An Android test fails, a CI watch observes a failed run reach completion, and a PostgreSQL check stays silent. Verify the parent receives the PostgreSQL stall alert while the wait is pending and the navigator still shows the running task. Cancel the PostgreSQL task and verify the parent then receives all three terminal results and can acknowledge their exact revisions.
- **Recovery.** Disconnect the parent before alert delivery. Reattach on the owning branch and verify a continuing stall is delivered. Repeat with progress or termination before reattachment and verify the obsolete alert is retired. With callbacks disabled, verify the stall remains inspectable.

The native acceptance test runs in the server CI shards. [Background stall acceptance test](../../packages/pi-better-server/test/runtime-background-stall.test.ts)
