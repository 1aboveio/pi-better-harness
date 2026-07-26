# Plan — #64 Discover child event signatures

## Slices

- [x] Capture normal model response JSON stream
- [x] Capture tool start/end (+ update) stream
- [x] Extract usage/cost samples from assistant message_end
- [x] Capture terminal agent_end / agent_settled
- [x] Reproduce model/API error + auto_retry_* (and document network-probe limitation)
- [x] Reproduce compaction_* envelope (RPC manual); document auto-compact print-mode gap
- [x] Document raw non-JSON noise separately
- [x] Write NOTES.md meaningful-activity + detectability verdicts
- [x] Bounded redacted fixtures + validation test
- [x] Closeout: scope-class, scan-diff, PR #97 + Review Contract

## Non-goals

- No production health/parser behavior changes
- No inferred long_model_call UI
