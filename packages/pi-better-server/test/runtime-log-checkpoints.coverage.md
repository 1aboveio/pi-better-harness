# Log checkpoint recovery

The derived `runtime-log-checkpoints.sqlite` file stores both consumers in one
SQLite transaction. Each serialized consumer carries its own source generation,
line-boundary offset, head sample, observed size and modification time, fold state,
and coverage. The store version invalidates both parser and health reducer state.
Deletion or eviction replays source evidence; it never deletes logs.

The server retains 64 hot states per consumer. The disk payload budget is 32 MiB,
with a 256 KiB per-entry ceiling, 4096-entry limit and oldest-commit eviction. SQLite uses FULL
auto-vacuum and DELETE journaling; schema/page overhead and the transient rollback
journal are additional to the payload budget. Oversized folds are counted and not
persisted. Body text is omitted from summary state; detail reads remain on demand.

Cumulative reads advance from the beginning in at most 1 MiB batches. Health has
its own recent-window cursor and cannot advance cumulative usage. Snapshots can
be available before cumulative catch-up completes. Cursor coverage records the
first observed byte and a bounded envelope of missing ranges. An individual
record exceeding the batch budget is reported as incomplete, not complete usage.

Generation validation detects inode/device/birth-time replacement, shrinkage,
head changes and same-size modification-time changes. It does not detect every
in-place edit followed by growth outside the sampled head. Head sampling is not
a cryptographic proof of an append-only history. Raw logs remain the evidence.

Automated tests exercise socket Navigator/activity snapshots for 48, 96 and 144
tasks, repeated eviction, daemon restart, index loss, independent cumulative and
health positions, speculative trailing usage, replacement/truncation, version
invalidation, oversized-entry refusal, and actual process death before/after
checkpoint commit. Existing registered-extension tests remain required for tool
entrypoints; server-tests (both shards) and workspace-ci remain delivery gates.
