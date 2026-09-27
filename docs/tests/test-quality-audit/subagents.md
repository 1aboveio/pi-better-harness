# pi-better-subagents test-quality audit

## Scope and outcome

Audited the test tree under `packages/pi-better-subagents`, including the executable smoke scripts in `docs/tests`. The final tree has 58 `tests/*.test.mjs` files. Used `/tmp/pi-harness-test-quality.json` as leads, then searched the wider tree for source/document oracles, loose errors, sleeps, duplicated behavior, dead widget coverage, and claims unsupported by assertions. Reviewed candidates against the implementation and existing behavior tests before classifying them. This was a pattern-based whole-suite audit, not a claim of exhaustive mutation coverage.

All edits are within the assigned package. No production code changed. No commits were made. Concurrent changes in other packages were left alone. The user's explicit request to fix confirmed findings overrides the skill's normal audit-only workflow.

Context: package `CONTEXT.md`; package ADRs 0001–0003 (sandbox backend, process-group health, native catalog inheritance); root ADRs 0006–0007 (failure observations and trusted runtime/task boundary); package test README and manifests. These establish that real registry/process behavior and registered extension paths matter, while external Pi UI, clocks, providers, and OS probes can be controlled at their boundaries.

## Findings and fixes

Locations below refer to **pre-edit lines at HEAD** unless explicitly marked current. Paths are relative to `packages/pi-better-subagents`. Findings are clustered to avoid counting each repeated assertion separately. Labels classify the original assertions, not the entire file.

| Location | Label / principle | Missed bug or harmless break | Fix |
|---|---|---|---|
| `tests/git_clone_workspace_wiring.test.mjs:22` | Not coverage / P1 | Source contains clone names but the spawned child still runs in the original repository; import/variable refactors fail harmlessly. | Deleted source-only file. Extended `git_clone_workspace_live.test.mjs:171` to capture the actual child `pwd -P` and compare it with the disposable clone. Wait for a nonempty marker. |
| `tests/subagent_spawn_batch.test.mjs:147`, `:477` | Not coverage / P1 | Registration/capacity source spelling survives broken runtime wiring; helper extraction breaks pins. | Removed source blocks. Retained pure planning tables and `batch_spawn_end_to_end.test.mjs` registered single/batch execution, capacity races, errors, and metadata coverage. |
| `tests/abandoned_runs.test.mjs:170`, `tests/health_reconcile.test.mjs:175` | Not coverage / P1 | Adoption may run periodically, notify the wrong session, or lose parent identity despite the expected source strings. | Removed pins; added registered session-start behavior in `extension_health_lifecycle.test.mjs` using dead/live parents, durable lost metadata, silence, and absence of adoption-only polling. Also checks a subsequently created foreign run is not adopted by the active periodic ticker. Spawn coverage checks recorded parent PID/start token. |
| `tests/health_result_diagnostics.test.mjs:54`, `tests/incomplete_result.test.mjs:185`, source blocks in `tests/health_surfacing.test.mjs` | Not coverage / P1 | Imports/helper names do not establish actual result status, partial artifacts, or health output. | Removed source assertions. Retained executed result-formatting, parser, health helper, and registered lifecycle/output tests. |
| `tests/navigator_close_extension_path.test.mjs:299`, `tests/navigator_overlay.test.mjs:150`, `tests/navigator_hardening.test.mjs:554` | Not coverage / P1 | A present `stopRun` import does not prove closing the selected child kills it; lifecycle wiring can still fail. | Removed redundant source checks. Kept registered editor/navigation/close tests that assert process termination, durable dismissal, session filtering, and reload cleanup. |
| `tests/navigator_overlay.test.mjs:203`, `tests/navigator_hardening.test.mjs:585` | Not coverage / P3–P4 | A guard implemented inside the test always avoids invoking its own stub; removing the production RPC UI guard would pass. | Removed copied guard tests. Registered RPC lifecycle test now requires actual widget boundary calls and verifies every call clears with `undefined`, never paints a TUI widget. |
| `tests/widget_flicker.test.mjs:41`, retired renderer cases in `tests/health_surfacing.test.mjs`, `tests/navigator_hardening.test.mjs:661`, `tests/smoke_health_surfacing.mjs:74` and `:129` | Redundant / P5 | Exercises retired `buildWidgetLines`/widget rendering; shipping navigator can regress while these tests pass. | Replaced widget suite with live formatting/cache behavior; removed retired renderer cases, associated source pins, and dead `formatWidgetHealthSuffix` assertions. Runtime uses the shared navigator; widget formatting/cache helpers still have live callers and remain covered. No production exports removed. |
| `tests/callback_completion.test.mjs:1`, `:258`, `:275`, `:332` | Not coverage and Redundant / P1, P4, P5 | Repeated marker checks, source scans, and absence checks without supplied result content fail to prove callback payload policy. | Consolidated into behavior cases for callback enabled/disabled, supplied sentinel artifact omission, incomplete/failed outcomes, and useful result instructions. Registered lifecycle tests remain responsible for actual delivery and durable markers. |
| `tests/extension_health_lifecycle.test.mjs:766` | Weak / P4 | Session-isolation negative assertion filtered obsolete `subagent-complete`; a leaking `background-completion-batch` passed. | Flush the actual completion batcher and reject any delivered message containing that run ID, independent of message type. |
| `tests/health_observation.test.mjs:902` | Not coverage / P1 | Finding event branch names in source does not prove disk extraction advances meaningful activity. | Feed incremental NDJSON records through the actual disk-log extraction/filter and verify each meaningful event updates the observation timestamp. |
| `tests/catalog-static-identity-import.test.mjs:15` | Not coverage / P1 | Static import spelling does not prove concurrent callers reserve distinct durable labels. | Execute concurrent `prepareCatalogJob` calls through the real catalog runtime/allocator, check distinct labels and durable reservations, then check the next reservation remains distinct. |
| `tests/agent-operations.test.mjs:639`, `tests/catalog-package.test.mjs:21` | Weak / P1–P2 | Exact TOML/YAML dependency versions fail harmless dependency upgrades; import text does not prove packaging. | Require runtime dependency presence and lock/manifest agreement. Retain `npm pack --dry-run` artifact checks and parser behavior tests. Remove source spelling pins. Pack subprocess cache uses temporary storage. |
| `tests/ci_gate.test.mjs:22` | Not coverage / P1 | CI YAML/script text includes checks while shell sequencing swallows their failures. | Execute package platform lane commands with external node/bash spies; assert required checks execute and failure code 17 stops/propagates through the lane. This proves package lane behavior, not live GitHub Actions execution. |
| `tests/child_event_signatures.test.mjs:12` | Not coverage / P1–P2 | Assertions about fixture contents prove the recording, not compatibility of the shipping parser. | Captured NDJSON now feeds actual `parseRun`; check supplied text, accumulated tokens/cost, terminal event, and unmatched tools. Existing health tests cover error/compaction observations. |
| `tests/task_runtime.test.mjs:95`, `:104`, `:133`, `:190`, `:202`, `:214`, `:235` | Weak / P4 | Any exception, including unrelated missing files or broken dispatch, could count as a security denial. Test title overstated SDK dispatch coverage. | Require sandbox read/write denial messages and filesystem EPERM/EACCES/EROFS codes; rename the case to describe SDK-loaded guarded tools. Kernel execution remains unverified here because fixture creation is denied. |
| `tests/catalog-navigator-live-row.acceptance.test.mjs:73`, `:221`; `tests/fixtures/acceptance/navigator-live-row-probe.ts:94`; `tests/catalog-navigator-reload.acceptance.test.mjs:26`, `:126` | Weak / P4 | Shared output paths can reuse old success artifacts. A 2.5-second paint sleep races under load; teardown sleeps add no proof. | Unique temporary evidence directories with cleanup; actual terminal capture must contain the agent and the provider must receive a POST. Driver acknowledges observed paint via a marker; probe uses a bounded condition wait. Removed teardown sleeps and combined navigation input. Opt-in acceptance changes were not exercised in this environment. |
| `tests/abandoned_runs.test.mjs:137`, `tests/health_reconcile.test.mjs:144` | Weak / P4 | “Not lost” also accepts incorrect running/completed states; an unbounded confirmation loop can hang after a regression. | Require exact orphaned state; bound confirmation attempts so a broken transition fails. |
| `tests/navigator_health.test.mjs:315`, `tests/navigator_overlay.test.mjs:657` | Weak / P2 | Exact decorative line counts/row offsets fail when spacing or a footer changes without affecting content. | Find rendered rows by identity and check status/color/content; retain width constraints. |
| `docs/tests/issue-46-runtime-smoke.mjs:301`, `issue-47-runtime-smoke.mjs:302`, `issue-48-runtime-smoke.mjs:368` | Not coverage / P1 | Source/docs strings cannot establish working registration or reload behavior. | Removed pins, kept executed behavior and syntax checks. Child test commands explicitly load `tsx`. |
| `docs/tests/issue-46-runtime-smoke.mjs:266`, `issue-48-runtime-smoke.mjs:258`; `tests/smoke_health_surfacing.mjs:148` | Weak / P4 and Not coverage / P4 | Old `>` marker rejects working selection or navigates to the wrong target. Health smoke claimed notification success without executing notification behavior. | Corrected selection checks to actual `›` rendering; removed unsupported notification/retired-widget success entries. All three changed archival navigator smoke scripts now pass. |

The main recurring cause was an inaccessible or inconvenient extension lifecycle being checked by source searches. Existing registered extension harnesses already provide the stronger seam for most of those cases, so duplicating their assertions in a source scanner adds maintenance cost without proof.

## Look-alikes cleared and retained

- Real registry/log/clone file reads assert **generated outcomes**, not checked-in spelling. They cover durable state, isolation, and parser behavior.
- Catalog and Codex TOML/YAML fixtures are inputs to the actual parsers. Native definition edits, secret omission, provenance, unsupported restriction refusal, and reload behavior are observable results.
- npm pack artifact checks enforce what a consumer can install. Comparing lock dependencies with manifest dependencies detects drift without freezing incidental versions.
- The six approved bundled roles in `model-resolution.test.mjs:153` are backed by the separately written approved role/model/effort table and checked individually; this is an intentional product default contract, not decorative inventory size.
- Public status names, error codes, capability restrictions, spawned argv, and required prompt guidelines encode user/host contracts. They are not internal source-text oracles.
- Pi SDK/UI/provider stubs and fake clocks are external boundaries. The suite's registered tool tests still run package-owned batch, catalog, registry, stop, and lifecycle logic. Pure helper decision tables plus a real registered path are useful layering.
- Bounded polling loops wait for concrete log, child, or metadata conditions; their short timer delays are polling cadence, not blind readiness sleeps. Cancellation/timeout tests intentionally inject deadlines.
- Metadata lock tests use real filesystem/process/worker contention and verify ownership/state; their timeout/stale-age checks concern the lock contract. No speculative rewrite was made solely because clocks appear.
- Platform gates and opt-in Pi acceptance gates remain explicit. A skipped test is not counted as runtime proof.
- Helper shape/precondition assertions followed by substantive state/content checks were retained. Raw-log truncation and formatting widths are output contracts.
- Final quality lint: **0 gate violations, 20 leads**. Remaining leads are the generated-outcome/fixture/packaging/contract cases above, not confirmed findings left unfixed.

## Exclusions and limits

- Generated historical reports, coverage manifests, screenshots, and captured fixtures were treated as evidence/input, not executable tests to rewrite. In particular, old `docs/tests/_generated` results were not regenerated to manufacture current success.
- Shared packages and other package tests are outside assignment. Their implementations were consulted only where necessary to understand a boundary; their concurrent edits were not changed.
- Live model/provider smoke scripts, Linux-only bubblewrap checks, and opt-in real-Pi/PTTY acceptance runs were not executed on this constrained macOS session. The four skipped cases in the standard test run are visible in its TAP log. No claim of end-to-end model or Linux kernel validation is made.
- This audit establishes the confirmed weaknesses listed above and their replacements. It does not prove that every possible missing scenario or mutation is covered.

## Parent integration and final verification

The parent subsequently ran full repository verification with required macOS Seatbelt: **1,290 passed, 0 failed, 6 expected skips; all 16 workspace typechecks passed**. This includes the ten runtime cases blocked inside this worker. The parent also executed the opt-in live-row acceptance test. Its first run exposed a test startup race: the probe stopped the child immediately after painting, before the local provider received a POST. The final fixture now waits for both painted-row and provider-request markers; the acceptance rerun passed. The preserved-run reload acceptance remains unexecuted. See [the repository report](../test-quality-audit.md) for final combined results.

## Validation

The following records the worker's own checks before parent integration:

1. Full standard suite, run directly to avoid pretest scripts that sync files into other packages:
   `node --import tsx --test --test-reporter=tap packages/pi-better-subagents/tests/*.test.mjs`
   **677 tests: 663 passed, 10 failed, 4 skipped.** All ten failures are `task_runtime.test.mjs` fixture creation errors: EPERM on `/var/tmp/pi-task-runtime-*` or `/var/tmp/pi-protected-sentinel-*`, before the assertions under test. Log: `/tmp/subagents-full-tests.log`. The suite is not reported green, and those checks were not weakened/skipped to force green.
2. After the final health/navigator assertion edits, targeted rerun: **26 passed, 0 failed**, `/tmp/subagents-final-focused.log`.
3. Package typecheck: `./node_modules/.bin/tsc -p packages/pi-better-subagents/tsconfig.task-runtime.json` — **passed**, `/tmp/subagents-typecheck.log`.
4. Changed archival navigator smoke scripts 46, 47, 48 — **passed** using `node --import tsx`; logs `/tmp/subagents-smoke46.log`, `/tmp/subagents-smoke47.log`, `/tmp/subagents-smoke48.log`. Scripts 47/48 also execute the registered close/reload suites.
5. Health smoke — **passed**; evidence written outside the repo to `/tmp/subagents-health-smoke.json`, log `/tmp/subagents-health-smoke.log`.
6. Skill quality lint over package test/smoke paths — **passed with 0 gates and 20 reviewed leads**, `/tmp/subagents-lint-after.json`. Initial leads preserved in `/tmp/subagents-lint-before.json` and `/tmp/subagents-quick-tells.txt`.
7. `git diff --check -- packages/pi-better-subagents` — **passed**.

No commit or PR was created.
