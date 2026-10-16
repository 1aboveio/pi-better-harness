# Footer status removal verification

## Scope

Remove the persistent minimal-tool-output and sandbox footer entries, including
`tools: minimal` and `sandbox · available`. Keep tool rendering, preference
persistence, sandbox policy publication and enforcement, command reports,
confirmations, and warning notifications unchanged. Preserve the exported
sandbox status formatters for compatibility.

Base: `origin/main` at `169af2d95e168913a39d1f43cd31440ff45f76ed`.
Environment: macOS, Node.js `v24.14.1`, npm `11.11.0`, workspace lockfile install.
All work and test settings used disposable state, outside the parent checkout.

## Regression proof

Before the implementation, the two changed minimal-output cases and four changed
sandbox lifecycle cases failed on their footer assertions. The passing suites
below include all six cases. They exercise commands, settings controls, startup,
branch restoration, reload, confirmed sandbox off/on, and unsafe-root warnings.
They drive the real extensions and tool-row renderer, not source-text checks.

## Checks

- `node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/minimal-tool-output.test.mjs scripts/harness-settings.test.mjs`
  - 51 passed, 5 skipped, 0 failed. Four skips require fullscreen mouse routing;
    one requires a bundled CLI absent from the lockfile's Pi SDK.
- `npm run verify -w packages/pi-better-sandbox`
  - Typecheck passed; 219 tests passed, 1 skipped, 0 failed. The skip is the
    Linux-only Bubblewrap case. Real macOS kernel confinement checks passed.
- `npm run typecheck`
  - Passed across all workspaces that declare a typecheck script.
- `node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/harness-settings.tui.e2e.test.mjs`
  - 1 passed, 0 skipped, 0 failed. The existing isolated tmux journey covers
    tool-output settings, expansion, reload, fresh-session defaults, and resume
    without model requests.
- `node /Users/exoulster/.pi/agent/skills/test-quality/scripts/lint-tests.mjs --diff origin/main`
  - No findings in the change.
- `git diff --check`
  - Passed.

The full monorepo test suite was not run. No release metadata was changed and
nothing was pushed, published, or submitted as a pull request.

## Clarified scope: work and background counts

Extended commit `0856d2ce9431ece3ebb607bb17e49ad2562abeda` to also remove
persistent `← work · N` and Goal's `bg N` (including unhealthy-count suffixes).
The shared navigator still clears its old status key on startup/reload/disposal;
its exported helpers remain available. Regenerated Background Tasks and
Subagents copies with `npm run sync:shared-log-utils`. The legacy
`subagents-nav` formatter in `navigator.mjs` is not wired into the live footer.

Keyboard navigation, grouped widgets, detail/log views, two-press close
confirmations, Goal pause/stall/no-progress guidance, question-completion
feedback, transient command/error feedback, activity inspection, and actual
worker lifecycle/callback paths were preserved. No product policy, release
metadata, parent-checkout files, or parent untracked work was changed.

### Regression evidence

Before the implementation, two shared-navigator cases and the registered
Subagents reload case failed on `← work` footer values. Both new Goal cases
(healthy/unhealthy work) failed on persistent count footer assertions. These
were behavioral tests invoking real modules at the host UI/provider boundary.
All five cases pass after the change. Existing question-harvest coverage now
also checks its transient footer while another worker remains active.

### Checks for the extension

Environment: macOS, Node.js `v24.14.1`, npm `11.11.0`, `npm ci --ignore-scripts`.
State, preferences, registries, and tmux servers were isolated from the parent.

- `npm test -w packages/navigator`: 31 passed, 0 skipped/failed.
- `npm test -w packages/pi-better-goal`: 188 passed, 0 skipped/failed.
- `node --import tsx --import ./packages/pi-better-subagents/tests/isolate-registry.mjs --test packages/pi-better-subagents/tests/navigator*.test.mjs packages/pi-better-subagents/tests/shared_navigator_tail.test.mjs packages/pi-better-subagents/tests/extension_health_lifecycle.test.mjs`:
  150 passed, 0 skipped/failed, including live stop, ownership, reload cleanup,
  callback batching, and health lifecycle checks.
- `node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/minimal-tool-output.test.mjs scripts/harness-settings.test.mjs scripts/sync-shared-log-utils.test.mjs`:
  58 passed, 5 skipped, 0 failed. The skips are the existing four fullscreen
  mouse-routing cases and one bundled-CLI case noted above.
- `npm run typecheck`: passed across all declaring workspaces.
- `PI_NAVIGATOR_EVIDENCE_DIR=/private/tmp/pi-footer-status-proof npm run test:golden:navigator`:
  6 passed, 0 skipped/failed in real Pi/tmux. The probe waits for Goal to observe
  active background work. Overview and returned-editor captures contain no
  persistent badges; Left/Enter, both provider details, Unicode logs at 100/80
  columns, close routing, editor replacement/wrapping and focus return work.
  Captures and `smoke-results.json` are retained in the evidence directory.
- `node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/goal-pause.tui.e2e.test.mjs scripts/harness-settings.tui.e2e.test.mjs`:
  2 passed, 0 skipped/failed, covering Goal Escape/pause/resume and tool settings,
  expansion, reload, defaults, and resume.
- Test-quality lint against `0856d2c`: no findings. `git diff --check`: passed.

### Known baseline failure

`npm test -w packages/pi-better-background-tasks`: 260 passed, 2 Windows-only
skips, 1 failed. The existing `#409 holds time-separated completions while busy
and drains once after agent_settled` case fails at `src/e2e.test.ts:321` (one
message instead of zero). Running that entire E2E file again reproduced it:
19 passed, 1 failed. The same E2E file at unmodified commit `0856d2c`, in a
disposable detached checkout with the same dependencies, produced the identical
19-pass/1-fail result. This unrelated completion-batching failure was not fixed
or suppressed. Other Background Tasks lifecycle and real macOS sandbox checks
passed. The full monorepo suite was not run.

Package impact: private `navigator` source, published `pi-better-background-tasks`,
`pi-better-subagents`, and `pi-better-goal`; the bundled `pi-better-harness` release
must include those updated dependencies. Release versioning and delivery remain
with the parent task. This implementation was committed locally only.
