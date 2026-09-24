# Agent catalog acceptance

Real-Pi evidence for GitHub #289 / DEV-23. This file is the coverage map. Machine-local transcripts stay in gitignored `.rush-results/` and `.acceptance-sandbox/`. A skipped test is not evidence, and a unit pass is not a missing acceptance criterion.

## What counts as instruction proof

T13, T14, and the workflow leg of T26 require a real coordinating model to turn a loaded instruction into `subagent_spawn` / `subagent_spawn_batch` arguments. The runtime then has to launch the child with those arguments.

The opt-in test `tests/catalog-real-pi.acceptance.test.mjs` does that with the Pi CLI (`--mode rpc`), this checkout's extension (`-e packages/pi-better-subagents/index.ts`), and `xai/grok-4.7` at high. The workflow text is the `implementer-model` skill, expanded by Pi's `/skill:name` command before the model call. The test does not prefill tool arguments and does not run a scripted provider that returns a canned tool call.

A passing resolver or `tool.execute()` test can show that the runtime does not scrape prose. That is required and not sufficient. Those tests are marked below as executable-path coverage, not as coordinator reasoning.

Isolated `PI_CODING_AGENT_DIR`, `TMPDIR`, and session files stay under `.acceptance-sandbox/` (gitignored). The built-in xAI catalog stops at grok-4.6, and the process `XAI_API_KEY` is rejected by the public xAI host. The test symlinks the existing `models.json` and `models-store.json` so the already configured xAI route and `grok-4.7` stay available. It does not copy those files, `auth.json`, or `settings.json` into the repository.

`/agents` create and Codex import confirmation use RPC `extension_ui_response` (`confirm` / `select`), which is the headless UI path documented in Pi's `docs/rpc.md`. `ctx.hasUI` is true in RPC mode. RPC does not mount the navigator (`mode === "tui"` is required). There is no `/subagents` command. The registered surfaces are `/agents`, the shared navigator provider, and `subagent_result`.

For the duration of the process only, the test writes `tierPolicy` and `maxConcurrent` into `packages/pi-better-subagents/config.json`, then restores the original bytes. That is how a real extension process loads tier candidates. It is not a permanent policy change.

## Command

```bash
PI_CATALOG_REAL_PI=1 node --test --test-timeout 780000 \
  packages/pi-better-subagents/tests/catalog-real-pi.acceptance.test.mjs
```

Without `PI_CATALOG_REAL_PI=1` the test skips and default `npm test` does not call a provider.

## Coverage audit

| ID | Executable-path tests (not coordinator reasoning) | Real Pi in this harness |
| --- | --- | --- |
| T01 | `catalog.test.mjs` six bundled defaults | `/agents list` must show all six role ids |
| T02 | `catalog.test.mjs` two agents, role unchanged | one personal create; not a second independent agent |
| T03 | `catalog-lifecycle.test.mjs` navigator detail fields | registered TUI detail/row hook for `sa_muff44v8_1`: name, role, model, effort, run id. Live list omits the expired foreign-parent run |
| T04 | `catalog-identity.test.mjs` concurrent numeric labels | one fresh registry numeric label; not a second process |
| T05 | identity + lifecycle alias collision | one `developer-checkout` label; collision suffix not repeated |
| T06 | lifecycle repeated runs / rename snapshot | not re-run here |
| T07 | `model-resolution.test.mjs` six defaults | not launched (would call gpt-6) |
| T08 | model-resolution precedence | not a separate real launch |
| T09 | model-resolution same-tier | real role `role.acceptance-same-tier` if the coordinator omits model |
| T10 | model-resolution foreground | real role `role.acceptance-foreground` if the coordinator omits model |
| T11 | model-resolution no child | not re-run against a dead foreground |
| T12 | model-resolution invocation provenance | legacy launch's structured model reaches argv and meta |
| T13 | lifecycle "does not read a quoted model" is runtime-only | skill model vs quoted `openai/gpt-6-astra@xhigh` |
| T14 | no unit test can supply the tool arguments | single and per-job batch through real delegation |
| T15 | model-resolution explicit unavailable | user `xai/grok-4.6@high` on the explorer job outranks the skill; unavailable-explicit path stays unit-only |
| T16 T33 | model-resolution effort | not re-run; no unsupported-effort real launch |
| T17 | model-resolution cross-provider candidate | real same-tier candidate is cross-provider `xai/grok-4.5` |
| T18 | catalog + agent-operations precedence | list/show only; duplicate and project shadow stay unit-only |
| T19 | lifecycle batch isolation | real batch metas must differ and share one snapshot digest |
| T20 T23 T27–T30 | catalog schema/store tests | not re-run on disk edits during the live session |
| T21 T31 T32 | codex-import + agent-operations | one RPC import with replace-mode confirm; re-import preview not repeated |
| T22 | lifecycle capacity, callback, stop | registered `subagent_result` on the preserved completed run returns `DONE`. Capacity, callback, and stop were not re-run |
| T24 | agent-operations capability note | not a second capability probe |
| T25 T35 | identity reload and atomic labels | preserved labels were read by the reload renderer. Snapshot immutability and the cross-process label race were not re-run |
| T26 | no single session covers every leg | preserved coordinator session did discovery, create, inspect, import confirm, named launch, direct role, fallbacks, and legacy. Reload adds navigator detail and `subagent_result`. Live overlay pixels for the expired run are not produced |
| T34 T36 | operations + lifecycle | not re-run in this process |

`sandbox:false` and `callback:false` are explicit tool arguments in the delegation task so completion is read from the run directory. They are not a runtime change.

`ps` is blocked in this environment (`EPERM`), so the harness prepends a `pi` on `PATH` that appends the child argument vector to `argv.jsonl` and `exec`s the real Pi binary. That log is the spawn argv. It is not a model and it does not choose tool arguments.

Parallel tool calls used to `import()` `catalog-identity.ts` while Pi executed `subagent_spawn` and `subagent_spawn_batch` together. Under Pi's loader that race threw `Cannot read properties of undefined (reading 'baseDir')` inside `resolveCatalogRegistryRoot`, and reject mode then dropped the rest of the batch. `catalog-runtime.ts` now imports `allocateCatalogLabel` when the extension loads, before any tool runs. `tests/catalog-static-identity-import.test.mjs` fails if that function body grows a dynamic `import()`.

## Preserved launch and navigator reload

The paid coordinator run is not repeated. Its sandbox is `.acceptance-sandbox/2026-09-24T10-57-01-240Z`. `sa_muff44v8_1` is the completed named agent `Acceptance Dev` (`role.developer`, `xai/grok-4.5`, effort `low`). The local `.rush-results/acceptance.json` transcript is untracked.

`tests/catalog-navigator-reload.acceptance.test.mjs` reloads that registry in a real Pi TUI (`pi` v0.87.0 on a pty, `--model xai/grok-4.7 --thinking high`, no prompt and no new child). The extension publishes its registered `subagent_result` object and `renderRegisteredWorkDetail` only when `PI_CATALOG_ACCEPTANCE_PROBE=1`. The probe calls those hooks after `session_start`. It does not read `meta.json` itself.

```bash
PI_CATALOG_NAVIGATOR_RELOAD=1 node --import tsx --test --test-timeout 120000 \
  packages/pi-better-subagents/tests/catalog-navigator-reload.acceptance.test.mjs
```

The registered detail lines show `Acceptance Dev`, `role.developer`, `grok-4.5 · effort low`, run id `sa_muff44v8_1`, status `completed`, and transcript `DONE`. The same process's `subagent_result` returns `[sa_muff44v8_1 · completed · exit 0 …]` and `DONE`. The live list is empty: `navigatorVisibleRuns` keeps `spawnPid === process.pid`, terminal rows expire after 30 seconds, and the section is hidden unless a row is running. The original parent pid is dead, so the on-screen list does not contain this run. The row formatter still renders the detail payload inside that Pi process. That is not a screenshot of an overlay that the list refused to open.
