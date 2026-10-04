# Goal Settings Verification

Issue: https://github.com/1aboveio/pi-better-harness/issues/411

Branch: `fix/goal-auto-resume-settings`, based on `origin/main` at
`80fd376237340c12df83f00e60a95dbfdd547593` in a disposable standalone clone.
Callback PR #410 and callback-batcher changes are not included. This work stops
at a local commit; no push, PR, or merge is authorized.

## Implemented Scope

Two independent user-wide persistent controls, both enabled by default:

- `/goal settings auto-continue on|off`: automatic idle and background-drain wakes.
- `/goal settings conversational-resume on|off`: model-callable `goal_resume` after Escape pause.

`/goal settings`, `/goal`, and `get_goal` inspect the controls. Preferences follow
the existing extension-owned agent-directory storage convention. Session goal
state, workflow ownership, clocks, background progress observation, question
harvesting, and callback delivery retain their existing behavior.

## Executed Checks

- `npm run verify -w packages/pi-better-goal`: typecheck passed; 94 tests passed,
  zero failed, zero skipped.
- `npm run typecheck`: all workspace typechecks passed.
- `node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/goal-retry-runtime.test.mjs scripts/goal-pause.tui.e2e.test.mjs`:
  both real-host regressions passed, zero skipped. The TUI journey used a private
  tmux server and scripted model provider; the runtime journey used a real Pi
  AgentSession and synthetic failing provider, not live model credentials.
- Test-quality `scripts/lint-tests.mjs --diff origin/main`: no findings.
- `git diff --check`: passed.

Focused regressions exercise enabled defaults, persistence across extension
recreation, independent controls, kickoff and explicit command/hotkey resume
with both controls off, pending idle/drain wake cancellation, in-flight audit
invalidation, background-drain progress observation while disabled,
environment-disable precedence, re-enable grace periods, disabled/stale
`goal_resume` refusal, active tool preservation, disabled prompt/status
guidance, restored paused workflow guidance, invalid command rejection, and
preference read/validation/save errors without changing runtime settings.

Preference tests use disposable directories and real file I/O. Existing goal
fixtures and the real-host retry test are isolated from user preferences.

## Limits

The full repository test suite and live-provider scenarios were not run.
The TUI journey verifies the existing default-enabled flow; disabled controls
are exercised through registered extension handlers/tools and fake timers.
No callback implementation or delivery changes were made.
