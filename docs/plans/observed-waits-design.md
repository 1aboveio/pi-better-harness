# Observed waits for parent sessions and worker conversations

> Superseded authority restriction (#708): passages below requiring an active
> parent session/branch or parent Goal admission for worker dispatch are historical.
> ADR 0018 and ADR 0020 now give delegated assignments independent continuation
> authority. Parent eligibility still gates parent turns and result delivery.

Status: proposed implementation design for the accepted invariant in [ADR 0020](../adr/0020-observed-waits-retain-an-owner.md). No APIs or states below are shipped by this document. Readers are maintainers implementing and reviewing the lifecycle. Terms follow the root [glossary](../../GLOSSARY.md).

## Keep ownership while moving observation out of model execution

A parent or worker starts an operation, registers its dependency, and yields when no independent work remains. The harness owns supervision and result delivery. The parent stays available for user input. A worker parks without holding an active subagent slot; the same conversation resumes in a new attempt after the operation settles.

The first implementation supports local process tasks and local command watches. A whole-application restart queues ready continuations until their owning parent session is activated and its gates permit execution. It does not start provider calls in an unattended daemon. Remote SSH supervision and arbitrary third-party tools require compatible adapters before participating.

No broad command classifier or timeout threshold is introduced. Necessary synchronous worker checks remain allowed. Model work that combines a mechanical wait with a detailed final report is divided at the observation boundary: observe in a background operation, then interpret the resulting evidence in the owning conversation.

## Existing mechanisms and gaps

The source references below describe the baseline inspected for this design. Concurrent changes in those modules require reconciliation during implementation.

| Area | Available baseline | Required extension |
| --- | --- | --- |
| Subagent continuation | [Saved sessions and recipes](../../packages/pi-better-subagents/session-store.ts), [continuation admission and writer leases](../../packages/pi-better-subagents/continuation.ts) | Parked-attempt finalization and dependency-triggered admission through the same continuation path |
| Capacity | [Attempt reservations](../../packages/pi-better-subagents/capacity.mjs) | Release only after the parked writer exits; queue ready continuations without reserving idle slots |
| Background execution | [Spawn/watch and task metadata](../../packages/pi-better-background-tasks/src/runtime.ts) | Supervision independent of the waiting child's lifetime, durable terminal evidence and restart reconciliation |
| Completion delivery | [Callback batching](../../packages/callback-batcher/index.ts) | A durable outbox addressed to a session or conversation, with idempotent consumption |
| Permissions | [Subagent policy](../../packages/pi-better-subagents/permission-policy.ts), [verified Background admission](../adr/0017-background-adapter-admission.md) | A guarded child-to-supervisor adapter; effective authority must not expand across the boundary |
| Outcome and Goal | [Outcome/Todo ownership](../adr/0018-harness-outcome-todo.md), [Goal implementation](../../packages/pi-better-goal/src) | Dependency references and waiting visibility without replacing workflow plans or bypassing human holds |

Current background scheduling is suspended when its owning session shuts down. Local processes may survive, but watches, collection and timers are not generally supervised independently; after Pi exits, a missing process may become lost rather than yielding a proven exit result. Therefore child tool availability must not precede the new supervision contract.

## Contracts exposed to the model

Keep existing `bg_task_spawn`, `bg_task_watch`, `bg_task_status` and `bg_task_log` contracts. In participating sessions, local launches pass through the supervisor adapter and return both the task ID and a durable operation reference. Existing `operation_id` remains caller-supplied intent for retry correlation; it is not a unique execution identity or permission grant.

Add a proposed tool with the same shape in the parent and supported workers:

```typescript
wait_for_operations({
  task_ids: ["bg_..."],
  continuation_note: "Read the build result; diagnose failure or continue packaging."
})
```

Initial semantics are all-settled: every listed operation must have a terminal outcome. Success, failure, cancellation and lost evidence all resolve the dependency; none implies assignment success. Only caller-owned or explicitly linked tasks qualify. The continuation note describes the next reasoning step and cannot change tools, model, role, permissions, workspace or authorization. Unknown IDs, incompatible supervision, conflicting ownership and a second pending wait generation refuse registration with a specific reason.

For a parent, the tool registers a durable pending dependency and returns; the session may continue independent work or yield normally. For a worker, the tool requests parking. The harness commits the conversation's tool result and checkpoint before cleanly completing the attempt with its park disposition. A partially recorded tool call must never become the checkpoint for automatic continuation. If the dependency is already settled, return its evidence references immediately and keep the attempt running.

Worker parking requires an explicit tool call. A final answer saying “waiting” is not sufficient. While a parking request is committing, prevent further worker tool dispatch. If public SDK lifecycle hooks cannot prove that the final tool result was flushed before process exit, the child must refuse parking; do not substitute an ordinary final response and pretend the dependency is durable.

### Parent merge example

The parent selects the established delivery adapter and starts the bundled stateful Mergify watcher with `bg_task_spawn`. It records `wait_for_operations` against the delivery milestone, then performs independent work or yields. The completion event brings the terminal verdict back to that parent. Only then does a model inspect merge/dequeue evidence, verify ancestry when needed, and decide whether diagnosis should be delegated.

The delivery adapter uses the skill's installed watcher and preserves its state and output contract. It does not rebuild queue logic as a stateless `bg_task_watch` predicate. The first design does not infer enqueueing or merge authorization from a request to observe. The parent retains the existing delivery flow and approval boundaries.

### Worker validation example

The worker starts a supported local build, registers its wait and parks. After build completion, the harness queues a continuation of its saved session with the task reference. When admitted, the worker reads terminal status/log evidence and continues the original assignment. The parent receives an assignment result only after interpretation; it does not relay commands or routinely interpret the child's build output.

## Runtime ownership and durable records

Use a small shared operation coordinator with no provider transport or tool execution of its own. Package it as a reusable internal library available to standalone Background Tasks and Subagents; do not make those packages depend on the Harness bundle. Background Tasks hosts one coordinator instance per Pi process, starts reconciliation on extension startup/session activation, and owns the supervisor transport and coordinator lease. Subagents registers a versioned continuation-admission capability with that host. Both standalone packages can load in either order; Subagents alone has no supervised-operation capability and refuses parking. On reload, unregister the old dispatch/transport handlers and release host claims; task runners continue, and the replacement host reconciles the journal before admitting new resumes. Runtime capability discovery uses a versioned event contract with verified source and schema identity, following existing adapter admission patterns. An incompatible or missing consumer refuses child background launch and parking, while existing synchronous tools remain usable.

Ownership is divided as follows:

| Component | Owns | Does not own |
| --- | --- | --- |
| Background Tasks | Task admission, execution runner, observation health, task result and logs | Subagent model selection or continuation |
| Subagents | Saved conversation, parked attempt, writer lease, capacity and continuation admission | Domain-specific merge verdicts or task shell execution |
| Shared operation coordinator | Dependency records, transition transactions, outbox and reconciliation leases | Provider credentials, launch authority or workflow outcomes |
| Harness / Goal adapters | Display, milestone links, human holds and parent wake eligibility | A second workflow plan or permission policy |
| Domain adapter | Correct observer command, domain transitions and structured terminal evidence | Permission escalation or autonomous mutation after observation |

Proposed durable storage is under the Pi agent directory, separate from reclaimable runtime logs. Use one SQLite database for dependency and outbox transactions; operation execution and native session persistence remain separate systems and are reconciled explicitly. Schema versions and migration failure are visible; an unreadable or newer database disables this feature without deleting records.

Minimum logical records are:

- **Operation:** unique execution ID, task ID, launch token, owner reference, observer kind/version, supervision identity, current phase, authority reference, timestamps and terminal evidence references. Retain no provider credentials or secret environment values in the coordinator store.
- **Wait:** unique wait ID, conversation or parent session identity including workspace, generation, dependency IDs, phase, original attempt, checkpoint identity, continuation note and cancellation epoch. Record the parent branch/goal/workflow binding when present; completion must not attach to an abandoned branch or unrelated outcome.
- **Outbox event:** unique operation terminal revision, wait generation, recipient, evidence references, dispatch claim and acknowledgement. Retain delivery attempts and recovery reasons without marking an unread result consumed.
- **Resume claim:** wait generation, launch request token, current attempt ID when published, lease owner and recoverable process identity.

Terminal evidence required for interpretation must survive ordinary task-log cleanup while an unconsumed wait references it. Pin bounded summaries and retained log artifacts; if retention limits remove detail, preserve the terminal outcome and disclose lost detail. Never recreate an exit code from a missing PID. Release evidence pins after consumption or explicit dismissal, according to the existing cleanup policy.

## Supervision outlives the child, without an always-running model

Child requests go to a supervisor hosted outside the child's process group through a verified local transport. The child does not load unrestricted background execution code to escape its task sandbox. The supervisor validates a parent-issued, run-scoped capability, request identity and current permission snapshot. Endpoint possession alone is not authorization.

A local task runner owns one process or command-watch loop and writes logs and a terminal record independently of the Pi session. Launch it from the supervising host in a separate owned process group so stopping the subagent cannot accidentally kill its task. The runner owns per-command limits, watch cadence and stop handling. A watch runner retains its own transition state when the domain needs it.

The runner survives worker exit and parent session switching. It must also record terminal evidence if Pi exits while it is running. After restart, the coordinator reconciles durable records with runner identity, result files and launch tokens. If a runner has disappeared without terminal evidence, mark lost and request interpretation; never automatically rerun a possibly side-effecting command.

This is new runtime work, not a claim about current `spawnTask` durability. The implementation must choose a supported standalone runner entrypoint and prove persistence, process-group ownership and result attestation on macOS and Linux. Whole-machine restart does not promise continued local execution. Unobserved outcomes become lost/needs-attention rather than invented success.

## Transitions and races

The wait phase and the attempt lifecycle are separate. Proposed wait phases are `registering`, `parking`, `waiting`, `ready`, `resuming`, `consumed`, `held`, and `cancelled`. `held` carries a reason such as unavailable owner, permission change or missing history. Observer health is separately reported as active, unmonitored or lost; a wait does not appear healthy merely because it exists.

A parked worker's attempt finalizes cleanly as `completed`, with a durable park disposition linked to its wait generation. This records completion of that execution attempt, not completion of its assignment. Reuse today's completed-attempt archive and continuation eligibility; do not park by killing the child or add a second continuation path. Update navigator, result delivery, health and Goal projections to distinguish a completed attempt with an outstanding wait from a completed assignment. Ordinary completed and stopped conversation continuation remains compatible. Activation requires a versioned capability handshake, and older runtimes must visibly refuse management of unsupported pending wait records.

### Launch and park

1. Persist a launch intent and unique execution token before starting the runner. The runner claims that token before executing. If launch acknowledgement is lost, reconcile the same token; do not issue another execution.
2. Register dependencies under the conversation transaction and read their current terminal revisions in that transaction. A task that finishes before registration is therefore not missed.
3. Persist the wait generation and checkpoint intent in `registering`, acknowledge the tool result into the native conversation, then enter `parking` and request attempt finalization. Here, a conversation transaction means a coordinator-database transaction keyed by conversation ID under its coordination lease; it cannot atomically commit the native session. The dependency cannot reach `waiting` or `ready` until checkpoint identity and writer exit are proven.
4. Release the conversation writer lease and active capacity only after the original writer is quiescent. If a dependency settled during parking, move directly to `ready` after that release. Otherwise enter `waiting`.

The native session, task runner and coordinator database do not share an atomic transaction. Recovery must reconcile the persisted intent with the session checkpoint and live writer identity; uncertainty becomes `held`, not a guessed fresh session. External command execution is not claimed to be exactly-once. Token claims prevent known duplicate launches, and ambiguous crash windows require reconciliation without automatic retry.

### Completion and continuation

Persist each terminal operation revision before enqueueing result delivery. Duplicate events and reload replay create at most one ready transition for a wait generation. A supervisor lease fences competing coordinators; leases are validated with process identity, not elapsed time alone.

For a parked worker, claim the wait generation, reserve capacity using ordinary Subagents admission, acquire the conversation writer lease, and enter the existing continuation launcher. Before spawn, persist the chosen new attempt ID, launch token and reserved native checkpoint in the resume claim and launch intent. Extend the child bootstrap to publish its process identity and matching token before admitting model execution. Use that known attempt ID and token to reconcile a crash after launch but before normal metadata publication; do not discover attempts by fuzzy name matching or command text. If the bootstrap, live writer lease or attempt record identifies the execution, recover it. If the records cannot prove whether a writer started, hold for recovery rather than launching again. Admission failures proven to precede spawn release temporary reservations and return the dependency to `ready` or `held` with a reason.

After reserving capacity and acquiring the writer lease, re-read the wait generation, cancellation epoch, parent binding, human holds and current permission revision immediately before releasing the bootstrap to model execution. A changed revision invalidates the admission and requires a fresh check. A concurrent cancellation after release is handled by stopping the published owned attempt; it cannot promise that no instructions or side effects ran between release and stop.

For a parent, queue a callback to the exact session and branch binding. Inactive sessions keep pending delivery until activation. An active model run receives the event through the existing safe message queue, not by concurrent transcript writes. New automatic worker dispatch requires that exact parent session and branch to be active and eligible at its final admission check. Switching away after an attempt is admitted prevents further dispatch for that owner but does not stop already admitted work; explicit cancellation or applicable execution-revocation policy can stop it.

Use one proposed acknowledgement tool for both owners: `acknowledge_operation_result({wait_id, generation, terminal_revisions, disposition, note})`. Allowed dispositions are `continue`, `blocked` and `assignment-complete`; the tool records an interpretation note against the exact evidence revisions and marks that wait consumed. The final disposition does not itself complete a Goal, workflow or assignment; their existing completion checks still apply. Require an evidence read by the current owner and a persisted note before accepting acknowledgement. Callback emission or a status read alone is not consumption. Retain evidence pins until acknowledgement or explicit cancellation/dismissal. If a resumed attempt fails first, hold its pending wait with the failure reason; do not create an unbounded automatic resume loop.

Queue ready workers in persisted FIFO order across eligible owners of the supervising parent. Recheck capacity at dispatch; dependency waiting reserves no slots. Today's capacity gate is process-local, so this proposal makes no machine-wide slot guarantee. A cross-process owner lease prevents competing parents from resuming the same wait; it does not pool their capacity. Continue ready independent work as required by ADR 0016. Paused owners, permission holds and unavailable workspaces stay held and do not block other eligible continuations.

Manual continuation of a parked conversation requires an explicit takeover action that cancels or transfers its pending wait generation under the same conversation transaction. Refuse an ordinary manual launch that would leave an automatic resume armed for the same assignment. Cleanup must pin the saved history and owned workspace while a pending wait depends on them; existing deletion and workspace permission rules still apply. Missing history or a removed workspace holds the wait without creating replacement history.

## Permissions, cancellation and user control

A child-launched operation must satisfy both the worker's captured task authority and the current Background profile. The effective authority is their intersection, never the parent's broader access. A changed profile may tighten future commands and resumes; mandatory revocation follows the permission system's explicit semantics. No background adapter may silently discard file, credential-file, command, shell, network or time controls. Unsupported combinations refuse launch.

Continuation runs through current mandatory admission while preserving the saved role, model, tools, workspace and verified implementation recipe. A permission change that makes the recorded recipe incompatible holds the wait and exposes the reason. Preserve any explicitly supplied absolute assignment deadline across parking and resumption; a new attempt must not silently extend it. Existing per-attempt limits and command limits remain distinct, with no new default deadline. An expired assignment deadline holds continuation for its owner's decision. Background completion does not authorize enqueueing, merging, pushing or any new mutation. Goal pause, human approval holds and workflow gates remain authoritative, including when Outcome/Todo hooks are off.

Cancellation semantics are explicit:

- Stopping an active attempt keeps today's stop meaning. Parking is not expressed as `subagent_stop`.
- Cancelling a parked assignment increments its cancellation epoch and invalidates pending resume claims. A task completion racing cancellation cannot resume the old generation.
- Stopping a task records cancellation and resolves its dependency for interpretation. This internal resolution must occur even when user-facing Background callbacks for cancellation are suppressed. It does not imply a successful assignment.
- Cancelling a wait detaches observation ownership; stopping its operation is a separate explicit choice, particularly for shared observers. No operation may remain silently unowned: display it as detached/needs-attention or transfer ownership explicitly.
- If continuation has already started when cancellation wins, stop the owned new attempt and suppress further automatic resumption. Preserve any changes and evidence it already produced; cancellation cannot roll them back.

## Parent routing and visibility

Supply one concise execution rule at the existing policy seam: established commands and repeated observation use background operations; model judgment runs before or after them. Domain adapters provide validated observer recipes. Do not ask the parent to invent a polling script for each delivery.

A linked milestone waiting on an external event must reference a live observer and its execution owner. A settle-time invariant check can verify registered dependencies against supervisor health. It reports `unmonitored` when the observer is absent or unhealthy and offers the specific repair path; it does not auto-launch commands or claim to infer every wait from prose. Unstructured claims such as “I will watch the merge” cannot be mechanically certified. Structured delivery entry points must register the observer before presenting a healthy waiting state.

The existing background-work navigator shows operation state and owner; worker conversations show `waiting for <task>` or `ready, awaiting slot`. Keep attempt status separately available. Cancellation, loss of supervision, held permissions and pending results remain visible across reload. No artificial heartbeat tool calls or model turns keep a wait alive. Do not mark an outcome or Goal complete until relevant terminal evidence has been inspected and integrated through its existing authority.

## Delivery slices and acceptance evidence

Each slice is independently reviewable. Later slices depend on earlier runtime guarantees; do not expose child tools before their prerequisites pass.

| Slice | Deliverable | Required evidence |
| --- | --- | --- |
| 1 | Durable operation/dependency store and reconciliation contracts | Duplicate terminal events, missing owner, schema mismatch, cleanup pins and crash recovery preserve records without launching work |
| 2 | Local runner and parent operation integration | Session switch and Pi exit preserve task execution/result capture; real process identity and macOS/Linux termination tests; existing command permissions remain enforced |
| 3 | Structured parent delivery waits and domain adapter | Replay session `01a1a186-2daa-7346-ac9e-24b10043ade9` with enqueue separately preauthorized by the fixture: enqueue followed by registered bundled watcher, zero model polling workers, terminal verdict routed for interpretation |
| 4 | Worker bridge, park checkpoint and capacity-aware continuation | Real subprocess starts a task, parks, releases its slot only after exit, resumes the same native conversation once, and interprets both success and failure |
| 5 | Recovery, cancellation, display and compatibility | Races below, workflow/human holds, standalone installs, both extension orders, old-record refusal and visible unmonitored waits |

Exercise task completion before, during and after park; parent shutdown while a task runs; crash after runner launch but before acknowledgement; crash after continuation launch but before its attempt link; duplicate callbacks; simultaneous resume claims; full capacity; cancelled owner; stopped observer; lost runner; missing workspace/history; tightened permissions; inactive or branched parent; output retention loss; and unsupported adapter versions. For each case assert the persisted phase and reason, live writer/runner count, capacity reservations, pending evidence and next eligible action. In particular, ambiguous launch recovery must yield a held record with no second launch; successful interpretation must acknowledge the exact revision before releasing evidence pins; and a completed parked attempt must remain unfinished in every assignment projection. Failure must not block unrelated ready work unless a shared constraint is demonstrated.

Live model evaluation remains separate from deterministic lifecycle proof. Use realistic tool responses, valid domain watcher conditions, multiple repetitions, and explicit provider-error accounting. Measure initial routing, schema and semantic validity, foreground sleep/poll attempts, callback handling and final failure reporting separately. The earlier simulator establishes a routing hypothesis, not production reliability or a sustained-wait acceptance gate.

## Deferred decisions

The invariant is accepted; the proposed interfaces, module split and storage schema require implementation review. V1 deliberately queues continuations while the owning parent is inactive, rather than running models without an active owner. Remote adapters, cross-owner observer sharing, pause-time accounting and automatic recovery of a failed continuation are follow-on work. Their absence must produce an explicit unsupported/held state, not a fallback that keeps a model sleeping.
