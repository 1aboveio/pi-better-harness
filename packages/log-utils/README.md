# log-utils

Dependency-free primitives for safely tailing large append-only logs and for
building bounded model-facing output.

This package does not define capture or retention policy, failure reduction, or
callback delivery. Callers retain ownership of log format, lifecycle, and ADR
0006 observation/delivery semantics. Follow-on consumers vendor this file
through `scripts/sync-shared-log-utils.mjs`; do not edit generated copies.

## Existing reader

`readBoundedTail`, `terminalDisplayRows`, and `tailTerminalDisplay` remain the
shared tail/display helpers. They are independent of the paging APIs below.

## UTF-8 budgets

All budgets and offsets are **UTF-8 bytes**, not JS UTF-16 units. The budget
covers the complete textual model-facing payload, including headers, failure
summaries, gaps, and continuation metadata.

| Surface | Default | Hard cap | Constant |
|---|---:|---:|---|
| Background status/result | 1 KiB | 2 KiB | `OUTPUT_BUDGET_BYTES.status` |
| Subagent final-answer page | 2 KiB | 8 KiB | `OUTPUT_BUDGET_BYTES.answer` |
| Log excerpt | 1 KiB | 4 KiB | `OUTPUT_BUDGET_BYTES.log` |
| List page | 1 KiB | 4 KiB | `OUTPUT_BUDGET_BYTES.list` |
| Completion callback batch | 2 KiB | 8 KiB | `OUTPUT_BUDGET_BYTES.callbackBatch` |
| Explicit raw evidence page | 16 KiB | 64 KiB | `OUTPUT_BUDGET_BYTES.rawPage` |

Default log excerpts are also capped at `OUTPUT_PAGE_DEFAULTS.logLines` (10)
and list pages at `OUTPUT_PAGE_DEFAULTS.listEntries` (10). Callers may request
larger pages with `maxBytes` / `maxLines` / `limit` up to the hard cap.

`budgetFor(surface, requested)` applies the default when `requested` is omitted
or unsafe, allows a lower caller budget, and clamps explicit larger pages to
`OUTPUT_BUDGET_MAX_BYTES`. `clampBudgetBytes(value, fallback)` only rejects
nonpositive/NaN inputs.

## Verbatim paging

`pageVerbatimText(text, { cursor, maxBytes, maxLines, resource })` pages a JS
string at UTF-8 boundaries, preferring newlines. A page never exceeds
`maxBytes`: when the next code point does not fit, the page is empty and
`nextCursor` equals `cursor` (nothing is skipped; ask for a larger page).
`maxBytes: 0` is an explicit empty page positioned at the cursor; other
nonpositive or non-numeric values fall back to the default. Consecutive pages
concatenate to the original string. The returned `cursor` replays that page;
`nextCursor` continues. A page ends after a newline only when that keeps at
least half of the page; otherwise it ends at a UTF-8 boundary. Two callers
holding different cursors do not consume each other. A content-hash change returns `reset: "source-replaced"`.

`resource` binds the cursor to one resource **and session scope** (for example
`answer:<scope>:<runId>`). A cursor minted for another resource, run, or scope
returns `reset: "stale-cursor"` and the first page. Cursors carry a short
digest of the resource, never the scope text.

## Retained-file paging

`pageRetainedFile(path, request)` pages raw retained bytes without skipping
unread ranges in the current snapshot.

- First read pins a high-water `snapshot` (current size, or `snapshotBytes`).
  Replaying `cursor` stays inside that snapshot while the file appends.
  When a page reaches the end, `appendReady` is set and `nextCursor` returns
  only bytes appended later; the envelope prints it as `end nextCursor=…`.
- A trailing, still-incomplete UTF-8 sequence (a writer split a code point
  across writes) is withheld and reported as `pendingBytes`; the next read
  returns the whole character once it is complete. Malformed bytes that can
  never complete are passed through instead of stalling.
- Cursors bind `resource` (task/run id plus session scope), the file object's
  identity (`dev`, `ino`, and birth time where the platform reports it, so a
  delete + recreate that reuses an inode number is still `source-replaced`),
  the consumer `generation`, a head sample, and a sample of the bytes just
  before the offset. Increment `generation` on replacement or same-inode
  compaction; the pre-offset sample also catches in-place rewrites that keep
  the head, size, and inode.
- `discardedBytes` and `captureGaps` are disclosed on every page. They are not
  recoverable. Empty readable files have no gaps; missing or unreadable files
  return a `read` gap and never look like a healthy empty log.
- **Accepted heuristic (identical prefix).** When the platform reports no
  fine-grained birth time and a file is deleted and recreated on a reused inode
  (or rewritten in place) so that its head sample and the 256 bytes before the
  cursor are byte-identical, the cursor continues from its offset. Every byte
  after the cursor is still returned, so nothing unread is skipped; what cannot
  be detected is a change *inside* the already-read prefix outside the sampled
  head and window. Closing it would mean hashing the whole prefix on every page
  (quadratic over a paged log), so it is documented and accepted rather than
  closed. Consumers that replace or compact a log should bump `generation`,
  which always resets.
- `reset` is `stale-cursor` (other resource/scope or garbage),
  `source-replaced` (different file object), or `compacted` (same file object,
  but generation/head/pre-offset bytes/size no longer match).

## Status revisions

`inspectStatusRevision({ cursor, resource, contentRevision, failureRevision })`
is caller-owned. Unchanged content **and** failures yield `change: "none"`;
use `formatUnchangedEvidence(cursor)` for the small no-change payload. A
failure-journal change with the same content revision yields
`change: "failure"` so incidents stay visible when log bytes do not. Consumers
must put every reportable fact into one of the two revisions: lifecycle
metadata and log identity (including a deleted log) in content, and
`failureRevision(state)` from failure-observations in failure. Nothing is
consumed globally. `revisionOf(value)` hashes JSON facts for either input.

## Row pages

`pageRows(items, { cursor, resource, limit, maxBytes, keyOf, render })` pages
compact list rows newest first. The `l1.` cursor records the last row shown
(time + id), so rows inserted ahead of it never shift later pages; every row
is reachable regardless of `limit`. Only whole rows are counted; a single row
larger than the page is clipped with `…` (callers keep the id near the start).
`hasMore` always comes with a `nextCursor`; when no row fits, it points at the
page's own start so a larger page can retry. List surfaces reserve half the
page for rows, so failure lead-ins cannot crowd rows out.
A cursor from another scope or filter resets with `stale-cursor`.

## Envelope integration contract

`assemblePriorityEnvelope` is the shared assembler for standalone tools and
action wrappers. **Do not page an answer to the full surface budget and then
prepend headers.** The assembler hands the verbatim pager the exact bytes left
after the other sections and never clips the page afterwards, so `nextCursor`
always points at the first byte not shown.

```ts
const envelope = assemblePriorityEnvelope({
  maxBytes: budgetFor("answer"),
  sections: {
    identity: "sa_9 completed",
    // A function receives the exact bytes the envelope can give it, so the
    // shared incident summary can count shown/omitted rows truthfully.
    failure: (budget) => formatIncidentSummary(state, { maxBytes: budget, resource }).text,
    decision: matchedConditionAndStopError,
    diagnostics: gapsAndLifecycleFacts,
    progress: optionalProgress,   // lowest priority
  },
  verbatimReserve: budgetFor("answer") / 2,   // answer pages always advance
  verbatim: (remainingBytes) => pageVerbatimText(finalAnswer, { cursor, maxBytes: remainingBytes, resource }),
  statusCursor,                                // rendered with the continuation
});
```

Budget priority: identity, decision facts, continuation/gap metadata, failure,
diagnostics, verbatim page (at least `verbatimReserve` when it has bytes),
progress. Text order: identity, failure, decision, diagnostics, verbatim,
progress, continuation (`failureFirst: true` puts the failure section first,
as background surfaces do). Continuation lines: `reset=`,
`hasMore=… omittedBytes|omittedRows=… nextCursor=…`, `end nextCursor=…`,
`pendingBytes=`, `gap …`, `omitted <section> bytes=…`, `statusCursor=…`.

Lifecycle success is not semantic correctness. This module never infers
structured failures from prose and never delivers callbacks.

## Shared tool-surface helpers

Both tool families (subagents and background tasks) use these so their
parameters and cursors cannot drift:

- `readOutputControls(params)` resolves the public output-control names:
  canonical `max_bytes` and `lines`, deprecated aliases `maxBytes` and
  `tail_lines`. The canonical name wins when both are given; values are
  returned unvalidated so each surface keeps its own defaults and caps.
- `readOutputInclude(value)` parses the explicit `include` opt-in
  (`cost`, `tools`) and names unknown values.
- `sessionScopeKey({ all, unavailable, origin, fallback })` is the cursor scope
  every page/revision cursor binds (`all`, `session:unavailable`,
  `session:<digest>`, or the fallback).
- `lifecycleContentRevision(facts, logPath)` hashes consumer lifecycle facts
  plus the retained log's identity (`logIdentityFacts`), so a deleted,
  replaced, or appended log is a content change.

## Incident pages and callbacks

Incidents are rendered and paged by `failure-observations`:
`formatIncidentSummary` (whole rows when they fit, otherwise
`N active failure observations · K shown · M omitted · incidentCursor=…`) and
`pageFailureIncidents` (`i1.` cursors that resume at the first unshown byte,
including inside a row larger than one page). Consumers accept the incident
cursor on their status/result tools and render the explicit page with the
shared `incidentVerbatimPage`, `incidentPageHeading`, and `incidentResource`.
`failureJournalFingerprint(path)` is a cheap change key for caching counts
derived from a journal.

`callback-batcher` counts incident rows per completion row
(`incidents=N shown=K omittedIncidents=M retrieve: …`) and formats urgent
callbacks as header, explanation, whole incident rows, counts, and one inspect
line under the same 2 KiB default / 8 KiB hard cap. Overflow completion rows
remain pending (not receipted) across handoff failure and reload.

UTF-8 slices that start on a continuation byte skip forward to the next complete
character. They do not insert replacement characters or drop later source bytes.
