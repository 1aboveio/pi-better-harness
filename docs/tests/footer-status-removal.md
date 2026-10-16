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
