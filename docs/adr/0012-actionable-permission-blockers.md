# Actionable permission blockers and bounded goal recovery

## Status

Accepted for issue #415. Extends [ADR 0006](0006-shared-failure-observations.md)
and [ADR 0007](0007-trusted-runtime-task-boundary.md).

## Context

A cloud read can require local credential-cache writes. A worker's local access
failure does not establish expired credentials, cloud IAM denial, an empty
successful query, or a restriction on foreground execution. Arbitrary CLI
output cannot prove whether a remote request started.

The goal no-progress ledger compared assistant wording as well as tool evidence.
Repeated descriptions of an unchanged blocker could therefore reset progress;
ordinary input and unrelated background completion could reopen a generic hold.
These are not evidence that permissions changed or the failed operation passed.

## Decision

Use the existing failure journal and explicit `failure_disposition open` path.
An optional permission resource category reports the need for human action and
must name a real unresolved failed tool incident. The child and trusted parent
replay validate the request. The adapter supplies operation identity and worker
context; the parent adds run identity. The report is agent-reported and remote
outcome unknown, not a proven policy refusal. Untrusted child claims do not
receive this contract. No classification is inferred from permission-error prose.

The strict shared contract contains bounded identifiers and resource enums,
not credential paths, commands, secrets, or output. Existing expectedness,
actionability, append-only history, recovery evidence, and pending-only delivery
rules remain intact. Parent result/output tools carry actionable reports in
structured details and display contextual diagnostics before ordinary progress.

An inspected actionable report pauses the current goal with a permission-blocker
reason. Compact blocker and release records are persisted separately from the
progress ledger. Ordinary conversation, background drains, settings changes,
reworded blocker prose, reload, and incident recovery do not release this hold.
Model-callable `goal_resume` remains restricted to interrupt pauses. Workflow
instructions cannot override permission-hold instructions.

The human selected `/goal resume` itself as confirmation for one bounded retry
of the held operation and scope; the human resume shortcut has the same meaning.
Resume preserves goal identity, usage, and history. It grants no new permissions,
changes no authentication, copies no credentials, and does not authorize a
foreground fallback or broader resource activity. Changed worker settings need
a fresh worker with a new immutable launch snapshot. Metadata inspection is not
permission to run product tests or mutate resources. A released continuation
returns to the hold after its turn; a new denial reestablishes the hold immediately.
Reload does not replay a persisted release as an execution ticket.

Assistant rewording is excluded from the generic evidence signature when a turn
contains tool actions/results. Assistant-only evidence retains its text identity.
This changes progress accounting, not failure outcome or permission classification.

## Limits

The installed SDK drops structured metadata on thrown errors and pre-execution
refusals. This implementation does not convert failed calls into successful
results or use stdout markers to evade that limitation. Proven guarded preflight
metadata and foreground blocker adoption are deferred until authentic error
transport is available. Workers must explicitly report a blocker through the
existing open disposition and the foreground must inspect their result/output.

The bound applies to autonomous continuation turns. Same-operation/scope is
conveyed through instructions; command count within a turn and already-running
children are not controlled by this feature. Existing task guards enforce actual
permissions. The mechanism is not a new security boundary against trusted
runtime extensions. Finite scope/history limits refuse further releases when
observation is incomplete; retained evidence is not erased.

## Verification

Synthetic fixtures exercise dummy credential-cache and process-inspection
failures, trusted parent/child replay, forged and malformed reports, output
budgets, history retention, and preservation of failed outcomes. Goal handler
tests cover varied prose, ordinary questions, unrelated background completion,
settings changes, reload, workflow precedence, stale timers/audits, explicit
single release, repeat denial, and missing or exhausted evidence. No real
credentials, cloud requests, product tests, or Android resources are needed.
