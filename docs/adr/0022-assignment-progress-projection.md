# Assignment Progress Projection

Status: accepted for #709 under the approved five-slice #707 plan.

Subagents owns one read-only projection with exactly five states: Running,
Waiting, Completed, Failed and Cancelled. Result/output tools, list rows,
navigator rows/details and Goal activity use the same implementation. Goal's
standalone package receives a generated copy, not an independent status mapping.

The coordinator remains the authority for wait generations, cancellation and
interpretation. Its bounded read-only observation API never creates or migrates
storage. Reads match the recorded worker conversation, workspace and assignment
attempt lineage. Wait origin/park attempt identity, published resume claims, or
an exact park wait/generation reference associate waits with that lineage. A
conversation-only wait is not evidence for an arbitrary assignment. A park
cache locates the relationship but cannot prove completion or cancellation.
Pending authoritative waits take precedence over exited attempts and final prose.
A consumed wait records interpretation; it does not complete a parked assignment.
A failed dependency command does not set assignment failure. Legacy attempts without
an immutable assignment binding retain their ordinary completion semantics. For bound
assignments (#744), exit zero alone cannot establish assignment completion. An explicit
`report_assignment_result` judgment with retained actual workspace evidence supplies
that decision without requiring Background or a dependency wait. The authenticated
child bridge derives the immutable assignment and attempt; the versioned report is
attempt evidence, not a terminal outcome. The existing exact `assignment-complete`
dependency acknowledgement remains compatible when there is no explicit report.
An explicit incomplete report takes precedence over that acknowledgement. Otherwise an
ended attempt with no outstanding interpretation commits `failed` with an explicit
completion-unverified reason, preserving its separate completed process status. This
uses the existing terminal contract to report failure to establish completion, not
failure of the child process. Parent inspection and acceptance remain separate;
an explicit follow-up can continue the same conversation as a new assignment.
Existing attempt failures and explicit stops retain their diagnostic records.

Evidence reports may retain explicit byte excerpts from larger workspace files.
The 65,536-byte bound applies to each retained file or excerpt, with a zero-based
inclusive `offset` and `max_bytes`; the end is exclusive and bounded by EOF.
The retained report binds the source path, source size, excerpt range and digest.
Captured and current read permissions, workspace and credential exclusions, and
the live writer fence apply before capture. Read-only workers need no workspace
writes to report evidence. A refusal is not a committed report: the writer may
correct the path or excerpt and retry. The latest authenticated rejection is
retained for parent diagnosis and cleared after a successful correction. Accepted
reports remain immutable, with identical retries returning the retained bytes.
An incomplete report may retain remaining work and a concrete permission or
external-input blocker. Parent terminal reasons distinguish incomplete work,
report rejection and process failure while retaining the separate process status
and exit code. Full detail remains in the bounded report if the terminal reason
must be shortened to the coordinator's limit.

Within a live execution attempt, the child bridge permits one completion
correction shared between a normal model stop without an accepted judgment and
an unblocked incomplete report with concrete remaining work. The latter is
returned as a tool refusal before report acceptance, so a later complete report
does not rewrite accepted evidence. A further incomplete report is accepted.
Accepted reports and exact assignment-complete acknowledgements suppress the
missing-report correction. The correction budget is saved in the native session
under the exact attempt ID and survives extension reload. Correction stays in
the current SDK execution with its original authority and absolute deadline;
it creates no new assignment, Goal, process, or retry timer. Aborted/error model
stops, parked attempts, expired deadlines and concrete blockers do not trigger
this correction. Exhausted correction keeps the existing terminal classification.

The assigned canonical workspace is the report evidence boundary. Worker prompts
state that boundary, and outside-workspace refusals explain how to correct the
source. Sibling output directories and escaping symlinks remain outside it.

The atomic assignment terminal decision and delivery contract is defined by
ADR 0020's #710 extension. A committed coordinator outcome takes precedence over
held dependency waits without implying those waits were interpreted. New launch
bindings scope reads by immutable assignment ID; conversation identity alone
cannot attach a later explicit follow-up's wait to an earlier terminal result.

`revision` is an opaque content-addressed semantic revision, not a timestamp or
numeric ordering. Consumers compare equality. State, readable reason, attempt
lineage and evidence references produce a new revision; elapsed time, output
prose, repeated observation and cache timestamps do not. Revision reads write no
state and cannot race a coordinator transaction or authorize dispatch.
Only fenced automatic resume attempts share this projection's assignment lineage.
The exact `resumedFrom` links define that lineage; a shared conversation `rootRunId`
does not, because it also spans explicit follow-ups.
An explicit follow-up in the same saved conversation is a new assignment; it
does not rewrite the earlier assignment's terminal outcome or retained output.

Process status and termination evidence remain separate fields. Cancelled does
not prove a process stopped. Lost/exited/orphaned evidence remains unproven and
does not establish assignment completion. Diagnostic references identify retained
run metadata/logs and exact wait generations. Reading never acknowledges a wait,
changes a cancellation epoch or releases a writer fence.

When the coordinator or its compatible read capability is unavailable, supervised
assignments show Waiting with an explicit unverified-state reason. This does not
promise provider execution without a runtime host. Legacy runs without supervised
operation bindings keep their recorded attempt outcomes; uncertain legacy exits
show Waiting. No repair, terminal delivery, manual recovery or new UI control is
introduced. Existing explicit stop remains the cancellation path.
