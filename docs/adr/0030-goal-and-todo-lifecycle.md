# Goal and Todo lifecycle

**Status** — Accepted design. This ADR defines when the parent should keep working, wait, pause, resume or declare the objective complete. The Outcome & Todo bridge defines how the participating packages store and exchange that state. [Bridge and work ledger](0018-harness-outcome-todo.md)

The user interface calls the accepted objective a **Goal** and its steps **Todo**.
A saved Goal may have no execution record yet. Explicit pause or resume attaches
execution to the same saved Goal and preserves the checklist. The historical
`outcome` session entry and settings keys remain readable across versions.

## Core invariants

- **Keep the acceptance criteria attached to the objective.** Goal owns foreground execution and its lifecycle. When a Harness Outcome is bound, it owns the requested result, boundaries and `doneWhen` criteria. Todo records the steps toward that result. A workflow coordinator retains authority over its own plan. Goal also works without a Harness Outcome.
- **Keep unfinished work visible.** Todo records pending, in-progress, blocked and completed steps. A step with prerequisites can advance once those prerequisites are complete. Preserve the reason for blocked work and its next action. A rejected plan update leaves the previous plan intact. Replanning, compaction, reload or a display change must preserve required work. Restore the current branch's plan and any explicitly associated ledger.
- **Start or replace a Goal deliberately.** Saving an ordinary checklist records the plan. Automatic Goal creation from an Outcome requires the opt-in **Auto-start Goals** preference and a qualifying explicit save of an active, unbound Outcome with acceptance criteria. Reloading the branch or discovering a ledger does not start a Goal or replace a paused one.
- **Continue while useful work is available.** With automatic continuation enabled, an active Goal takes an available foreground step or waits on an identified dependency with an owner and an observable result. A parked worker, an idle foreground or a disconnected activity provider cannot prove that the work is finished. Treat unavailable coverage as unknown. Re-evaluate on an eligible activity change, deadline or reconnect. [Observed waits](0020-observed-waits-retain-an-owner.md)
- **Respect the reason execution is held.** A human pause, a budget limit and an exhausted no-progress retry allowance leave unfinished work intact. Resume through the action authorized for that hold. A callback can make evidence available while the Goal is paused. It cannot resume the parent or revoke work already delegated. [Pause and recovery policy](0012-actionable-permission-blockers.md) · [Server and notifications](0029-notification-delivery.md)
- **Require an explicit completion decision.** For agent-requested completion of a bound Goal, inspect each `doneWhen` criterion against an observed result and its source. If the Outcome has no listed criteria, verify its objective. Outstanding required Todo steps, open items in an associated active ledger, or an unmet applicable workflow gate keep the Goal open. An all-checked Todo, a scheduler's `finish`, a worker's exit or a received callback can support the audit. None proves the business outcome by itself. The direct human `/goal complete` command is a separate operator decision.

## Acceptance

1. Request deployment, a business-rule check and issue closure. Mark the deployment Todo done and let the scheduler report `finish`. An agent completion request must name the missing evidence and leave the Goal open. Once the checks, issue state and remaining required steps are accounted for, an explicit completion can succeed.
2. Leave a worker waiting for a Background task, disconnect its activity provider and reload the parent. Verify the Goal still shows unfinished work. When observation recovers, the owner can inspect the original result and continue without relaunching the task.
3. Pause the parent while delegated work is running. Deliver a terminal callback and restore the session branch. Verify the parent remains paused, the result is retrievable and authorized resume restores the same objective and Todo.
4. Exhaust a configured budget or the no-progress retry allowance. Verify the recorded reason and outstanding steps survive reload. No elapsed timer, checklist redraw or unrelated session can mark the Goal complete.
5. Try to complete a dependent Todo step while its prerequisite is open. Verify the update is rejected and the prior plan survives reload. Then finish all steps and verify that the Goal still requires its own completion decision.
