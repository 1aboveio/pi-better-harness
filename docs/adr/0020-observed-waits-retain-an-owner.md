# Observed waits retain an execution owner

## Status

Accepted invariant. The user approved recording this decision after inspecting parent merge monitoring and worker continuation behavior. The [lifecycle design](../plans/observed-waits-design.md) is proposed; recording this ADR does not enable automatic continuation or change permissions.

## Decision

### Assignment-local continuation (#708)

An assigned worker retains execution authority independently of its parent's
Goal and active session or branch. Its captured recipient is delivery identity,
not execution authority. A compatible supervisor may resume the same saved
conversation without activating that parent. Parent Goal pause, completion,
clearing and replacement affect parent execution only.

Admission preserves captured scope and intersects current mandatory permissions;
missing expected permission authority is a refusal. Exact wait generation,
cancellation epoch, launch token, writer safety and capacity remain mandatory.
Parked workers reserve no slot after proven writer exit. Without a compatible
host, ready work remains queued. Legacy pending records retain their captured
policy; absent policy is refused rather than reconstructed from a new parent.
Cross-package capability negotiation must explicitly refuse incompatible hosts.
This slice adds no repair loop, terminal outcome store or always-running daemon.

**A workflow waiting for an external event must have a registered observer and an owner to receive its result.** The observer performs mechanical execution or state observation. The owner is the parent session or worker conversation that interprets the terminal evidence and decides what happens next. A registered observer must have a recoverable supervision path; an identifier pointing to an unsupervised task does not satisfy the invariant.

Use background operations for established commands and external waits. Use model execution for judgment before an operation and interpretation after it. A worker may retain necessary synchronous checks, including long ones; duration alone does not determine ownership. A command-only polling assignment does not become model work because its requested final report is detailed.

A waiting parent remains responsive. A waiting worker may end its execution attempt while preserving its conversation and assignment, then resume in a new attempt when its dependency resolves. Waiting is neither completion of the assignment nor a stalled model. A terminal observation makes evidence available; the owner must interpret it before claiming success. Failure, cancellation and lost execution evidence also require explicit resolution.

## Context and trade-off

Session `01a1a186-2daa-7346-ac9e-24b10043ade9` used background delivery watchers, then delegated merge monitoring to a Bash-only subagent that made 33 Bash calls, including repeated sleeps, before the user corrected it. The parent combined mechanical waiting with a rich final report. Keeping these phases separate preserves model ownership without paying for model turns to observe unchanged state.

Existing saved-conversation continuation provides history, a new attempt, writer exclusivity and fresh admission, but no automatic dependency-triggered continuation. Existing background supervision is session-bound. This decision therefore requires durable dependency and supervision work; adding tool names or instructions alone is insufficient.

This extends [ADR 0016](0016-unified-execution-concurrency.md). That ADR introduced scheduling guidance without an automatic scheduler; the proposed lifecycle adds narrowly scoped dependency-driven resumption. It preserves the workflow and Goal authorities in [ADR 0018](0018-harness-outcome-todo.md) and the verified tool boundaries in [ADR 0007](0007-trusted-runtime-task-boundary.md) and [ADR 0017](0017-background-adapter-admission.md).

## Consequences

## Coordinator Outage Observations (#712)

Conversation storage retains version-1 observation reports under its existing
durable root. A report identifies the assignment, wait generation, published
claim and observed revision (cancellation epoch and exact dependency revisions
when available). Its content-addressed identity excludes error prose and time.
It is evidence for reconciliation, never a second wait scheduler or terminal
authority. A local unverified observation means Waiting, not a committed hold.

Compatible hosts advertise `outageReconciliation: 1`. Before parking, conversation
storage must accept a durable probe; failure refuses parking and reports degraded
supervision. Reports survive host replacement. Replay consults current coordinator
records, preserves consumed/cancelled generations, and uses existing fenced repair
and terminal-outcome transactions. A resolved report is a receipt of reconciliation,
not worker interpretation or parent consumption. It releases no pins or fences.
Crashes before that receipt replay the same claim; coordinator repair accounting
and terminal-event identity remain authoritative. Unsupported hosts retain reports
without claiming repair or durable delivery. Storage schema v4 remains unchanged:
the separately versioned evidence format adds no coordinator table.

A cancelled-publication observation has a distinct stable cancellation marker.
It may reconcile only the exact writer's exit and released lease, never repair
or execution admission. A held/disarmed coordinator wait or advanced cancellation
epoch does not suppress that proof. The cancelled cache and terminal outcome stay
immutable; observation receipts do not acknowledge the worker's dependency wait.

## Bounded Autonomous Repair (#711)

An unacknowledged published worker exit is reconciled against its exact claim,
launch token, cancellation epoch, saved checkpoint and proven writer/lease exit.
The coordinator records at most one repair per assignment, wait generation and
structured fault (category, original checkpoint and exact dependency revisions).
Attempt IDs, prose and observation times never define a new fault. Accounting
commits before the existing launcher can dispatch; capacity deferral and retries
of an existing launch token do not spend another allowance. Restart and host
replacement read the same accounting. Repeated faults commit the #710 terminal
failure and parent event without manufacturing interpretation. Explicit stop
disarms repair; uncertain writers retain their fences. No background command is
rerun. Missing history or authority is failure, not a manual recovery workflow.
After terminal failure, later independent exact writer-exit and lease-release
proof still reconciles the published claim through the terminal-aware hold
contract. This neither reopens the outcome nor spends repair allowance or
acknowledges dependency interpretation. Held terminal waits remain observable
for this proof-only reconciliation, including after parent outcome consumption.
Storage v4 adds durable repair records; older hosts must refuse that version.
Read-only assignment observers support v4's unchanged wait/outcome fields using
an explicit version allowlist. Observation never creates or migrates storage;
unknown versions or unavailable required fields remain unverified.
The outage observation journal remains #712's responsibility.

## Terminal Assignment Outcomes (#710)

The coordinator commits an immutable terminal assignment decision and a typed,
parent-addressed outbox event in one transaction. Dependency-ready events remain
worker admission inputs. A terminal assignment disarms its linked waits without
inventing interpretation or proving process exit. Published claims and writer
lease identities remain available for independent reconciliation. Evidence pins
move to the outcome; delivery receipts do not release them. Only the recorded
parent's explicit disposition of the exact inspected outcome revision releases
that outcome's obligations. Runtime adapters must validate current read authority
and captured recipient identity before exposing bounded evidence or delivery.

Storage version 3 migrates versions 1 and 2 transactionally and refuses newer versions.
Hosts must advertise outcome support explicitly; a dependency-only host cannot
claim to provide durable assignment delivery. Repair and outage journals remain
separate work under #711 and #712.

Each launch records its immutable assignment, attempt, worker and parent binding
before dispatch. Automatic continuations retain that assignment; explicit
follow-ups receive a new assignment ID even in the same saved conversation.
Terminal waits are dispatch-disarmed, not acknowledged. They retain unresolved
facts without occupying the pending-wait slot of a new assignment. Outcome pins
preserve their original operation/revision identity, including dependencies that
settle after the assignment fails.

The Subagents finalizer supplies ordinary terminal decisions to the coordinator.
The existing callback batcher uses the stable outcome event as its notification
identity and the attempt as its retrieval identity. Recipient transcript entries
are reconciled before replay; a callback receipt remains distinct from inspection
and exact-revision consumption through `subagent_result`. Recorded branch anchors
must remain on the recipient's branch. Current file-read permissions apply to
bounded dependency evidence reads; neither foreign-session overrides nor outcome
inspection confer worker acknowledgement or mutation authority. Standalone
packages negotiate assignment outcome capability v1 when registering the worker
bridge, and refuse an incompatible host instead of silently dropping delivery.

Plans retain deliverables rather than watcher processes. A waiting deliverable references its operation and owner; absent supervision is visible as unmonitored work, not reported as healthy waiting. Worker parking releases active capacity without erasing the assignment. Restart, cancellation, permissions and duplicate events must preserve this relationship.

Broad bans on long commands, model subagents used solely as pollers, and child processes kept idle to preserve context are rejected as the default design. Domain watchers retain their own state and evidence contracts: for example, merge observation uses an appropriate stateful delivery watcher, rather than replacing it with a stateless predicate.
