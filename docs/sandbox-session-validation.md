# Session error validation ledger

Status: post-fix replay passed for all three sessions and all nine recorded child policies. Gate completed before opening a PR, against `cbba9c6` on 2026-09-26 at 23:08–23:10 UTC.

Evidence root: `/private/var/folders/hh/j9d9ym9d1n3b_lks9_4b5zx40000gn/T/pi-better-subagents/runs/`. Run IDs below identify `meta.json`, `control/task-policy.json`, `failures.jsonl`, and structured `output.log`. Original artifacts are read-only. Parent/child sessions may continue generating later events; final replay will record its cutoff.

All inspected policies select Project Read/write, Outside Read, credential files Read, commands On, network On. Each has a specific assigned root and protected runtime paths.

| Session | Runs / evidence prefix | Observed failure | Classification and final replay |
|---|---|---|---|
| KYC `01a0dfb2-b77a-762f-b8e3-1a8e5427ee6d` | `sa_muixk4ih_1`, `call_uZu`, `call_gY1`, `call_cBp`, `call_LRw` | Literal glob passed to read, missing script, read offset past EOF | Invocation/path error. Discover actual filenames and read valid ranges; do not alter read semantics to silently expand arbitrary paths. |
| KYC | `sa_muixv0xz_2`, `call_fzT0lLabHqwrVzGjKKX8LW5F` | Combined discovery command exits 2 after rg over selected docs/paths | Inspect missing inputs and perform bounded existing-path reads. |
| KYC | `sa_muixv0xz_2`, `call_FINSYVwSGfUWyxD0GZwxIzdX` | Write from assigned unit to a different worktree's `.resolve-issues` directory denied | Expected outside-write denial. Validate disposable write inside assigned root and deny outside sentinel. |
| FMM `01a0dfb1-e87e-7312-aa91-08f26dcad94b` | `sa_muixg3io_1`, `call_tnY`, `call_33J` | gh GraphQL 401 and Git HTTPS credential lookup failure | Keychain runtime compatibility regression. Replay authenticated gh read and git ls-remote, no login change. |
| FMM | `sa_muixg3io_1`, `call_ol8`, `call_OCO` | Unauthenticated curl returns private-resource 404 | Authenticated gh read is the safe authority check; unauthenticated curl is not expected to become authenticated. |
| FMM | `sa_muixg3io_1`, `call_yUr` | Base workspace lacks Android/plan paths | Workspace selection issue. Confirm preserved unit source paths. |
| FMM | `sa_muixg3io_1`, `call_Uj4`; A1 `sa_muixz4e3_1`, `call_wIA` | Shell `apply_patch` not found | No shell-binary contract. Validate available guarded write/edit on disposable files; do not inject a global executable. |
| FMM | `sa_muixg3io_1`, `call_Kce` | Findings write to base checkout outside child root denied | Expected boundary. Child should return findings or write within assigned root. |
| FMM | `sa_muixwcgu_4`, `call_SKc`; `sa_muixwfy2_5`, `call_yfF`; `sa_muixwjdb_6`, `call_GcT` | Literal `/tmp` log redirection denied | Historical runtime compatibility regression. Replay writes to uniquely named temporary logs, never overwrite original outputs. |
| FMM | `sa_muixw93k_3`, `call_9PXY`; `sa_muixwcgu_4`, `call_agO` | `ERR_PNPM_NO_OFFLINE_TARBALL`, missing `@axe-core/playwright` archive | Dependency availability, not filesystem denial. Do not rerun installs in active workspaces or claim fixed by sandbox policy. |
| FMM | `sa_muixwfy2_5`, `call_Ib6`; `sa_muixwjdb_6`, `call_FAd` | node_modules directories absent during discovery | Workspace dependency state. Read-only existence check only. |
| FMM | `sa_muixwfy2_5`, `call_nd7` | `/bin/ps: Operation not permitted` | Existing macOS sandbox/setuid limitation: reproduced even with `(allow default)` (exit 71). Not a filesystem-profile regression. |
| FMM | `sa_muixwfy2_5`, `call_2Um`, `call_AkX`, `call_DTFe`, `call_9yQ`, `call_nJw`, `call_mK8` | Android build failures and explicit 60-second timeouts | Read-only inspection found `.android/analytics.settings` write denial (ordinary home remains Outside Read), and the offline build's terminal failure is missing cached Maven artifacts, including `bundletool-1.15.2.jar`. Online log has no terminal success/failure and was reused across commands, so per-attempt attribution remains incomplete. Explicit 60-second timeouts remain timeouts; no build recovery claimed. |
| FMM | `sa_muixwcgu_4`, `call_NkH` | Playwright `headers[1].value: expected string, got number` | Concrete test/input failure, not sandbox permission failure. Original evidence suffices; no database-mutating replay. |
| FMM | `sa_muixwcgu_4`, `call_Mnq` | Integration tests expected `body.storeId`, received undefined; 2 failures/19 passes | Concrete application/test assertion. Do not mark recovered by unrelated successful sandbox probes. |
| FMM | `sa_muixwjdb_6`, `call_7T9` | Edit oldText matches twice | Correct editor ambiguity guard. Test unique edit separately; no product mutation. |
| FMM | `sa_muixwjdb_6`, `call_lav`, `call_VrJ` | Frontend tests fail with output redirected; missing wildcard input in combined command | The current redirected log reports 143 tests passing, but it was reused and contains three suites rather than the original two-suite invocation. Historical failure attribution remains incomplete; do not treat this overwritten log as an exact matching recovery. No product tests rerun. |
| FMM | `sa_muixwjdb_6`, `call_YMT` | Inventory generated successfully; later rg wildcard does not exist | Search invocation error; inventory mutation is not replayed. |
| A1 `01a0dfb8-46fe-73d4-8ed7-d9a4b127b289` | `sa_muixz4e3_1`, `call_G1J` | gh GraphQL 401 | Same Keychain regression; replay safe authenticated repository/issue read. |
| A1 | `sa_muixz4e3_1`, `call_IJjfm0xlMmb5qderwF0ZoFah` | rg over gateway/rule-engine/infra paths returns 2, output contains SQL test text | Search, not database execution. Confirm missing paths; read existing matches safely. |

## macOS process-inspection follow-up

This later investigation is separate from the three-session replay gate above;
it does not extend that gate's cutoff or claim product/build acceptance.

- Session: `01a1027f-34e7-75b6-89e3-ccb509b83108`, FMM Express.
- Worker: `sa_musqiow3_11`; original tool call:
  `call_0mxiUYlhjXFvbtE6owYIWJjH` (provider suffix omitted).
- At 2026-10-03 18:40:46 UTC, `ps -axo pid,ppid,lstart,command` returned
  `/bin/bash: /bin/ps: Operation not permitted`, exit 126. The failure
  observation was recorded at 18:40:51 UTC. The worker withheld #1321's APK
  build because current exclusive process ownership could not be verified.
- Saved `control/task-policy.json` had project Read/write, outside Write,
  stored credentials Read, commands On and network On. Commands were not
  disabled, and the generated broad profile starts with `(allow default)`.
- Read-only host probes on 2026-10-04 verified `/bin/ps` and `/usr/bin/top`
  are setuid-root. Executing `ps` through a shell inside a minimal
  `(version 1) (allow default)` Seatbelt profile reproduced exit 126;
  direct `sandbox-exec` execution failed with exit 71. The same narrow query
  outside Seatbelt succeeded. This isolates the macOS setuid execution
  limitation from the harness's file/network restrictions.
- Human decision W24 approved a coordinator handoff. A permitted foreground
  snapshot at 2026-10-04 00:47:19 UTC found no Java/Gradle/emulator/QEMU
  process. The pre-existing adb daemon was left untouched. The coordinator
  granted a serial #1321 build lease and launched `sa_mut3reln_13`; #1325
  remained queued. Sandbox restrictions were unchanged. This is admission
  evidence, not proof that either build completed.

Original artifacts live under the evidence root above, in
`sa_musqiow3_11/{output.log,failures.jsonl,control/task-policy.json}`.
The parent session JSONL records the inspected result at line 297 and the
human handoff answer at line 306. No original evidence was modified.

See [the platform limitation and reproduction command](../packages/pi-better-sandbox/README.md#macos-setuid-executable-limitation).

## Post-fix replay results

All nine recorded roots/policies passed the same bounded probes using the updated task executor (`runtimeCompatibility: true`). Original policy artifacts were only read. A new isolated scratch/profile was used per run; temporary log names and workspace probe files were unique and cleaned up. No original file contents, credentials, session state, findings, build settings, or database were changed.

| Session | Replayed child policies | Result |
|---|---|---|
| KYC `01a0dfb2-b77a-762f-b8e3-1a8e5427ee6d` | `sa_muixk4ih_1`, `sa_muixv0xz_2` | 2/2 passed |
| FMM `01a0dfb1-e87e-7312-aa91-08f26dcad94b` | `sa_muixg3io_1`, `sa_muixpdzk_2`, `sa_muixw93k_3`, `sa_muixwcgu_4`, `sa_muixwfy2_5`, `sa_muixwjdb_6` | 6/6 passed |
| A1 `01a0dfb8-46fe-73d4-8ed7-d9a4b127b289` | `sa_muixz4e3_1` | 1/1 passed |

Each replay verified authenticated repository REST and issue GraphQL reads, Git HTTPS credential-helper access through `git ls-remote`, a literal `/tmp` log redirect, guarded workspace file read/write operations, discovery followed by an actual ADR read, and denial of both an ordinary outside `*.lock` write and a unique Pi control-directory probe. Shell `apply_patch` remained unavailable in all nine cases; guarded file operations worked. Tests of editor ambiguity and SDK behavior remain covered by the repository suite rather than replaying original product edits.

The authentication and literal-temp-write regressions are therefore resolved under the recorded policies. Application assertions, unavailable offline dependencies, missing paths, explicit timeouts, and expected outside denials remain separately classified above; unrelated success is not a recovery marker. No original failure-observation records were altered. Later session events are outside this replay's cutoff.

Verification: full local `npm run verify` passed; manual CI [36278320507](https://github.com/1aboveio/pi-better-harness/actions/runs/36278320507) passed all four lanes, including real Linux sibling-control/credential and two-launch ancestor-replacement tests. Local SDK tests passed with an actual synthetic macOS Keychain item. Cold-cache MDS initialization is covered by source analysis and policy tests, not by clearing a user's real cache.

Local durable replay evidence: task `bg_if8_muj03hry_49` (exit 0), `/tmp/sandbox-session-replay-results.json`, `/tmp/validate-three-sandbox-sessions.mts`. Per-run observations began at 23:08:21, 23:08:27, 23:08:33, 23:08:39, 23:08:45, 23:08:51, 23:08:57, 23:09:03, and 23:09:09 UTC.
