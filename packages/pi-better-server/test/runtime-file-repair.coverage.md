# File Hints and Source Repair

`runtime-file-repair.test.ts` uses the production read model and a separate real
daemon with five socket clients. It tests task appearance, atomic metadata
replacement, terminal state, deletion, malformed input, retained stale rows,
and degraded status that survives unrelated updates. The direct model case
closes actual watchers to drop hints, injects a watcher error, replaces source
directory identity, removes/restores the source root, and overflows the queue.
It continuously appends a hot log between repair batches and checks progress.
Failed first observations of metadata, archives and markers remain eligible for
repair after a missed deletion hint. Tests retain degradation while the source
root is unavailable, clear it after verified absence under an available root,
and check the 128-path budget across 130 never-imported failed sources.

The existing `runtime-event-publication.test.ts` measures external atomic
metadata commits through real socket subscriptions for 1, 5, and 10 clients.
`runtime-incremental-log.test.ts` preserves the 96-task append comparison:
one projection, one shared log read, and unchanged sibling source revisions.
`runtime-archive-publication.test.ts` retains source verification races and
`runtime-work.test.ts` covers 10,000 archives, coordinator changes, consumer
reconnection, failure attention, and watcher overflow. Authority and writer
rules remain in the existing domain implementations.

## Budgets and Measurements

The entity queue holds at most 256 paths and merges repeated paths. A path is
removed before its read starts, so a newer hint remains queued for a later
batch. One serial worker alternates up to 32 queued entities with one repair
batch of up to 128 paths. Filesystem stat concurrency stays at most 32.
Metadata is limited to 1 MiB per record; larger records retain the verified
snapshot and report degradation. This bounds each repair batch to 128 MiB of
metadata input. Existing independent log window limits still apply. Processing
yields after 8 ms or 256 records and between batches; synchronous JSON parsing
and domain folds cannot be preempted in the middle of one record.

Repair retains its directory iterator and known-path position between timer
turns. Entity hints do not restart it. Explicit `reconcile()` requests a fresh
complete walk for compatibility and diagnostics. Missing roots retain verified
rows; removal requires an explicit missing file observation under an available
root, not absence from an incomplete enumeration. Overflow coalesces an atomic
repair obligation file under `agentDir/runtime-read-repair/subagents.json`.
Startup always reconstructs these same source scopes, including after a crash;
directory cursors themselves are process-local and restart on a new process.
This derived file is neither assignment authority nor a reason to keep the
server alive.

`sourceWork.entity` and `sourceWork.repair` report batches, candidate paths,
metadata reads, observation stats, log read calls, and log bytes separately.
Observation stats exclude parser-internal identity probes, config checks and
the three root identity checks. `scheduling` reports repair progress, overflow,
queue length, maximum queue age and maximum entity batch duration. The latter
is projection publication time, not client delivery time; real socket delivery
latencies are emitted separately by the existing event-publication test.
Task batches reuse the current in-memory projection machinery; this change does
not remove its history-sized map traversals or implement query scope revisions.

## Platform Lanes

The tests use platform-neutral Node filesystem operations, real processes and
Unix sockets. They are discovered by both shards of the existing Linux
`server-tests` lane. Local verification for this change ran on macOS. Linux CI
is pending at handoff, not claimed as executed. Cross-platform resource workload
automation belongs to epic slice #808; these correctness cases can run there
unchanged. No test substitutes mocked watcher delivery for the real socket
publication measurement.
