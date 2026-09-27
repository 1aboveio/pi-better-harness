# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **subagents**: the harness now times every run. A soft deadline (default 30 min) steers the child to stop starting new work, commit what is done, and report, and wakes the parent once; grace (default 5 min) starts when that message reaches the child, after its current tool call, so a test run started just before the deadline is not killed mid-run; an unfinished run is then stopped and its completion reports `stopped: deadline`. A hard ceiling (default 90 min) stops without grace (`stopped: ceiling`), also for orphaned runs. No progress for 10 min (progress = any successful tool call that is not an exact repeat of an earlier one, by tool name and normalized arguments; edits, writes, commits, and a success after a failure always count; time inside a running tool call does not count) wakes the parent once (`stuck`) without stopping the run. `subagent_spawn` and `subagent_spawn_batch` accept `deadline_minutes`, `grace_minutes`, `max_minutes`, and `stuck_minutes` (0 = off; null = inherit: shared in a batch, then the default); global defaults come from `PI_SUBAGENT_*_MINUTES` or `config.json`. The policy lives in run metadata, so `/reload` keeps it. The reason shows on list, output, result, and completion callbacks.
- **sandbox**: Project files and Outside project gain a **Write** level: read, create, and overwrite in place, but nothing removed or renamed away. The former Read / write is now labelled **Write & delete**, and saved `read-write` values keep that meaning. Removal is always allowed in temp, hidden home entries, and git worktree folders (`.worktrees/`, `*-worktrees/`).
  - Outside project = Write writes across home and temp behind one fixed deny list. Credential files, plus `~/Library/Keychains`, Claude and Codex auth, `~/.gnupg`, cargo credentials, `~/.pgpass` and rclone, are unreadable and unwritable.
  - Code that runs later can't be written, removed, or renamed: shell startup files, `~/.pi`, `~/.claude`, `~/.agents`, `~/Library/LaunchAgents`, git config and templates, `~/.local/bin`, `~/bin`, oh-my-zsh custom, gradle init scripts, and cargo config. Harness state stays protected. Git config and hooks inside repositories are deliberately not protected, so `git init`, `git clone`, and `git worktree add` work.
  - Entries are guarded under their literal path, every symlink hop, and their target, so symlinked dotfiles (including chains of links) can't be swapped out or retargeted.
  - macOS enforces this with Seatbelt `file-write-unlink`. Linux uses a Bubblewrap fallback that keeps ordinary top-level home folders read-only, and refuses Project files = Write.
  - In `/sandbox`, a looser value applies only on a second Space, and saving looser defaults needs a second Enter. See ADR 0008. (#341)
- **sandbox**: on macOS, a confined subagent or background task launched with Outside project = Write or Write & delete starts an APFS local snapshot (`tmutil localsnapshot`) in the background, at most one per 15 minutes. A failure is reported and never blocks the run. `PI_SANDBOX_RECOVERY_SNAPSHOT=off` disables it. (#341)
- **background-tasks**: confined local tasks accept the Write levels from Main's profile and take the macOS recovery snapshot for Outside project = Write or Write & delete. (#341)
- **subagents**: add adjustable `manual`, `adaptive`, and `coordinator` delegation modes, session-persisted `/subagents mode ...` overrides, role-first coordinator guidance, and explicit ownership boundaries for bundled roles. Generic plans now follow the active delegation mode. (#334)

### Changed

- **subagents**: the default Subagents profile is Outside project = Write, so tool caches such as `~/.gradle` work with no per-tool configuration while sibling repositories cannot be removed or moved. Set Outside project to Read (strict) or Write & delete in `/sandbox` to opt out. (#341)
- **subagents**: the navigator detail view opens showing up to the latest 25 transcript rows (was 10); `l` switches between 25 and 10. The metadata lines always stay visible, and on a short terminal the transcript shows as many newest rows as fit below them (previously metadata gave way to the transcript). `subagent_result` and `subagent_output` defaults are unchanged.
- **background-tasks**: the navigator detail view opens showing up to the latest 25 log rows (was 10); `l` switches between 25 and 10. The metadata lines always stay visible, and on a short terminal the log shows as many newest rows as fit below them. `bg_task_log` and `bg_task_status` defaults are unchanged.

### Fixed

- **background-tasks**: a navigator log tail taller than the terminal now drops its oldest rows instead of cutting off the newest ones.

## [pi-better-harness@0.7.0] - 2026-09-27

### Changed

- Bundle subagents 0.6.0, background-tasks 0.4.0, and plan 0.4.0: `update_plan` writes the bound Rush workflow plan; failure output lists only what needs action and keeps history on request; aligned output parameters; mutation ownership; completions survive `/reload`; null intent fields no longer hide real failures.

## [pi-better-subagents@0.6.0] - 2026-09-27

### Added

- `subagent_result` accepts `lines`, an optional per-page line cap for the answer; `nextCursor` continues after the last line shown. (#321)
- `subagent_output` and `subagent_result` accept `include: ["cost", "tools"]` to add one token/cost spend line and one tool-call count line (with the distinct tool names). Ordinary payloads still omit both. (#321)
- `subagent_result`, `subagent_output`, `bg_task_status`, and the `bg_task`/`bg_status` `action:status` wrappers accept `history: true`, which returns an incident page listing failure history (unclassified tool errors, expected failures, recovered and superseded incidents) as well as what needs action. The page's `nextCursor` stays in the history view.

### Changed

- Only failures that need action are "active": `Action required` incidents (non-tool failures, a tool operation failing three times, incidents disposed `open`) and observation gaps. Unclassified tool errors and expected failures are history: counted, never listed or paged by default. When nothing needs action, result, output, and status say so in one line (`No failures need action · 8 unclassified tool errors · 2 expected (history)`) with no `incidentCursor`; the active count, `shown`/`omitted`, and the incident cursor cover actionable incidents only. List rows and list lead-ins count only what needs action. Completion callbacks keep their once-only counts.
- Incident rows are compact on every surface (result, output, list, callbacks, status, log). A tool error stored as its result JSON (`{"content":[{"type":"text","text":…`) is shown as its text, the excerpt is capped at 120 UTF-8 bytes on a code-point boundary, and evidence is shortened to the log name and offset (`output.log#byte=N`). `mode: "raw"` (`subagent_output`/`subagent_result`) and raw background logs show the journal summary verbatim with the full evidence path; the failure journal is unchanged. Incident cursors issued before this change reset once with `reset=stale-cursor`. Background-task completion callbacks carry the same history count line.
- New child tool errors are recorded with the tool's text instead of its JSON result wrapper.
- Output-control parameters use one spelling across both tool families: `max_bytes` and `lines`. Byte budgets, hard caps, and defaults are unchanged. (#321)
- Completion callback rows no longer clip the `status` field to 80 bytes with an ellipsis. Background-task rows carry the lifecycle status plus an attention count (`failed; 2 incidents need attention`); the incident text stays on its own rows with exact counts. Any status longer than 160 bytes keeps whole `; `-separated notes and says how many it left out. (#323)
- `subagent_list` caches each run's incident counts and recomputes only runs whose child log or failure journal changed, so a list call no longer rescans every matching run. (#323)
- Structured intent and `failure_disposition` are honoured only when a parent-authored provenance record exists alongside `meta.taskRuntime`. The record is written before the child starts, outside every run directory, under the registry root the task runtime denies to the child, so a child that could rewrite its own metadata cannot claim the trusted runtime. Unconfined children keep the exact-retry rule by design: the parent cannot trust anything an unconfined child can rewrite (#325)
- The confined child checks `attemptId` reuse and validates dispositions against its whole session record (every branch), matching the parent's whole-log scan. After a branch switch or compaction a reuse the parent sees is always one the child refused, so a command that really ran and failed is never filed as a non-escalating `rejected-intent` (#325)
- After an orphaned or lost run's health callback, observation gaps are delivered promptly (once) instead of waiting for a callback that may never come (#325)
- The provenance record is removed on every run-removal path (age and size sweeps, including runs with unreadable metadata) and records whose run is gone are swept. A launch whose spawn fails removes its run directory, provenance, and task scratch (#325)

### Deprecated

- `maxBytes` is deprecated in favor of `max_bytes` on `subagent_list`, `subagent_output`, and `subagent_result`; it still works, and `max_bytes` wins when both are given. (#321)
- `tail_lines` is deprecated in favor of `lines` on `bg_task_log`, `bg_task`, `bg_status`, `subagent_output`, and `subagent_result`; `maxBytes` is likewise accepted on the background tools as an alias of `max_bytes`. Both still work, and the canonical name wins when both are given. (#321)

### Fixed

- A transient failure reading a run's metadata no longer pins its failure scan to the exact-retry rule. The scan waits for trust to be readable, for at most 30 seconds or until the run ends; after that the log is scanned under the exact-retry rule so real failures stay visible, with an `Observation incomplete` note that the metadata could not be read (#325)
- The terminal failure summary never exceeds its byte budget and is made of whole lines. Under a tight budget incident rows are dropped first, then lower-priority notes and the count line; the "Work correctness was not inferred from lifecycle alone." note is kept whenever it fits and never cut mid-sentence (#325)
- A confined child's `bash` call that sent optional intent fields as explicit `null` (for example `"expectedExitCodes": null`, as openai/gpt-5.6-sol does on nearly every call) ran, but the parent's replay filed its real failure as `rejected-intent` ("bash not run: invalid command intent"), which never escalates, so repeated real failures were hidden. `null` now means "not declared" in the shared intent validator and in the `bash` intent schema, so Pi hands `execute` the same raw arguments the log records. The parent files `rejected-intent` only when the child's tool result is its own pre-run refusal (or Pi's schema refusal of intent fields), never by re-validating the logged arguments; a command that ran and failed is always an ordinary failure under the escalation rules. Journals written by harness 0.6.x may still show real failures as "not run: invalid command intent"; those records are not rewritten (no migration: read them as possibly-real failures and check the run log at the cited byte offset)

## [pi-better-background-tasks@0.4.0] - 2026-09-27

### Added

- `bg_task`/`bg_status` `action:clear` with `id` dismisses that one terminal task. (#322)
- `bg_task_spawn`, `bg_task_watch`, and the `bg_task` wrapper accept `operation_id` and `expected_exit_codes`, validated before launch by the same validator as the subagent task runtime's `bash` (a malformed declaration starts nothing). A declared exit code is recorded as an `Expected failure`, not an incident needing action; signals and timeouts never are. A later task with the same `operation_id` (same kind, cwd, SSH target, and owner: the same session id, or for sessionless tasks the same Pi process) that succeeds recovers the earlier task's unresolved failures, so a retry with a changed command or timeout closes the original incident (#325)
- `subagent_result`, `subagent_output`, `bg_task_status`, and the `bg_task`/`bg_status` `action:status` wrappers accept `history: true`, which returns an incident page listing failure history (unclassified tool errors, expected failures, recovered and superseded incidents) as well as what needs action. The page's `nextCursor` stays in the history view.

### Changed

- Only failures that need action are "active": `Action required` incidents (non-tool failures, a tool operation failing three times, incidents disposed `open`) and observation gaps. Unclassified tool errors and expected failures are history: counted, never listed or paged by default. When nothing needs action, result, output, and status say so in one line (`No failures need action · 8 unclassified tool errors · 2 expected (history)`) with no `incidentCursor`; the active count, `shown`/`omitted`, and the incident cursor cover actionable incidents only. List rows and list lead-ins count only what needs action. Completion callbacks keep their once-only counts.
- Incident rows are compact on every surface (result, output, list, callbacks, status, log). A tool error stored as its result JSON (`{"content":[{"type":"text","text":…`) is shown as its text, the excerpt is capped at 120 UTF-8 bytes on a code-point boundary, and evidence is shortened to the log name and offset (`output.log#byte=N`). `mode: "raw"` (`subagent_output`/`subagent_result`) and raw background logs show the journal summary verbatim with the full evidence path; the failure journal is unchanged. Incident cursors issued before this change reset once with `reset=stale-cursor`. Background-task completion callbacks carry the same history count line.
- Output-control parameters use one spelling across both tool families: `max_bytes` and `lines`. Byte budgets, hard caps, and defaults are unchanged. (#321)
- Stop and clear use the same session ownership rule as reads. `bg_task_stop` and `action:stop` refuse a task owned by another session or whose ownership cannot be verified unless `all:true` is passed; clearing by id works the same way. Bulk `action:clear` dismisses only tasks the current session owns and never crosses sessions (even with `all:true`); a sessionless caller is told how many same-cwd terminal tasks it skipped because their ownership could not be verified. (#322)
- A raw log `nextCursor` passed to `bg_task_status` continues the raw log page, and a verbose-metadata cursor continues verbose pages, instead of resetting as a stale status cursor. (#323)
- Completion callback rows no longer clip the `status` field to 80 bytes with an ellipsis. Background-task rows carry the lifecycle status plus an attention count (`failed; 2 incidents need attention`); the incident text stays on its own rows with exact counts. Any status longer than 160 bytes keeps whole `; `-separated notes and says how many it left out. (#323)
- Page and status cursors issued by 0.3.x (bundled in harness 0.6.x) reset once after upgrading, with a clean `reset=stale-cursor`, because the cursor scope key is now the shared `session:<hex24>` form. Request the page again without the cursor. (#323)
- The `env` and `ssh.options` parameters of `bg_task_spawn`, `bg_task_watch`, and `bg_task` are declared as plain string maps (`additionalProperties`) instead of `Type.Record`; accepted values are unchanged. A test runs the provider-schema check over every background-task tool schema and the subagent list/output/result/stop schemas.
- Resume is per session. After `/new`, `/resume`, fork, or a session switch, the previous session's tasks keep running, but their watches, remote output collection, and `timeout_seconds` deadlines pause until that session is active again; an overdue deadline is enforced on resume. (#324)

### Deprecated

- `tail_lines` is deprecated in favor of `lines` on `bg_task_log`, `bg_task`, `bg_status`, `subagent_output`, and `subagent_result`; `maxBytes` is likewise accepted on the background tools as an alias of `max_bytes`. Both still work, and the canonical name wins when both are given. (#321)

### Fixed

- The terminal failure summary never exceeds its byte budget and is made of whole lines. Under a tight budget incident rows are dropped first, then lower-priority notes and the count line; the "Work correctness was not inferred from lifecycle alone." note is kept whenever it fits and never cut mid-sentence (#325)
- Completion callbacks are no longer lost across `/reload`. Before, the unloaded extension instance kept running watch and poll timers and child exit handlers with no active session; when a task finished there, its callback was durably suppressed as "active session identity is unavailable". Session shutdown now stops that instance's timers and it never notifies; work already in flight (a child exit, a remote tmux start, a timeout kill) only records its result, and the resuming instance delivers the callback once. A same-process task whose exit nobody records is marked lost after a 5 s grace period instead of immediately. (#324)
- `bg_task_spawn`, `bg_task_watch`, and `bg_task` accept `operation_id: null` and `expected_exit_codes: null` as "not declared" and launch the task normally, instead of refusing it as a malformed intent (or, on Pi 0.82, failing schema validation)

## [pi-better-plan@0.4.0] - 2026-09-27

### Added

- While `rush-issues` owns the plan and a run is bound with `sync_workflow_plan`, `update_plan` accepts a `workflow` transition instead of `plan`. It sets fields on units, components, fleet stages, and run-level fields by id, can add new unit and component rows for a mid-run scope change, can append a `decisions` entry, and saves them as one revision: the task plan is replaced atomically with `planRevision + 1` and a new `updatedAt`, and one profiling event with the same revision is appended to the run's existing log (`profiling/run.jsonl` or `profiling.jsonl`). Unknown or duplicate ids, unknown or cyclic dependencies, invalid worker slots, off-contract status/stage values (fleet `n/a` is saved as `not-applicable`), and a stale expected `revision` are refused without writing. If a crash leaves the profiling log one revision ahead of the plan, the next event says so with `logAheadRevision`. The generic checklist is unchanged when no workflow owns the plan.

## [pi-better-harness@0.6.1] - 2026-09-27

### Fixed

- Bundle subagents 0.5.1, which fixes OpenAI-backed confined subagents failing on their first request.

## [pi-better-subagents@0.5.1] - 2026-09-27

### Fixed

- Confined children's `bash` schema no longer uses `uniqueItems` on `expectedExitCodes`. OpenAI rejects that keyword (`400 invalid_function_parameters`), so every OpenAI-backed confined subagent failed on its first request in 0.5.0. Distinct codes are still enforced when the intent is validated, and a test now checks every child-facing tool schema for provider-rejected keywords (#327).

## [pi-better-harness@0.6.0] - 2026-09-27

### Changed

- Bundle subagents 0.5.0, background-tasks 0.3.0, goal 0.4.1, and sandbox 0.5.3: bounded, paged tool output scoped to the current session (#312); failure incidents separated from history, with child tool errors no longer waking the parent (#315); goals resuming after an interrupt and alias-started workflows binding their coordinator (#317, #318).

## [pi-better-subagents@0.5.0] - 2026-09-27

### Added

- Append-only incident dispositions (`recovered`, `superseded`, `expected`, `open`) that name incidents, a reason, and evidence, and fail closed on unknown, already-disposed, or evidence-free requests. (#315)
- Sandboxed children's `bash` accepts `operationId`, `attemptId`, and `expectedExitCodes`, validated before the command runs, and children get a `failure_disposition` tool. The parent re-validates each disposition from the child's log before journaling it. (#315)

### Changed

- Model-facing tool output is bounded by UTF-8 byte budgets that cover the whole response: status, log excerpts, and lists 1 KiB (10 rows/lines); subagent answer pages and callback batches 2 KiB; explicit raw evidence pages 16 KiB. Callers can ask for larger pages up to hard caps (status 2 KiB, log/list 4 KiB, answer/callback 8 KiB, raw 64 KiB) with `maxBytes` (subagents) or `max_bytes` (background tasks). (#312)
- Long answers, logs, lists, incidents, and verbose metadata are paged instead of truncated. Responses carry `nextCursor` to continue, `statusCursor` for a small "no new evidence" reply until something changes (failure-only changes are reported), and `incidentCursor` for omitted failure incidents; pass any of them back as `cursor`. Raw pages end with an append-ready cursor. New parameters: `cursor` and `maxBytes` on `subagent_list`/`subagent_output`/`subagent_result`, `lines` on `subagent_output`, `mode: "raw"` on `subagent_output`/`subagent_result`; `cursor`, `max_bytes`, `all`, `raw` on the background list/status/log tools and wrappers. (#312)
- List, status, output, result, and log default to the current session. Pass `all:true` to read another session's runs or tasks. When ownership cannot be verified (session identity unreadable, or a legacy record without an origin) the response is an ownership gap, never evidence and never "not found". (#312)
- Ordinary results, lists, and callbacks no longer include ordered tool-name histories or default token/cost lines. `subagent_list` defaults to 10 rows (was 20); `bg_task_log` defaults to a 10-row tail (was 5) and `tail_lines: 0` now pages raw bytes instead of returning up to 512 KiB. (#312)
- A live child's individual tool errors no longer wake the parent. Running attention is limited to non-tool failures, an operation that failed three times with no recovery, and incidents the child marks `open`, each delivered once; observation gaps ride the completion or health callback. Unresolved incidents are reported once in the completion callback, with unclassified tool failures as a count and lifecycle stated separately. (#315)
- Failure notifications render only their pending incidents; earlier deliveries are counted, not repeated. (#315)
- Shared failure observations use distinct labels: `Action required`, `Unclassified failure observation`, `Expected failure`, and `Observation incomplete`. Recovered and superseded incidents stay in history and leave active summaries. (#315)

### Fixed

- Missing or corrupt metadata, missing logs, capture overflow, and log retention are reported as explicit gaps instead of empty or healthy results; final answers keep their whitespace; completion and urgent callbacks count exactly which failure incidents they show. (#312)

## [pi-better-background-tasks@0.3.0] - 2026-09-27

### Added

- Append-only incident dispositions (`recovered`, `superseded`, `expected`, `open`) that name incidents, a reason, and evidence, and fail closed on unknown, already-disposed, or evidence-free requests. (#315)

### Changed

- Model-facing tool output is bounded by UTF-8 byte budgets that cover the whole response: status, log excerpts, and lists 1 KiB (10 rows/lines); subagent answer pages and callback batches 2 KiB; explicit raw evidence pages 16 KiB. Callers can ask for larger pages up to hard caps (status 2 KiB, log/list 4 KiB, answer/callback 8 KiB, raw 64 KiB) with `maxBytes` (subagents) or `max_bytes` (background tasks). (#312)
- Long answers, logs, lists, incidents, and verbose metadata are paged instead of truncated. Responses carry `nextCursor` to continue, `statusCursor` for a small "no new evidence" reply until something changes (failure-only changes are reported), and `incidentCursor` for omitted failure incidents; pass any of them back as `cursor`. Raw pages end with an append-ready cursor. New parameters: `cursor` and `maxBytes` on `subagent_list`/`subagent_output`/`subagent_result`, `lines` on `subagent_output`, `mode: "raw"` on `subagent_output`/`subagent_result`; `cursor`, `max_bytes`, `all`, `raw` on the background list/status/log tools and wrappers. (#312)
- List, status, output, result, and log default to the current session. Pass `all:true` to read another session's runs or tasks. When ownership cannot be verified (session identity unreadable, or a legacy record without an origin) the response is an ownership gap, never evidence and never "not found". (#312)
- Ordinary results, lists, and callbacks no longer include ordered tool-name histories or default token/cost lines. `subagent_list` defaults to 10 rows (was 20); `bg_task_log` defaults to a 10-row tail (was 5) and `tail_lines: 0` now pages raw bytes instead of returning up to 512 KiB. (#312)
- Failure notifications render only their pending incidents; earlier deliveries are counted, not repeated. (#315)
- Shared failure observations use distinct labels: `Action required`, `Unclassified failure observation`, `Expected failure`, and `Observation incomplete`. Recovered and superseded incidents stay in history and leave active summaries. (#315)

### Fixed

- Missing or corrupt metadata, missing logs, capture overflow, and log retention are reported as explicit gaps instead of empty or healthy results; final answers keep their whitespace; completion and urgent callbacks count exactly which failure incidents they show. (#312)

## [pi-better-goal@0.4.1] - 2026-09-27

### Fixed

- An `escape` interrupt no longer leaves an active goal paused indefinitely. It is now a soft pause (`pauseReason: "interrupt"`): the next conversational message reactivates the goal, and automatic continuation resumes once that exchange settles. `/goal pause` and pauses for an unavailable command or workflow stay sticky until `/goal resume`; completed and budget-limited goals are unaffected. Previously a long orchestrator run sat idle after the user interrupted to ask a question, until the skill was re-invoked.
- Background work that finishes while a blocking `ask_user_question` is pending is now steered to the agent right after the answer, instead of waiting behind the follow-up callback batch until the whole run ends. The prompt context also warns the agent, while background work runs, that a blocking question holds completions.
- A skill alias declaring `metadata.workflow-alias-of: <coordinator>` now binds its target coordinator as the workflow owner. Previously `/skill:resolve-issues` (an alias of `rush-issues`) recorded no owner, so `sync_workflow_plan` refused with "Only an active rush-issues workflow can sync its plan.".

## [pi-better-sandbox@0.5.3] - 2026-09-27

### Changed

- Synchronize the shared task-sandbox core, which adds an optional `bashDefinition` hook used by subagents for structured command intent (#315).

## [pi-better-harness@0.5.2] - 2026-09-27

### Fixed

- Bundle sandbox 0.5.2, subagents 0.4.2, and background-tasks 0.2.20 with Linux fail-closed protection for denied paths that cannot be materialized.

### Tests

- Require five real SDK compatibility golden paths on macOS and Linux, including isolated Keychain and Secret Service retrieval, with uploaded ALIVE/DEAD evidence.

## [pi-better-sandbox@0.5.2] - 2026-09-27

### Fixed

- Refuse Linux task launch when a required guard cannot be established, including denied children beneath replaceable regular files.

## [pi-better-subagents@0.4.2] - 2026-09-27

### Fixed

- Synchronize Linux fail-closed guard handling in the shared sandbox core.

## [pi-better-background-tasks@0.2.20] - 2026-09-27

### Fixed

- Synchronize Linux fail-closed guard handling for both legacy and permission-profile launches.

## [pi-better-harness@0.5.1] - 2026-09-27

### Fixed

- Bundle sandbox `0.5.1`, subagents `0.4.1`, and background-tasks `0.2.19` for restored default temporary-file and macOS Keychain compatibility.

## [pi-better-sandbox@0.5.1] - 2026-09-27

### Fixed

- Restore explicit runtime access to `/tmp`, the current user's macOS temporary directory, and its Security.framework MDS cache when Outside is Read or Read/write. Keychain-backed CLI authentication can initialize and refresh its runtime state without a global lock-file or home-directory allowance.
- Preserve credential/control denials, stricter project permissions, and runtime symlink protection under the restored temporary-directory grants.

## [pi-better-subagents@0.4.1] - 2026-09-27

### Fixed

- Apply the shared runtime compatibility policy to guarded task tools, restoring literal temporary-log writes and macOS Keychain-backed GitHub authentication.
- Reject runtime aliases under newly writable temporary paths; protect Linux project ancestors against replacement between task launches.

## [pi-better-background-tasks@0.2.19] - 2026-09-27

### Fixed

- Synchronize the shared sandbox core, including mount ordering that prevents sibling protections from being hidden by later ancestor binds.

## [pi-better-harness@0.5.0] - 2026-09-27

### Changed

- Bundle `pi-better-sandbox@0.5.0`, `pi-better-subagents@0.4.0`, and `pi-better-background-tasks@0.2.18` to separate trusted Pi startup from kernel-confined task execution.
- Enabled actor profiles now reject tool implementations without a verified execution adapter. Main remains Off by default.

## [pi-better-sandbox@0.5.0] - 2026-09-27

### Changed

- Run read/write/edit filesystem operations in fixed kernel-confined workers, preserving SDK tool behavior while closing symlink-check races.
- Verify guarded tool implementations and reject unknown extension execution under enabled profiles. Currently supported task tools are read, write, edit, and bash; SSH, MCP, background, and nested-agent tools require future adapters.
- Protect runtime configuration/code and provide private task scratch space without granting writes to the rest of the system temporary directory. Confined file operations have an explicit 8 MiB limit.

## [pi-better-subagents@0.4.0] - 2026-09-27

### Fixed

- Allow Pi settings/authentication locks, provider transport, and session persistence to run in a trusted runtime while task access to outside paths, including `~/.pi`, remains Read by default.

### Changed

- Start confined children through a mandatory guard and immutable permission snapshot. Missing backends, invalid guard initialization, inherited extension discovery, and unsupported runtimes fail closed.
- Apply Commands Off and Network Off to task operations without disabling Pi startup or its provider connection. Require Pi SDK 0.82.1 or newer.
- Load only admitted task dependencies and trusted provider dependencies. Report requested tools without adapters as unavailable, and keep task workspaces separate from protected runtime metadata.

## [pi-better-background-tasks@0.2.18] - 2026-09-27

### Fixed

- Synchronize shared Linux confinement support so protected leaves remain read-only inside explicitly writable runtime directories.

## [pi-better-harness@0.4.0] - 2026-09-27

### Changed

- Bundle `pi-better-sandbox@0.4.0`, `pi-better-subagents@0.3.0`, and `pi-better-background-tasks@0.2.17` for independent permission profiles and durable failure reporting.

## [pi-better-sandbox@0.4.0] - 2026-09-27

### Added

- Configure independent Main and Subagents permission profiles in the flat `/sandbox` table, with saved defaults and retained inactive values.
- Enforce project and outside file modes, credential-file overrides, command gates, and network restrictions on integrated execution surfaces.

## [pi-better-subagents@0.3.0] - 2026-09-27

### Added

- Snapshot human permission profiles at launch and reserve private runtime directories; reject tool opt-outs that bypass enabled profiles.
- Keep structured failure observations separate from lifecycle status and show them before stale assistant progress. Recovery requires a later matching retry.

### Fixed

- Retry notification handoffs and receipt writes without suppressing alerts on temporary read errors or repeatedly sending an already handed-off event.
- Retain pending evidence on failed writes and report missing, truncated, or corrupt observations explicitly.

## [pi-better-background-tasks@0.2.17] - 2026-09-27

### Fixed

- Reject invalid watcher JSON paths before launch; keep evaluator errors visible and withhold success while failure detection is incomplete.
- Retain structured failure observations and matching recovery across task reporting surfaces, and replay undelivered terminal callbacks on session startup.
- Retry evidence and delivery-receipt writes, defer unreadable callback state, and prevent repeated handoffs while receipt persistence is unavailable.

### Changed

- Inherit Main permissions for local launches and reject structured SSH when its client cannot apply those restrictions.

## [pi-better-plan@0.3.5] - 2026-09-25

### Fixed

- **plan**: remove the empty row between the heading or workflow metadata and the steps, preserving spacing between widgets

## [pi-better-harness@0.3.20] - 2026-09-25

### Changed

- **harness**: bundle `pi-better-plan@0.3.5` with compact heading-to-step spacing

## [pi-better-subagents@0.2.0] - 2026-09-25

### Added

- **subagents**: discover six bundled specialist roles, create named agents with live role inheritance, and inspect current model, effort, capabilities, and launchability through `/agents` and `agents_catalog`
- **subagents**: import Codex agent definitions explicitly with secret redaction, restriction checks, and replacement previews
- **subagents**: preserve coherent launch identity and configuration snapshots across concurrent writers, process crashes, and reloads

## [pi-better-background-tasks@0.2.16] - 2026-09-25

### Changed

- **background-tasks**: include the shared navigator detail-inspection helper used by agent catalog acceptance checks

## [pi-better-harness@0.3.19] - 2026-09-25

### Changed

- **harness**: bundle `pi-better-subagents@0.2.0` and `pi-better-background-tasks@0.2.16`, including the catalog's TOML runtime dependency

## [pi-better-plan@0.3.4] - 2026-09-23

### Changed

- **plan**: unify native and workflow-synced plans with a shared heading, progress summary, aligned rows, semantic status colors, and section spacing
- **plan**: show workflow revision and fleet progress as secondary metadata, preserving stage, worker, dependencies, and notes in the full view
- **plan**: use consistent selection and keyboard navigation in both full plan views

### Fixed

- **plan**: distinguish failed, skipped, and unknown workflow states from active work, and count diagnosing work as active
- **plan**: fit status labels and Unicode titles within narrow terminal widths

## [pi-better-harness@0.3.18] - 2026-09-23

### Changed

- **harness**: bundle `pi-better-plan@0.3.4` with unified native and workflow plan styling

## [pi-better-subagents@0.1.31] - 2026-09-23

### Fixed

- **subagents**: separate the passive navigator from the plan with a blank line
- **subagents**: fit CJK titles and wrap Unicode log text without losing content or exceeding terminal width

## [pi-better-background-tasks@0.2.15] - 2026-09-23

### Fixed

- **background-tasks**: separate the passive navigator from the plan with a blank line
- **background-tasks**: prevent navigator crashes for CJK titles and preserve Unicode log text when wrapping

## [pi-better-plan@0.3.3] - 2026-09-23

### Fixed

- **plan**: use consistent section spacing and themed headings for passive plans and Rush workflows

## [pi-better-harness@0.3.17] - 2026-09-23

### Changed

- **harness**: bundle `pi-better-subagents@0.1.31`, `pi-better-background-tasks@0.2.15`, and `pi-better-plan@0.3.3` with the widget spacing, heading styling, and Unicode navigator fixes

## [pi-better-plan@0.3.2] - 2026-09-23

### Fixed

- **plan**: keep the passive Rush workflow area hidden until a valid persisted task plan has been synced

## [pi-better-harness@0.3.16] - 2026-09-23

### Changed

- **harness**: bundle `pi-better-plan@0.3.2` with hidden unsynced Rush workflow state

## [pi-better-plan@0.3.1] - 2026-09-23

### Fixed

- **plan**: accept live Rush task plans that persist units under `units` and fleet states as strings while retaining compatibility with the original projection schema

## [pi-better-harness@0.3.15] - 2026-09-23

### Changed

- **harness**: bundle `pi-better-plan@0.3.1` with live Rush task-plan schema compatibility

## [pi-better-plan@0.3.0] - 2026-09-22

### Added

- **plan**: display persisted `rush-issues` fleet stages and actual units in the widget, `/plan`, and `get_plan` without taking workflow ownership

### Fixed

- **plan**: reject mismatched Rush revisions and prevent a new run from showing a previous run's plan

## [pi-better-harness@0.3.14] - 2026-09-22

### Changed

- **harness**: bundle `pi-better-plan@0.3.0` with the Rush workflow plan view and blocking TUI smoke coverage

## [pi-better-subagents@0.1.30] - 2026-09-22

### Fixed

- **subagents**: keep the structured transcript renderer when another extension registers the shared navigator, preserving the visible tail in the Pi TUI

## [pi-better-background-tasks@0.2.14] - 2026-09-22

### Fixed

- **background-tasks**: retain the subagent transcript renderer when both extensions register the shared navigator

## [pi-better-harness@0.3.13] - 2026-09-22

### Changed

- **harness**: bundle `pi-better-subagents@0.1.30` and `pi-better-background-tasks@0.2.14` with the transcript display fix and blocking TUI smoke check

## [pi-better-goal@0.4.0] - 2026-09-19

### Added

- **goal**: supervise resolved skill and prompt commands through kickoff and resumed turns, and support one-shot extension commands as goal objectives

### Changed

- **goal**: require Pi 0.84.4 or newer for command expansion and pause goals whose bound command is no longer available

## [pi-better-harness@0.3.12] - 2026-09-19

### Changed

- **harness**: bundle `pi-better-goal@0.4.0` with supervised skill and command objectives

## [pi-better-goal@0.3.1] - 2026-09-19

### Changed

- **goal**: accept harness-neutral `workflow-role: coordinator` skill metadata while preserving compatibility with existing workflow declarations

## [pi-better-plan@0.2.1] - 2026-09-19

### Changed

- **plan**: document the harness-neutral coordinator role for skill-owned planning

## [pi-better-harness@0.3.11] - 2026-09-19

### Changed

- **harness**: bundle `pi-better-goal@0.3.1` and `pi-better-plan@0.2.1`

## [pi-better-subagents@0.1.29] - 2026-09-19

### Changed

- **subagents**: align delegated-work guidance with concurrent foreground and delegated plan milestones

## [pi-better-goal@0.3.0] - 2026-09-19

### Added

- **goal**: recognize opt-in skill-owned coordinator workflows, restore their instructions on resumed turns, and release ownership after completion

### Fixed

- **goal**: reject slash-shaped goal objectives that would bypass skill activation and pause legacy slash-shaped goals on resume

## [pi-better-plan@0.2.0] - 2026-09-19

### Added

- **plan**: track independent in-progress milestones and optional dependency edges; defer the generic plan to opted-in skill workflows

### Changed

- **plan**: prompt an early delegation decision for substantial independent work

## [pi-better-harness@0.3.10] - 2026-09-19

### Changed

- **harness**: bundle `pi-better-subagents@0.1.29`, `pi-better-goal@0.3.0`, and `pi-better-plan@0.2.0`

## [pi-better-subagents@0.1.28] - 2026-09-17

### Fixed

- **subagents**: preserve the requested latest 10 or 25 transcript rows in constrained detail viewports

## [pi-better-background-tasks@0.2.13] - 2026-09-17

### Fixed

- **background-tasks**: reserve detail viewport space for rolling transcript rows before optional metadata

## [pi-better-harness@0.3.9] - 2026-09-17

### Changed

- **harness**: bundle `pi-better-subagents@0.1.28` and `pi-better-background-tasks@0.2.13` with corrected detail transcript tails

## [pi-better-goal@0.2.3] - 2026-09-14

### Fixed

- **goal**: pause an active goal immediately when Escape aborts the current turn, including interrupts during tool execution

## [pi-better-harness@0.3.8] - 2026-09-14

### Changed

- **harness**: bundle `pi-better-goal@0.2.3` with reliable pause-on-Escape behavior

## [pi-better-plan@0.1.5] - 2026-09-14

### Changed

- **plan**: guide the foreground model to use structured plans as coordinator milestones, delegate independent work early, and inspect delegated outcomes before verification or completion

## [pi-better-subagents@0.1.27] - 2026-09-14

### Changed

- **subagents**: coordinate launches with an active parent plan and fetch terminal results from completion or attention callbacks without polling

## [pi-better-background-tasks@0.2.12] - 2026-09-14

### Changed

- **background-tasks**: reserve durable tasks for long-running work and keep active plans synchronized with terminal background outcomes

## [pi-better-goal@0.2.2] - 2026-09-14

### Changed

- **goal**: keep plan verification and completion open until relevant delegated work is terminal, inspected, and integrated

## [pi-better-harness@0.3.7] - 2026-09-14

### Changed

- **harness**: bundle coordinated plan, subagent, background-task, and goal guidance from the new component patch releases

## [pi-better-plan@0.1.4] - 2026-09-12

### Fixed

- **plan**: keep completed plans visible for 30 seconds, then clear them durably across active, resumed, and branch-navigated sessions

## [pi-better-harness@0.3.6] - 2026-09-12

### Changed

- **harness**: bundle `pi-better-plan@0.1.4` with automatic completed-plan cleanup

## [pi-better-plan@0.1.3] - 2026-09-12

### Changed

- **plan**: remove the `→ plan` navigation hint and empty-editor right-arrow shortcut; `/plan` remains available for the full view

## [pi-better-background-tasks@0.2.11] - 2026-09-12

### Changed

- **background-tasks**: remove obsolete plan navigation composition from the shared background-work footer

## [pi-better-subagents@0.1.26] - 2026-09-12

### Changed

- **subagents**: remove obsolete plan navigation composition from the shared background-work footer

## [pi-better-harness@0.3.5] - 2026-09-12

### Changed

- **harness**: bundle the passive plan widget and background-work navigator cleanup from the new component patch releases

## [pi-better-plan@0.1.2] - 2026-09-12

### Added

- **plan**: publish persistent structured plan state, explicit checklist progress tools, branch-aware restoration, and empty-editor keyboard navigation as a standalone Pi package

### Changed

- **plan**: show the complete checklist and compose `→ plan · n/total` through the shared navigator while retaining a standalone status fallback
- **plan**: supersede the manually bootstrapped `0.1.1` package with a provenance-backed trusted-publisher release

## [pi-better-harness@0.3.4] - 2026-09-12

### Added

- **harness**: include `pi-better-plan@0.1.2` in the bundled extension set and standalone installer with `update_plan`, `get_plan`, and `/plan`

### Changed

- **harness**: require the plan shim and package entry point in CI, release tarball checks, and whole-session coverage

## [pi-better-harness@0.3.3] - 2026-09-12

### Added

- **harness**: include `pi-better-ssh@0.1.1` in the bundled extension set and standalone installer so short remote commands use `remote_bash`, `ssh_profile`, and `ssh_mux` by default

### Changed

- **harness**: require the SSH entry point and vendored shared SSH core in CI and release tarball checks while continuing to exclude the unpublished plan extension

## [pi-better-background-tasks@0.2.10] - 2026-09-09

### Fixed

- **background-tasks**: scope goal, navigator, resume, and clear paths to session-owned task indexes instead of repeatedly scanning the machine-wide registry
- **background-tasks**: reconcile abandoned local processes conservatively with process-start identity, daily locked maintenance, and seven-day terminal retention while preserving remote tmux tasks

### Changed

- **background-tasks**: cache owner snapshots behind directory revision checks and use an active-only index for resume, eliminating repeated metadata parsing on warm reads

## [pi-better-goal@0.2.1] - 2026-09-09

### Fixed

- **goal**: sleep the activity poll when no goal or owned work is active, wake from provider metadata events, and stop polling again after work drains

## [pi-better-subagents@0.1.25] - 2026-09-09

### Fixed

- **subagents**: scope navigator, health, capacity, callback recovery, and shutdown paths to parent- or session-owned indexes instead of rereading the global run registry

### Changed

- **subagents**: cache owner snapshots behind directory revision checks and maintain an active-only parent index for capacity checks

## [pi-better-harness@0.3.2] - 2026-09-09

### Changed

- **harness**: bundle background-tasks 0.2.10, goal 0.2.1, and subagents 0.1.25 with owner-scoped registry reads and event-driven idle behavior
- **harness**: keep the experimental plan workspace available for local development while excluding it from the npm harness bundle and installer until its standalone release is authorized

## [pi-better-subagents@0.1.24] - 2026-09-05

### Fixed

- **subagents**: render exactly one input bar in background-work detail overlays and cover the real Pi TUI navigation path with a regression test

## [pi-better-background-tasks@0.2.9] - 2026-09-05

### Fixed

- **background-tasks**: render exactly one input bar in background-work detail overlays and cover the real Pi TUI navigation path with a regression test

## [pi-better-harness@0.3.1] - 2026-09-05

### Changed

- **harness**: bundle subagents 0.1.24 and background-tasks 0.2.9 with the single-input detail overlay fix

## [pi-better-goal@0.2.0] - 2026-09-04

### Added

- **goal**: add selectable `/goal` action completions for pause, resume, clear, and complete with contextual descriptions while preserving free-form objectives

## [pi-better-sandbox@0.3.0] - 2026-09-04

### Changed

- **sandbox**: add contextual descriptions to the `/sandbox` activation, default, deny-rule, and rules-page completions

## [pi-better-harness@0.3.0] - 2026-09-04

### Changed

- **harness**: bundle goal 0.2.0 and sandbox 0.3.0

## [pi-better-subagents@0.1.23] - 2026-09-03

### Fixed

- **subagents**: stop serving stale background-work navigator contexts after session replacement and detach invalid contexts safely during teardown

## [pi-better-background-tasks@0.2.8] - 2026-09-03

### Fixed

- **background-tasks**: stop serving stale background-work navigator contexts after session replacement and detach invalid contexts safely during teardown
- **background-tasks**: validate Windows task-tree termination outcomes and preserve running state when termination cannot be confirmed
- **background-tasks**: preserve raw Windows argv across MSYS2 shells and close log descriptors when spawn marker writes fail

## [pi-better-harness@0.2.1] - 2026-09-03

### Changed

- **harness**: bundle subagents 0.1.23 and background-tasks 0.2.8

## [pi-better-sandbox@0.2.0] - 2026-09-02

### Added

- **sandbox**: add `/sandbox default on|off` to persist the foreground activation preference across sessions

### Changed

- **sandbox**: start foreground shell, write, edit, user-bash, and local background-task confinement inactive by default; explicit or persisted opt-in remains fail-closed, while subagent sandboxing remains default-on
- **sandbox**: distinguish available-but-inactive foreground status without breaking older background-task consumers

## [pi-better-background-tasks@0.2.7] - 2026-09-02

### Changed

- **background-tasks**: inherit the foreground sandbox's opt-in activation state for local tasks while preserving captured launch policy and fail-closed behavior after enablement

## [pi-better-harness@0.2.0] - 2026-09-02

### Changed

- **harness**: bundle sandbox 0.2.0 and background-tasks 0.2.7; foreground confinement is now opt-in while detached subagents remain sandboxed by default

## [pi-better-sandbox@0.1.1] - 2026-08-23

### Changed

- **sandbox**: republished through the release workflow so the package carries npm provenance; 0.1.0 was published by hand during a first-publish outage and has no attestation. No code changes from 0.1.0.

## [pi-better-ssh@0.1.1] - 2026-08-23

### Changed

- **ssh**: republished through the release workflow so the package carries npm provenance; 0.1.0 was published by hand during a first-publish outage and has no attestation. No code changes from 0.1.0.

## [pi-better-harness@0.1.27] - 2026-08-23

### Changed

- **harness**: bundle sandbox 0.1.1, the provenance-carrying republish of 0.1.0

## [pi-better-sandbox@0.1.0] - 2026-08-23

### Added

- **sandbox**: confine Pi's built-in `bash` tool and user-entered `!` / `!!` commands to the canonical launch directory with macOS Seatbelt or Linux Bubblewrap
- **sandbox**: confine Pi's built-in `write` and `edit` tools to the same policy while keeping Pi's schemas, renderers, result details, mutation queue, and cancellation
- **sandbox**: deny writes to `.git/hooks`, `.env`, and `.env.local` by default, and add `/sandbox deny list|add|remove|reset` plus the `/sandbox rules` editor over one validation and persistence path
- **sandbox**: add `/sandbox`, `/sandbox on`, and `/sandbox off` with a truthful footer for the enabled, disabled, unavailable, and failed states; `/sandbox off` needs interactive confirmation and is never model-callable
- **sandbox**: fail closed when the backend is missing or cannot be applied, and publish an immutable effective-policy snapshot on `pi.events` for first-party consumers

## [pi-better-harness@0.1.26] - 2026-08-23

### Added

- **harness**: load `pi-better-sandbox` by default and configure/remove it alongside the other components

### Changed

- **harness**: bundle sandbox 0.1.0, subagents 0.1.22, and background-tasks 0.2.6

## [pi-better-subagents@0.1.22] - 2026-08-23

### Changed

- **subagents**: run the OS write sandbox through the shared `sandbox-core` mechanism behind a thin policy adapter; tool parameters, default-on/explicit behaviour, and spawn lifecycle are unchanged

## [pi-better-background-tasks@0.2.6] - 2026-08-23

### Added

- **background-tasks**: confine locally launched tasks and watch polls to the foreground sandbox policy captured at launch, blocking a launch instead of running it unconfined when the backend is unavailable or failed; structured remote SSH tasks keep their existing remote semantics

## [pi-better-ssh@0.1.0] - 2026-08-22

### Added

- **ssh**: add synchronous `remote_bash` execution over safe reusable ControlMaster connections
- **ssh**: add session-scoped SSH profiles, mux status/stop controls, and an active-profile footer chip
- **ssh**: document SSH config Host aliases, safety defaults, and the short-sync versus durable-background split

### Changed

- **release**: make `pi-better-ssh` independently publishable while keeping it out of the harness meta bundle

## [pi-better-harness@0.1.25] - 2026-08-22

### Changed

- **harness**: bundle goal 0.1.22 (multiline objective rail flattening)

## [pi-better-goal@0.1.22] - 2026-08-22

### Fixed

- **goal**: flatten multiline objectives on the above-editor rail so dock height stays stable and Working... / Elapsed no longer stack into scrollback

## [pi-better-harness@0.1.24] - 2026-08-21

### Changed

- **harness**: bundle background-tasks 0.2.5 (default `bg_task_log` tail 5 lines)

## [pi-better-background-tasks@0.2.5] - 2026-08-21

### Changed

- **background-tasks**: default `bg_task_log` / compact log tails to 5 lines instead of 20

## [pi-better-harness@0.1.23] - 2026-08-21

### Changed

- **harness**: bundle background-tasks 0.2.4 (SSH tmux probe MOTD hardening)

## [pi-better-background-tasks@0.2.4] - 2026-08-21

### Fixed

- **background-tasks**: parse remote tmux probe path/version via protocol markers so SSH login MOTD/banners cannot be mistaken for the tmux binary

## [pi-better-harness@0.1.22] - 2026-08-18

### Changed

- **harness**: bundle subagents 0.1.21 and background-tasks 0.2.3 (aligned focused background-work detail rendering)

## [pi-better-background-tasks@0.2.3] - 2026-08-18

### Fixed

- **background-tasks**: keep focused background-work detail rendering aligned with the main rail height by removing the duplicate detail footer above the persistent navigator

## [pi-better-subagents@0.1.21] - 2026-08-18

### Fixed

- **subagents**: keep focused background-work detail rendering aligned with the main rail height and show subagent transcripts as a latest-10-row tail by default, with `l` cycling to 25 rows

## [pi-better-harness@0.1.21] - 2026-08-17

### Changed

- **harness**: bundle subagents 0.1.20 and background-tasks 0.2.2 (quiet background-work navigator repainting)

## [pi-better-background-tasks@0.2.2] - 2026-08-17

### Fixed

- **background-tasks**: stop repainting the shared background-work rail for volatile elapsed/deadline-only updates, making terminal copy/paste stable while tasks run

## [pi-better-subagents@0.1.20] - 2026-08-17

### Fixed

- **subagents**: stop repainting the shared background-work rail for elapsed-only running updates and replace the animated running dot with a stable indicator

## [pi-better-harness@0.1.20] - 2026-08-17

### Changed

- **harness**: bundle background-tasks 0.2.1 (clearer SSH background-task schema guidance)

## [pi-better-background-tasks@0.2.1] - 2026-08-17

### Fixed

- **background-tasks**: make the structured SSH remote-task path explicit on the `ssh` and `remote` parameter schemas, steering agents away from hand-written outer `ssh` commands and toward tmux-backed remote spawns

## [pi-better-harness@0.1.19] - 2026-08-17

### Changed

- **harness**: bundle goal 0.1.21 (mid-stream `/goal` no longer stacks `Working...` / bash `Elapsed` into scrollback)

## [pi-better-goal@0.1.21] - 2026-08-17

### Fixed

- **goal**: stop `Working...` / bash `Elapsed` stacking when setting a goal mid-stream — mid-stream feedback uses footer status (not chat notify), skip replace confirm while busy, and force a full TUI redraw when the goal clock appears or disappears

## [pi-better-harness@0.1.18] - 2026-08-17

### Changed

- **harness**: bundle background-tasks 0.2.0 (SSH remote-task preset: structured ssh fields, tmux lifecycle, watch polls, resume/timeouts)

## [pi-better-background-tasks@0.2.0] - 2026-08-17

### Added

- **background-tasks**: first-class SSH remote-task preset — structured `ssh` / `remote` fields on spawn/watch, agent-safe argv (`BatchMode`, connect timeout, `-T`, shell:false), injectable fake remote runner for tests
- **background-tasks**: remote tmux bootstrap (probe / non-interactive package-manager install / fail-closed needs-user with copy-pasteable commands)
- **background-tasks**: SSH watch as direct one-shot remote polls with existing success/failure conditions
- **background-tasks**: SSH spawn defaults to durable remote tmux sessions with log capture and real remote stop (`tmux kill-session`); explicit `remote.session=direct` escape hatch with weak-stop warning
- **background-tasks**: resume after reload for tmux-backed and direct-watch remote tasks; `timeout_seconds` yields `timed_out` (including deadline-bounded supervision polls)
- **background-tasks**: Remote SSH usage docs and tool descriptions steering models to structured `ssh` fields

## [pi-better-harness@0.1.17] - 2026-08-14

### Changed

- **harness**: bundle goal 0.1.20 (the active goal pauses when a running turn is interrupted; the reserved `escape` shortcut conflict is gone), background-tasks 0.1.18, and subagents 0.1.19

## [pi-better-goal@0.1.20] - 2026-08-14

### Fixed

- **goal**: pause the active goal when a running turn is interrupted (escape / ctrl+c), replacing an `escape` shortcut that pi's reserved built-in `app.interrupt` always skipped

## [pi-better-harness@0.1.16] - 2026-08-14

### Changed

- **harness**: bundle goal 0.1.19, background-tasks 0.1.18, and subagents 0.1.19

## [pi-better-background-tasks@0.1.18] - 2026-08-14

### Fixed

- **background-tasks**: cancelled tasks record a durable callback suppression instead of queueing a completion follow-up, so an explicit stop never wakes the agent and stays silent across session restarts

## [pi-better-goal@0.1.19] - 2026-08-13

### Added

- **goal**: pause the active goal on `escape` (preserving the interrupt of a running agent turn) and never poke paused goals

## [pi-better-harness@0.1.15] - 2026-08-13

### Changed

- **harness**: bundle goal 0.1.19, background-tasks 0.1.17, and subagents 0.1.19

## [pi-better-subagents@0.1.19] - 2026-08-12

### Changed

- **subagents**: render bounded Pi-style structured transcripts and keep the shared navigator, input box, and full-height detail view stable while switching between the foreground and active subagents

## [pi-better-background-tasks@0.1.17] - 2026-08-12

### Changed

- **background-tasks**: use the persistent shared activity navigator with stable selection gutters and input geometry in detail views

## [pi-better-goal@0.1.18] - 2026-08-12

### Changed

- **goal**: align the goal clock with the flattened shared activity-rail section and row layout

## [pi-better-background-tasks@0.1.16] - 2026-08-11

### Changed

- **background-tasks**: batch completion callbacks into one bounded follow-up while preserving retry, session isolation, and urgent health notifications

## [pi-better-subagents@0.1.18] - 2026-08-11

### Changed

- **subagents**: batch completion callbacks across subagent and background-task sources while preserving durable retries and urgent health notifications

## [pi-better-subagents@0.1.17] - 2026-08-04

### Added

- **subagents**: show the foreground `main` agent above child runs with live model, effort, tool, context-token, status, and elapsed metadata

### Changed

- **subagents**: wrap detail tool-call logs at readable path and JSON boundaries instead of truncating long rows

## [pi-better-subagents@0.1.16] - 2026-08-04

### Fixed

- **subagents**: keep completion callbacks focused on outcome metadata while preserving full execution evidence in `subagent_result`

## [pi-better-background-tasks@0.1.15] - 2026-08-04

### Added

- **background-tasks**: report quiet and stalled running tasks from observable process output or completed watcher polls; stalled tasks remain advisory and never trigger automatic termination

## [pi-better-goal@0.1.17] - 2026-08-04

### Added

- **goal**: report observable goal progress and stalled state while preserving foreground and active-background exemptions

## [pi-better-subagents@0.1.15] - 2026-08-04

### Changed

- **subagents**: use shared observable-progress stall thresholds while preserving model, tool, compaction, and terminal health semantics

## [pi-better-goal@0.1.16] - 2026-08-04

### Fixed

- **goal**: bound self-sustaining continuation loops after repeated identical tool outcomes while preserving retries for changed evidence, interactive input, and background-drain events

## [pi-better-goal@0.1.15] - 2026-08-02

### Changed

- **goal**: establish package-scoped releases for the Goal spacing and 30-second completion-retention behavior

## [0.1.14] - 2026-08-02

### Fixed

- **goal**: keep equal spacing between Goal and navigator sections, and hide completed goals after the shared 30-second terminal retention window

## [0.1.13] - 2026-08-02

### Added

- **subagents**: configure child reasoning effort with `thinking` or a validated `model@effort` shorthand, including shared and per-job batch options

## [0.1.12] - 2026-08-02

### Added

- **subagents**: show a shared, rolling 10- or 25-row live log tail in the detail view while it is open

## [0.1.11] - 2026-07-31

### Added

- add `npx pi-better-harness install` and `uninstall` shortcuts for managing all three standalone component packages, with optional project-local scope

## [0.1.10] - 2026-07-31

### Changed

- expose clean harness extension entry points so Pi displays `pi-better-harness:subagents`, `pi-better-harness:background-tasks`, and `pi-better-harness:goal`

## [0.1.9] - 2026-07-31

### Fixed

- bundle the subagents, background-tasks, and goal extension entry points inside `pi-better-harness` so Pi can load all three from one install

## [0.1.8] - 2026-07-31

### Changed

- show both package-gallery images in every published package README ([#118](https://github.com/1aboveio/pi-better-harness/pull/118))

## [0.1.7] - 2026-07-31

### Added

- **background-tasks**: retain task logs within a bounded size and expose terminal-aware bounded log tails ([#114](https://github.com/1aboveio/pi-better-harness/pull/114))

### Changed

- **background-tasks**: expand task commands by default and limit evidence-tail controls to 10 or 25 rows ([#114](https://github.com/1aboveio/pi-better-harness/pull/114))
- **subagents**: share bounded raw log-tail reading with background tasks while preserving incremental lifecycle parsing ([#114](https://github.com/1aboveio/pi-better-harness/pull/114))

## [0.1.6] - 2026-07-30

### Changed

- **subagents**: fold parseRun incrementally instead of re-reading a tail ([#110](https://github.com/1aboveio/pi-better-harness/pull/110))

### Fixed

- **subagents**: read run logs incrementally on the UI hot path ([#100](https://github.com/1aboveio/pi-better-harness/pull/100))
- clean up subagent runtime ownership ([#102](https://github.com/1aboveio/pi-better-harness/pull/102))
- **subagents**: bound the run registry by size, and scan it once per rebuild ([#104](https://github.com/1aboveio/pi-better-harness/pull/104))
- **subagents**: reconcile runs whose spawning pi is gone ([#106](https://github.com/1aboveio/pi-better-harness/pull/106))