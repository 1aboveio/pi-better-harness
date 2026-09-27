# Repository test-quality audit

Baseline: `0f1f84c18d6df76cce7a4dcdfc2a276a4015abb9`.

## Summary — 102 findings/clusters over 133 baseline test files

**28 Not coverage · 69 Weak · 5 Redundant · 0 unresolved Lead**, classified by each cluster's primary failure. Some subagent clusters also contain redundant assertions; these are counted once under their primary label. Counts describe original assertions, not remaining defects. The audit also inspected executable subagent smoke scripts and supporting fixtures. One source-only test file was removed, leaving 132 conventional test files.

All confirmed findings were addressed. Changes affect tests, test support and this report; no production implementation or dependencies were changed. The user's request explicitly included fixes, so the skill's audit-only default was followed by implementation and verification.

| Scope | Baseline test files | Findings/clusters | Detailed findings, locations, and resolutions |
|---|---:|---:|---|
| Root scripts and SSH core | 13 | 14 | [Root audit](test-quality-audit/root.md) |
| Utilities, navigator, goal, plan, read-aloud and harness CLI | 23 | 21 | [Utilities audit](test-quality-audit/utilities.md) |
| Background tasks and SSH extension | 21 | 21 | [Background/SSH audit](test-quality-audit/background-ssh.md) |
| Foreground sandbox, sandbox core and task sandbox | 17 | 26 | [Sandbox audit](test-quality-audit/sandbox.md) |
| Subagents | 59 | 20 | [Subagent audit](test-quality-audit/subagents.md) |

The detailed reports carry file:line references, principles, missed-bug examples, harmless-change failures, and fixes. They distinguish pre-edit locations from current locations.

## Most consequential fixes

- Sandbox tests now distinguish permission denials from unrelated errors, exercise genuine session-override resets, observe queued operation entry, prove atomic replacement and in-place log retention, and verify UTF-8 file-size boundaries.
- Shell lifecycle tests observe child readiness before cancellation or policy changes; timeout tests check the actual descendant processes rather than an artifact scheduled far in the future.
- Callback tests observe delivered messages and durable receipts, protect cross-session isolation across message types, and retain resolved incident evidence.
- Packaging tests execute staged/packed extensions. Source and CI prose checks no longer claim runtime proof. The parent additionally made the new SSH pack test accept array, direct-record and keyed-record npm JSON output.
- Sync tests use independent consumer paths and canonical bytes, avoiding production helpers as both implementation and oracle.
- Subagent tests execute registry adoption, concurrent catalog preparation, disk-log event parsing, and clone launch cwd. Tests for the retired widget renderer and duplicated source checks were removed; live formatter/cache tests remain.
- Error, ordering, default-policy, complete-output and foreign-session fixtures now distinguish the promised behavior from weaker implementations. Environment-sensitive goal tests control their defaults.

## Verification

`PI_SANDBOX_REQUIRE_BACKEND=macos-seatbelt npm run verify` **passed**: all **16 workspace typecheck scripts** passed; **1,290 tests passed, 0 failed, 6 skipped** across root scripts and all workspaces. The skips are two native Windows cases, one Linux-only case, and three opt-in subagent acceptance cases. The additional opt-in live-row acceptance test **also passed** after its final readiness-handshake correction.

Parent-session checks already inspected:

| Check | Result |
|---|---|
| Full repository verification with required macOS Seatbelt | 1,290 passed, 6 expected skips, 0 failures; all 16 typechecks passed |
| Root scripts and SSH core | 54 passed, no skips/failures |
| Strict macOS sandbox-core/task-sandbox/foreground sandbox | 243 passed, 1 Linux-only skip, no failures |
| Latest foreground shell lifecycle/kernel test file | 24 passed, 1 Linux-only skip, no failures |
| Background sandbox and kernel tests | 25 passed, no skips/failures |
| SSH extension after npm-output compatibility correction | 14 passed; typecheck passed |
| Subagent task-runtime kernel tests | 10 passed, no skips/failures |
| Opt-in real-Pi live-row acceptance with local model fixture | 1 passed; observes both the painted agent row and a provider POST before stopping the child |
| Targeted sandbox mutations | Three bad implementations correctly rejected: backend discovery during opt-out, omitted credential store, omitted global read denial |
| Whole-tree test-quality lint | 0 gates; 40 manually reviewed leads |
| Diff test-quality lint against baseline | 0 gates; 8 manually reviewed leads |
| Diff whitespace check | Passed |

The worker reports preserve the checks each worker actually ran. Their nested-sandbox `/var/tmp` and Seatbelt failures were environmental and were **subsequently resolved by the parent-session strict runs above**. Historical failed edits and initial failed fixtures were corrected; they are not outstanding findings. No kernel gate was disabled to produce the parent results.

## Look-alikes kept

- Files created by real operations, generated SBPL/argv, NDJSON inputs, parsed manifests and packed artifacts are valid behavioral inputs or outputs; they account for most remaining text-oracle leads.
- Canonical-versus-vendored file equality is intentional drift detection. It is kept in one appropriate owner rather than copied across suites.
- Three count leads encode independently defined contracts: retry limits, the fixed permission table and approved bundled role defaults.
- Fake clocks, Pi host interfaces, provider requests and OS process boundaries are external seams. Package-owned controllers, registry state and parsers continue to execute.
- Polling with a bounded observable condition and deliberately long cancellable workloads are not blind sleeps before assertions.

## Not audited / limits

- Pre-existing untracked `.npm-cache/`, `.resolve-issues/` and `.skill-pr-worktree/` trees, dependency trees, generated historical reports and fixture captures were excluded as standalone test suites. Fixtures were read where needed to assess tests.
- Linux Bubblewrap and native Windows execution require their platform CI lanes. Local verification uses macOS Seatbelt; Windows protocol unit tests do not prove native taskkill execution.
- Opt-in acceptance tests are not counted as executed by ordinary `npm test`. The changed live-row PTY test was additionally run and passed against its local provider fixture. The preserved-run reload acceptance and real-provider acceptance remain unexecuted; their fixture/platform requirements are unchanged. Root deterministic real-Pi/tmux journeys run as part of the normal root suite.
- No external SSH server, TTS service, model provider, GitHub release or npm publication was invoked; the live-row test uses a local HTTP provider fixture. Packed-extension loading uses installed workspace dependencies and does not prove a fresh remote installation.
- This was a whole-suite pattern and implementation review with targeted mutations, not a complete mutation campaign or a measurement of coverage percentages.
