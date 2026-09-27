# pi-better-subagents

A better subagent extension for [pi](https://github.com/earendil-works/pi-coding-agent).

Not a clone of Claude Code's subagents — a rethink of what a subagent system
should be: **autonomous, non-blocking, and safe by default.** You delegate work
and keep going; each subagent runs on its own in an isolated process, confined to
what it needs, and reports back when it's done. No blocking waits, no
back-channel for it to stall on, no unbounded blast radius.

```
launch is the result · completion triggers fetch · the foreground never blocks
```

## Principles

- **The foreground never blocks.** Launching a subagent *is* the deliverable —
  `subagent_spawn` starts a detached `pi -p` child and returns immediately,
  leaving the session free for the human. When the child finishes, it sends a
  lightweight trigger; the foreground calls `subagent_result` and presents the
  result (as a `followUp`, never cutting into work in progress). The foreground
  is nudged once, at completion — never on a wait/poll loop.
- **Subagents are autonomous; communication is one-way (parent → child).** The
  parent front-loads everything the child needs into the spawn; the child runs to
  completion and **returns a result**. There is no mid-task child→parent blocking
  call for a subagent to waste wall-clock on — a child missing a piece of info
  resolves it from what it was given, or records it unavailable and returns.
- **Safe by default.** Every subagent is OS-sandboxed — writes confined to its
  working directory, reads and network open — and scoped to an explicit tool
  allowlist. It can't corrupt the parent, escape its directory, or recurse into
  more subagents without opt-in.
- **Observable.** A live status widget and on-demand queries show each run's
  elapsed time and token/cost spend.

### Observable progress

Subagent health uses the shared 60-second quiet and 5-minute stalled defaults,
while preserving its stricter child-event semantics: active tool calls,
compaction, and model retry/error phases explain silence rather than becoming
stale. For a cross-extension override, set `PI_BETTER_STALL_QUIET_MS` and
`PI_BETTER_STALL_MS` in milliseconds. Existing subagent `config.json` health
thresholds continue to take precedence for subagent health.

## Tools

| Tool | Blocks? | What it does |
|------|---------|--------------|
| `subagent_spawn` | never | Launch a task in a background subagent; returns a run id at once. Params: `prompt`, `name`, `model`, `tools` (allowlist), `exclude_tools`, `sandbox`, `sandbox_dir`, `callback`, `clean`, `cwd`, `git_clone_workspace`, `approve`, `allow_nested`. |
| `subagent_spawn_batch` | never | Launch several independent subagents at once. Each job becomes a normal run. Params: `batchName`, `shared` (options applied to every job), `jobs[]` (each needs `prompt`; same optional params as `subagent_spawn`), `onCapacity` (`reject` or `launch-available`). |
| `subagent_list` | never | Compact current-session list (default 10 rows / 1 KiB page). Params: `all` (machine-global / foreign session), `limit` (default 10, max 100), `cursor`, `maxBytes` (max 4 KiB), `status` (`running`, `completed`, `failed`, `killed`, `exited`, durable `orphaned`, `lost`). Incident counts are compact; no spend/tool histories. |
| `subagent_output` | never | Bounded current-session excerpt (default 1 KiB / 10 lines). `all:true` for a foreign-session id. `mode=raw` pages retained log bytes (16 KiB default, 64 KiB cap). Missing/unreadable logs are gaps, not empty healthy output. |
| `subagent_result` | never | Finished-run answer for the current session (2 KiB default, 8 KiB cap, caller cursor). `all:true` for a foreign-session id. Failures and exceptional lifecycle facts come before progress; no tool-name histories. TUI folding is display-only. |
| `subagent_stop` | never | SIGTERM a running run's process group. |

## Non-blocking, by construction

- **Process isolation.** Each run is a `detached` + `unref`'d `pi -p` process.
  Its context can't clog the parent, its crash can't corrupt parent state, and
  its output is durable in a log file.
- **Completions trigger one batched turn that fetches durable results.** Ordinary
  terminal callbacks accumulate for 100 ms and share one
  `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` notification
  with background-task completions from the same Pi host. Each row contains only
  source, id, label, terminal status, and the `subagent_result` lookup. Full
  results and logs stay in durable tools and are never embedded in the callback.
  Set `PI_BETTER_CALLBACK_BATCH_MS` to `0` through `5000` milliseconds to tune
  the accumulation window; invalid values use 100 ms. A failed handoff keeps the
  pending records retryable, and `/reload` recovers records explicitly marked
  pending. `callback:false` sends no model message; read the durable result later
  with `subagent_result`.
- **The prompt guidelines forbid polling.** The foreground agent is told, in the
  tool guidelines, that spawning is done and it must not loop on `output`/`result`
  or sleep to wait.

## Autonomy & safety

Every subagent is confined by default, and the confinement is **self-contained** —
it does not depend on any other extension being installed.

- **Task sandbox (default on, macOS and Linux).** Pi startup, authentication,
  provider transport, and session persistence run as trusted runtime operations.
  Admitted task tools run under `sandbox-exec` or Linux Bubblewrap. Project files
  default to Read / write and outside files to Read, including `~/.pi`; runtime
  control files remain protected. Commands use private scratch plus explicit
  runtime exceptions for `/tmp` and the current user's macOS temporary and MDS
  cache directories when Outside is Read or Read/write. Credential and control
  denials retain precedence. See the permission details below.
- **Tool allowlist.** Confined children admit only verified read/write/edit/bash
  implementations. Requested tools without adapters are reported as unavailable.
- **No runaway recursion.** Confined children cannot spawn nested agents.
  `allow_nested:true` loads nested-agent support only for unconfined children.

### Write sandbox

The shared `sandbox-core` and `task-sandbox` modules enforce task operations in
both Main and Subagents. The defaults are Main Off and Subagents On, with project
Read / write, outside Read, stored credential files Read, commands On, and network
On. A subagent's project root is its selected workspace (`cwd` / `sandbox_dir`),
or its disposable clone. `/sandbox off` changes Main, not Subagents.

Pi runs as the trusted runtime so it can take settings/authentication locks,
connect to its provider, and persist sessions. A mandatory guard loads before
the task can run. Its immutable launch snapshot controls shell commands and
kernel-confined file workers. Task access to `~/.pi` follows the outside and
credential-file rules; there are no writable lock exceptions. Runtime code,
configuration, and control files remain protected from task writes.

Commands Off still permits file tools according to their file permissions.
Network Off blocks task network access while Pi's provider transport remains
available. The confined file worker has an 8 MiB file limit and rejects larger
files explicitly; use confined commands for larger files when commands are On.

Currently `read`, `write`, `edit`, and `bash` have verified adapters. Other tools
are disabled in confined children and listed in launch output. Provider
extensions are trusted runtime code; arbitrary extension tools are not admitted
merely because their names were requested. Confined children disable project
runtime configuration and inherited extension discovery. Startup or backend
failure never falls back to an unconfined child.

You still start Pi normally. The subagent package's internal launcher requires
Pi SDK 0.82.1 or newer; it is not a replacement user-facing Pi command.

### Git-mutating subagents and linked worktrees

A sandboxed subagent that will mutate Git should set **`git_clone_workspace:true`**
on `subagent_spawn`. The parent prepares a fresh, self-contained Git clone whose
`.git/` directory lives **inside the sandbox writable root**, then runs the child
in that clone.

Why this matters: a linked Git worktree (created with `git worktree add`) has a
`.git` file that points back to administrative state under the main repository,
typically outside the sandbox directory. A sandbox that only allows writes under
the worktree directory therefore cannot support normal Git producer operations
such as fetch, rebase, commit, and push — the child stalls or fails when Git
tries to write metadata it cannot reach. `git_clone_workspace:true` avoids this
by cloning the repository with a real `.git/` directory inside the writable root.

The clone uses:

```
git clone --reference-if-able <local-reference-repo> --dissociate \
          <remote-url> <sandbox-workspace>
```

`--reference-if-able` borrows local objects from the parent repository during
setup; `--dissociate` removes the alternates link afterwards, so the clone is
self-contained and safe to delete. The clone source prefers the source
workspace's upstream remote URL (`origin` when set) so the disposable
workspace's `origin` points at the real remote rather than the parent working
tree — pushes therefore target upstream, not the sandboxed parent. The local
repository is used only as a reference (and as a content fallback when no
remote is configured). Source remotes are re-synced after clone. The
checked-out branch/commit matches the source workspace at spawn time.
Repo-local Git identity settings from the source (`user.name`, `user.email`,
and `user.signingkey` when set) are copied into the clone so ordinary commits
work without reconfiguring identity inside the disposable workspace.

If the source workspace is a linked worktree, the clone is prepared from the
main repository's object database and the requested branch/commit; the child is
never launched into the structurally broken linked-worktree sandbox. If clone
preparation fails, the spawn fails fast with a message explaining that the
linked-worktree Git metadata is outside the sandbox and recommending
`git_clone_workspace:true`.

The mandatory task guard is independent of optional guardrails extensions.
Adding a package to the tool map does not make its tools safe to execute outside
the task boundary.

## Tool scoping (allowlist)

Precedence, highest first: the per-call `tools` param → `config.json`
`defaultTools` → a built-in default (`read, bash, edit, write, web_search,
web_fetch`; just `read, bash` in a `clean` child). `exclude_tools` subtracts on
top.

`config.json` (next to the extension) also sets:

- `defaultModel` — model for spawns that don't specify one (`null` = inherit the
  foreground model).
- `maxConcurrent` — how many subagents may run at once (**default 4**). A spawn
  past the cap is rejected until a running one finishes.

## The allowlist also decides what LOADS

For confined children, the requested list is first restricted to tools with
verified task adapters. Unsupported task extensions are not loaded. Provider
extensions can still load as trusted runtime dependencies. Nested spawning and
inherited extension discovery are currently unavailable under confinement.

The mapping behavior below applies to unconfined children and to admitted
runtime dependencies:

The `tools` allowlist does double duty: it is both what the child may call **and**
which extension *code* is loaded into it. A child launches as

```
pi -p --mode json --no-extensions -e <package backing a requested tool> ...
```

so a package that backs no requested tool never loads. With the default
allowlist (`read, bash, edit, write, web_search, web_fetch`) exactly one package
loads — the web-tools one — and `web_fetch` works normally.

Two maps in `config.json` drive it:

- `toolExtensions` — tool name → package(s) providing it. Built-ins (`read`,
  `bash`, `edit`, `write`) need no entry.
- `providerExtensions` — provider → auth package. Model auth is not tool-shaped:
  `xai/grok-4.5` needs `pi-xai-oauth` loaded whatever tools it was granted.

Ask for a tool with no mapping and the spawn still succeeds, but says so at
launch — the tool simply will not exist in the child.

`clean:true` is the narrowest case of the same mechanism: no extensions at all.
For unconfined children, `allow_nested:true` loads this package into the child;
without it, nested spawning is unavailable. Confined children disable nesting
regardless of this flag until a verified adapter exists.

`inheritExtensions: true` in `config.json` restores the old load-everything
behavior. It is **operator-only** — no spawn parameter can reach it, so the child
model cannot widen its own runtime. It also re-exposes the failure below.

### Why: a subagent that loads everything can die mid-turn reporting success

Loading every installed package means inheriting their startup side effects. A
package that replaces builtin `bash` with a `detached` + `unref()` spawn breaks
`pi -p`: on a parallel `bash` + `read` batch the in-process `read` finishes, the
unref'd `bash` doesn't hold the event loop, Node drains, and the child **exits 0
mid-turn** — no `tool_execution_end`, no `agent_end`. Historically, exit 0 was
indistinguishable from a clean finish, so all 17 observed mid-turn exits were
reported as ✓ completed. Finalization now requires terminal agent evidence and
no unmatched tool starts. Lifecycle validation classifies runs as `complete`,
`incomplete_no_terminal_event`, `incomplete_open_tools`, `failed_exit`, or
`killed`; incoherent exit-0 streams are recorded as failed with named lifecycle
diagnostics on `subagent_result` and attention wording on completion callbacks.

A tool allowlist alone cannot fix this. `--tools` restricts what the model may
*call*; the package already overrode builtin `bash` at startup, so the `bash` in
your allowlist **is** the broken one. Measured with the default 6 tools:

| runtime | tool starts / ends | terminal event |
|---|---|---|
| all extensions loaded | 2 / 1 | none — exits 0 mid-turn |
| `--no-extensions -e <web-tools>` | 3 / 3 | `agent_settled`, `web_fetch` OK |

A package *denylist* isn't expressible either: pi has only `-e <path>` (add one)
and `--no-extensions` (all off) — there is no "load all except X" flag. Naming
what you want is the only mechanism that excludes anything, and it excludes
future offenders too, with no name to keep updated.

### Known incompatibility: `pi-patty-bg-tasks`

**`pi-patty-bg-tasks` (tested at 1.1.6) is incompatible with subagents and must
not be loaded into a child.** It is the package that produced the failure above:
it replaces builtin `bash` and spawns `detached` + `proc.unref()`
(`src/spawn.ts`), which in print mode drains the event loop mid-turn. Bisected
against all 18 installed packages — alone it reproduces; every other package
alone is fine.

The default configuration already excludes it, structurally, because it backs no
requested tool. You only re-expose it by setting `inheritExtensions: true`, or by
mapping a tool to it in `toolExtensions`. Don't.

A proper fix belongs upstream — preserve builtin `bash` semantics when overriding
it, keep foreground subprocesses referenced until the tool promise settles, and
put genuinely detached work behind a separate background-task tool.

## Status & cost tracking

Driven by the child's `--mode json` usage events:

- **Live widget** above the editor while any subagent runs — a spinner per run
  with elapsed time, the current tool, and running token/cost spend, ticking once
  a second. It clears itself when the last run finishes. (TUI/RPC only; silent in
  `-p`/print mode.)
- **On demand** — `subagent_list`, `subagent_output`, and `subagent_result` are
  bounded current-session pages (see `docs/issue-312-output.md`). They omit
  ordered tool-name sequences and default token/cost lines. The human toast may
  still include elapsed + spend; the model-facing callback does not.
- **Folded result display.** In interactive TUI sessions, `subagent_result`
  renders a compact preview by default so long child answers do not flood the
  transcript. Clicking the tool row, or using the row expand action, shows the
  full bounded result. This is a display concern only: the tool still returns
  the complete bounded `content` payload to the model.

Spend is summed from each finalized assistant turn's `usage` (so multi-turn
tool-using runs total correctly), and cost comes straight from the model's
reported per-request cost.

## Subagent navigator (TUI)

In an interactive TUI session, a **subagent navigator** lets you inspect and
organize runs without asking the model to call a tool. The running-subagents
widget can be focused from an empty input line for quick actions; detail output
opens in the overlay. Print/RPC modes do not install the navigator; tool access
is unchanged in every mode.

### Open

- With the editor **empty** and at least one non-dismissed current-parent run
  still running, press `←` to focus the main-window subagent list above the
  input line.
- If the editor contains text, `←` keeps normal cursor-left behavior.
- While running runs exist, the default footer shows `← subagents · N`. The
  live widget also includes a secondary `← to navigate` hint on its title line
  for terminals that do not render the default footer status. The hint clears
  when no non-dismissed current-parent run is still running.
- While the main-window list is focused, the title hint changes to
  `Enter to view · x to stop`; the selected row is marked with `›`. Press
  `↓` from the bottom row to return to the input line.
- The Subagents lane pins an informational `main` row above child runs. It
  shows the foreground model, effort, active tool, context tokens, and active
  elapsed time. It is not selectable and can never become an `x` stop target.
- `↑` moves to the previous row when multiple running rows are shown. `↓`
  moves toward the input line, returning to normal input from the bottom row.
- `Enter` opens the selected run's live detail view. `x` stops the selected
  running run using shared `subagent_stop` semantics and dismisses it from the
  navigator.

### Detail view

- Detail uses the same command-sheet treatment, with section rules for the
  inspector groups and command bars at the top and bottom of the view.
- Tool-call log rows wrap within the detail width instead of truncating. Source
  row boundaries and indentation are retained, with long paths and JSON values
  preferring delimiter breaks before a hard wrap. Header and metadata geometry
  is unchanged.
- Shows status (colorized), model/effort, elapsed, tools, spend, and parsed
  output, plus sectioned health: process identity/liveness, activity,
  compaction, active tool, model call/error, last log write, thresholds, and
  callback notification timestamps. Compaction, active tool, and model state
  are separate sections. The view refreshes about once per second while open.
- Detail opened from the main-window list closes back to the main page; the
  main-window selection remains on the viewed run when it is still visible.
- `x` arms Stop for a running run, or Dismiss for a terminal run.
- `esc` closes the detail view and returns to the main page.

### Two-press `x` stop/dismiss

- First `x` on the selected (list) or viewed (detail) run arms the action for three
  seconds and shows a footer hint: `x again to stop <name>` while running, or
  `x again to dismiss <name>` when terminal.
- Second `x` within the window, on the **same** run, acts:
  - **Running** — stop the process group (shared `subagent_stop` semantics),
    mark killed, then dismiss from the navigator.
  - **Terminal** — dismiss only; terminal status is not rewritten.
- Changing selection, leaving the view, closing the overlay, arming timeout,
  reload, and session teardown all disarm close and clear the confirm hint.

### Dismissal is navigator-only

Dismissed runs leave the navigator list and footer count. Logs, prompt, session
data, metadata, and id-based tool access stay intact. `subagent_list`,
`subagent_output`, `subagent_result`, and `subagent_stop` still resolve dismissed
run ids. Dismissal survives `/reload` as dismissed in the navigator.

### Reload and teardown

`/reload` and session restart reinstall the empty-editor wrapper without stacking
duplicate handlers, republish the footer count, and clear any leftover overlay
timers or close-confirm state. Session shutdown disposes open navigator timers
and clears navigator footer statuses (TUI only).

## Design notes

- Runtime lives outside any repo, under `$TMPDIR/pi-better-subagents/`
  (`runs/<id>/` holds `output.log`, `prompt.md`, `meta.json`; `sessions/` holds
  child session state). The `meta.json` sidecar is authoritative, so `list` /
  `output` / `result` survive turns, `/reload`, and pi restarts.
- The child runs `--mode json`; `subagent_result` / `subagent_output` **parse**
  the event stream and return just the bounded final answer (no tool-name history).
  Non-JSON banner/warning lines fail to parse and are dropped, so the result is
  clean. The prompt is passed as a **positional argument**, never `@file` — some
  models refuse an @-attached file as untrusted content.
- The child gets **only** the explicit prompt — no silent parent-context bleed.
- `--approve` is **off by default** (headless runs can't prompt for trust).


## Parent-process scoping

The live widget, default `subagent_list`, concurrency cap, and `session_start` ticker only include runs this pi process spawned (`spawnPid === process.pid`). The on-disk registry stays machine-global for durability. Default `subagent_list` is current-session, newest first, 10 compact rows / 1 KiB. Pass `limit:N` (max 100) or `maxBytes` (max 4 KiB) for an explicit larger page. Pass `all:true` for a global / foreign-session view. Pass `status:[...]` to filter by effective status: `running`, `completed`, `failed`, `killed`, transient `exited`, or durable `orphaned` / `lost`. Id-based `subagent_result` / `subagent_output` default to the current session; pass `all:true` to read a foreign-session id. Unknown ownership is a gap, not “not found”.

## Supervision health (`orphaned` / `lost`)

While a current-parent run is `running` or `orphaned`, a periodic health tick
reconciles process-group evidence only (see `docs/adr/0002-process-group-only-subagent-health.md`):

- **`orphaned`** — direct supervision of the child is broken, but related
  process-group work may still be alive. Non-terminal and non-final; operationally
  unhealthy immediately. The coordinator (when `callback:true`) gets one durable
  ATTENTION follow-up naming `subagent_result` / `subagent_output` / `subagent_stop`
  so it can inspect artifacts and decide whether to wait, stop, or retry. Human
  `ui.notify` still fires when `callback:false`.
- **`lost`** — no related process remains and no coherent terminal completion was
  observed. Terminal with unknown outcome (not the same as `failed`). Same one-shot
  ATTENTION follow-up + diagnostic `subagent_result` path with best-available
  artifacts.

Orphaned/lost callbacks use the same non-interrupting
`{ deliverAs: "followUp", triggerTurn: true }` mechanics, but bypass the ordinary
completion accumulation window and retain distinct ATTENTION wording. Per-status
markers on `meta.json` (`orphanedCallbackSentAt` / `lostCallbackSentAt`) are written
only after a successful handoff and dedupe across reloads and repeated health ticks.
Persisted unmarked orphaned/lost states are recovered on the health ticker after
`/reload` even when process evidence does not produce a fresh transition.

Pi's optional `followUpMode: all` remains useful when completion groups arrive
after an earlier 100 ms batch has already flushed: Pi can consume those queued
follow-ups in one later agent turn. This extension does not change Pi core or
Pi's default follow-up mode.

### Surfacing health (tools + passive widget)

Multi-dimensional observations (`stale`, long tool, compacting / long compaction,
model error/retry, plus process `orphaned` / `lost`) are computed from durable
status + child-event evidence and surfaced on existing paths without a parallel
health model:

- **`subagent_list`** — durable `orphaned` / `lost` status brackets; degraded
  compact facts only when actionable. Healthy/quiet rows stay on the compact format.
- **`subagent_output` / `subagent_result`** — `[health: …]` diagnostics for
  orphaned, lost, and degraded running runs; #65 orphaned/lost result bodies kept.
- **Passive live widget** — healthy/quiet unchanged; degraded (and orphaned) may
  show a short suffix. Still `setWidget` only — never focusable.
- **`callback:false`** suppresses coordinator follow-up only; human `ui.notify` and
  TUI/passive visibility remain.

## Install

Linux sandboxing requires the system `bubblewrap` package. Install it before
launching sandboxed children:

```bash
# Debian/Ubuntu
sudo apt-get install bubblewrap
# Fedora/RHEL
sudo dnf install bubblewrap
# Arch Linux
sudo pacman -S bubblewrap
```

When `bwrap` is absent, explicit sandbox requests fail with an installation hint;
default-on sandboxing preserves the documented direct-execution fallback. Once
`bwrap` is selected, a launch failure fails closed rather than retrying the child
without confinement.

Symlink the project into pi's auto-discovered extensions dir:

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-better-subagents
```

Then `/reload` (or restart pi). It appears as `pi-better-subagents`.

> Do **not** add it to `settings.json`'s `extensions` array — a live pi session
> rewrites that file on its own saves and drops hand-added entries. Auto-discovery
> via the symlink is stable. Quick throwaway test without installing:
> `pi -e ./index.ts`.

## Tests

Unit tests (`node --test tests/*.test.mjs`) cover the pure logic — widget
rendering, completion delivery, and extension resolution.

Real integration smoke tests live in [`tests/`](tests/) — a subagent using
`web_fetch`, one driving `gh`, env inheritance through the sandbox, and headless
isolation surviving a parallel `bash` + `read` batch. See
[`tests/README.md`](tests/README.md).

## Roadmap

Tracked in [issues](https://github.com/1aboveio/pi-better-subagents/issues).
Near-term:

- Guarantee subagent autonomy — verify/deny any child→parent supervision
  back-channel so a child can never block on the parent ([#1](https://github.com/1aboveio/pi-better-subagents/issues/1)).
- Make `callback:true` a lightweight trigger instead of embedding the full result
  twice ([#2](https://github.com/1aboveio/pi-better-subagents/issues/2)) — **done**.
- Named agent-definition files (per-agent system prompt + tool allowlist) and
  chain/parallel orchestration.
