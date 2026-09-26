# Session error validation ledger

Status: evidence classified; post-fix replay pending. Mandatory before PR.

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
| FMM | `sa_muixwfy2_5`, `call_2Um`, `call_AkX`, `call_DTFe`, `call_9yQ`, `call_nJw`, `call_mK8` | Android build failures and explicit 60-second timeouts | Inspect redirected logs read-only; do not rerun builds or change product settings. Distinguish denied cache/temp writes, dependency availability, and timeout. |
| FMM | `sa_muixwcgu_4`, `call_NkH` | Playwright `headers[1].value: expected string, got number` | Concrete test/input failure, not sandbox permission failure. Original evidence suffices; no database-mutating replay. |
| FMM | `sa_muixwcgu_4`, `call_Mnq` | Integration tests expected `body.storeId`, received undefined; 2 failures/19 passes | Concrete application/test assertion. Do not mark recovered by unrelated successful sandbox probes. |
| FMM | `sa_muixwjdb_6`, `call_7T9` | Edit oldText matches twice | Correct editor ambiguity guard. Test unique edit separately; no product mutation. |
| FMM | `sa_muixwjdb_6`, `call_lav`, `call_VrJ` | Frontend tests fail with output redirected; missing wildcard input in combined command | Read redirected result for classification; avoid re-running active product tests. |
| FMM | `sa_muixwjdb_6`, `call_YMT` | Inventory generated successfully; later rg wildcard does not exist | Search invocation error; inventory mutation is not replayed. |
| A1 `01a0dfb8-46fe-73d4-8ed7-d9a4b127b289` | `sa_muixz4e3_1`, `call_G1J` | gh GraphQL 401 | Same Keychain regression; replay safe authenticated repository/issue read. |
| A1 | `sa_muixz4e3_1`, `call_IJjfm0xlMmb5qderwF0ZoFah` | rg over gateway/rule-engine/infra paths returns 2, output contains SQL test text | Search, not database execution. Confirm missing paths; read existing matches safely. |

No failures are marked resolved yet. Final replay must exercise the updated task executor with each recorded policy/root, protect original runtime artifacts, use disposable output names, and report expected denials separately from successful compatibility restores.
