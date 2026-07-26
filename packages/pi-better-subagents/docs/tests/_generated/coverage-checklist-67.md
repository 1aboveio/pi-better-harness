## Coverage Checklist — issue #67 (surface health in tools + passive UI)

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows auto-filled by `coverage-checklist.mjs generate` then completed; lead/judgment rows completed by the producer for reviewer adjudication._

Scope class: **surface-bearing** (`list.mjs`, `widget.mjs`, `tools.ts`, `index.ts`, `health-surface.mjs`). No browser routes.

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | PASS | `docs/tests/_generated/surface-inventory.json` — `subagent.list-health`, `subagent.output-health`, `widget.health`, `subagent.health-notify` added; no browser route inventory exists in this pi extension repo |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | ownership via `docs/tests/issue-67-health-surfacing.coverage.yml`; proving tests `tests/health_surfacing.test.mjs` tagged `@covers subagent.list-health` / `subagent.output-health` / `widget.health` / `subagent.health-notify` `@level unit`; residual `Unverified` attestation is pre-review state |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | issue #67 ACs map to list/output/result/widget/notify surfacing of #66 observations + #65 orphaned/lost; no navigator health (#69), no stop/restart (#68). Plan: `docs/plans/issue-67-health-surfacing.md` |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | list/output/result are model-facing read tools; widget is passive setWidget paint; notify is existing health-tick mutation from #65 |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests` --diff origin/main → 0 findings (run at closeout) |
| No fixed sleep added | gate-lint | PASS | command: `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings |
| No empty/placeholder test body added | gate-lint | PASS | command: `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings |
| Each added test actually asserts a behavior | lead | PASS | `tests/health_surfacing.test.mjs` asserts healthy silent list/widget, healthy short-running tool silent (no list/output/widget health noise), degraded list suffix, orphaned/lost filters + diagnostics, widget non-focus wiring, size/mtime health-log cache across frames, notify/callback independence pins |
| Declared @level meets each surface floor | gate-lint | PASS | `@level unit` floors in `docs/tests/issue-67-health-surfacing.coverage.yml` |
| First-party interception in a behaviour/journey test is justified | lead | N/A | no browser / Playwright tests |
| No mock of a first-party internal seam module | gate-lint | PASS | command: `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules mock-internal-seam --diff origin/main` → 0 findings; pure helpers + real list/widget/observation modules |
| Mock use respects the boundary | judgment | PASS | observations built via real `observeRunHealth` in `tests/health_surfacing.test.mjs`; no mocked first-party modules |
| Assertions are behavior-first | judgment | PASS | command: `node --experimental-strip-types --test tests/health_surfacing.test.mjs` → 18 pass; asserts on list row text, widget lines, diagnostic lines, status filters, short-running tool silence, health-log cache hit/miss |
| Every new branch / error path has a driving test | lead | PASS | `tests/health_surfacing.test.mjs` covers healthy/quiet silent, healthy short-running tool silent, stale/long-tool/compacting/model-error actionable, orphaned/lost filters + diagnostics, widget degraded suffix, health-log size/mtime cache, result formatter wiring |
| Diffs that modify existing behavior are pinned | lead | PASS | healthy list format pin + widget baseline deepEqual in `tests/health_surfacing.test.mjs`; command: `node --experimental-strip-types --test tests/subagent_list.test.mjs tests/widget_flicker.test.mjs` → pass |
| Runtime smoke: each changed non-browser surface was run | gate-lint | PASS | `node --experimental-strip-types tests/smoke_health_surfacing.mjs` → SMOKE PASS; `docs/tests/_generated/runtime-smoke-results-67.json` |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | no browser routes |
| Presentation sweep ran | gate-lint | N/A | no browser routes |
| Sweep specs do not intercept first-party traffic | lead | N/A | no browser routes |
| Perceivability edge cases | judgment | N/A | no browser routes |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | N/A | repo CI runs `node --test tests/*.test.mjs`; new unit tests included |
