# Assignment Progress Projection

Status: accepted for #709 under the approved five-slice #707 plan.

Subagents owns one read-only projection with exactly five states: Running,
Waiting, Completed, Failed and Cancelled. Result/output tools, list rows,
navigator rows/details and Goal activity use the same implementation. Goal's
standalone package receives a generated copy, not an independent status mapping.

The coordinator remains the authority for wait generations, cancellation and
interpretation. Its bounded read-only observation API never creates or migrates
storage. Reads match the recorded worker conversation and workspace. A park
cache locates the relationship but cannot prove completion or cancellation.
Pending authoritative waits take precedence over exited attempts and final prose.
A consumed wait records interpretation; it does not complete a parked assignment.
A failed dependency command does not set assignment failure. An ordinary coherent
completed attempt retains legacy completion semantics when it owes no interpretation.
Existing attempt failures and explicit stops retain their diagnostic records.
The atomic assignment terminal decision and delivery contract belongs to #710.

`revision` is an opaque content-addressed semantic revision, not a timestamp or
numeric ordering. Consumers compare equality. State, readable reason, attempt
lineage and evidence references produce a new revision; elapsed time, output
prose, repeated observation and cache timestamps do not. Revision reads write no
state and cannot race a coordinator transaction or authorize dispatch.
Only fenced automatic resume attempts share this projection's assignment lineage.
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
