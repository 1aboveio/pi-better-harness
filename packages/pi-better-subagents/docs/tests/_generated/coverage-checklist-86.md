## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue)._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` cannot inventory this extension: no `coverage.config.json` or repository inventory adapter. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 without output because this repo has no `coverage.config.json` or inventory adapter; no ownership/floor assertion is available. |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | `lifecycle.ts` owns named lifecycle classification + result formatting; `finalization.ts` owns durable finalize/result assembly; `parse.ts` owns bounded-tail parse + full-stream grammar-validating `scanLifecycleEvidence`/`parseRunForLifecycle` (complete JSON grammar before top-level field ownership, no payload retention); `registry.ts` only persists `lifecycleClassification`; `completion.mjs` only surfaces classification in callbacks. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | `index.ts` host wrappers + `finalization.ts` finalize/result paths are existing internal extension handlers; no new route/API mutation surface. |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings. |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings. |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings. |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/run_finalization.test.mjs` asserts named classifications + persisted finalize metadata/callback/result including truncated unmatched-tool window + large newline-free complete + truncated early-type EOF fail-closed + nested-type ordering fail-closed + trailing-comma malformed agent_end fail-closed + malformed tool_execution_end fail-closed + duplicate toolCallId fail-closed + escaped duplicate key fail-closed + open-tools; `tests/parse_run.test.mjs` asserts grammar-validating full-stream scan (top-level ownership, nested ignore, late type complete, truncated early-type fail-closed, trailing-comma/malformed tool end/duplicate lifecycle keys/escaped key duplicates/invalid primitives fail-closed, large nl-free tight-heap); `tests/incomplete_result.test.mjs` asserts lifecycle diagnostics + legacy completed re-derivation + killed/failed compatibility; `tests/callback_completion.test.mjs` asserts ATTENTION wording. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 without output because this repo has no `coverage.config.json` or inventory adapter; no level floor can be resolved. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | PASS | `tests/parse_run.test.mjs` writes a real run log and calls the real parser/lifecycle scanner; finalize integration writes real logs/meta and calls real finalize/result; no browser/API interception exists in changed tests. |
| No mock of a first-party internal seam module (real internals, faked externals) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules mock-internal-seam --diff origin/main` and whole-tree equivalent → 0 findings. |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | finalize integration uses real filesystem + parser + full-stream lifecycle scanner + classifier + registry + callback builder; only host hooks (`sendMessage`/`notify`/`renderWidget`) are recorded. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | finalize integration asserts persisted `status`/`lifecycleClassification`/`failureReason`, ATTENTION callback text, and diagnostic result body for incomplete/truncated/open-tools/failed_exit/large-record/truncated-early-type/nested-type/trailing-comma-malformed/malformed-tool-end paths; legacy completed path rejects clean lifecycle complete even under truncated parse windows; unfinished/malformed grammar-invalid evidence fails closed. |
| Every new branch / error path has a driving test | lead | PASS | `tests/run_finalization.test.mjs` classifier matrix + finalizeRun integration incomplete/complete/failed_exit/truncated unmatched-tool window + legacy completed under truncation + large nl-free complete + truncated early-type EOF + nested-type ordering + trailing-comma malformed agent_end + malformed tool_execution_end + duplicate toolCallId + escaped duplicate key + large unmatched tool; `tests/parse_run.test.mjs` grammar scan outside bounded tail + large nl-free + late top-level type + truncated early-type + nested-type ownership + trailing-comma + malformed tool end + duplicate lifecycle keys + escaped key duplicates + invalid primitives/escapes/delimiters + large tool start; `tests/incomplete_result.test.mjs` legacy completed metadata + killed/failed formatting; `tests/callback_completion.test.mjs` ATTENTION paths. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | Declared intended behavior change: issue #86 ACs + round-1/2/3/4/5/6 lifecycle-validation-authority (complete-stream tool balance + structural top-level ownership + complete JSON grammar authority + fail-closed duplicate semantic lifecycle keys before lifecycle fields); #75/#73 compatibility pinned via `@characterizes` failed/killed cases, legacy completed metadata regression, and bounded-tail parse tests. |
| Runtime smoke: each changed non-browser surface was actually run and its happy path responded | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-86.json` → `node --experimental-strip-types tests/smoke_midturn_exit.mjs` observed `SMOKE PASS` via real finalizeRun + buildSubagentResultText + parseRunForLifecycle. |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | Extension lifecycle/tool handlers only; no browser route changed. |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | No browser route changed. |
| Sweep specs do not intercept first-party traffic | lead | N/A | No browser sweep/spec is added by this extension-only change. |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | No browser-rendered surface changed. |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/ci-audit.mjs --files .github/workflows/ci.yml` → required inventory, ledger, checklist, evidence, smoke, and presentation gates absent from pre-existing CI configuration. |
