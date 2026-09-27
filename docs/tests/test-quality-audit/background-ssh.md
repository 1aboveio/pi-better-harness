# Test-quality audit and fixes: background tasks and SSH

## Summary

Audited all **21 test files** under `packages/pi-better-background-tasks` (18) and `packages/pi-better-ssh` (3), including helpers and assertions not flagged by the supplied lint results. Confirmed **21 findings/clusters: 4 Not coverage, 17 Weak, 0 Redundant, 0 unresolved Lead**. Fixed them in **14 test files**. No production code, generated implementation, package manifest, or documentation was changed. No commits were made.

The user's explicit request to fix tests overrides the skill's audit-only restriction. Read `/Users/exoulster/.agents/skills/test-quality/SKILL.md`, ran its release check, used `/tmp/pi-harness-test-quality.json`, and ran fresh whole-scope and diff lint. The supplied JSON had eight in-scope candidates: seven text-oracle leads and one internal-mock gate.

Read ADRs 0001–0007, both package READMEs, background-task PRODUCT.md and docs/usage.md, package scripts, the tested consumer implementations, and relevant shared SSH, callback, log, and stall implementation paths. Inspected CI configuration to verify that native Windows and required-backend kernel checks have dedicated lanes.

**Validation:** 183 tests passed (169 background + 14 SSH); two native Windows tests skipped on macOS. The nine-case kernel sandbox file could not collect because this execution environment refuses fixture creation under `/private/var/tmp` with EPERM. That is an explicit validation limitation, not a passing confinement check. Both typechecks and scoped lint pass.

## Findings and fixes

Paths below are relative to the repository. `BG` means `packages/pi-better-background-tasks/src`; `SSH` means `packages/pi-better-ssh/src`. Locations refer to the final working tree unless marked **original** (the inspected pre-edit location of removed code). Labels describe the original assertion, not the repaired test. “None identified” means no particular harmless break was needed to establish the finding.

| # | file:line | Principle / pattern | Label | Realistic bug missed | Harmless break | Fix |
|---|---|---|---|---|---|---|
| 1 | BG/e2e.test.ts:153; SSH/e2e.test.ts:284 (**original**) | P1: README/usage prose pins | Not coverage | SSH execution, timeout, or recovery can break while documentation still contains the expected words. | Rewording headings, examples, or explanations. | Removed the two prose-only tests. Existing runtime, preset, schema, profile, mux, and recovery tests remain; documentation was read during review. |
| 2 | SSH/e2e.test.ts:310 (**original**); replacement :301 | P1/P2: release guide, workflow, changelog and config text | Not coverage | An npm artifact can omit a transitive module and still match every release-file string. | Workflow refactoring, release-table formatting, or changelog cleanup. | Actually pack with lifecycle scripts disabled, extract the artifact, resolve its declared extension against the root bundle, load it in a fresh Node process, and verify tool registration. |
| 3 | BG/runtime-windows.test.ts:9 (**original**); replacement :8 | P3: first-party process-layer mock | Not coverage for Windows termination | The real process layer could swallow taskkill failure and falsely permit cancellation; the test forced the desired error itself. | Internal process API refactoring. | Keep real stopTask and stopProcessGroup. Fake only child_process.spawnSync, platform, and the OS liveness probe; require taskkill tree flags plus persisted running/error state. |
| 4 | BG/runtime.test.ts:63,586 | P2: production constant as oracle | Weak | Changing the default deadline from documented 900 seconds to an incorrect value changes both implementation and expectation. | None identified. | Derive expected deadlines from the documented 15-minute/900-second contract. |
| 5 | BG/runtime.test.ts:1109 | P4: waiter silently returns on timeout | Weak | A test can continue after the named state was never reached; later assertions may inspect unrelated matching fields. | None identified. | Timeout now throws with task ID and last metadata. |
| 6 | BG/runtime.test.ts:335 | P4: callback delivery inferred from a receipt | Weak | Writing callbackSentAt without sending any message can satisfy the old test and its unchanged-message-count replay check. | None identified. | Require one actual message containing the task ID before verifying replay suppression. |
| 7 | BG/runtime.test.ts:887 | P4: bounded-output claim checks metadata only | Weak | Retention can increment counters while leaving an oversized file or discarding all useful output. | None identified. | Check on-disk byte bound and retained process output as well as existing counters. |
| 8 | BG/logs.test.ts:41 | P4: “in place” not observed | Weak | Rename-based rotation loses subsequent writes through the detached child's old descriptor. | None identified. | Hold an append descriptor across compaction, check inode/device identity, then write through it and require the new output at the original path. |
| 9 | SSH/process-runner.test.ts:9 | P4: “complete” and “bounded tail” checked by endpoints | Weak | Losing middle output or returning an unbounded capture could pass. The original fixture did not exceed the capture byte budget. | None identified. | Generate more than 100 KiB, compare the complete retained file against independently generated input, and verify nonempty suffixes, final line, byte budget, and total byte/line counts. |
| 10 | SSH/remote-bash.test.ts:188 | P4: tail endpoint checks | Weak | Dropping or reordering middle lines of the 2,000-line tail could pass while reported truncation metadata stayed correct. | None identified. | Compare the entire returned tail with the last 2,000 input lines. |
| 11 | SSH/process-runner.test.ts:34 | P2/P4: asserts the test's own AbortController | Not coverage for runner cancellation | controller.signal.aborted is true regardless of whether the runner terminates the child; null exit alone accepts unrelated signal termination. | None identified. | Require SIGTERM and null exit for timeout and abort, and no timedOut marker for abort. Remove the unsupported SSH-cleanup claim from this process-level test name; the service test still proves mux preservation. |
| 12 | BG/failures.integration.test.ts:41 | P4: vacuous every(resolved) | Weak | Deleting incident evidence on recovery makes an empty array pass every(). | None identified. | Capture the unresolved incident and require the same ID and operation to remain with resolved status. |
| 13 | BG/log-display.test.ts:135 | P4: vacuous rendered-line loop | Weak | Returning zero display lines satisfies every width assertion. | None identified. | Require visible input content before checking all line widths. |
| 14 | BG/process-windows.test.ts:171 | P4: precedence without competing candidates | Weak | Reversing candidate priority still finds the sole existing candidate. | None identified. | Make both earlier and later Git candidates exist, and require the earlier one. |
| 15 | BG/process-windows.test.ts:299 | P4: descriptor type instead of destination | Weak | Any numeric descriptors, including descriptors for the wrong destination, satisfy typeof-number checks. | None identified. | Simulate child stdout/stderr writes through the actual supplied descriptors and read both probes from the requested log. |
| 16 | BG/maintenance.test.ts:59 | P4: retention cutoff without surviving controls | Weak | Removing every terminal task, including recent tasks, passes when the only fixture is expired. | None identified. | Add exactly-seven-day and recent terminal controls, require one removal, and verify both controls survive. |
| 17 | BG/conditions.test.ts:20,27,35 | P4: loose rejection and positive-only match assertions | Weak | Wrong rejection category, always-true matching, or accidentally searching stderr can pass the pure-condition assertions. | None identified. | Distinguish malformed path from missing field and add mismatching exit, stdout, JSON equality, absent-array, and stream-isolation controls. |
| 18 | SSH/e2e.test.ts:193 | P4: current-session mux isolation without foreign fixture | Weak | statusAll/stopAll can operate on every session when the fixture contains only the current session. | None identified. | Populate the real shared registry from a second session using a separate external runner; require its registry entry and runner calls to remain intact. |
| 19 | SSH/e2e.test.ts:256 | P4: sliced every() protocol assertions | Weak | Missing check calls can satisfy an empty sliced every(); partial slices do not independently prove the complete expected operation sequence. | None identified. | Assert the full check/check/exit/exit operation and target sequence, retaining result assertions. |
| 20 | BG/runtime.test.ts:804,1040; BG/failures.integration.test.ts:132,160; BG/golden-path.test.ts:15; BG/sandbox-kernel.test.ts:309,512 | P4: fixed sleeps (8 waits across four files) | Weak | Sleep expiry does not establish the intended callback/poll/process milestone. | Scheduler load or changing the callback accumulation window. | Flush cancellation callbacks explicitly; await attention receipts/attempts; hold the golden-path child behind a release file until running status is observed; await a later sandbox poll; remove the delay after synchronously rejected launches. |
| 21 | BG/sandbox-kernel.test.ts:280 | P4: “every interval” completes on first poll | Weak | Applying confinement only to the first poll passes the old test. | None identified. | Complete on a second-poll sentinel and require two completed probes while retaining all denial checks. This edit is typechecked but kernel execution is blocked on this host. |

## Clusters and coverage preservation

- Documentation pins confused static explanatory prose with execution coverage. Removing them loses no executable proof. Release packaging now has actual artifact-load evidence rather than a claim inferred from YAML or Markdown. The new test deliberately does not run prepack or publish anything.
- Missing controls and partial-result assertions were the main additional issues beyond lint: competing shell candidates, recent retention records, a foreign mux session, complete output, and nonempty evidence make the existing scenarios capable of catching the named bugs.
- Timing changes preserve the assertions and wait for the event each test needs. Deadline tests still use genuine short deadlines; bounded polling delays remain where they implement an observable-condition waiter.
- Existing schema allowlists, SSH safety options, user-facing error evidence, callback suppression/replay, external runner command assertions, and real process tests remain. No executable regression scenario was deleted. Two documentation tests were removed and one release test was replaced, explaining the net reduction of two test cases.

## Cleared look-alikes

- `process-windows.test.ts` and `process-windows.integration.test.ts`: `/opt/x.sh` and `/c` are synthetic argv inputs. They do not read checked-in source. Assertions concern argument preservation across the MSYS boundary.
- `sandbox.test.ts`: `.env`, generated Seatbelt profiles, and Bubblewrap argv are test-produced launch policies. These are valid compiler/wire-contract assertions, complemented by the kernel suite, not claims that source grep proves confinement.
- `sandbox-kernel.test.ts`: reads/writes concern disposable probes, negative controls, generated profiles, and attempted tampering. These observe filesystem behavior rather than checked-in prose.
- SSH packaging test's remaining text-oracle lead: manifests are parsed to locate and load a real packed artifact and compare independently declared bundle registration. This is an executable packaging/drift check.
- Tool descriptions and promptGuidelines returned by real extension registration are the model-facing product output. Kept these explicit steering-contract checks; they are not treated as proof of SSH execution or human plan compliance.
- FakeRemoteRunner replaces the external SSH/process transport. Actual consumer runtime, mux controller, profile, command construction, journal, registry, and lifecycle branching execute. Result assertions that check transport output propagation remain useful in that context; they do not claim a live host was contacted.
- Node fs/child_process/platform/liveness fakes in Windows tests are external OS boundaries. Native Windows integration remains separate.
- Existing every() checks in remote bootstrap/resume are paired with exact nonzero call counts. Existing persisted timestamp checks are combined with real delivery/state checks; they are not mere shape-only tests.
- Kernel skip guards are intentional platform availability guards, with `PI_SANDBOX_REQUIRE_BACKEND` enforced by dedicated macOS/Linux CI lanes. Native Windows integration is run by the Windows CI job. These are not permanently self-skipping tests.
- Similar runtime/preset/extension tests cover different boundaries: protocol normalization, lifecycle orchestration, public registration, and session replay. No duplicate-file or demonstrably redundant/dead test was confirmed in scope.
- The permission-core availability branch in `sandbox.test.ts` explicitly covers either supported permission propagation or fail-closed compatibility behavior. It does not silently skip the assertion.

## Complete suite inventory

All test files were read, including files with no confirmed finding:

- Background: `conditions`, `e2e`, `failures.integration`, `goal-provider`, `golden-path`, `log-display`, `logs`, `maintenance`, `process-windows.integration`, `process-windows`, `process`, `registry`, `remote-task-preset`, `runtime-windows`, `runtime`, `sandbox-kernel`, `sandbox`, `stall` (all under src, suffix `.test.ts`).
- SSH: `e2e`, `process-runner`, `remote-bash` (under src, suffix `.test.ts`).

## Exclusions and limits

- Repository edits were restricted to the two requested packages. Other agents changed unrelated packages during this shared session; those changes were neither edited nor reverted. No commits were created.
- Other packages, root script suites, generated shared modules' own upstream suites, dependencies, build outputs, and pre-existing `.resolve-issues`, `.skill-pr-worktree`, and `.npm-cache` trees were excluded from this audit. Relevant shared implementation and CI configuration were consulted only to assess these consumers. This is not an independent audit of the entire shared navigator/sandbox implementation.
- Test helpers and synthetic fixtures used by these suites were reviewed; they were not counted as test files.
- No live remote SSH host, package manager installation, or publication was exercised. SSH behavior is tested at its injectable external transport boundary; the process runner executes local child processes for real.
- The packed-artifact test resolves dependencies from the repository's installed node_modules. It catches missing packaged first-party modules and bad extension entrypoints; it does not prove a clean remote npm installation or a publish workflow.
- The nine kernel cases remain unexecuted here. The suite's `/var/tmp` placement is essential because the sandbox intentionally allows ordinary temporary writes; relocating fixtures would create misleading confinement evidence. The test changes do not add skips or relax enforcement.
- No dedicated ESLint/Biome package lint script exists. “Lint” below refers to test-quality lint plus whitespace validation. No mutation-test run was performed; missed-bug examples are based on inspected implementations and assertion logic.

## Checks

| Check | Result |
|---|---|
| Skill release check: `node /Users/exoulster/.agents/skills/test-quality/release-check.mjs` | Exit 0. |
| Initial background full suite: `cd packages/pi-better-background-tasks && ../../node_modules/.bin/vitest run` | 169 passed, 2 Windows skipped; sandbox-kernel failed collection with EPERM on `/private/var/tmp/bg-sandbox-kernel-XXXXXX`. |
| Final background runnable suite: `cd packages/pi-better-background-tasks && ../../node_modules/.bin/vitest run --exclude src/sandbox-kernel.test.ts` | 16 files passed, 1 Windows file skipped; 169 passed, 2 skipped. Exclusion is command-line only and explicitly records the environment blocker. |
| Final SSH suite: `cd packages/pi-better-ssh && ../../node_modules/.bin/vitest run` | 3 files, 14 tests passed, including actual pack/extract/load. |
| `npm run typecheck --ignore-scripts -w packages/pi-better-background-tasks -w packages/pi-better-ssh` | Both passed. Ignoring lifecycle scripts prevents cross-package synchronization writes. |
| Test-quality whole-suite lint with `--files` containing the 21 scoped test files | Exit 0, 0 gates, 5 leads; all cleared above. JSON: `/tmp/pi-test-quality-background-ssh-after.json`. |
| Test-quality `--diff HEAD`, excluding every other package and root auxiliary directory | Exit 0, 0 gates, 1 packaging lead; cleared above. JSON: `/tmp/pi-test-quality-background-ssh-diff.json`. An earlier exclude list inadvertently included pre-existing hidden worktree tests; rerun corrected the scope. |
| `git diff --check -- packages/pi-better-background-tasks packages/pi-better-ssh` | Passed. |

The first SSH pack-test attempt hit Vitest's lack of `import.meta.resolve`; the test was corrected to use the subprocess's normal `--import tsx` resolution through the temporary dependency symlink. The final run passed. No production defect was inferred from that harness error.
