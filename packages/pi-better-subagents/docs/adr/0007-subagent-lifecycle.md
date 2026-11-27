---
status: accepted
date: 2026-11-22
---

# Subagent lifecycle, preservation and delivery

This ADR defines the contract between a subagent, its supervisor and its parent. The following guarantees apply to every assignment, including read-only research, non-Git tasks, caller-owned directories and isolated Git checkouts.

- **Preserve recorded work.** The parent can recover results, supporting evidence and the last known verification state across execution attempts, even if the worker exits before sending a final message.
- **Deliver the requested outcome.** The parent can retrieve a durable result describing what the worker accomplished and what remains. The assignment determines the deliverable. It may be an answer, a report, generated files or code changes. All use the same result and notification contract.

## From launch to a terminal outcome

| Transition | Contract |
| --- | --- |
| Launch | Bind the requested work to its owner, worker conversation and execution attempt. A launch receipt identifies the attempt and its scope. |
| Run | The worker records findings, outputs and checks against the assignment. Each attempt retains its own evidence. |
| Wait and continue | A parked attempt can exit and release its slot. The pending operation, its owner and the state needed to resume survive reload and runtime restart. On resumption, one writer continues the conversation and interprets the recorded operation result. [Observed waits](../../../../docs/adr/0020-observed-waits-retain-an-owner.md) |
| Finish | For a bound assignment, the coordinator records its terminal outcome from the completion judgment and retained evidence. An exit code, a resolved dependency or a Git commit alone cannot establish completion. Failed and cancelled assignments can still have useful work to deliver. [Assignment progress and completion](../../../../docs/adr/0022-assignment-progress-projection.md) |

## Limits during the lifecycle

The harness records the effective timing policy when it admits an attempt. Changing a default applies to future launches. Automatic continuation carries forward the remaining time up to the original 24-hour deadline. The same controls apply in every workspace mode. [Run timing and precedence](0004-harness-owned-run-timing.md)

| Control | What happens at the limit |
| --- | --- |
| Admission capacity | The concurrency cap (default 6) limits new admissions. If a batch exceeds available slots, its policy either refuses the batch or admits the jobs that fit and reports the rest as skipped. A ready continuation can wait for a slot. Lowering the cap lets existing runs finish. |
| Run timeout | At the hard ceiling (default 60 minutes), the supervisor stops the run, including during a tool call or a soft-deadline grace period. The stop reason is `ceiling`. The 24-hour maximum applies to all runs. |
| Soft deadline | When explicitly set, the deadline asks the worker to save its work and report. Delivery can wait behind an open tool call. If the run is still active when grace expires (default 5 minutes), the supervisor stops it with reason `deadline`. |
| Tool-wait and no-progress alerts | An open tool call (default 5 minutes) or lack of progress (default 10 minutes) can notify the owner while the run continues. Time inside an open call is excluded from the no-progress window. Model turn count does not trigger a stop. |
| Operation limits | Sandbox permissions govern the individual operation. A configured command time limit can stop that command even when the run has **24 hours**. The worker or parent interprets the operation result and decides whether the assignment can proceed. |
| Result page size | A bounded result read returns a page. The parent can use its continuation cursor to retrieve more of the recorded result. |

When a limit stops a run, the parent can retrieve the stop reason, the available work and which checks remain unverified through the ordinary delivery path. A timeout supplies no evidence that the interrupted check passed or failed.

## Result and delivery

The parent uses the run ID with `subagent_result`. The result identifies the outcome and any stop reason, gives the requested answer or retrievable references to the outputs, and reports the evidence, verification status and remaining work relevant to the assignment. For example, a read-only review can deliver findings with source references. A timed-out file conversion can deliver the completed files and identify which inputs remain. An interrupted check stays unverified. Partial work remains inspectable even when the attempt is ineligible for continuation.

Record the result before sending a completion callback. The callback identifies the run and tells its owner where to retrieve it. With `callback: false`, the same result remains available on demand. The parent inspects the deliverable against its own acceptance criteria. Routing, retries and receipts follow the shared contract. [Notification delivery](../../../../docs/adr/0029-notification-delivery.md)

## Recovery and cleanup

- After an interruption, recover from durable evidence. If the outcome of an external action is unknown, surface that uncertainty before attempting it again.
- Before a handoff or automatic cleanup would remove the only usable copy, verify that the saved state can be recovered. If saving or restoring fails, retain the source, report where it is and allow recovery to be retried.
- Reclaim harness-owned scratch only after the work is recoverable and active writers or pending waits have released it. Retry interrupted cleanup safely after restart. Caller-owned directories stay under the caller's control.

## Acceptance

1. Interrupt a read-only investigation after it records a finding but before it sends a final message. After restart, retrieve the finding and the interruption reason by run ID without requiring a repository or an output file.
2. Cancel a non-Git task after it writes a deliverable and starts verification. Retrieve that deliverable and the incomplete verification status. Exercise both a caller-owned directory and harness-owned scratch.
3. Park a worker on an external operation and restart the runtime. Its owner can recover the recorded work, observe the original operation and continue without submitting it twice.
4. Interrupt a handoff or cleanup before the saved result is verified. The source remains recoverable. After a successful retry, the parent can retrieve the result and cleanup can reclaim the owned scratch.
5. Complete a read-only review, a non-Git file task and isolated Git tasks in Clone and Worktree. Retrieve each requested deliverable through `subagent_result`. Repeat with callbacks disabled and with a failed notification handoff followed by restart. Verify that each result stays available and that retrying an enabled callback refers to the same completion and recipient.
6. Use a controlled clock and a long verification command. The tool-wait alert leaves the run active. At the hard ceiling the result reports `ceiling`, preserves the saved output and identifies verification as incomplete. With **24 hours**, the same command can pass that point. Separately, deliver a configured soft deadline, advance past grace and verify the `deadline` reason through the same result path.
7. Fill the available slots while a continuation is ready. Verify that the continuation keeps its owner and saved state, that admitted runs continue, and that the continuation can resume when a slot becomes available.
