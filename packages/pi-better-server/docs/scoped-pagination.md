# Scoped Work Pagination

Subagent pages use a content-fenced keyset, ordered by descending `startedAt`
and ID. Each page contains at most 200 rows and remains subject to the existing
4 MiB frame bound. Cursors bind the complete query identity, runtime instance,
retained scope token, content revision and last ordering key.

A relevant membership, ordering, row-content, activity or completeness change
requires restarting from the first page (`resync_required`). An unrelated change
does not invalidate a page. This contract avoids mixing revisions within a page
walk without retaining unbounded historical snapshots. The model retains at most
128 scope identities, each expiring after five minutes without use. Expiration,
eviction and instance replacement require the same first-page recovery.

The model and its caches belong to one admitted canonical agent root. Query
identities include the existing workspace, origin session, exact ID, filters,
detail mode and paging options. Background identities also include process and
history visibility options. Session/branch authorization remains with existing
admission and domain ownership; a query revision grants no permission. Catalog
trust/branch resolution is a separate API and is not cached as a Work query.

Subscriptions install synchronously with initial capture. They retain bounded
full snapshots, generation fencing, replay-gap resync and slow-reader recovery.
The worker shares cached snapshots and event encodings for equivalent identities.
`queryCount`, `serializationCount` and `eventEncoding.serializations` measure
shared computation; `eventEncoding.frames` and `bytes` measure necessary fanout.
