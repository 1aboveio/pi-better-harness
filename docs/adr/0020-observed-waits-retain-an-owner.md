# Observed waits retain an execution owner

## Status

Accepted invariant. The user approved recording this decision after inspecting parent merge monitoring and worker continuation behavior. The [lifecycle design](../plans/observed-waits-design.md) is proposed; recording this ADR does not enable automatic continuation or change permissions.

## Decision

**A workflow waiting for an external event must have a registered observer and an owner to receive its result.** The observer performs mechanical execution or state observation. The owner is the parent session or worker conversation that interprets the terminal evidence and decides what happens next. A registered observer must have a recoverable supervision path; an identifier pointing to an unsupervised task does not satisfy the invariant.

Use background operations for established commands and external waits. Use model execution for judgment before an operation and interpretation after it. A worker may retain necessary synchronous checks, including long ones; duration alone does not determine ownership. A command-only polling assignment does not become model work because its requested final report is detailed.

A waiting parent remains responsive. A waiting worker may end its execution attempt while preserving its conversation and assignment, then resume in a new attempt when its dependency resolves. Waiting is neither completion of the assignment nor a stalled model. A terminal observation makes evidence available; the owner must interpret it before claiming success. Failure, cancellation and lost execution evidence also require explicit resolution.

## Context and trade-off

Session `01a1a186-2daa-7346-ac9e-24b10043ade9` used background delivery watchers, then delegated merge monitoring to a Bash-only subagent that made 33 Bash calls, including repeated sleeps, before the user corrected it. The parent combined mechanical waiting with a rich final report. Keeping these phases separate preserves model ownership without paying for model turns to observe unchanged state.

Existing saved-conversation continuation provides history, a new attempt, writer exclusivity and fresh admission, but no automatic dependency-triggered continuation. Existing background supervision is session-bound. This decision therefore requires durable dependency and supervision work; adding tool names or instructions alone is insufficient.

This extends [ADR 0016](0016-unified-execution-concurrency.md). That ADR introduced scheduling guidance without an automatic scheduler; the proposed lifecycle adds narrowly scoped dependency-driven resumption. It preserves the workflow and Goal authorities in [ADR 0018](0018-harness-outcome-todo.md) and the verified tool boundaries in [ADR 0007](0007-trusted-runtime-task-boundary.md) and [ADR 0017](0017-background-adapter-admission.md).

## Consequences

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

Storage version 2 migrates version 1 transactionally and refuses newer versions.
Hosts must advertise outcome support explicitly; a dependency-only host cannot
claim to provide durable assignment delivery. Repair and outage journals remain
separate work under #711 and #712.

Plans retain deliverables rather than watcher processes. A waiting deliverable references its operation and owner; absent supervision is visible as unmonitored work, not reported as healthy waiting. Worker parking releases active capacity without erasing the assignment. Restart, cancellation, permissions and duplicate events must preserve this relationship.

Broad bans on long commands, model subagents used solely as pollers, and child processes kept idle to preserve context are rejected as the default design. Domain watchers retain their own state and evidence contracts: for example, merge observation uses an appropriate stateful delivery watcher, rather than replacing it with a stateless predicate.
