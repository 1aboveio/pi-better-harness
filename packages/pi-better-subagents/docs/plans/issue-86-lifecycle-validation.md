# Issue 86: Validate subagent lifecycle before presenting clean results

Implementation Model: xai/grok-4.5 @ high
Related: #75 (regression coverage preserved via PR #79)

Public seams: `parseRun`, lifecycle classification, child-exit finalization (`finalization.ts`), `subagent_result`, completion delivery.

## AC map

- [done] AC1: Lifecycle validation derives terminal-event presence from child logs. Proof: `tests/parse_run.test.mjs`, `tests/run_finalization.test.mjs`.
- [done] AC2: Lifecycle validation detects unmatched tool executions. Proof: `tests/parse_run.test.mjs`, `tests/run_finalization.test.mjs`.
- [done] AC3: Exit 0 with no terminal event → `incomplete_no_terminal_event`. Proof: `tests/run_finalization.test.mjs` (classifier + finalizeRun integration).
- [done] AC4: Exit 0 with unmatched tools → `incomplete_open_tools`. Proof: `tests/run_finalization.test.mjs`.
- [done] AC5: Nonzero exit → `failed_exit` separately. Proof: `tests/run_finalization.test.mjs` (classifier + finalizeRun integration).
- [done] AC6: `subagent_result` includes lifecycle diagnostics for incomplete runs. Proof: `tests/incomplete_result.test.mjs`, finalizeRun integration via `buildSubagentResultText`.
- [done] AC7: Progress text is not a clean final answer when lifecycle fails. Proof: `tests/incomplete_result.test.mjs` (fresh + legacy completed metadata), finalizeRun integration.
- [done] AC8: Completion callbacks use attention wording. Proof: `tests/callback_completion.test.mjs`, finalizeRun integration callback assertions.
- [done] AC9: Coherent terminal + balanced tools still complete. Proof: `tests/run_finalization.test.mjs`, `tests/incomplete_result.test.mjs`.
- [done] AC10: failed/killed remain compatible. Proof: `tests/run_finalization.test.mjs`, `tests/incomplete_result.test.mjs`.
- [done] AC11: Tests cover normal, no terminal, unmatched tools, nonzero, killed, result formatting, callback wording, **and real finalization/result integration**.

## Round-1 fix (lifecycle-validation-authority)

- [done] Legacy `completed + exitCode 0` metadata without `lifecycleClassification` is re-derived from parsed stream evidence (`resolveLifecycle` → `classifyChildExit`).
- [done] First-party `finalizeRun` / `buildSubagentResultText` live in `finalization.ts` and are executed by integration tests (persist meta, callback delivery, result body) without mocking parser/classifier/registry.
- [done] Rebased onto `origin/main` preserving bounded-tail parser behavior from #73.

## Round-2 fix (lifecycle-validation-authority / complete-stream evidence)

- [done] `scanLifecycleEvidence` streams the full NDJSON log in fixed-size chunks (never retains the whole file) for tool-balance + terminal authority.
- [done] `parseRunForLifecycle` overlays full-stream lifecycle fields onto bounded-tail `parseRun` output; result text/token parsing remains memory-safe (#73).
- [done] `finalizeRun` and `buildSubagentResultText` classify via `parseRunForLifecycle` only.
- [done] Stored `lifecycleClassification: "complete"` is re-checked against current stream evidence in `resolveLifecycle`.
- [done] Real finalizeRun regression: unmatched `tool_execution_start` outside `PI_SUBAGENT_MAX_LOG_PARSE_BYTES=1024` + trailing `agent_end` → persists `incomplete_open_tools`, ATTENTION callback, diagnostic result.
- [done] Legacy completed + stored complete classification under truncated window reclassifies via `buildSubagentResultText`.

## Round-3 fix (lifecycle-validation-authority / bounded newline-free records)

- [done] `scanLifecycleEvidence` retains at most `LIFECYCLE_RECORD_PREFIX_BYTES` (4 KiB) per NDJSON record while hunting lifecycle fields; large newline-free payloads are discarded until the next newline (never `leftover + chunk` growth proportional to event size).
- [done] Lifecycle fields (`type` / `toolCallId` / `toolName`) are extracted from the retained prefix without `JSON.parse` of the full event payload.
- [done] When a capped record looks like JSON but yields no extractable `type`, evidence is marked `complete: false` so classification fails closed (no clean completion from unknown evidence).
- [done] Real finalizeRun / buildSubagentResultText regressions for single events larger than the 64 KiB scan chunk (coherent large `agent_end` stays complete; unknown capped record → incomplete; large unmatched tool start + terminal tail → incomplete_open_tools).
- [done] Tight-heap child (`--max-old-space-size=16`) proves an 8 MiB newline-free record still scans without OOM.

## Round-4 / split-scope fix (structural lifecycle scanner authority)

Narrowed after human-approved BREAKER SPLIT on theme `lifecycle-validation-authority`:

- [done] `scanLifecycleEvidence` walks each NDJSON record with bounded structural state (depth / string / escape / top-level key ownership). No regex-over-prefix field extraction.
- [done] Top-level `type` / `toolCallId` / `toolName` are collected only at depth 1; nested payload keys never become lifecycle evidence.
- [done] Lifecycle fields are applied only after the record returns to depth 0 (structurally valid). Unfinished/malformed records (including truncated early-type EOF) mark `complete:false` and never set `sawEnd`/tool evidence.
- [done] Valid oversized newline-free top-level lifecycle events still classify correctly without retaining payloads (including late top-level `type` after a large payload).
- [done] Scanner regressions: truncated early-type EOF fail-closed; nested `agent_end` before top-level `message_end` ignored; late top-level type still complete; large nl-free + unmatched tool cases preserved.
- [done] Real `finalizeRun` / `buildSubagentResultText` regressions for truncated early-type EOF and nested-type ordering never produce clean completion.

## Round-5 / split-scope fix (complete JSON grammar authority)

Continues human-approved structural lifecycle scanner authority split:

- [done] `scanLifecycleEvidence` validates complete JSON grammar with bounded streaming state before applying top-level lifecycle fields (not depth-only structural closure).
- [done] Fail closed on trailing commas, mismatched delimiters, invalid primitive syntax (`tru`, leading-zero numbers), invalid string escapes, and unfinished/truncated records.
- [done] Malformed closed oversized `agent_end` (e.g. trailing comma after large payload) never sets `sawEnd` / never finalizes as `complete`.
- [done] Malformed `tool_execution_end` never balances a valid open tool; any malformed record marks the stream untrusted (`complete:false`) and clears terminal lifecycle authority.
- [done] Valid oversized top-level lifecycle events still classify correctly without payload retention.
- [done] Scanner regressions: trailing-comma oversized agent_end; malformed tool_execution_end; invalid primitives/escapes/mismatched delimiters.
- [done] Real `finalizeRun` / `buildSubagentResultText` regressions for trailing-comma agent_end and malformed tool_execution_end never produce clean completion.


## Round-6 / split-scope fix (duplicate semantic lifecycle keys)

Continues human-approved structural lifecycle scanner authority split after post-split recurrence on PR #102:

- [done] Fail closed on duplicate semantic top-level lifecycle keys (`type` / `toolCallId` / `toolName`) before applying any field evidence from that record.
- [done] Object keys are JSON-decoded (including `\uXXXX` escapes) before lifecycle-key matching and duplicate detection, so `"toolCall\u0049d"` is treated as `toolCallId`.
- [done] A grammar-valid record with duplicate `toolCallId` (final value null or otherwise) cannot retain a stale earlier capture or balance an open tool; the record/stream is untrusted (`complete:false`) and terminal authority is cleared.
- [done] Scanner regressions: duplicate toolCallId+null; escaped equivalent key duplicate; duplicate type.
- [done] Real `finalizeRun` / `buildSubagentResultText` regressions for duplicate and escaped-duplicate toolCallId never produce clean completion.

## Contract matrix (`lifecycle-validation-authority` × `subagent_lifecycle_result`)

| state | proof |
|---|---|
| `legacy_completed_metadata` | `tests/incomplete_result.test.mjs` :: legacy completed without stream evidence; `tests/run_finalization.test.mjs` :: reclassifies legacy completed metadata when unmatched tools are outside the parse window |
| `fresh_finalization` | `tests/run_finalization.test.mjs` :: finalizeRun integration (incomplete / complete / failed_exit / truncated unmatched-tool window / large newline-free complete / truncated early-type EOF fail-closed / nested-type ordering fail-closed / trailing-comma malformed agent_end fail-closed / malformed tool_execution_end fail-closed / duplicate toolCallId fail-closed / escaped duplicate key fail-closed / large unmatched tool) |
| `result_formatting` | `tests/incomplete_result.test.mjs` + `buildSubagentResultText` in finalizeRun integration (including truncated-window + large-record + structural fail-closed bodies) |
| `callback_notification` | finalizeRun integration asserts ATTENTION + lifecycle label for incomplete (incl. truncated unmatched tools + truncated early-type + nested-type + open-tools); `tests/callback_completion.test.mjs` |

Adjacent members checked under the same contract (round-4 split-scope structural authority):

| adjacent case | proof |
|---|---|
| unmatched tool start before bounded tail | finalize truncated-window + parse_run scanLifecycleEvidence outside tail |
| terminal event inside bounded tail | same truncated-window cases (agent_end in tail) |
| single very large newline-free event | parse_run large nl-free + finalize large nl-free complete |
| truncated early-type EOF fails closed | parse_run + finalize truncated early-type (`complete:false`, no sawEnd) |
| nested type before real top-level type ignored | parse_run nested-type ownership + finalize nested message_end incomplete |
| closed oversized trailing-comma agent_end fails closed | parse_run + finalize trailing-comma malformed agent_end (`complete:false`, no sawEnd) |
| malformed tool_execution_end never balances open tool | parse_run + finalize malformed tool end (no clean completion; stream untrusted) |
| duplicate semantic lifecycle keys fail closed (no stale capture) | parse_run + finalize duplicate toolCallId/null + escaped equivalent key |
| invalid primitives/escapes/mismatched delimiters fail closed | parse_run invalid grammar matrix |
| late top-level type on oversized valid record | parse_run late-type complete |
| normal coherent completion remains complete | finalize complete + large nl-free complete |
| killed and nonzero-exit remain distinct | incomplete_result killed; finalize failed_exit |

## Slices

- [done] Slice A: named lifecycle classifications + diagnostics on classify/result format.
- [done] Slice B: wire finalization + `subagent_result` + callbacks; preserve #75 behavior.
- [done] Slice C: killed/failed compatibility + full test matrix + closeout.
- [done] Slice D: round-1 blockers — legacy evidence authority + real finalization integration.
- [done] Slice E: round-2/3 blockers — complete-stream authority + bounded newline-free record scanning.
- [done] Slice F: round-4 split-scope — structural lifecycle scanner authority (top-level ownership + malformed fail-closed).
- [done] Slice G: round-5 split-scope — complete JSON grammar authority before lifecycle field application.
- [done] Slice H: round-6 split-scope — fail closed on duplicate semantic lifecycle keys (decoded/escaped equivalents).
