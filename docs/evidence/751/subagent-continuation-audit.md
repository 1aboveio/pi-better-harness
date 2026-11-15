# Managed continuation acceptance evidence

Issue: #762, parent #751. This branch integrates #761 recovery at 8c7ec00f. External model responses are fixture-controlled; SDK, bootstrap, workers, local runners, Unix transport, coordinator SQLite, saved native conversations, and result publication are production paths.

## Verified behavior

- `runtime-subagent-park.test.ts` runs actual Background-enabled foreground SDK admission, a separate worker and runner, parking, foreground exit, dependency completion, resume, exact evidence reads/acknowledgement, and durable succeeded assignment outcome. Conversation ID and original capacity owner remain unchanged.
- Crash scenarios kill the server while parked, immediately after resume claim commit, after spawned launch-journal commit, after assignment result commit, after resumed bootstrap with a live writer, and after published claim commit before the launch journal. The canonical bounded repair path is used only after proof of no dispatched/live writer. One token is retained per attempt; the external dependency operation is never relaunched.
- Live bootstrapped writers reconnect using the original private capability and stable runtime socket. Restoration checks the exact writer PID/start identity, conversation and writer lease. Capabilities are stored in owner-only files, not metadata or transcripts.
- Standalone Subagents cannot obtain Background tools simply because Server bundles them. The protected foreground grant captures compatible Background service availability and actual production tool inventory; continuation retains that captured capability.
- Admission reads canonical current permissions and intersects captured profiles. Managed scope validation accepts narrower task permissions, refuses widening, preserves protected paths, and requires mandatory authority. Tool-policy changes currently fail closed for explicit re-admission.
- Unavailable permission sources expose diagnostics and bounded exponential backoff. A 32-admissions/second root budget prevents eviction from defeating per-key backoff; diagnostics retain at most 128 generations. The real unavailable-source fixture verifies no dispatch and idle closure of runtime management after foreground detachment.
- `runtime-subagent-bootstrap-restart.test.ts` verifies stale unbootstrapped epochs cannot execute, while already bootstrapped workers resume the exact original writer and token. Transport paths are canonical and waits/cleanup are bounded.

## Validation and integration boundaries

Dependencies were installed independently with `npm ci`; no original checkout dependency aliases are used. Canonical source packages own typechecking of generated Background/Sandbox source mirrors, matching the existing generated Subagents arrangement.

The fixed Background service is currently created alongside the managed Subagents SDK with a borrowed root coordinator connection. The broader Background foreground-proxy migration and per-request current Background policy publication are being integrated separately. They must preserve captured capability limits and the live-writer restoration checks. Upgrade and root-wide resource acceptance remain parent-epic work.

These are evidence records, not a declaration that #751 is complete. Final integration review must verify permission publication for live restored Background requests, all generated package assets, Windows behavior, and the root resource/reconnect budgets.
