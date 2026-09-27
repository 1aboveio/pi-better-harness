# Issue #312 model-facing payload baseline (after)

Measured at 2026-09-27T08:32:44.013Z from fix/test-packaging-hygiene @ `bc5599b5776be3f043d3a3c14772d516efeef5b4`.
Accounting: **UTF-8 bytes** (`Buffer.byteLength(text, "utf8")`). Tokenizer counts are not included.

Runtime model for this capture session: `unknown/unknown` effort `unknown`.
No model calls were made to seed the payloads.

## How to rerun

```bash
node --import tsx scripts/issue-312-payload-baseline.mjs --phase after \
  --json-out docs/tests/issue-312-payload-baseline/after.json \
  --md-out docs/tests/issue-312-payload-baseline/after.md
```

This AFTER capture measures the shipped OUTPUT-POLICY defaults. Compare it with the BEFORE file (`--phase before`) on `utf8Bytes`, `facts.containsOrderedToolSequence`, longest-line bytes, and whether budgets are exceeded.

## OUTPUT-POLICY default budgets (enforced by the tools)

| Surface | Default UTF-8 budget |
|---|---:|
| background_status | 1024 |
| subagent_result | 2048 |
| log_excerpt | 1024 |
| list_page | 1024 |
| callback_batch | 2048 |
| raw_evidence | 16384 |

## Cases

| id | family | tool | UTF-8 bytes | UTF-16 units | longest line (UTF-8) | exceeds budget | ordered tool sequence |
|---|---|---|---:|---:|---:|---|---|
| `subagent.success.result` | success | subagent_result | 339 | 335 | 120 | no / 2048 | no |
| `subagent.success.output` | success | subagent_output | 307 | 305 | 120 | no / 1024 | no |
| `subagent.success.callback` | success | createCallbackBatcher.flush | 320 | 320 | 163 | no / 2048 | no |
| `subagent.failed.result` | failed | subagent_result | 515 | 509 | 120 | no / 2048 | no |
| `subagent.failed.callback` | failed | createCallbackBatcher.flush | 529 | 527 | 173 | no / 2048 | no |
| `subagent.incomplete.result` | incomplete | subagent_result | 818 | 812 | 133 | no / 2048 | no |
| `subagent.incomplete.callback` | incomplete | createCallbackBatcher.flush | 500 | 498 | 196 | no / 2048 | no |
| `subagent.orphaned.result` | orphaned | subagent_result | 725 | 719 | 131 | no / 2048 | no |
| `subagent.orphaned.callback` | orphaned | createCallbackBatcher.deliverUrgent | 587 | 586 | 196 | no / 2048 | no |
| `subagent.unicode.result` | unicode-long-line-json | subagent_result | 2047 | 984 | 1696 | no / 2048 | no |
| `subagent.multi_page.result` | multi-page-answer | subagent_result | 1993 | 1719 | 151 | no / 2048 | no |
| `subagent.many_failures.result` | many-failures | subagent_result | 630 | 623 | 251 | no / 2048 | no |
| `subagent.list` | many-failures | subagent_list | 899 | 888 | 147 | no / 1024 | no |
| `subagent.foreign.result` | success | subagent_result | 165 | 164 | 88 | no / 2048 | no |
| `subagent.ownership.unavailable` | success | subagent_result | 293 | 292 | 204 | no / 2048 | no |
| `background.success.status` | success | bg_task_status | 589 | 589 | 318 | no / 1024 | no |
| `background.success.status.wrapper` | success | bg_status | 589 | 589 | 318 | no / 1024 | no |
| `background.success.log` | success | bg_task_log | 157 | 156 | 61 | no / 1024 | no |
| `background.failed.status` | failed | bg_task_status | 818 | 815 | 276 | no / 1024 | no |
| `background.repeated_poll.status` | repeated-poll | bg_task_status | 842 | 842 | 333 | no / 1024 | no |
| `background.repeated_poll.log.default` | repeated-poll | bg_task_log | 962 | 961 | 333 | no / 1024 | no |
| `background.repeated_poll.log.full` | repeated-poll | bg_task_log | 10495 | 10495 | 280 | no / 16384 | no |
| `background.unicode.status` | unicode-long-line-json | bg_task_status | 1024 | 694 | 497 | no / 1024 | no |
| `background.unicode.log` | unicode-long-line-json | bg_task_log | 8074 | 3049 | 7647 | no / 16384 | no |
| `background.many_failures.status` | many-failures | bg_task_status | 887 | 881 | 307 | no / 1024 | no |
| `background.many_failures.list` | many-failures | bg_task_list | 864 | 859 | 198 | no / 1024 | no |
| `callback.many_completions.batch` | many-completions | createCallbackBatcher.sendMessage | 1949 | 1469 | 288 | no / 2048 | no |

## Facts worth carrying into AFTER

These are observations about the current producer, not blessed behavior.

- `subagent.incomplete.result`: contains Observation incomplete; TUI compact 755 B vs model 818 B
- `subagent.incomplete.callback`: contains Observation incomplete
- `subagent.orphaned.result`: TUI compact 653 B vs model 725 B
- `subagent.unicode.result`: TUI compact 464 B vs model 2047 B; UTF-8 2047 B > UTF-16 984
- `subagent.multi_page.result`: 5420 B answer over 4 pages (max 2045 B/page); reconstructed exactly: true
- `subagent.many_failures.result`: TUI compact 548 B vs model 630 B
- `background.success.status.wrapper`: wrapper matches standalone: true; TUI compact 311 B vs model 589 B
- `background.failed.status`: matched-condition path present: true; compact "Condition matched:" line present: true; compact result field currently shows `failure_when`
- `background.repeated_poll.log.default`: TUI compact 603 B vs model 962 B
- `background.repeated_poll.log.full`: TUI compact 611 B vs model 10495 B
- `background.unicode.status`: UTF-8 1024 B > UTF-16 694
- `background.unicode.log`: TUI compact 435 B vs model 8074 B; UTF-8 8074 B > UTF-16 3049; longest line 7647 B
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

