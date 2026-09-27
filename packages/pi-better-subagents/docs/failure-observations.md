# Failure observations

Structured tool, model, exit, and supervision failures are collected separately from lifecycle status. A child may still be `running`, or finish its agent loop, while checks remain unresolved. List, output, result, navigator, and completion notifications expose these observations before assistant progress can suggest that the work is healthy. All of them read the same reduced incident state.

Each run retains an append-only `failures.jsonl` journal. Nothing is deleted from it: recovered and superseded incidents leave the active summaries but stay in history.

## What each label means

| Label | Meaning |
|---|---|
| `Action required` | An incident that needs someone other than the child: a non-tool failure (child exit, model, supervision), the same tool operation failing three times with no recovery, or an incident the child explicitly marked `open`. |
| `Unclassified failure observation` | A tool error the child has not disposed of. Children normally handle their own tool errors, so this is retained evidence, not the run's outcome. |
| `Expected failure` | A non-success the child declared intentional before running the command, or disposed as `expected`. |
| `Observation incomplete` | Missing, corrupt, truncated, or unreadable evidence. |
| `Recovered` / `Superseded` | Closed. Counted in history, never shown as active. |

A completed run reports lifecycle and incidents as separate facts, for example:

```text
status=completed
8 earlier tool failures remain unclassified.
Work correctness was not inferred from lifecycle alone.
```

## When the parent is notified

- **While the child runs**, a single tool error does not wake the parent; the child owns it. The parent is woken, after a 60-second grace period, only for non-tool failures, for an operation that failed three times with no recovery, and for incidents the child marked `open`. Each incident is delivered once. Observation gaps (for example an oversized log record) stay visible on every surface and are delivered with the completion or health callback, since the parent cannot act on them mid-run.
- **At completion**, every still-unresolved incident is reported once in the ordinary completion callback: actionable incidents in full, unclassified tool failures as a count. Incidents a running notification already delivered are counted, not repeated.
- **Orphaned and lost** health callbacks carry the same facts once.

Every notification renders only its pending incidents. Delivery receipts are independent of recovery and are written after handoff; `callback:false` suppresses notifications without hiding inspection evidence.

## Recovery and disposition

Automatic recovery still requires an exact retry: the same tool name, arguments, and working directory, started after the failure. Parallel or unrelated successes cannot clear an incident, and neither can exit 0 of another command or anything an assistant writes.

Sandboxed children (the task runtime) get two structured additions. The parent honours them only for runs whose metadata it wrote as launched on the task runtime; for any other run, intent-looking arguments are ordinary arguments and `failure_disposition` calls are ignored.

- `bash` accepts optional `operationId`, `attemptId`, and `expectedExitCodes`, validated before the command runs.
  - `operationId` names one logical operation across modified retries. A later success with the same `operationId` (a changed scope, timeout, or flag) recovers the earlier failure automatically. Without it, the exact rule applies. `attemptId` names one execution for use as evidence and never changes operation identity.
  - `expectedExitCodes` (distinct integers 1–255) declares intentional non-zero exits, such as `[1]` for an `rg`/`grep` no-match or a `git diff --exit-code` probe. Only the final shell exit code is classified, taken from the tool's structured result, never from output text. Timeouts, aborts, and undeclared codes stay ordinary failures.
- `failure_disposition({ disposition, targets, reason, evidence? })` records an explicit classification of the child's own incidents:
  - `recovered`: the same operation later passed. Evidence must be a successful attempt of that operation that started after the failure.
  - `superseded`: a different verification or remediation established the outcome, such as resolving a merge conflict and continuing. Evidence must be a successful attempt that started after the failure.
  - `expected`: the failure was intentional. A later successful retry keeps the classification.
  - `open`: the incident still needs the parent. This makes it `Action required`.

  A `bash` call whose intent is rejected (malformed fields, or a reused `attemptId`) never runs. It is recorded as its own unclassified observation, not as a failure of the command it named, so it cannot make that operation look stuck.

  Targets may be incident ids, the `attemptId` or `operationId` the child declared, or tool call ids. Unknown, already-disposed, evidence-free, or partially invalid requests are rejected whole, with the open incidents listed, and nothing is written. The parent replays the same validation from the child's log before it appends the disposition to the journal, so dispositions survive reload and replay exactly once.

Unconfined children keep the exact-retry rule and do not yet have these additions.

## Evidence health

The collector scans complete structured records independently of the finite progress tail. Missing terminal logs, unreadable records, and detected truncation are shown as **observation incomplete**. Failure classification uses structured error and exit fields; output text and domain-specific status codes are not failure signals.

A `.observed` companion marker makes missing journals detectable after restart. Failed writes retain evidence and receipts in memory and retry on subsequent reads, with an observation-incomplete warning until storage recovers. This pending memory cannot survive process loss while persistence is unavailable. Journals and markers follow existing run retention and explicit cleanup.
