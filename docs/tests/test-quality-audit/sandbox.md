# Sandbox test-quality audit and fixes

## Summary

Audited all **17 test files** under `packages/pi-better-sandbox`, `packages/sandbox-core`, and `packages/task-sandbox`, including manual review beyond the supplied lint results and reading the implementations exercised by the tests. **26 confirmed findings/clusters: 5 Not coverage, 19 Weak, 2 Redundant. All addressed.** No unresolved speculative Lead is counted as a finding. Labels describe the original assertions, not the repaired suite.

Changes are confined to **13 test files in the three assigned packages**. Production implementations, generated shared modules, manifests, and other contributors' edits were not changed. No commit was created. This report and verification artifacts are in `/tmp`, as requested.

Validation: **196 passed, 0 failed, 13 skipped** in the available 15-file run (209 tests reported); all three package typechecks pass; assigned-scope lint has **0 gates and 8 manually cleared leads**; diff lint has **0 gates**, with 3 assigned-scope leads cleared. Three isolated source mutations were detected by the repaired tests. Four extracted shell lifecycle tests also pass with the real, unconfined SDK. **Real kernel enforcement could not be verified in this session**: macOS denies nested `sandbox-exec` with `sandbox_apply: Operation not permitted`. The strict kernel run failed, and has not been relabeled as passing.

The user's explicit request to fix tests overrides the skill's audit-only instruction. No permission pause or commit was required.

## Scope and sources

Read `/Users/exoulster/.agents/skills/test-quality/SKILL.md`, ran its release check, and used `/tmp/pi-harness-test-quality.json` as candidate input. Eight supplied candidates belong to this assignment: seven text-oracle file candidates and the permission-page count candidate. They were inspected individually; they were not automatically treated as findings.

Architectural context read:

- `docs/adr/0003-sandbox-core-shared-package.md`: shared mechanism, consumer policy, vendored distribution.
- `docs/adr/0004-foreground-sandbox-opt-in.md`: default inactive foreground, persisted defaults and session overrides.
- `docs/adr/0005-sandbox-permission-table.md`: six fixed rows, credential-store scope, independent columns and enforcement requirements.
- `docs/adr/0007-trusted-runtime-task-boundary.md`: trusted Pi runtime, fixed confined file workers, queues, task admission and runtime protection.
- `packages/pi-better-subagents/docs/adr/0001-linux-sandbox-bubblewrap.md`, referenced by ADR 0003: historical backend decision. Its PATH lookup is superseded by ADR 0007's system-only discovery; the new opt-out test follows the current implementation.
- `docs/sandbox-default-compatibility.md` and `docs/development-and-release.md`: runtime exceptions, 8 MiB worker cap, platform gates and test commands.
- Read CI's sandbox lane declarations to establish that `PI_SANDBOX_REQUIRE_BACKEND` is actually set on both macOS and Linux lanes. No CI changes were made.

Implementation review covered `sandbox-core/index.ts`, both `task-sandbox` implementation files, and foreground `index.ts`, `files.ts`, `shell.ts`, `state.ts`, `policy.ts`, `permissions.ts`, `permission-settings.ts`, `preferences.ts`, `permissions-page.ts`, `deny-rules.ts`, `rules-page.ts`, `commands.ts`, `events.ts`, and `status.ts`. Also inspected the installed SDK's file-tool queue calls, write renderer and edit renderer, and the foreground test backend helper. The generated shared copies were treated as distribution artifacts rather than independent implementation owners.

Test inventory:

- `pi-better-sandbox/test`: `deny-rules`, `extension`, `files`, `foreground-shell.kernel`, `permission-settings`, `permissions-page`, `permissions`, `policy`, `preferences`, `shell`, `state`, `status` (`.test.ts`).
- `sandbox-core`: `index.test.ts`, `permissions.test.ts`, `macos-seatbelt.test.ts`.
- `task-sandbox`: `index.test.ts`, `files.test.ts`.

## Findings and fixes

**Locations below refer to the original, pre-edit files read during this audit.** This preserves accurate references for removed assertions and collapsed tests. Current tests can be found by the quoted behavior names. “None identified” means no harmless-change failure was demonstrated; it does not mean the old assertion was adequate.

| # | Original location | Principle / label | Missed realistic bug | Harmless change that breaks it | Fix |
|---|---|---|---|---|---|
| 1 | `packages/sandbox-core/index.test.ts:218` (PATH trap helper at `:69`) | P4 — Weak | `sandbox:false` starts backend discovery, but discovery now reads trusted system paths rather than PATH, so the trap cannot see it. | None identified. | Replace the obsolete environment proxy with throwing platform, lookup, canonicalization, profile-write and materialization seams, plus a no-profile-artifact assertion. A mutation that discovers a backend during opt-out now fails. |
| 2 | `packages/sandbox-core/permissions.test.ts:169`, `:191`, `:240`, `:305`, `:383`, `:413`, `:419`, `:432` | P4 — Weak | A required SBPL rule or mount is absent: `indexOf()` returns -1 and an ordering comparison still passes. The scratch check can accidentally find a different `--bind`. | None identified. | Require rule presence before comparing positions, match complete mount tuples, and explicitly establish presence for the left side of ordering comparisons. Removing the global read denial now fails. |
| 3 | `packages/sandbox-core/permissions.test.ts:99` | P2/P4 — Weak | A credential store is dropped while another path, including configured agent auth, keeps the count at least 11. | Removing a redundant entry can break an arbitrary count even if the same stores remain protected. | Replace count with ADR-named credential paths and actual read/write denial decisions under a broad outside grant; retain symlink and mode cases. Removing `.aws` now fails. |
| 4 | `packages/sandbox-core/permissions.test.ts:126` | P4 — Not coverage on the early-return paths | Data-volume alias normalization regresses, but unsupported platform or absent alias returns as a successful test without assertions. | None identified. | Use an explicit non-macOS skip; on macOS require the fixture alias to exist before checking denials. |
| 5 | `packages/pi-better-sandbox/test/extension.test.ts:531` | P4 — Not coverage for override reset | A session override survives restart: the old test chose Off while the persisted default was also Off, so both paths produced disabled. | None identified. | Start inactive, enable a session override, verify enabled, resume, then require disabled. The existing persisted-On lifecycle test retains the opposite transition and all session reasons. |
| 6 | `packages/pi-better-sandbox/test/extension.test.ts:586` | P1 — Not coverage for executable entry-point loading | Manifest points to a file that exists but does not register the extension. Literal and existence checks pass. | Moving the entry point while updating the manifest breaks the literal pin. | Resolve the actual declared entry points, run the SDK loader, require no errors and a registered sandbox command. Keep the no-binary capability check. |
| 7 | `packages/pi-better-sandbox/test/files.test.ts:495` (source comparisons at `:515`) | P1/P2 — Not coverage for product registration | The extension stops preserving SDK contracts, but the test itself constructs both definitions from the same SDK factories, then compares renderer source strings. | Equivalent closures with different captured behavior can compare equal; source differences can also fail without a rendering change. | Remove this harness-self-check and carry its useful metadata comparisons to the actual extension-registration test. Exercise renderers there and compare rendered output against the SDK. |
| 8 | `packages/pi-better-sandbox/test/extension.test.ts:279`, `:321` | P4 — Weak | A renderer returns the wrong content while still being a function; bash schema or description changes while retaining a `command` property. | None identified for the shape assertions. | One real-registration contract test covers write, edit and bash: full SDK schema/metadata comparisons plus call rendering and observable error rendering. Initialize the SDK theme without watchers. |
| 9 | `packages/pi-better-sandbox/test/extension.test.ts:242` | P5 — Redundant | No unique bug: repeats the exact registered-tool allowlist in `:231`. The later human-only rule test also verifies event-channel tampering cannot mutate policy. | An authorized tool-surface change requires editing multiple identical pins. | Remove only the duplicate registration-only test. Keep the surface allowlist and the independent event-tampering behavior. |
| 10 | `packages/pi-better-sandbox/test/state.test.ts:48` | P5 — Redundant | Five cases only vary names and fixture paths; the reason never reaches `beginSession`. They prove the same controller transition five times. | None identified beyond duplicate maintenance. | Collapse to one controller test covering enabled and disabled overrides resetting. The extension lifecycle tests still pass every actual event reason through the registered handler. |
| 11 | `packages/pi-better-sandbox/test/files.test.ts:558`, `:607`, `:676` | P4 — Weak | Queue exclusion can look correct merely because I/O has not completed within 50 ms; a 20 ms pause guesses when cancellation should arrive. | Slow filesystems or scheduler load. | Use explicit promise barriers, instrument the real operations' entry points, check event order through the complete mutation window, and release mkdir only after abort. Real controller, guards, SDK queue and filesystem effects remain in use. |
| 12 | `packages/pi-better-sandbox/test/foreground-shell.kernel.test.ts:275`, `:299`, `:429`, `:534` | P4 — Weak | A toggle or rule change occurs before the child starts; streaming/cancellation tests rely on guessed elapsed time instead of observing startup. | Slow process startup or loaded CI. | Add a real FIFO readiness/release handshake. Observe streamed readiness before release, cancellation or policy mutation; use bounded operation timeouts and drain/close the launched command in cleanup. |
| 13 | `packages/pi-better-sandbox/test/foreground-shell.kernel.test.ts:287` | P4 — Weak | Only the shell is killed while its descendant survives. The marker scheduled after 30 seconds is necessarily absent when the one-second timeout returns. | None identified. | Capture actual shell and child PIDs from streamed output; after timeout require each process gone (or a non-running Linux zombie), while retaining error and no-marker assertions. |
| 14 | `packages/pi-better-sandbox/test/foreground-shell.kernel.test.ts:317` | P4 — Weak | Truncation advertises a full-output path but never writes the complete output, or display output is not actually shortened. | None identified. | Read the output artifact and compare all 5,000 input-derived lines; require shorter displayed output retaining the tail; clean up the artifact. |
| 15 | `packages/pi-better-sandbox/test/preferences.test.ts:22` | P4 — Weak | Preference persistence writes directly into the destination; sequential round trips still pass while concurrent readers can observe partial data. | None identified. | Keep an old file descriptor open across the update. It must still read the old complete document while a fresh read sees the new one, proving atomic replacement rather than an in-place overwrite. |
| 16 | `packages/pi-better-sandbox/test/deny-rules.test.ts:185` | P4 — Weak | Missing-file rule is displayed and published but the mutation guard ignores it. | None identified. | Attempt an actual guarded write to the nonexistent denied file; assert the specific denial and no artifact; write a permitted sibling as a positive control. |
| 17 | `packages/pi-better-sandbox/test/deny-rules.test.ts:450` | P4 — Weak | Remove or reset stops announcing/reapplying policy, while the test titled “every change” only checks add. | None identified. | Check load, add, remove and reset publication counts, announced paths and controller/report agreement. |
| 18 | `packages/pi-better-sandbox/test/permissions-page.test.ts:25`, `:58` | P4 — Weak | Extra permission rows after the first eight rendered lines are invisible because the test helper truncates the table itself. | None identified. | Locate the rendered Save action and inspect the entire table through that action. Retain the exact eight-line check because ADR 0005 fixes six permission rows plus header and Save. |
| 19 | `packages/pi-better-sandbox/test/permissions.test.ts:15`; `test/policy.test.ts:28`; `test/state.test.ts:189`; `test/extension.test.ts:400` (same package) | P4 — Weak | An unrelated exception satisfies bare `assert.throws`, hiding broken validation or mutation setup. | None identified. | Match specific validation diagnostics and require TypeError for attempts to mutate frozen values. |
| 20 | `packages/pi-better-sandbox/test/policy.test.ts:27` | P2 — Weak | No extra behavioral protection from pinning the source-array order; the resolver sorts the effective policy. | Reordering the same three packaged protections. | Compare sorted membership, retaining the intentional frozen protection set and immutability test. |
| 21 | `packages/pi-better-sandbox/test/extension.test.ts:739` | P4 — Weak | A running operation loses its launch policy; the test never has an operation running during the change. | None identified. | Rename the test to its actual completed-write/subsequent-write behavior. The real in-flight claim remains in the kernel tests and is strengthened by finding 12, not dropped. |
| 22 | `packages/task-sandbox/files.test.ts:77` | P4 — Weak | Kernel-backed SDK operations bypass their queue; sequential write/edit/read still succeeds. | None identified. | Keep the sequential semantics test with an accurate name and add a held real SDK queue with competing write/edit, a no-policy-request-before-release assertion and a final serialized result. |
| 23 | `packages/task-sandbox/files.test.ts:89` | P2 — Not coverage | The helper mishandles disabled commands, but asserting the fixture's own `commands: false` literal can never see it. | Changing fixture policy legitimately. | Remove the fixture echo. Successful worker I/O with Commands Off remains the real evidence; explain that in the test comment/name. |
| 24 | `packages/task-sandbox/files.test.ts:172` | P4 — Weak boundary coverage | The worker rejects below the documented 8 MiB boundary or counts characters rather than UTF-8 bytes; the old ASCII oversize case misses these regressions. | None identified. | Write/read an exactly 8 MiB multibyte payload, reject the next multibyte character, and verify the existing file is not truncated; retain oversize read and absent-file checks. |
| 25 | `packages/pi-better-sandbox/test/deny-rules.test.ts:473` | P4 — Weak | Planning reads an override and ignores it; observing no file creation cannot prove “neither read nor write.” | None identified. | Rename the test to the actual assertions: computed changes, unchanged input and no created override. No false claim of observed read absence remains. |
| 26 | `packages/pi-better-sandbox/test/extension.test.ts:48` | P4 — Weak | Registration, command, persistence and lifecycle regressions receive no local exercise when nested kernel confinement is unavailable, although these checks do not execute workers. | Running the suite inside a restricted host with a discoverable but unusable backend. | Separate discovery-only test gating from usable-kernel gating. Only four extension cases that actually execute permitted workers retain the stronger prerequisite. The strict backend requirement still throws when requested. |

## Clusters and coverage preservation

The principal causes were stale assertions after architectural changes (PATH discovery; sequential tests labeled as queue tests), negative observations before work had actually started (timers and marker absence), and tests observing their own setup (SDK factory/source comparisons, fixture literal). Repairs favor actual operation entry, independent contracts, filesystem results, and explicit readiness.

No enforcement case was deleted. Two redundant groups were collapsed: the duplicate tool-registration allowlist and the controller's five equivalent reason-labeled cases. The source-comparison test was replaced by actual registered SDK contract/rendering checks, including bash. Existing real-kernel positive/negative controls, symlink cases, policy matrices, tool admission checks, file mutation details and both platform gates remain.

Additional test-harness portability change: `packages/task-sandbox/index.test.ts:12` now honors the existing `PI_SANDBOX_TEST_TMPDIR` convention for the non-compatibility target fixture, defaulting to `/var/tmp`. This enabled the test here without placing its outside-read target under the writable compatibility `/tmp` allowance. It does not weaken policy assertions or modify runtime behavior.

## Look-alikes cleared and retained

All eight assigned candidates from the supplied JSON were investigated:

| Candidate | Resolution |
|---|---|
| `pi-better-sandbox/test/deny-rules.test.ts:189` text-oracle | `config/production.env` and `summary.txt` are disposable runtime inputs/results, not checked-in source text. Separately repaired the missing enforcement assertion and publication coverage. |
| `pi-better-sandbox/test/extension.test.ts:144` text-oracle | Most paths identify loaded code or disposable files. The actual manifest literal check was a confirmed finding and replaced by loading the declared entries. The remaining sourceInfo identity is an intentional admission contract. |
| `pi-better-sandbox/test/files.test.ts:168` text-oracle | Actual SDK operations mutate/read disposable files. The independent renderer-source/harness check was found manually and replaced elsewhere. |
| `pi-better-sandbox/test/foreground-shell.kernel.test.ts:233` text-oracle | Observes real filesystem effects and syscall denial. No source-text oracle. |
| `pi-better-sandbox/test/permissions-page.test.ts:58` count-pin | Eight lines encode the ADR's fixed table, not an arbitrary inventory size. Kept after removing the helper's eight-line clamp. |
| `pi-better-sandbox/test/shell.test.ts:104` text-oracle | Reads an SBPL profile produced by the code under test. SBPL is an external backend language; this checks generation, with enforcement separately owned by kernel tests. |
| `sandbox-core/index.test.ts:353` text-oracle | Canonicalization of actual symlink fixtures and missing files; no checked-in source read. |
| `task-sandbox/files.test.ts:68` text-oracle | Actual files created/read by local operations or confined workers, not repository content. |

Other cleared patterns:

- Injected OS discovery, getconf, filesystem boundaries and host SDK event/UI interfaces are legitimate external boundaries. Tests keep the real controller, policy compiler and guards. Recording operation entry for queue ordering still delegates to the real guarded operation.
- Handwritten/default-profile tables and permission matrices have independent input/ADR expectations. Exact tool names and parameter allowlists prevent unintended capabilities; they are not arbitrary inventory counts.
- Broad nonzero checks in kernel denial tests coexist with unchanged-file/no-artifact checks and positive controls under the same policy. They are not treated as proof from a failure exit alone.
- Legitimate backend/platform skips remain: CI has macOS and Linux lanes with mandatory backend variables. None was removed to manufacture a passing kernel run. The Data-volume silent return was different and was fixed.
- Generated SBPL/argv tests and actual kernel tests provide different layers; they are not duplicate proof. An argv/profile check is not reported as kernel enforcement.
- `files.ts` and `shell.ts` in the foreground package remain public exports through `index.ts`; their pure-operation tests are not declared dead merely because current registration uses the shared task executor.
- SDK `withFileMutationQueue` is real. Promise barriers and a `setImmediate` scheduler turn are used to observe entry/order, not as an arbitrary elapsed-time claim about filesystem completion. Kernel shell `sleep 30` is deliberately cancellable workload, not a test wait.
- Runtime output/error text checks are observations of public behavior. Generated persisted-format version checks protect a storage contract.
- `task-sandbox/index.test.ts` symlink chains, relative targets and cycle detection all execute the actual alias resolver over real fixtures. No fake resolver or implementation-derived expected path was introduced.

## Verification and artifacts

1. **Strict backend attempt**:

   ```sh
   PI_SANDBOX_REQUIRE_BACKEND=macos-seatbelt node --import tsx --test packages/pi-better-sandbox/test/*.test.ts packages/sandbox-core/*.test.ts packages/task-sandbox/*.test.ts
   ```

   Failed in this restricted session: nested Seatbelt application is prohibited; the original default `/var/tmp` fixture roots were also denied. Recorded in `/tmp/pi-sandbox-tests.log`. This is not a clean full-suite result.

2. **Available tests**, after choosing a permitted non-compatibility fixture directory:

   ```sh
   PI_SANDBOX_TEST_TMPDIR="$PWD/packages/task-sandbox" node --import tsx --test \
     packages/pi-better-sandbox/test/{deny-rules,extension,files,permission-settings,permissions-page,permissions,policy,preferences,shell,state,status}.test.ts \
     packages/sandbox-core/{index,permissions}.test.ts packages/task-sandbox/*.test.ts
   ```

   Final result: **209 tests; 196 pass, 0 fail, 13 skip**. The thirteen skips are the four worker-running extension cases, one SDK-loaded file-worker case, and eight task-file kernel cases. Additionally, real-kernel describe groups in core permissions are skipped at suite level. Log: `/tmp/pi-sandbox-tests-available.log`. Temporary fixtures were removed by their cleanup hooks.

3. **Typechecks**:

   ```sh
   npm run typecheck --ignore-scripts -w packages/pi-better-sandbox -w packages/sandbox-core -w packages/task-sandbox
   ```

   All pass. Log: `/tmp/pi-sandbox-typecheck.log`. `--ignore-scripts` deliberately avoids pretypecheck sync hooks that would write generated copies in other assigned-to-someone-else packages. Only tests changed, so no production sync was necessary.

4. **Test-quality lint**:

   Ran the skill's `scripts/lint-tests.mjs --files <all 17 assigned test files> --json`: **0 gates, 8 leads**, all resolved above. Artifact: `/tmp/pi-sandbox-lint.json`.

   Also ran `--diff HEAD --exclude .npm-cache,.resolve-issues,.skill-pr-worktree --json`: **0 gates** in the captured shared-workspace run. Three leads touch this assignment, all runtime fixture paths/loader inputs. Artifact: `/tmp/pi-sandbox-diff-lint.json`. Findings outside this assignment were neither owned nor fixed here. `git diff --check -- packages/pi-better-sandbox packages/sandbox-core packages/task-sandbox` passes.

5. **Mutation checks**:

   `/tmp/pi-sandbox-mutations.py` copied only sandbox-core source and the relevant tests into a disposable `/tmp` directory. Each unchanged control passed, and each mutated variant failed:

   - Invoke backend discovery on `sandbox:false`.
   - Omit `.aws` from known credential stores.
   - Omit global macOS file-read denial.

   Results: `/tmp/pi-sandbox-mutations.json`. No repository production file was mutated. These are targeted oracle checks, not a comprehensive mutation score.

6. **Shell harness validation without confinement**:

   `/tmp/pi-sandbox-lifecycle.py` extracts the revised run/readiness helpers and four lifecycle test bodies into a disposable harness using the installed SDK's real ordinary Bash tool. Streaming/FIFO handshake, timeout plus process-tree exit, observed-start cancellation, and complete truncation artifact checks: **4 pass, 0 fail**. Log: `/tmp/pi-sandbox-lifecycle.log`. This verifies the test machinery and SDK lifecycle assumptions only; it does not prove the confined adapter or kernel policy.

## Exclusions and remaining limits

- No assigned test file was excluded from manual audit. Two wholly real-kernel files, `pi-better-sandbox/test/foreground-shell.kernel.test.ts` and `sandbox-core/macos-seatbelt.test.ts`, were excluded from the successful available-tests command after the strict attempt demonstrated that this host cannot apply Seatbelt. They still typecheck. The changed kernel tests require a capable platform lane before claiming enforcement verification.
- Linux mount construction and permission planning ran locally; real Linux Bubblewrap enforcement cannot run on this macOS host. Existing mandatory Linux CI coverage remains intact.
- No full-repository test, package pretest/prepack sync, golden-path runner or publishing workflow was invoked. Those write outside the assigned packages or exceed this audit scope. The 13 changed test files are the only repository files edited by this task.
- Other packages, root scripts, vendored/generated implementation copies, external consumer tests, and actual Pi TUI/RPC session smoke journeys were not audited as deliverables. Referenced ADRs and SDK source outside the assignment were read-only context.
- No code-coverage percentage was measured. Preservation here means retained behavioral cases and stronger/replacement oracles, not an unsupported claim about line or branch percentages.
- The full shared working tree contains concurrent changes by other contributors. Those were left untouched; no commit, reset, restore or cleanup of their files occurred.
