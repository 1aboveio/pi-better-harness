# Issue #312 model-facing payload baseline (before)

Measured at 2026-09-27T03:01:15.658Z from rush/312-baseline @ `0f1f84c18d6df76cce7a4dcdfc2a276a4015abb9`.
Accounting: **UTF-8 bytes** (`Buffer.byteLength(text, "utf8")`). Tokenizer counts are not included.

Runtime model for this capture session: `xai/grok-4.6` effort `high`.
No model calls were made to seed the payloads.

## How to rerun (BEFORE and AFTER)

```bash
node --import tsx scripts/issue-312-payload-baseline.mjs --phase before \
  --json-out docs/tests/issue-312-payload-baseline/before.json \
  --md-out docs/tests/issue-312-payload-baseline/before.md
```

After the integration lands, rerun with `--phase after` and compare `utf8Bytes`, `facts.containsOrderedToolSequence`, longest-line bytes, and whether proposed budgets are exceeded. Do not treat this BEFORE file as a regression pin that blesses current over-budget or tool-history behavior.

## Proposed budgets (issue discussion, not enforced)

| Surface | Proposed UTF-8 budget |
|---|---:|
| background_status | 2048 |
| subagent_result | 8192 |
| log_excerpt | 4096 |
| list_page | 4096 |
| callback_batch | 8192 |
| raw_evidence | 65536 |

## Cases

| id | family | tool | UTF-8 bytes | UTF-16 units | longest line (UTF-8) | exceeds proposed | ordered tool sequence |
|---|---|---|---:|---:|---:|---|---|
| `subagent.success.result` | success | subagent_result | 389 | 378 | 153 | no / 8192 | yes |
| `subagent.success.output` | success | subagent_output | 264 | 256 | 81 | no / 4096 | yes |
| `subagent.success.callback` | success | finalizeRun.sendMessage | 321 | 310 | 135 | no / 8192 | no |
| `subagent.failed.result` | failed | subagent_result | 417 | 404 | 152 | no / 8192 | yes |
| `subagent.failed.callback` | failed | finalizeRun.sendMessage | 327 | 316 | 142 | no / 8192 | no |
| `subagent.incomplete.result` | incomplete | subagent_result | 262775 | 262762 | 7066 | yes / 8192 | yes |
| `subagent.incomplete.callback` | incomplete | finalizeRun.sendMessage | 375 | 366 | 174 | no / 8192 | no |
| `subagent.orphaned.result` | orphaned | subagent_result | 952 | 941 | 224 | no / 8192 | yes |
| `subagent.orphaned.callback` | orphaned | formatHealthCallbackTrigger | 437 | 436 | 196 | no / 8192 | no |
| `subagent.unicode.result` | unicode-long-line-json | subagent_result | 7896 | 2860 | 7647 | no / 8192 | yes |
| `subagent.many_failures.result` | many-failures | subagent_result | 2169 | 2143 | 359 | no / 8192 | yes |
| `subagent.list` | many-failures | subagent_list | 3020 | 2953 | 363 | no / 4096 | no |
| `background.success.status` | success | bg_task_status | 481 | 481 | 177 | no / 2048 | no |
| `background.success.status.wrapper` | success | bg_status | 481 | 481 | 177 | no / 2048 | no |
| `background.success.log` | success | bg_task_log | 251 | 251 | 172 | no / 4096 | no |
| `background.failed.status` | failed | bg_task_status | 881 | 878 | 302 | no / 2048 | no |
| `background.repeated_poll.status` | repeated-poll | bg_task_status | 561 | 561 | 189 | no / 2048 | no |
| `background.repeated_poll.log.default` | repeated-poll | bg_task_log | 496 | 496 | 194 | no / 4096 | no |
| `background.repeated_poll.log.full` | repeated-poll | bg_task_log | 10259 | 10259 | 178 | no / 65536 | no |
| `background.unicode.status` | unicode-long-line-json | bg_task_status | 2692 | 1307 | 2197 | yes / 2048 | no |
| `background.unicode.log` | unicode-long-line-json | bg_task_log | 7821 | 2796 | 7647 | yes / 4096 | no |
| `background.many_failures.status` | many-failures | bg_task_status | 2274 | 2259 | 330 | yes / 2048 | no |
| `background.many_failures.list` | many-failures | bg_task_list | 2360 | 2342 | 330 | no / 4096 | no |
| `callback.many_completions.batch` | many-completions | createCallbackBatcher.sendMessage | 14546 | 10546 | 291 | yes / 8192 | no |

## Facts worth carrying into AFTER

These are observations about the current producer, not blessed behavior.

- `subagent.success.result`: ordered tool sequence: `bash, read, bash, write, edit`
- `subagent.success.output`: ordered tool sequence: `bash, read, bash, write, edit`; `tools used:` header present
- `subagent.failed.result`: ordered tool sequence: `bash, read, bash, write, edit`
- `subagent.incomplete.result`: ordered tool sequence: `bash`; exceeds proposed 8192 B (262775 B); contains Observation incomplete; TUI compact 680 B vs model 262775 B; longest line 7066 B
- `subagent.orphaned.result`: ordered tool sequence: `bash, read`; TUI compact 533 B vs model 952 B
- `subagent.unicode.result`: ordered tool sequence: `bash, read, bash, write, edit`; TUI compact 409 B vs model 7896 B; UTF-8 7896 B > UTF-16 2860; longest line 7647 B
- `subagent.many_failures.result`: ordered tool sequence: `bash`; 7 additional failure observations retained beyond the 5-row summary; TUI compact 830 B vs model 2169 B
- `subagent.list`: 7 additional failure observations retained beyond the 5-row summary; contains Observation incomplete
- `background.success.status.wrapper`: wrapper matches standalone: true; TUI compact 289 B vs model 481 B
- `background.success.log`: TUI compact 239 B vs model 251 B
- `background.failed.status`: matched-condition path present: true; compact "Condition matched:" line present: false; compact result field currently shows `failure_when`
- `background.repeated_poll.log.default`: TUI compact 462 B vs model 496 B
- `background.repeated_poll.log.full`: TUI compact 687 B vs model 10259 B
- `background.unicode.status`: exceeds proposed 2048 B (2692 B); UTF-8 2692 B > UTF-16 1307; longest line 2197 B
- `background.unicode.log`: exceeds proposed 4096 B (7821 B); TUI compact 288 B vs model 7821 B; UTF-8 7821 B > UTF-16 2796; longest line 7647 B
- `background.many_failures.status`: exceeds proposed 2048 B (2274 B); 7 additional failure observations retained beyond the 5-row summary; contains Observation incomplete
- `background.many_failures.list`: 7 additional failure observations retained beyond the 5-row summary; contains Observation incomplete
- `callback.many_completions.batch`: exceeds proposed 8192 B (14546 B)

## Limitations

- Accounting is UTF-8 bytes via Buffer.byteLength, plus JS UTF-16 code-unit length. Tokenizer counts are not measured.
- Payloads come from registered tool execute() / finalizeRun sendMessage / callback-batcher sendMessage. TUI renderResult is recorded only to show display folding is not the model-facing budget.
- Seeds are synthetic NDJSON / watch logs and failure journals. No live model child and no real credentials. Historical issue samples are not this checkout.
- Date.now is frozen for deterministic elapsed/status text. Production elapsed is live.
- Proposed budgets are copied from issue #312 for comparison. This harness does not enforce them and does not treat over-budget output as a pass or fail.
- Background status/log strings embed absolute registry paths. utf8Bytes includes that host prefix; facts.utf8BytesExcludingIsolatedTmpdir substitutes $TMPDIR so AFTER comparisons can ignore path-length drift.
- Background log reads remain tail-capped at 512 KiB in the current reader; this harness does not claim full-history recovery.
- Incomplete/orphaned raw tails are the current tailLog window (40 display rows, 256 KiB read cap). The formatter does not currently disclose skipped older bytes.
- Process stdout/stderr 1 MiB capture overflow is not exercised (would need a live command). Retention-compaction gaps are not a pageable API on this base.
- verbose:true status is not dumped here because it serializes full metadata. Targeted diagnostics vs env dumps are a later product change.

## Integration usage

The AFTER validation unit should import `collectBaseline` from `scripts/issue-312-payload-baseline/run.mjs` (after isolating TMPDIR via `isolateHarnessEnv`) or exec this CLI. Compare by case id. A drop in UTF-8 bytes, disappearance of ordered tool sequences from ordinary results, and explicit omission/continuation metadata are the intended deltas — not a frozen hash of this BEFORE capture.

