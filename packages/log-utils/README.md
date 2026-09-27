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

`pageVerbatimText(text, { cursor, maxBytes })` pages a JS string at UTF-8
boundaries, preferring newlines but always making forward progress on a huge
line. Consecutive pages concatenate to the original string. The returned
`cursor` replays that page; `nextCursor` continues. Two callers holding
different cursors do not consume each other. A content-hash revision change
returns `reset: "source-replaced"` and the first page of the new text.

## Retained-file paging

`pageRetainedFile(path, request)` pages raw retained bytes without skipping
unread ranges in the current snapshot.

- First read pins a high-water `snapshot` (current size, or `snapshotBytes`).
  Replaying `cursor` stays inside that snapshot while the file appends.
  `nextCursor` at the snapshot end is append-ready and returns later bytes.
- Bind `resource` (task/run id) and increment consumer `generation` on every
  replacement or same-inode compaction. Generation is required when a rewrite
  could keep a compatible head; inode and head samples still detect ordinary
  replace/compact/truncate.
- `discardedBytes` and `captureGaps` are disclosed on every page. They are not
  recoverable. Empty readable files have no gaps; missing or unreadable files
  return a `read` gap and never look like a healthy empty log.
- `reset` is `stale-cursor`, `source-replaced` (new inode/resource), or
  `compacted` (same inode, generation/head/size invalidation).

## Status revisions

`inspectStatusRevision({ cursor, resource, contentRevision, failureRevision })`
is caller-owned. Unchanged content **and** failures yield `change: "none"`;
use `formatUnchangedEvidence(cursor)` for the small no-change payload. A
failure-journal change with the same log revision yields `change: "failure"`
so incidents stay visible when log bytes do not. Nothing is consumed globally.

## Envelope integration contract

`assemblePriorityEnvelope` is the shared assembler for standalone tools and
action wrappers. **Do not page an answer to the full surface budget and then
prepend headers.** That either exceeds the budget or clips verbatim bytes.

Reserve metadata first by paging from the callback budget:

```ts
const envelope = assemblePriorityEnvelope({
  maxBytes: budgetFor("answer"),
  sections: {
    identity: "sa_9 completed",
    failure: failureSummary,      // from failure-observations; do not reimplement
    decision: matchedCondition,
    diagnostics: gapsAndStopError,
    progress: optionalProgress,   // lowest priority; omitted before failures
  },
  verbatim: (remainingBytes) => pageVerbatimText(finalAnswer, {
    cursor,
    maxBytes: remainingBytes,     // leftover after headers + continuation
  }),
});
// envelope.text is the entire model-facing tool `content`
// utf8ByteLength(envelope.text) <= maxBytes
```

Allocation order: identity, failure, decision, diagnostics, verbatim page,
optional progress, continuation. Continuation (omitted byte counts, next
cursor, reset, capture/retention/read gaps) is reserved so overflow is visible
and retrievable. Reconstructing `verbatim` pages with that same leftover
budget concatenates to the original answer; pages are smaller because headers
took part of the cap.

Lifecycle success is not semantic correctness. This module never infers
structured failures from prose and never delivers callbacks.
