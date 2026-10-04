# Issue #415: Phase 1/2 Diagnosis

Scope: tests only. No implementation, new runtime APIs, commits, cloud calls,
real credentials, real process inspection, or Android operations. Product Manager
and Architect retain ownership of the structured blocker and rearm contract.

## Reproduce

Run from the repository root, without the package's source-syncing `pretest`:

```sh
node --import tsx --import ./scripts/isolate-registry.mjs --test --test-name-pattern='issue #415' packages/pi-better-goal/test/extension.test.ts
```

Expected current exit: 1. Three leaf cases fail (Node counts their failing parent
as a fourth failure). Repeated runs produce the same assertions:

- Assistant rephrasing: `12 !== 11` queued turns. The continuation ledger reports
  `blocked: false`, `noProgressRetries: 0`, and `lastProgressAt: 4300000` despite
  unchanged tool failures from fake time `1000000` onward.
- Persisted hold plus ordinary question: `1 !== 0` new queued turns.
- Persisted hold plus unrelated background completion: `1 !== 0` new queued turns.
  Both replay cases report `blocked: false` and `noProgressRetries: 0` afterward.

All cases first verify that the goal remains active with `completedAt: null`.
Automatic success is not observed; renewed autonomous work and recorded progress
without permission recovery are the reproduced symptoms.

## Smallest Exercised Scenario

The rephrasing case uses the existing extension harness and real registered
`session_start`, `/goal`, `agent_start`, `agent_end`, and `agent_settled` handlers.
Each turn contains the same two synthetic tool calls and error results: a dummy
credential-cache read returning EPERM and a fixture process-inspection denial.
Only the final assistant text alternates between two equivalent summaries.

Eleven settled turns and ten timer-delivered retries consume the documented
existing allowance. Advancing the fake clock by one final 60 seconds delivers
the unwanted twelfth turn. No provider, ordinary input, runtime override, real
tool execution, or manually fabricated continuation state is needed.

The replay cases establish a hold through eleven identical failed turns, shut
down, copy persisted entries into a fresh existing harness, and restore through
`session_start`. Replay alone queues nothing. One ordinary question and answer,
or one unrelated provider's running-to-completed transition, then rearms work.
Provider completion here supplies lifecycle evidence, not permission recovery.

## Ranked Falsifiable Hypotheses (Untested)

1. Assistant prose participates in progress identity. If only prose variation is
   removed, identical errors should accumulate retries and hold at the existing
   limit. Relevant paths: `src/continuation.ts` and the `agent_settled` handler in
   `src/index.ts`. The existing identical-outcome control passes.
2. Ordinary input clears a held ledger without recovery evidence. If the
   question/answer is omitted, the restored hold should remain quiet; if only
   unrelated input is delivered, it should already clear `blocked`.
3. Background drain treats unrelated lifecycle completion as goal progress. If
   the provider remains running instead of completing, the restored hold should
   not reset or wake. Relevant path: `publishSnapshot` in `src/index.ts`.

These predictions are a handoff, not a chosen recovery policy or implementation.
ADR 0006 separates lifecycle, failure evidence, and recovery; the existing goal
continuation-state ledger is exercised unchanged. The available independent
`packages/pi-better-subagents/CONTEXT.md` was read for domain terminology.

## Verification

```sh
node --import tsx --import ./scripts/isolate-registry.mjs --test --test-skip-pattern='issue #415' packages/pi-better-goal/test/*.test.ts
npm --workspace packages/pi-better-goal run typecheck
node /Users/exoulster/.pi/agent/skills/test-quality/scripts/lint-tests.mjs --diff HEAD
git diff --check
```

Existing suite: 114 passed, zero failed. Typecheck, focused test lint, and diff
whitespace checks pass. New regressions deliberately remain red and unskipped.
Dependency setup used only permitted ignored symlinks to the main workspace's
root and goal-package `node_modules`; no install or metadata edits were made.
