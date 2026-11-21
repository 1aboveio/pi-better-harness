# Background tasks stop when their assignment ends

> Decision history. The current Background task ownership and cleanup policy is maintained in [ADR 0028](0028-background-task-policy.md#execution-and-ownership).

Status: accepted decision; implementation pending.

## Decision

When the coordinator commits a terminal outcome for a subagent assignment, its supervisor must stop any still-running background tasks owned by that assignment. This applies to successful completion, final failure, and explicit cancellation. A background task with no remaining execution owner should not keep running. This extends [ADR 0020](0020-observed-waits-retain-an-owner.md), which defines ownership and the terminal assignment outcome.

The assignment is the boundary, not the process or saved conversation. A parked worker has no running attempt but still owns its work. Parking, a recoverable attempt failure, extension reload, and service restart do not trigger cleanup. Automatic continuations retain ownership; a new assignment in the same conversation does not inherit it.

## Consequences

- Stop tasks only when their recorded ownership ties them to the ending assignment. Leave parent-owned tasks, other assignments' tasks, and tasks linked only as dependencies alone. If ownership cannot be proved, report that gap and do not signal the task.
- Record the obligation to stop owned work as part of ending the assignment. Use the ordinary supervised stop path rather than assuming that terminating the worker also terminates its task runners. Keep logs and terminal evidence. Replaying cleanup after a restart must not repeat side effects or affect a newer task.
- A stop request is not proof that a task has exited. Keep unfinished cleanup visible and recoverable until the supervisor confirms termination or reports what it cannot verify. Do not present an assignment as fully cleaned up while any owned task is still running or its state is unknown.
