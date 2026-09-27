# Issue #312 — frozen model-facing output contract

Budgets, cursors, and evidence-gap reporting for subagent and background-task
tool `content` (the model-facing payload). TUI folding is display-only and is
not this contract.

Accounting is **UTF-8 bytes** of the complete textual `content`, including
headers, failure summaries, gaps, and continuation metadata. Offsets are UTF-8
byte offsets. Slices never split a code point and never insert U+FFFD in place
of source bytes.

## Defaults and hard caps

| Surface | Default | Hard cap | Constant |
|---|---:|---:|---|
| Background status / compact result | 1 KiB | 2 KiB | `OUTPUT_BUDGET_BYTES.status` |
| Subagent final-answer page | 2 KiB | 8 KiB | `OUTPUT_BUDGET_BYTES.answer` |
| Log excerpt | 1 KiB | 4 KiB | `OUTPUT_BUDGET_BYTES.log` |
| List page | 1 KiB | 4 KiB | `OUTPUT_BUDGET_BYTES.list` |
| Completion callback batch **and urgent callback** | 2 KiB | 8 KiB | `OUTPUT_BUDGET_BYTES.callbackBatch` |
| Explicit raw evidence page | 16 KiB | 64 KiB | `OUTPUT_BUDGET_BYTES.rawPage` |

Default log excerpts are 10 display rows (`OUTPUT_PAGE_DEFAULTS.logLines`).
Default lists are 10 compact rows (`OUTPUT_PAGE_DEFAULTS.listEntries`).
Callers may pass a lower `maxBytes` / `lines` / `limit`, or an explicit larger
page up to the hard cap.

Standalone tools and action wrappers share one assembler
(`assemblePriorityEnvelope`). A page never exceeds its budget: a pager that
cannot fit the next code point returns an empty page whose `nextCursor` does
not advance, and the envelope never clips a page after the pager produced it.
Answer and explicit raw pages reserve part of the budget for page bytes, so a
long failure section cannot starve them.

## Session scope

- Default list and direct id reads are **current-session**.
- Override with `all: true`.
- Foreign session: ownership gap; evidence is not included; not “not found”.
- Unreadable/unknown ownership, including an unavailable current-session
  identity: ownership gap; never a healthy empty result, never a conclusive
  missing task, and never same-process “legacy” evidence without `all:true`.
- Every cursor (answer, raw, list, incident, status) binds a digest of its
  resource **and** the selected scope. Reusing a cursor under another scope
  resets with `reset=stale-cursor`.

## Cursors

Cursors are opaque and caller-owned. Replaying `cursor` returns the same page.
`nextCursor` continues. Two callers do not consume each other.

| Kind | Prefix / owner | What it pages |
|---|---|---|
| Verbatim text | `p1.` `k=t` (log-utils) | Final answers, verbose metadata |
| Retained file | `p1.` `k=f` (log-utils) | Raw retained log bytes |
| Status revision | `p1.` `k=s` (log-utils) | Unchanged vs failure-only vs content |
| List | `l1.` (log-utils `pageRows`) | Compact list rows (keyset: last row shown) |
| Incidents | `i1.` (failure-observations) | Active incidents, resumable inside a row |

The change-detection cursor is printed as `statusCursor=…`; the page cursor as
`nextCursor=…`. A status cursor with unchanged content **and** failures
returns `No new evidence since cursor …`. Content revisions include lifecycle
metadata (status, exit, end time, classification) and the log's identity, so a
metadata-only transition or a deleted log is a change. Failure revisions cover
every observation's state, count, and latest evidence, so a repeated failure
of the same operation is a failure-only change (`change=failure`).

A raw page that reaches the end prints `end nextCursor=…`; that cursor returns
only bytes appended later. Compact log tails and status excerpts that omit
earlier rows or a long line's prefix say so (`hasMore=true omittedBytes=…`)
and give a raw cursor that pages from the oldest retained byte.

## Evidence gaps

Every omission is one of:

1. **Omitted from this response, retained and retrievable** — `hasMore`,
   `omittedBytes` / `omittedRows`, `nextCursor` / `incidentCursor`.
2. **Unavailable / unreadable / corrupt** — `gap read`, never empty-healthy
   and never “does not exist” when the id, its run directory, or its evidence
   exists. Corrupt or missing metadata is counted on lists.
3. **Permanently discarded by capture or retention** — `gap capture` /
   `gap retention` with byte counts (each poll result counted once). Not
   recoverable. Do not claim full-history recovery.
4. **Cursor invalidated** — `reset=stale-cursor` / `source-replaced` /
   `compacted` (including same-inode retention and in-place rewrites).

A trailing, incomplete UTF-8 sequence in a retained file is withheld
(`pendingBytes=…`) until the writer completes it. Capture never keeps a
partial code point at its cap; those bytes are counted as discarded.

## Failures and incidents

Unresolved incidents, matched condition, stop error, recorded runtime errors,
and observation gaps render before routine progress. Decision facts (matched
condition and observed value, stop error, exit) are budgeted ahead of the
incident rows, so long incidents never hide them. The shared incident summary
shows whole rows when they fit; otherwise it leads with
`N active failure observations · K shown · M omitted · incidentCursor=…`, where
the counts are exact and the cursor resumes at the first byte not shown (even
inside a row longer than a page). Pass `incidentCursor` as `cursor` to
`subagent_result` / `subagent_output` / `bg_task_status`. The failure journal
remains retained evidence.

## Callbacks

Ordinary completions share one 2 KiB batch. Rows that do not fit stay queued,
are **not** receipted, and flush on the next window. Overflow survives
handoff failure and `/reload` via durable pending markers; already-receipted
rows are not sent again. Each row reports `incidents=N shown=K` and, when rows
are omitted, `omittedIncidents=M retrieve: <tool>`; a clipped incident row is
never counted as shown. A single oversized row shrinks its detail, never its
counts.

Urgent health/failure callbacks are bounded to 2 KiB total: header,
explanation, whole incident rows that fit, the incident count line, and one
inspect line naming the real task/run id (notification identity and retrieval
identity are separate).

`callback:false` never enters the batch. Origin isolation is rechecked at flush.

## Ordinary output

Ordinary result / output / list / callback payloads omit ordered tool-name
sequences and default token/cost lines. Spend remains on the TUI widget and is
opt-in for explicit transcript/evidence retrieval. Final answers are verbatim,
including leading indentation and trailing newlines. Verbose background
metadata is explicit evidence under the raw-page budget: plain JSON when it
fits, otherwise paged with a cursor.

## Before / after measurements

BEFORE capture (issue discussion budgets, historical):
`docs/issue-312-payload-baseline.md` / `.json`.

AFTER capture (OUTPUT-POLICY defaults):
`docs/issue-312-payload-baseline-after.md` / `.json`.

Rerun:

```bash
node --import tsx scripts/issue-312-payload-baseline.mjs --phase after \
  --json-out docs/issue-312-payload-baseline-after.json \
  --md-out docs/issue-312-payload-baseline-after.md
```
