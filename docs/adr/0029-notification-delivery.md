# Shared server and notification delivery to the owning session

**Status** — Accepted. This ADR defines how the local shared server supervises work and recovers pending notifications, and how the receiving frontend delivers them to the owning session. It covers subagent and Background task completions, health alerts and wait notifications. Each producer defines when an event is due. Goal decides whether the foreground may continue. [Goal and Todo lifecycle](0030-goal-and-todo-lifecycle.md)

## Server lifecycle and recovery

1. **One authority per canonical Pi agent directory.** Local frontends use the shared runtime on demand. Ordinary foreground startup can register tools before a connection is needed. A lightweight client does not acquire a hosted session. The server handles admission, shared reads and mechanical supervision. Domain records, the task runner and its verified writer retain their respective authority. [Unified server architecture](0023-unified-server-runtime.md)
2. **Establish ownership and compatibility before admitting work.** Handshake and negotiate the required capabilities. A draining server refuses new launches. A client that loses the reply to a launch reconciles its original request or task identity before proceeding. Reconnect, upgrade and notification recovery cannot authorize a second execution.
3. **Treat failed observation as unknown.** For example, `runtime_background_tool timed out` means the caller lacks a fresh answer. A subscription timeout, read-worker failure or disconnected socket supplies no evidence that a task list is empty, an assignment finished or a wait settled. Re-establish the subscription for its recorded scope and obtain an authoritative snapshot before advancing the view. After system sleep, allow a fresh health-check window before declaring a read worker unresponsive.
4. **Recover work and delivery independently.** On replacement, check the recorded runner and writer identity, recover the task's evidence and eligible pending notifications, and recheck the recipient before handoff. Closing the frontend can delay delivery while a supervised local runner continues. The server may exit when no clients, retained hosted sessions or actionable supervision remain. Completed history alone does not keep it alive. Recovery is bounded and leaves durable state available for the next explicit connection.

## Notification invariants

1. **Record evidence before notifying.** A completion points to the durable result. A health alert or wait review identifies the observed condition and where to inspect it. Keep the notification bounded. The owner can retrieve the underlying evidence while delivery is delayed or when unsolicited task callbacks are disabled.
2. **Route to the recorded recipient.** Bind the logical event to its producer, source identity and intended session and eligible branch. For a wait, include its generation. An unavailable recipient leaves eligible work pending. Reopening the same directory in a different session never transfers delivery.
3. **Recheck before handoff.** Confirm recipient eligibility, the applicable callback setting and, for a conditional alert, that its condition still holds. Retire an obsolete alert after progress, cancellation or termination. A new incident, or a later review explicitly due under the wait policy, has its own identity.
4. **Persist receipts after handoff.** Refused or failed handoffs remain retryable. Reload and reconnect recover pending events and consult existing receipts. Delivery is at least once. A crash after the recipient accepts a message but before the receipt is durable can cause a repeat. Reconcile recipient evidence where available and reuse the original event identity. A repeat must not launch the task again, consume a wait or create another completion.
5. **Keep attention separate from acceptance.** The callback tells the owner what to inspect. Receiving or reading it does not verify success, acknowledge a dependency, accept a deliverable, stop work or complete a Goal. Those decisions belong to the execution owner and use the recorded evidence. [Observed waits](0020-observed-waits-retain-an-owner.md) · [Failure observations](0006-shared-failure-observations.md)

## Delivery behavior

Ordinary subagent and Background completions on the same host can share a bounded batch. The default waits for an idle recipient and sends a follow-up. With **Steer active run** selected, the batch can join a busy run at an eligible boundary after active tool calls finish. Urgent health alerts keep their own delivery path. Each included event keeps its own identity and receipt. Overflow remains pending for a later batch.

If the recorded session and branch are attached but Goal prevents a new model turn, an eligible terminal assignment notification still appears there. The frontend records the handoff with `triggerTurn: false`. If the recipient is detached, the event stays pending until the session can receive it. [Terminal assignment outcomes](0020-observed-waits-retain-an-owner.md#terminal-assignment-outcomes-710)

For a registered all-settled wait, the wait owns completion delivery. Individual results remain inspectable while other dependencies run. Health alerts and periodic reviews can reach the owner during that wait. The owner interprets the exact terminal revisions before acknowledging the wait. [Background task policy](0028-background-task-policy.md#waits-and-callbacks)

## Acceptance

- Start a fresh local frontend with no runtime consumer, then request managed work. Verify it connects on demand. During a server drain, a new launch receives a refusal. If an earlier launch lost its reply, reconnect and reconcile it without executing the command twice.
- Interrupt a scoped subscription while a task is running. Verify the client reports unavailable coverage until it refreshes the snapshot. Reattach after the runner finishes and verify the original result and any pending notification reach the eligible recipient. A read outage alone cannot finish the Goal.
- Finish a subagent and a Background task while the parent is busy. Verify a compact batch reaches the eligible session at the configured boundary and both results can be retrieved independently. Repeat with task callbacks disabled and inspect the results on demand.
- Disconnect the owner before handoff, open another session in the same directory, then reattach the owner. Verify the other session receives nothing, and the original event is recoverable on the eligible branch.
- Refuse a handoff, then retry. Exercise a crash on each side of receipt persistence. A durable receipt suppresses replay. Any repeat in the unconfirmed window refers to the same event and leaves the task outcome and wait acknowledgement unchanged.
- Queue a stall warning during a multi-task wait, then let progress resume before delivery. Verify the obsolete warning is retired. Let all dependencies settle, including a failed dependency, and verify the owner receives the wait result and can acknowledge it separately.

The shared-batch tests exercise availability and handoff, and the coordinator tests exercise pending callbacks across restart. [Callback batcher integration](../../packages/callback-batcher/integration.test.ts) · [Background parent callbacks](../../packages/operation-coordinator/tests/background-parent-callbacks.test.ts)
