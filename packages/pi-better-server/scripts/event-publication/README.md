# Source Commit Visibility

The writer stages a unique marker and atomically renames its metadata file. The
measurement accepts only a ready subscription event containing that task and marker;
neither a polling query nor the writer's IPC acknowledgement counts as visibility.

The rename occurs between `commitStartedNs` and `committedNs`. A concurrent reader can
receive the renamed content before the writer is scheduled to record `committedNs`.
Subtracting that post-rename timestamp from event receipt therefore can be negative
even though the event contains fresh, committed content.

`latencyMs` is the conservative upper bound from immediately before rename to receipt.
The one-second healthy publication budget and nonnegative-latency gates are unchanged.
The measurement also rejects any receipt preceding `commitStartedNs` and retains the
signed `completionDeltaMs` alongside both timestamps. A negative completion delta
exposes the scheduling interval rather than being clamped or discarded. This bound
includes rename duration and can overestimate, never underestimate, commit latency.

`event-publication-clock.test.ts` deterministically holds an external writer after its
rename until 1/5/10 real Unix socket subscribers have received the exact marker. It uses
the production read model and subscription encoder without daemon identity admission.
It reproduces the old negative-delta assertion, verifies the timestamp bracket, checks
the fresh snapshot and retains per-recipient values and changed-source read counts.
The production writer does not wait for subscribers. Workload concurrency, resource
windows and shared-read budgets are unchanged. Full daemon/resource acceptance still
belongs to the qualifying resource CI lane.
