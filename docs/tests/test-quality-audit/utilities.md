# Utilities and extension test audit — fixes completed

## Summary

Audited all **23 test files** in the ten assigned packages against their implementations. **21 findings: 2 Not coverage, 19 Weak, 0 Redundant, 0 unresolved Lead.** These are assertion-level findings/clusters, not counts of broken test cases. All confirmed findings below are addressed. Two additional fixture-cleanup improvements are recorded separately.

Changes are limited to assigned-package tests and one goal test-support module. No production implementation, root script, excluded package, dependency, or package manifest was edited. No commit was created. Other workers' changes in this shared workspace were left alone.

The user's explicit audit **and fix** instruction overrides the test-quality skill's audit-only workflow. Read `/Users/exoulster/.agents/skills/test-quality/SKILL.md`, ran its release check and lint, and reviewed ADR `docs/adr/0006-shared-failure-observations.md` for the durable observation/receipt contract. There is no CONTEXT.md in the assigned packages; the discovered subagents CONTEXT.md belongs to an excluded package.

## Findings and fixes

Locations refer to the updated working tree, using the closest surviving assertion/test for removed assertions. Every listed test and its relevant implementation were opened. “None identified” means the weakness is missed behavior rather than a demonstrated harmless-change failure.

| ID | file:line | Principle | Pattern / label | Realistic bug the old assertion misses | Harmless change that breaks the old assertion | Fix |
|---|---|---|---|---|---|---|
| F01 | `packages/pi-better-plan/test/workflow-plan.test.ts:116` | P4 — assertion must check its claim | Wrong-reason rejection — **Weak** | Removing project/run containment still throws ENOENT for the nonexistent unrelated file, satisfying `/ENOENT\|inside/`. | None identified. | Create an actual unrelated task-plan.json and require the containment error. Existing invalid-run-identity case remains. |
| F02 | `packages/failure-observations/index.test.ts:13`, `:123` | P4 | Restart/durability overclaim — **Weak** | A future memory cache or receipt surviving only in process can satisfy repeated same-process reads; the literal `delivered:` in a file does not prove that receipts restore correctly. | Changing receipt serialization could break the literal check despite correct restoration. | Load journal state in fresh Node processes, checking actual incidents, pending attention before receipt, receipt restoration afterward, and recovery of failed writes. |
| F03 | `packages/pi-better-read-aloud/src/client.test.ts:81` | P4 | Privacy claim unasserted — **Weak** | Appending the speech request or API key to an otherwise correct 401 error stays green. | None identified. | Assert the provider failure and reject inclusion of distinct private-text/key sentinels in that same error. This does not claim sanitization of arbitrary provider response content. |
| F04 | `packages/callback-batcher/index.test.ts:42` | P4 | Urgent retry success checked only by return/send count — **Weak** | Returning success after storage recovers without invoking the urgent receipt hook passes. | None identified. | Require the second successful receipt alongside the existing no-resend checks. |
| F05 | `packages/pi-better-plan/test/extension.test.ts:102`, `:144` | P4 | No append mistaken for unchanged live state — **Weak** | Rejected duplicate/DAG updates mutate currentPlan in memory before throwing but append no entry. | None identified. | Clone the valid plan before rejection, then read through get_plan and compare the entire retained snapshot. Cloning avoids an alias masking mutation. |
| F06 | `packages/pi-better-plan/test/plan-state.test.ts:16` | P4 | Atomic replacement incompletely observed — **Weak** | A successful replacement changes the previous snapshot's first step status in place while returning the expected IDs/revision. | None identified. | Check that the original in-progress step remains in progress after replacement. |
| F07 | `packages/pi-better-goal/test/continuation.test.ts:6` | P4 | “Action and result changes” only varies results — **Weak** | Omitting assistant tool names or arguments from the signature still passes all original examples. | None identified. | Vary arguments and tool name independently while holding result content/tool-result metadata constant. Require each to change the signature. |
| F08 | `packages/pi-better-goal/test/stall.test.ts:19` | P4 | Changed progress never exercised — **Weak** | Ignoring lastProgressAt and using the old goal creation time still yields stalled/quiet for every original example. | None identified. | Supply recent progress for the old goal and require a healthy verdict. |
| F09 | `packages/callback-batcher/index.test.ts:68` | P4 | Ordering allows missing first item — **Weak** | Dropping sa_2 from formatted content gives indexOf(sa_2) = -1, which still sorts before the other IDs; delivered hooks and heading can remain correct. | None identified. | Require all input IDs in formatted rows before checking order. The separate retry-order test already has an occurrence check anchoring its first ID and was kept. |
| F10 | `packages/pi-better-read-aloud/src/client.test.ts:6`, `:49` | P3/P4 — observe the external request | Permissive fetch boundary — **Weak** | Changing POST to GET or omitting the method returns fake audio successfully, despite a real provider rejecting the request. | None identified. | Assert POST for JSON and form requests, and one request for the form case. |
| F11 | `packages/pi-better-read-aloud/src/config.test.ts:11` | P4 | Precedence test lacks competing URL — **Weak** | Environment URL incorrectly takes precedence over the explicit URL; no environment URL existed in the fixture. | None identified. | Provide a conflicting PI_TTS_URL and retain the expected explicit URL. |
| F12 | `packages/pi-better-harness/test/cli.test.mjs:14` | P3/P4 | Spawn fake ignores executable — **Weak** | Running the correct arguments through the wrong executable passes because only args and stdio are checked. | None identified. | Assert the platform's Pi executable for every recorded install call. |
| F13 | `packages/navigator/index.test.ts:58` | P4 | Multiple-provider routing checks only one provider — **Weak** | Hard-coding close dispatch to subagents still satisfies the only close assertion. | None identified. | Select the background-task row, open its detail and confirm close twice, asserting the second provider's exact callback target. |
| F14 | `packages/navigator/index.test.ts:276` | P3/P4 | Empty detail fixture masks detail theme errors — **Weak** | A bad color or missing failure status in populated detail rendering passes because detail returned null; the error-color observation came from the main rail. | None identified. | Supply a real failed-detail payload, reset recorded colors before rendering, and assert the failed status uses error color and log evidence appears. |
| F15 | `packages/pi-better-goal/test/extension.test.ts:405`, `:452`; `test/command-binding.test.ts:24`; `test/workflow.test.ts:14`; `test/stall.test.ts:19` | P4 | Uncontrolled external environment — **Weak** | No specific product bug is the cause; default-policy checks depend on caller settings rather than controlled inputs. | Valid custom wake disable/delay/retry/stall environment settings make the unchanged implementation fail default-policy tests. | New `test/extension-fixture.ts` imports the real extension with wake defaults and restores the environment; stall test similarly controls/restores its dynamic threshold inputs. |
| F16 | `packages/pi-better-goal/test/extension.test.ts:44` | P4 | Name overclaims enforcement — **Weak** | Prompt guidance alone cannot prove that completion is prevented while background work runs. update_goal does not implement that guard. | None identified. | Rename to “active background work adds completion-audit guidance to the agent prompt,” accurately describing the executed behavior. No completion guard was invented. |
| F17 | `packages/pi-better-plan/test/plan-state.test.ts:31` | P2 — independent expected values | Generated-ID spelling — **Not coverage** for uniqueness/stability | The third ID's literal spelling cannot establish the general identity contract or collision avoidance. Other ID checks remain useful. | Changing the generated ID encoding while retaining unique stable IDs. | Replace the `step_2_3` pin with nonempty/new-plan uniqueness checks; retain unchanged-step identity checks. |
| F18 | `packages/navigator/index.test.ts:87` | P2 | Private factory marker pin — **Not coverage** for navigation | A marker can remain true while editor navigation is broken. | Renaming/removing the private factory bookkeeping field. | Delete the private-property assertion; the test executes actual focus, detail opening and close routing through the installed editor. |
| F19 | `packages/pi-better-read-aloud/src/client.test.ts:76` | P2 | URL-encoded field insertion order — **Weak** | Primarily brittleness; the original literal did check field values, but imposed an irrelevant wire ordering. | Reordering form field serialization without changing the parsed request. | Compare sorted parsed key/value entries, preserving duplicate/extra/missing field detection. |
| F20 | `packages/failure-observations/index.test.ts:84` | P2/P4 | Object identity mistaken for replay semantics — **Weak** | Mutating and returning the same state reference can pass strictEqual while reopening an incident. | Returning an equivalent new state object for replay. | Compare replay result with a cloned pre-replay value. |
| F21 | `packages/pi-better-plan/test/plan-state.test.ts:159` | P2 | Production constant selects its own boundary — **Weak** | The boundary assertion follows a changed retention constant instead of independently establishing the required 30-second deadline. The neighboring 20-second remaining-delay assertion already provides independent partial protection. | None identified beyond an intentional change of the policy, which should require updating the contract test. | Remove the imported retention oracle and check 1 ms before/exactly at the 30-second deadline using independent times. |

## Additional fixture hygiene

- `packages/pi-better-goal/test/activity.test.ts:68`: use mkdtemp instead of PID/time-derived directory naming, and remove the fixture after the test. This avoids leaked registry directories and accidental fixture reuse. The real filesystem and index implementation remain exercised.
- `packages/pi-better-read-aloud/src/playback.test.ts:33`: stop test playback and remove temporary audio in finally, including assertion-failure paths. The environment restoration remains in place. This does not run an actual audio player.

## Clusters and likely causes

- **Claims outrun inputs/observations:** restart, containment, urgent receipts, plan retention, action signatures, progress age, request method and config precedence. Fixtures were generally sound but did not distinguish the named behavior from a weaker implementation.
- **Boundary fakes accept anything:** the fetch and spawn fakes are appropriate external seams. The fixes assert the requests those seams receive rather than replacing owned modules or running costly external services.
- **Representation coupled to behavior:** private marker, generated ID spelling, object identity, and form ordering. Assertions now retain behavioral contracts without requiring those representations.
- **Caller configuration affects fixtures:** goal settings are read partly at module load and partly during calls. Both times are now controlled in the tests that require defaults.

## Look-alikes kept

- `packages/pi-better-goal/test/extension.test.ts:506`: the sole scoped lint lead, `messages.length === 5`, is **kept**. It follows the initial turn, three permitted retries, a blocked repeat, and an interactive reset. It measures a concrete retry policy, not arbitrary inventory size. The test now isolates default configuration.
- `packages/failure-observations/index.test.ts:135`: comparing runtime-created journal contents before/after replay checks no extra append. It is not grepping checked-in source. Other corrupt/missing/truncated journal fixtures execute the real reducer and filesystem.
- `packages/pi-better-goal/test/workflow.test.ts:14`: writes skill YAML fixtures and executes the real YAML parser/provenance logic. Matching the resulting prompt checks emitted extension output, not source text.
- `packages/pi-better-plan/test/extension.test.ts:20`: tool promptGuidelines and before_agent_start output are runtime outputs. They verify guidance wiring, not actual agent compliance or enforced delegation.
- `packages/pi-better-harness/test/cli.test.mjs:14`, `:29`: iterating componentPackages is a legitimate registry-derived expected set for dispatch. It does not independently prove that the registry lists every intended product; inventory policy/root packaging checks are outside this assignment.
- `packages/callback-batcher/integration.test.ts:13`: singleton reference equality is intentional shared-host behavior. This is not a duplicate of createCallbackBatcher's unit state-machine cases. It executes the existing vendored consumer copies rather than mocked twins.
- `packages/navigator/index.test.ts:169`: doesNotThrow around stale-context access is justified by the failure mode and accompanied by a post-disposal read-count assertion. No-error alone was not treated as proof of all rendering.
- `packages/navigator/index.test.ts:1247`: the injected transcript component is an external Pi rendering boundary. The test checks this package's viewport/tail budgeting, not correctness of the external transcript renderer.
- `packages/navigator/index.test.ts:1347`, `:1387`; `packages/pi-better-plan/test/plan-render.test.ts:87`: real terminal-width/grapheme operations on produced strings are useful rendering behavior, not class-name/layout pins.
- `packages/pi-better-plan/test/plan-render.test.ts:58`: comparing native/workflow presentation verifies intentional shared visual semantics; separate mappings and fixture status branches justify the layering.
- `packages/render-scheduler/index.test.ts:6`, `:23` and the other mock-timer suites: deterministic deadline advancement is not a fixed real-time sleep. setImmediate flushes async delivery work rather than relying on elapsed wall time.
- `packages/stall-detector/index.test.ts:6`: finite threshold examples check actual healthy/quiet/stalled/unknown decisions; they are not constant-value-only tests.
- `packages/log-utils/index.test.ts:15`: creates a large real file and verifies the returned tail/truncation. This proves output behavior, not independently a peak-memory bound or exact syscall count.
- `packages/pi-better-read-aloud/src/playback.test.ts:9`: bytes are written/read on the real filesystem; only process launch is faked. PID/args checks describe propagation through that external boundary, not a fake-owned UI result.
- No identical-file or mocked integration-twin deletion was justified within the assigned scope. Similar cases mostly cover different branches, entry points, or shared-copy integration.

## Scope inventory and results

| Package | Test files read | Tests passed | Result |
|---|---:|---:|---|
| failure-observations | 1 | 15 | Persistence/replay checks strengthened |
| navigator | 1 | 22 | Provider routing/detail checks strengthened; private marker removed |
| stall-detector | 1 | 3 | No confirmed finding |
| log-utils | 1 | 3 | No confirmed finding |
| callback-batcher | 2 | 11 | Urgent receipt and batch-membership checks strengthened |
| render-scheduler | 1 | 2 | No confirmed finding |
| pi-better-goal | 7 | 34 | Evidence/progress/default configuration checks and accurate prompt-test naming |
| pi-better-plan | 4 | 24 | Rejection/immutability/containment/ID/deadline checks improved |
| pi-better-read-aloud | 4 | 11 | Request/privacy/precedence checks and cleanup improved |
| pi-better-harness | 1 | 5 | Executable selection asserted |
| **Total** | **23** | **130** | **All passed** |

## Checks performed

1. Ran skill release check and scoped whole-suite lint before edits. Result: zero gates, one count-pin lead, manually cleared as described above.
2. Ran `npm run test` with explicit `-w packages/<name>` for all ten assigned packages. **130 tests passed; no failed/skipped tests.** Log: `/tmp/pi-test-audit-utilities-checks.log`.
3. Ran all available assigned-package `typecheck` scripts with `--if-present`. **All nine available typecheck scripts passed.** pi-better-harness has no typecheck script. Log: `/tmp/pi-test-audit-utilities-types.log`.
4. After further callback/goal fixes, ran callback-batcher and pi-better-goal with `PI_BETTER_GOAL_DISABLE_WAKE=1`, `PI_BETTER_EXTENSION_DISABLE_WAKE=1`, `PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS=17`, `PI_BETTER_GOAL_MAX_NO_PROGRESS_RETRIES=1`, `PI_BETTER_STALL_QUIET_MS=10`, and `PI_BETTER_STALL_MS=20`. **45 tests passed.** Log: `/tmp/pi-test-audit-utilities-env.log`.
5. After final replay/name edits, reran failure-observations and pi-better-goal. **49 tests passed.** Log: `/tmp/pi-test-audit-utilities-final.log`. The final callback change only removed an unnecessary newly added assertion from a case already covered by an occurrence check; no executable implementation changed.
6. Scoped whole-suite lint after fixes: zero gates; same cleared count-pin lead. Diff lint with excluded packages/root scripts and local generated work trees excluded: **no findings in this change**. `git diff --check` for assigned packages passed.
7. One initial diff-lint invocation unexpectedly included pre-existing untracked `.resolve-issues/rush/issue-289/results/{review-spec,rereview-spec}/live-row.test.mjs` files: four fixed-sleep gates and two text-oracle leads. Those are outside the assigned package scope. Reran with `.resolve-issues`, `.skill-pr-worktree`, and `.npm-cache` explicitly excluded; no findings. Did not edit those artifacts.

## Not audited / limits

- Explicitly excluded: `packages/pi-better-subagents`, `packages/pi-better-background-tasks`, `packages/pi-better-ssh`, `packages/pi-better-sandbox`, `packages/sandbox-core`, `packages/task-sandbox`, `packages/ssh-core`. No edits to them. The existing assigned callback-batcher integration test imports two consumer copies; executing it is not a claim of auditing those consumer suites.
- Root `scripts/` belongs to the parent and was not edited or run as a suite. Did not run root `npm test`, sync/generation scripts, packaging/release jobs, terminal/tmux E2E, live SSH, sandbox kernel tests, or external TTS/audio playback.
- Excluded node_modules, generated/vendored dependency trees, `.resolve-issues`, `.skill-pr-worktree`, `.npm-cache`, and other workers' unrelated changes.
- Runtime entry implementations relevant to all assigned suites were read, including goal/plan/read-aloud extension wiring and navigator UI logic. Package-level checks do not prove real Pi terminal integration, audible output, arbitrary provider error redaction, or every untested input branch. Those are coverage limits, not represented as passing tests.
- This audit did not run a mutation-testing campaign or measure coverage percentages. Missed-bug examples are based on inspected fixture/assertion/implementation relationships. No confirmed production defect requiring an implementation edit was found in this test-quality pass.
