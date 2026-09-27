# Root scripts and SSH core test-quality audit

Scope: all 12 `scripts/*.test.mjs` files plus `packages/ssh-core/index.test.ts`, read against their implementations. Locations below refer to baseline `0f1f84c18d6df76cce7a4dcdfc2a276a4015abb9`, before removals. User requested both audit and fixes.

## Findings

| Baseline location | Principle / label | Failure and missed bug | Harmless change that broke it | Resolution |
|---|---|---|---|---|
| scripts/harness-default-capability.test.mjs:32; scripts/harness-session.e2e.test.mjs:76 | 1 / Not coverage | Regex inferred shim imports, so a commented import or broken export could count as loading an extension. | Single-quoted or reformatted import. | Session test now stages current packages and executes actual manifest shims; checks every required tool, including goal. Removed text-derived duplicate loading tests. |
| scripts/harness-default-capability.test.mjs:145 | 1 / Not coverage | A list in staging source could remain correct while the staging loop did nothing. | Rename or compute the package list. | Removed grep; actual npm pack output must carry every declared component entry. |
| scripts/harness-default-capability.test.mjs:164 | 2 / Weak | Exact `files` and extension-entry arrays pinned configuration spelling without proving packaged contents. | Equivalent glob or entry relocation. | Removed mirrors; real tarball checks retain entry and no-launcher requirements. |
| scripts/harness-default-capability.test.mjs:170; scripts/harness-default-capability.test.mjs:185 | 1 / Not coverage | Two workflow-text tests passed for dead/commented shell and never ran the release checks. | YAML indentation or equivalent shell spelling. | Removed false workflow proof; retained actual standalone and bundled pack checks. Workflow execution itself remains outside this suite's proof. |
| scripts/harness-default-capability.test.mjs:92; scripts/harness-default-capability.test.mjs:116 | 5 / Redundant | Installer/bundled dependency set equality was checked twice. | N/A: duplicate, not brittle. | One independent manifest/installer drift check remains. |
| scripts/harness-session.e2e.test.mjs:249 | 4 / Weak | Existence of `operations` did not prove user-bash confinement; an unconfined implementation passed. | None. | Execute allowed and outside writes; check successful bytes and absence of an escaped artifact. |
| scripts/harness-session.e2e.test.mjs:364 | 4 / Weak | Backend executable name alone did not prove subagent wrapper policy was enforced. | None. | Execute the generated wrapper with a Node child; check allowed write and refused outside write. |
| scripts/sandbox-fail-closed.test.mjs:51 | 5 / Redundant | Canonical shared-file equality repeated the stronger exact equality in sync-shared-sandbox-core.test.mjs. | Generated banner rewording (for its additional prose pin). | Remove duplicate; keep a single canonical synchronization owner and packaging checks. |
| scripts/sandbox-fail-closed.test.mjs:93 | 4 / Weak | Missing-backend host returned before the test of backend loss. | None. | Feed a valid confined plan to the real wrapper with unavailable platform discovery; rejection is exercised on every host. |
| scripts/sandbox-fail-closed.test.mjs:147 | 4 / Not coverage on unsupported hosts | Early return reported a pass without testing confinement. | None. | Explicit platform-dependent skip; real backend CI lanes execute it. |
| scripts/sync-shared-sandbox-core.test.mjs:26; scripts/sync-shared-sandbox-core.test.mjs:121 | 2 / Weak | Sync and oracle used the same target/content helpers; dropping a consumer or truncating source could pass. | None. | Independent ADR-defined consumer paths and expected bytes read directly from canonical source. |
| scripts/sync-shared-sandbox-core.test.mjs:202 | 2 / Weak | Internal package name literal did not prove private publication policy. | Internal package rename. | Remove name mirror; keep forbidden-publication flag assertion. |
| packages/ssh-core/index.test.ts:64; packages/ssh-core/index.test.ts:195 | 2 / Weak | Exported timeout constants were pinned separately from real emitted argv. | Rename/remove the exports while keeping the protocol behavior. | Remove constant mirrors; keep actual safe SSH argv checks. |
| packages/ssh-core/index.test.ts:125 | 1 / Weak | Exact generated shell spelling passed without proving the no-workdir command executes. | Equivalent POSIX quoting. | Run the generated command in a directory with a quote/space and check observed cwd. |

## Look-alikes kept

- `failure-observations-contract.test.mjs`: intentionally synchronized copies plus execution of each real consumer reducer; text equality is a legitimate drift check.
- `sync-shared-ssh-core.test.mjs`: reads files produced by the synchronizer, verifies stale-file removal; not source grep.
- `task-sandbox-packaging.test.mjs`: canonical synchronization and actual npm pack file manifests; not static config proof.
- Root manifest/dependency agreement: two independently maintained surfaces must agree; exact pins for forbidden launcher/publication capabilities are intentional.
- SSH `FakeRemoteRunner`: substitutes SSH, an external process/network boundary; real controllers build safe commands and parse responses. Tests do not claim a real SSH-server connection.
- TUI tests execute real Pi and tmux; screen checks assert produced output. Poll intervals wait for explicit conditions, not fixed sleeps before assertions. The short negative-focus observation continuously checks the forbidden state.
- Kernel/TUI prerequisite skips have real macOS/Linux/tmux CI lanes. The standalone fail-closed unit now exercises unavailable backend without relying on such a lane.
- SSH control-path shape is accompanied by reuse/scope-isolation assertions, filesystem mode checks, and external argv verification.

## Not audited

- Untracked `.npm-cache/`, `.resolve-issues/`, `.skill-pr-worktree/`, installed dependencies, generated shared source copies and fixture trees as standalone suites. Generated copies remain exercised by consumer/packaging tests.
- Live GitHub release execution, actual npm publishing, and live SSH servers. Local packing and fake external transport cannot prove those services.

## Validation

Parent runs the complete repository verification after integrating package audits. Focused changed-file lint has zero gates (remaining text-oracle leads are input manifests and generated filesystem output).
