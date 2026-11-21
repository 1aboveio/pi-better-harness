# Actionable permission blockers and bounded goal recovery

## Status

Accepted for issue #415. The Goal pause and bounded-recovery decision below is
superseded by the amendment in this document. Extends [ADR 0006](0006-shared-failure-observations.md)
and [ADR 0007](0007-trusted-runtime-task-boundary.md).

## Amendment: permission reports do not control the Goal loop

Goal is an agent continuation loop. A failed operation does not establish that
all useful work must stop. The agent may retry transient failures, wait, or
continue other authorized work using the reported evidence.

Permission reports remain diagnostic evidence. They do not pause Goal, suppress
wakes, restrict resume to one turn, or inject a prohibition on continuing work.
Historical permission records must not reestablish a hold after reload or resume.
A legacy permission-paused goal can be resumed through the ordinary resume path.
An explicit user pause remains a pause.

Actual tool and sandbox permissions remain enforced by their owning runtimes.
Continuing the loop grants no permissions. Goal's existing no-progress detection
still stops repeated unchanged work; completion and explicit pause behavior stay
in place. Goal does not become a task scheduler or add a retry policy of its own.

The [reporting rules](#reporting-permission-failures) remain in force. The
[former Goal hold](#former-goal-hold) records the retired automatic pause and
single-retry behavior.

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

### Reporting permission failures

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

Assistant rewording is excluded from the generic evidence signature when a turn
contains tool actions/results. Assistant-only evidence retains its text identity.
This changes progress accounting, not failure outcome or permission classification.

### Former Goal hold

The original policy paused Goal when the foreground inspected an actionable
permission report. It stored the hold and allowed one bounded retry after a human
resume. The amendment above retired both transitions. An existing legacy hold
can be resumed normally. Runtime permission checks still apply on every attempt.
See [Goal and Todo lifecycle](0030-goal-and-todo-lifecycle.md) for current pause,
continuation and completion rules.

## Limits

The installed SDK drops structured metadata on thrown errors and pre-execution
refusals. This implementation does not convert failed calls into successful
results or use stdout markers to evade that limitation. Proven guarded preflight
metadata and foreground blocker adoption are deferred until authentic error
transport is available. Workers must explicitly report a blocker through the
existing open disposition and the foreground must inspect their result/output.

## Verification

Synthetic fixtures exercise dummy credential-cache and process-inspection
failures, trusted parent/child replay, forged and malformed reports, output
budgets, history retention, and preservation of failed outcomes. For the
amended Goal behavior, inspect a permission report, reload the session and
verify that an active Goal can continue other authorized work. Repeat with a
human-paused Goal and verify that the pause survives.
