# Issue #312 model-facing payload baseline (after)

Measured at 2026-09-27T04:58:14.545Z from rush/312-validation @ `bc01dcb76a2f9746e78536c28b5e2b33ce3a412c`.
Accounting: **UTF-8 bytes** (`Buffer.byteLength(text, "utf8")`). Tokenizer counts are not included.

Runtime model for this capture session: `xai/grok-4.6` effort `high`.
No model calls were made to seed the payloads.

## How to rerun (BEFORE and AFTER)

```bash
node --import tsx scripts/issue-312-payload-baseline.mjs --phase before \
  --json-out docs/issue-312-payload-baseline.json \
  --md-out docs/issue-312-payload-baseline.md
```

After the integration lands, rerun with `--phase after` and compare `utf8Bytes`, `facts.containsOrderedToolSequence`, longest-line bytes, and whether proposed budgets are exceeded. Do not treat this BEFORE file as a regression pin that blesses current over-budget or tool-history behavior.

## Proposed budgets (issue discussion, not enforced)

| Surface | Proposed UTF-8 budget |
|---|---:|
| background_status | 1024 |
| subagent_result | 2048 |
| log_excerpt | 1024 |
| list_page | 1024 |
| callback_batch | 2048 |
| raw_evidence | 16384 |

## Cases

| id | family | tool | UTF-8 bytes | UTF-16 units | longest line (UTF-8) | exceeds proposed | ordered tool sequence |
|---|---|---|---:|---:|---:|---|---|
| `subagent.success.result` | success | subagent_result | 426 | 422 | 211 | no / 2048 | no |
| `subagent.success.output` | success | subagent_output | 394 | 392 | 211 | no / 1024 | no |
| `subagent.success.callback` | success | finalizeRun.sendMessage | 281 | 276 | 135 | no / 2048 | no |
| `subagent.failed.result` | failed | subagent_result | 548 | 542 | 210 | no / 2048 | no |
| `subagent.failed.callback` | failed | finalizeRun.sendMessage | 287 | 282 | 134 | no / 2048 | no |
| `subagent.incomplete.result` | incomplete | subagent_result | 909 | 903 | 215 | no / 2048 | no |
| `subagent.incomplete.callback` | incomplete | finalizeRun.sendMessage | 341 | 338 | 140 | no / 2048 | no |
| `subagent.orphaned.result` | orphaned | subagent_result | 813 | 807 | 212 | no / 2048 | no |
| `subagent.orphaned.callback` | orphaned | formatHealthCallbackTrigger | 437 | 436 | 196 | no / 2048 | no |
| `subagent.unicode.result` | unicode-long-line-json | subagent_result | 2041 | 900 | 1813 | no / 2048 | no |
| `subagent.many_failures.result` | many-failures | subagent_result | 1795 | 1779 | 359 | no / 2048 | no |
| `subagent.list` | many-failures | subagent_list | 904 | 887 | 80 | no / 1024 | no |
| `subagent.foreign.result` | success | subagent_result | 262 | 261 | 96 | no / 2048 | no |
| `subagent.ownership.unavailable` | success | subagent_result | 346 | 345 | 160 | no / 2048 | no |
| `background.success.status` | success | bg_task_status | 360 | 360 | 214 | no / 1024 | no |
| `background.success.status.wrapper` | success | bg_status | 360 | 360 | 214 | no / 1024 | no |
| `background.success.log` | success | bg_task_log | 119 | 119 | 33 | no / 1024 | no |
| `background.failed.status` | failed | bg_task_status | 905 | 902 | 302 | no / 1024 | no |
| `background.repeated_poll.status` | repeated-poll | bg_task_status | 606 | 606 | 222 | no / 1024 | no |
| `background.repeated_poll.log.default` | repeated-poll | bg_task_log | 661 | 661 | 72 | no / 1024 | no |
| `background.repeated_poll.log.full` | repeated-poll | bg_task_log | 10200 | 10200 | 78 | no / 16384 | no |
| `background.unicode.status` | unicode-long-line-json | bg_task_status | 1017 | 633 | 578 | no / 1024 | no |
| `background.unicode.log` | unicode-long-line-json | bg_task_log | 7779 | 2754 | 7647 | no / 16384 | no |
| `background.many_failures.status` | many-failures | bg_task_status | 999 | 993 | 330 | no / 1024 | no |
| `background.many_failures.list` | many-failures | bg_task_list | 922 | 917 | 302 | no / 1024 | no |
| `callback.many_completions.batch` | many-completions | createCallbackBatcher.sendMessage | 1949 | 1469 | 288 | no / 2048 | no |

## Facts worth carrying into AFTER

These are observations about the current producer, not blessed behavior.

- `subagent.success.result`: TUI compact 415 B vs model 426 B
- `subagent.failed.result`: TUI compact 531 B vs model 548 B
- `subagent.incomplete.result`: contains Observation incomplete; TUI compact 755 B vs model 909 B
- `subagent.orphaned.result`: TUI compact 699 B vs model 813 B
- `subagent.unicode.result`: TUI compact 413 B vs model 2041 B; UTF-8 2041 B > UTF-16 900
- `subagent.many_failures.result`: TUI compact 751 B vs model 1795 B
- `background.success.status.wrapper`: wrapper matches standalone: true; TUI compact 226 B vs model 360 B
- `background.failed.status`: matched-condition path present: true; compact "Condition matched:" line present: true; compact result field currently shows `failure_when`
- `background.repeated_poll.log.default`: TUI compact 588 B vs model 661 B
- `background.repeated_poll.log.full`: TUI compact 601 B vs model 10200 B
- `background.unicode.status`: UTF-8 1017 B > UTF-16 633
- `background.unicode.log`: TUI compact 338 B vs model 7779 B; UTF-8 7779 B > UTF-16 2754; longest line 7647 B
- `background.many_failures.status`: contains Observation incomplete

## Limitations

- Accounting is UTF-8 bytes via Buffer.byteLength, plus JS UTF-16 code-unit length. Tokenizer counts are not measured.
- Payloads come from registered tool execute() / finalizeRun sendMessage / callback-batcher sendMessage. TUI renderResult is recorded only to show display folding is not the model-facing budget.
- Seeds are synthetic NDJSON / watch logs and failure journals. No live model child and no real credentials. Historical issue samples are not this checkout.
- Date.now is frozen for deterministic elapsed/status text. Production elapsed is live.
- BEFORE comparison uses the issue #312 discussion table. AFTER comparison uses OUTPUT-POLICY defaults (status/log/list 1 KiB, answer/callback 2 KiB, raw 16 KiB).
- Background status/log strings embed absolute registry paths. utf8Bytes includes that host prefix; facts.utf8BytesExcludingIsolatedTmpdir substitutes $TMPDIR so AFTER comparisons can ignore path-length drift.
- Session tools are wired with getActiveOrigin. Default list/status/result are current-session. Foreign and unavailable ownership are measured as gaps, not masked with all:true.
- Raw retained evidence is pageable from the oldest retained offset. Capture/retention loss is disclosed and is not recoverable as full history.
- Process stdout/stderr 1 MiB capture overflow is not exercised here (needs a live command); product tests cover capture counters.
- verbose:true status remains an explicit recovery hatch and is not the default compact payload.

## Integration usage

The AFTER validation unit should import `collectBaseline` from `scripts/issue-312-payload-baseline/run.mjs` (after isolating TMPDIR via `isolateHarnessEnv`) or exec this CLI. Compare by case id. A drop in UTF-8 bytes, disappearance of ordered tool sequences from ordinary results, and explicit omission/continuation metadata are the intended deltas — not a frozen hash of this BEFORE capture.

