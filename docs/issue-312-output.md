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
(`assemblePriorityEnvelope`).

## Session scope

- Default list and direct id reads are **current-session**.
- Override with `all: true`.
- Foreign session: ownership gap; evidence is not included; not “not found”.
- Unreadable/unknown ownership: ownership gap; never a healthy empty result
  and never a conclusive missing task.
- Cursors bind to the selected session scope.

## Cursors

Cursors are opaque and caller-owned. Replaying `cursor` returns the same page.
`nextCursor` continues. Two callers do not consume each other.

| Kind | Prefix / owner | What it pages |
|---|---|---|
| Verbatim text | `p1.` `k=t` (log-utils) | Final answers and compact excerpts |
| Retained file | `p1.` `k=f` (log-utils) | Raw retained log bytes |
| Status revision | `p1.` `k=s` (log-utils) | Unchanged vs failure-only vs content |
| List | `l1.` (subagent list) | Compact list rows |
| Incidents | `i1.` (failure-observations) | Omitted unresolved incidents |

A status cursor with unchanged content **and** failures returns
`No new evidence since cursor …`. A failure-journal change with unchanged log
bytes returns the incidents (`change=failure`).

Compact newest-suffix tails may preview the end of a huge line. Omitted prefix
bytes are retrievable: pass the returned `nextCursor` to page from the start of
the excerpt, or use `mode=raw` / `tail_lines:0` to page retained file bytes
from the oldest retained offset. Consecutive raw/answer pages concatenate to
the retained source; they do not skip unread snapshot bytes.

## Evidence gaps

Every omission is one of:

1. **Omitted from this response, retained and retrievable** — `hasMore`,
   `omittedBytes`, `nextCursor` / `incidentCursor`.
2. **Unavailable / unreadable / corrupt** — `gap read`, never empty-healthy
   and never “does not exist” when the id is known.
3. **Permanently discarded by capture or retention** — `gap capture` /
   `gap retention` with byte counts. Not recoverable. Do not claim full-history
   recovery.
4. **Cursor invalidated** — `reset=stale-cursor` / `source-replaced` /
   `compacted` (including same-inode retention).

## Failures and incidents

Unresolved incidents, matched condition, stop error, and observation gaps
render before routine progress. The compact summary shows up to five incident
rows and **counts** the rest. Omitted incidents are retrievable with
`incidentCursor` on `subagent_result` / `subagent_output` / `bg_task_status`
(same tool, `cursor` parameter). The failure journal remains retained evidence.

## Callbacks

Ordinary completions share one 2 KiB batch. Rows that do not fit stay queued,
are **not** receipted, and flush on the next window. Overflow survives
handoff failure and `/reload` via durable pending markers; already-receipted
rows are not sent again.

Urgent health/failure callbacks are also bounded to 2 KiB total, keep
receipts, and include incident counts plus the inspect tool when rows/incidents
are omitted.

`callback:false` never enters the batch. Origin isolation is rechecked at flush.

## Ordinary output

Ordinary result / output / list / callback payloads omit ordered tool-name
sequences and default token/cost lines. Spend remains on the TUI widget and is
opt-in for explicit transcript/evidence retrieval.

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
