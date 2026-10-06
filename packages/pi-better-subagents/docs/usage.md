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

## Delegation Mode

Set `delegationMode` in this package's `config.json` to `manual`, `adaptive`, or
`coordinator` (default `adaptive`). This controls foreground delegation guidance,
not child permissions or catalog definitions. `/subagents settings` (or simply
`/subagents`) opens the terminal settings page with mode and concurrent-subagent
cap controls and Reset to defaults. The page uses the same selected-row and
active-cell styling as `/sandbox`, with one editable value column.
Edits automatically persist for this session, including across reloads; Escape
closes the page without undoing them.
Enter edits the cap as a positive whole number; Escape cancels an unfinished edit.
Ctrl+S saves both settings as defaults. Sandbox permissions remain in `/sandbox`.

Command equivalents also work outside the terminal UI:

```text
/subagents mode manual|adaptive|coordinator
/subagents cap 6
/subagents save
/subagents reset
```

The cap defaults to 4 and applies to both single and batch launches. Lowering it
below the running count leaves existing work untouched and blocks new admissions
until capacity becomes available. Slots already reserved by an in-flight launch
remain admitted. Settings apply to this parent Pi process, not
all Pi sessions on the machine. Saving preserves unrelated config keys and
clears both session overrides. The command form asks for confirmation when a UI
is available. Reset restores saved defaults without changing config.

`/reload` retains session overrides; new sessions use config, while resuming or
navigating a branch restores its settings. On the navigator `main` sheet, `m`
cycles the session mode and `ctrl+s` saves only that mode default.

- **Manual:** no proactive delegation, including in plan mode. A user request or
  explicit workflow requirement may still delegate.
- **Adaptive:** delegate useful, substantial independent work while continuing
  foreground work; keep small or coupled tasks local.
- **Coordinator:** use `agents_catalog` to discover current roles and delegate
  every nontrivial task owned by an available role, passing the role by its
  short name (`role: "developer"`). The foreground owns
  orchestration, cross-role decisions, unowned or ambiguous work, integration,
  and final verification. Current role descriptions, including custom catalog
  overrides, determine ownership.

All modes retain the no-polling rule and require inspection of delegated results
before final verification. `pi-better-plan` follows the active mode when a plan
is present; without this extension it uses adaptive guidance.

## Principles

- **The foreground never blocks.** Launching a subagent *is* the deliverable —
  `subagent_spawn` starts a detached `pi -p` child and returns immediately,
  leaving the session free for the human. When the child finishes, it sends a
  lightweight trigger; the foreground calls `subagent_result` and presents the
  result (as a `followUp` by default; optional busy steering is described below). The foreground
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
| `subagent_spawn` | never | Launch a task in a background subagent; returns a run id at once. Params: `prompt`, `name`, `model`, `tools` (allowlist), `exclude_tools`, `sandbox`, `sandbox_dir`, `callback`, `clean`, `cwd`, `git_clone_workspace`, `approve`, `allow_nested`, and the [timing](#run-timing-deadline-ceiling-stuck) overrides `deadline_minutes`, `grace_minutes`, `max_minutes`, `stuck_minutes`. |
| `subagent_spawn_batch` | never | Launch several independent subagents at once. Each job becomes a normal run. Params: `batchName`, `shared` (options applied to every job), `jobs[]` (each needs `prompt`; same optional params as `subagent_spawn`), `onCapacity` (`reject` or `launch-available`). |
| `subagent_list` | never | Compact current-session list (default 10 rows / 1 KiB page). Params: `all` (machine-global / foreign session), `limit` (default 10, max 100), `cursor`, `max_bytes` (max 4 KiB), `status` (`running`, `completed`, `failed`, `killed`, `exited`, durable `orphaned`, `lost`). Incident counts are compact; no spend/tool histories. |
| `subagent_output` | never | Bounded current-session excerpt (default 1 KiB / 10 lines). Params: `id`, `lines` (`tail_lines` is a deprecated alias), `cursor` (a returned `nextCursor`, `statusCursor`, or `incidentCursor`), `max_bytes` (max 4 KiB; raw 16 KiB default, 64 KiB max), `mode` (`raw` pages retained log bytes), `include` (`["cost"]`, `["tools"]`, or both: opt-in spend and tool-count lines), `all` (foreign-session id). Missing/unreadable logs are gaps, not empty healthy output. |
| `subagent_result` | never | Finished-run answer for the current session (2048-byte page). Params: `id`, `cursor` (a returned `nextCursor` continues the answer; `statusCursor` / `incidentCursor` also accepted), `max_bytes` (maximum 8192 bytes), `lines` (optional line cap per answer page), `mode` (`raw`), `include` (`["cost"]`, `["tools"]`, or both), `all` (foreign-session id). Failures and exceptional lifecycle facts come before progress; no tool-name histories. TUI folding is display-only. |
| `subagent_stop` | never | SIGTERM a running run's process group. |

## Codemode batch launches

On Pi 0.99.1 or newer, enable native codemode alongside the existing direct
tools with `defaultTools: ["+codemode"]` and `codemode.mode: "on"`. SDK sessions
must also load Pi's `createCodemodeExtension()`. This support is for the
foreground coordinator; it does not enable codemode in confined children or
change sandbox admission.

`subagent_spawn_batch` returns the same readable text to direct callers and a
structured launch receipt to codemode scripts. No text parsing is needed:

```javascript
const receipt = await tools.subagent_spawn_batch({
  batchName: "inspection",
  shared: { tools: "read,bash" },
  jobs: [
    { role: "explorer", prompt: "Map the request handling path." },
    { role: "reviewer", prompt: "Review the current changes for regressions." }
  ]
});
store("inspection-launch", receipt);
text(receipt);
```

| Field | Meaning |
|-------|---------|
| `status` | `launched`: every effective job launched; `partial`: some launched and some failed or were skipped; `not-launched`: none launched; `clarification-needed`: selection needs a human decision and nothing launched. These are launch outcomes, never completion outcomes. |
| `batchId`, `batchName` | Assigned batch identity and optional label. No batch ID is assigned for clarification. |
| `launched` | `{ job, name, id, modelNote? }` for each created run. |
| `failed` | `{ job, name, reason }` for launch failures, including later jobs not attempted after a reject-mode launch failure. |
| `skipped` | `{ job, name }` for jobs omitted because capacity was full in `launch-available` mode. |
| `message`, `choices` | Explanation and selection options on a clarification receipt. |

`job` is a 1-based position in the effective batch order, after any confirmed
role split. All three job lists are always present. Invalid input and whole-batch
capacity rejection still throw, so codemode callers must catch those errors.
Returned partial or no-launch receipts do not throw; inspect `status` and every
list instead of treating a fulfilled promise as complete success.

Await the launch call and print or retain its receipt before returning from the
script. Codemode `store()` writes persist only if the script succeeds; launched
runs are not rolled back if the script later fails, times out, or is interrupted.
Use the durable run registry to recover IDs when needed, and `subagent_stop` to
stop a run. Script cancellation is not a stop request. Collect results after
completion callbacks with `subagent_result`; do not poll or keep a script open
waiting for completion. Callbacks and capacity/catalog guarantees remain owned
by the existing harness runtime.

## Run timing (deadline, ceiling, stuck)

Timeout control belongs to the harness, not to the prompt or the skill that
launched the run. A time limit written into a prompt is enforced by nothing, and
a parent that only notices late tends to kill a child that was still making
progress. Every run gets stall detection by default. Elapsed-time limits are
opt-in because total runtime does not distinguish a slow agent from a stalled
one.

| Control | Default | What happens |
|---------|---------|--------------|
| Soft deadline (`deadline_minutes`) | Off | When configured, the child gets one steering message (delivered through Pi's steer queue after its current tool call finishes): stop starting new work, commit or save what is done, and report what is complete, what is not, and where the work is. The parent gets one wake saying so. |
| Grace (`grace_minutes`) | 5 | Grace starts when the steering message actually reaches the child, which is after its current tool call. While the message is still waiting behind a running tool call, the deadline stop is held, so a test run that began just before the deadline is not killed mid-run. If the child has not finished by the end of grace, the harness stops it; the ordinary completion callback reports `killed; stopped: deadline`. A child that completes inside grace is not stopped; its surfaces say `deadline: finished in grace`. |
| Hard ceiling (`max_minutes`) | Off | When configured, the run is stopped at once, without grace or a steer, and reported as `stopped: ceiling`. The ceiling bounds everything, including a tool call that never ends and an orphaned run (child gone, its process group still alive). |
| Stuck window (`stuck_minutes`) | 10 | No progress (see below) for this long wakes the parent once (`stuck`). It never stops the run. After new progress, a later stuck spell wakes again. |

`0` turns a control off. `null` or an omitted value means "inherit": on
`subagent_spawn` that is the configured default; on a `subagent_spawn_batch` job
it is the `shared` value, then the configured default. Values are minutes and
may be fractional. A job's own number (including `0`) wins over `shared`.

**Known limits of the deadline hold.**

- `max_minutes: 0` turns the ceiling off, and the ceiling is the only control
  that bounds a tool call that never ends. With it off, a steer stuck behind a
  hung tool call is never delivered, the deadline stop stays held, and the run
  is never stopped. Opt into a ceiling when a command must have a wall-clock
  bound.
- The parent reads at most the last 32 MiB of a child log after `/reload`. If
  the log is larger and the running tool call started before that window, the
  parent cannot see the call, so the hold is lost and grace counts from when
  the steer was sent. The child can be stopped mid-call.
- The child confirms delivery by matching the steer's exact text in its
  conversation. If another extension rewrites user input (an input-transform
  hook), the text no longer matches, no receipt is written, and grace silently
  counts from when the steer was sent instead of when it arrived.

**Progress**, defined simply: any successful tool call that is not an exact
repeat of an earlier call in the same run. "Exact repeat" means the same tool
name and the same arguments, with null and absent optional fields treated alike
(as in #336) and key order ignored. A successful file-mutating tool (`edit`,
`write`, `multi_edit`, `apply_patch`, `str_replace`, `write_file`, and similarly
named tools), a `git commit`, and a success directly after a failed call always
count, even when repeated. Re-reading the same file or re-running the same command with the same
arguments does not reset the stuck window, so a read-only research child making
distinct calls is never flagged, while one looping on the same read is. The
harness remembers up to 4096 distinct calls per run as fixed-size hashes of the
name and normalized arguments; past that the oldest is forgotten, so a call from
long ago counts again. Time the child spends waiting on a running tool call does not count toward the
stuck window, so a child in the middle of a 20-minute test run is waiting, not
stuck. A command that hangs is bounded only when the caller opts into a deadline
or ceiling.
The other stuck signal is the existing escalation: the same operation failing
three times wakes the parent once as an `Action required` incident
([failure observations](failure-observations.md)).

**Where the reason shows.** `subagent_list` rows, `subagent_output`,
`subagent_result`, and completion callbacks carry `stopped: deadline`,
`deadline: wrapping up`, `deadline: finished in grace` (completed after the
deadline), `deadline: passed` (ended some other way after the deadline, for
example it crashed or a user stopped it), `stopped: ceiling`, or `stuck`. The spawn response lists the limits in force.

**Global defaults.** Precedence is spawn parameter, then environment, then
`config.json`, then the built-in default:

| Setting | Environment | `config.json` |
|---------|-------------|---------------|
| Soft deadline | `PI_SUBAGENT_DEADLINE_MINUTES` | `deadlineMinutes` |
| Grace | `PI_SUBAGENT_GRACE_MINUTES` | `graceMinutes` |
| Hard ceiling | `PI_SUBAGENT_MAX_MINUTES` | `maxMinutes` |
| Stuck window | `PI_SUBAGENT_STUCK_MINUTES` | `stuckMinutes` |

**Durability and delivery.** The policy and its one-shot markers (steer
requested, deadline wake, stuck wake, stop reason) are stored in the run's
metadata at launch, so `/reload` keeps the deadline and never repeats a wake.
The parent checks timing on its 15-second supervision tick. The steer travels
through a request file in the run directory, read by a small harness extension
loaded into every child (it registers no tools and runs no commands). When the
message enters the child's conversation, the extension writes a receipt file
next to the request; grace starts at that time. The extension runs in the
trusted Pi process, and the child's confined tools cannot write the run
directory, so a child cannot forge a receipt. Without a receipt and with no
tool call running (for example, a child started without the extension), grace
runs from when the steer was requested. Wakes follow `callback:false` and session ownership like other callbacks.
Runs launched before this feature have no timing record and are not timed.

Output-control parameters are spelled the same across subagents and background
tasks: `max_bytes` and `lines`. The older spellings `maxBytes` and `tail_lines`
are deprecated aliases; both work, and the canonical name wins when both are
given.

## Non-blocking, by construction

- **Process isolation.** Each run is a `detached` + `unref`'d `pi -p` process.
  Its context can't clog the parent, its crash can't corrupt parent state, and
  its output is durable in a log file.
- **Completions trigger one batched turn that fetches durable results.** Ordinary
  terminal callbacks stay in the harness queue while the foreground agent is
  busy by default. Once Pi is idle, they accumulate for 100 ms and share one
  `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` notification
  with background-task completions from the same Pi host. Each row contains only
  source, id, label, terminal status, and the `subagent_result` lookup. Full
  results and logs stay in durable tools and are never embedded in the callback.
  Set `PI_BETTER_CALLBACK_BATCH_MS` to `0` through `5000` milliseconds to tune
  the accumulation window; invalid values use 100 ms. `agent_settled` schedules
  the aggregate without starting a model run inside the lifecycle handler.
  Completions arriving during that model run, including bounded overflow,
  stay queued for the next available boundary. A failed handoff keeps the
  pending records retryable, and `/reload` recovers records explicitly marked
  pending. `callback:false` sends no model message; read the durable result later
  with `subagent_result`.
- **Optional busy steering.** In `/harness-settings`, set **Completions while
  busy** to **Steer active run** to receive ordinary completions during
  foreground work. Changes autosave to the current session branch and apply
  immediately; **Ctrl+S** saves the choice as the user default for future
  sessions, including standalone callback packages. **Wait until idle** is the
  default. The former `PI_BETTER_CALLBACK_WHILE_BUSY` environment variable is
  no longer supported. Completions spanning multiple accumulation windows during
  one tool call stay together until the final active tool ends, then share one
  compact `steer` notification without triggering a new run. Parallel and nested
  tools are tracked together by both extensions. While busy with no active tool,
  the normal accumulation window applies. Manual compaction and branch
  summarization hold callbacks until an agent run starts or Pi becomes idle.
  Idle delivery remains
  `{ deliverAs: "followUp", triggerTurn: true }`. The same byte budget, queued overflow,
  dedupe, delivery receipts, retry, ownership checks, and `callback:false` rules
  apply to both modes; a completion handed off by steer is not sent again at
  idle. Urgent health/failure alerts are unchanged.
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
  implementations, the guarded `apply_patch`, and the trusted tools ticked in
  `/sandbox`. The fixed `process_list` adapter is available with Process access
  set to Read. Other requested tools are reported as unavailable, with the reason.
- **No runaway recursion.** Confined children cannot spawn nested agents.
  `allow_nested:true` loads nested-agent support only for unconfined children.

### Write sandbox

The shared `sandbox-core` and `task-sandbox` modules enforce task operations in
both Main and Subagents. The defaults are Main Off and Subagents On. Subagents
use Project files = Write & delete and Outside project = **Write**: tasks write
across home and temp (tool caches such as `~/.gradle` and `~/.npm` just work), but
outside the workspace they can only remove or rename files in temp, hidden home
entries, and worktree folders (`.worktrees/`, `*-worktrees/`). Credential files
default to Write & delete, so authenticated CLIs can maintain their credential
databases and token state. Tasks can also modify or delete these credentials,
subject to stricter protected-path rules. Set Stored credentials to Read to
deny writes or Off to hide them. Explicit saved profiles keep their values.
Shell startup files, `~/.pi`, `~/.claude`,
`~/.agents`, and harness state cannot be written, removed, or renamed. Rename-based
saves and git commits in a sibling repository fail under Write; set Outside
project to Write & delete when a task needs that. Linux uses a stricter fallback
where ordinary home folders are read-only. See
[pi-better-sandbox](../../pi-better-sandbox/README.md) and
[ADR 0008](../../../docs/adr/0008-write-without-delete.md). Commands and network
default On. A subagent's project root is its selected workspace (`cwd` / `sandbox_dir`),
or its disposable clone. `/sandbox off` changes Main, not Subagents.

Pi runs as the trusted runtime so it can take settings/authentication locks,
connect to its provider, and persist sessions. A mandatory guard loads before
the task can run. Its immutable launch snapshot controls shell commands and
kernel-confined file workers. Task access to `~/.pi` follows the outside and
credential-file rules; there are no writable lock exceptions. Runtime code,
configuration, and control files remain protected from task writes.

Commands Off still permits file tools according to their file permissions.
Process access defaults to Off. Set it to Read for the fixed `process_list`
tool, which returns current-user PIDs and names only, even with Commands Off.
It accepts a literal name filter and a bounded limit, not shell commands or
process-control actions. It does not expose arguments or environments, and
does not start an emulator or allocate test resources. The setting governs
the fixed adapter only, not every OS process operation available through bash
or trusted tools. New launches capture changes; running children retain their
launch-time setting. Raw macOS `/bin/ps` remains subject to setuid execution
restrictions. See [ADR 0011](../../../docs/adr/0011-fixed-read-only-process-inventory.md).
Network Off blocks task network access while Pi's provider transport remains
available. The confined file worker has an 8 MiB file limit and rejects larger
files explicitly; use confined commands for larger files when commands are On.

`read`, `write`, `edit`, and `bash` have verified adapters. Extension tools are
chosen in `/sandbox` → Subagents · Tools
([ADR 0009](../../../docs/adr/0009-guarded-and-trusted-subagent-tools.md)):

- **Guarded:** `apply_patch`, a harness adapter with the Codex tool's name,
  schema and patch format. Every add, update, move and delete goes through the
  guarded file operations, so the Project files / Outside project levels apply:
  Write refuses deletes and moves outside disposable places, Read refuses
  writes, credential files and protected paths are refused. The whole patch is
  checked first; no file is left half-patched, and a failure part-way reports
  what was and wasn't applied. It is added for a child that may `edit` or
  `write`, or asks for it.
- **Trusted:** third-party tools you tick (default `web_fetch` and `web_search`).
  Their package is loaded into the child and they run in the child Pi process,
  **outside the file rules**. The child admits one only when both its name and
  its package match the ticked entry, so another package registering the same
  name is refused. A single extension file with no package manifest is loaded
  and admitted by itself, never its directory. Known network tool names
  (`web_fetch`, `web_search`, `firecrawl_scrape`, `firecrawl_extract`, `mcp`, `mcpScript`, `remote_bash`, and any `mcp__*` name) are refused while Network access is Off; this is a name list, not a
  network sandbox. A ticked tool whose package can't be found is refused at launch. Ticked tools
  join the default tool list; an explicit `tools` list still decides.

Other tools are disabled in confined children and listed in launch output with
the reason. The launch line shows what was admitted, for example
`Runtime: isolated · guarded apply_patch · trusted web_fetch (@juicesharp/rpiv-web-tools)`.
Provider extensions are trusted runtime code; arbitrary extension tools are not
admitted merely because their names were requested. Confined children disable project
runtime configuration and inherited extension discovery. Startup or backend
failure never falls back to an unconfined child.

You still start Pi normally. The subagent package's internal launcher requires
Pi SDK 0.82.1 or newer; it is not a replacement user-facing Pi command.

### Git-mutating subagents and linked worktrees

Confined bash commands default to `GIT_OPTIONAL_LOCKS=0`, unless the inherited
environment or the call supplies a value. This keeps inventory commands such as
`git status` from creating an optional `index.lock` in the parent repository's
linked-worktree metadata. On macOS, Outside project = Write can permit creation
there but refuse unlink, leaving an empty lock even when status exits zero.
The default skips optional index refreshes; it does not disable required locks
for `git add` or commits, grant metadata removal, or remove existing locks.

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
- `delegationMode` — foreground policy (`manual`, `adaptive`, or `coordinator`;
  default `adaptive`). `/subagents mode ...` changes only the current session.
  `/subagents save` saves mode and cap together as config defaults.
- `maxConcurrent` — positive whole-number concurrency cap (**default 4**).
  `/subagents cap <number>` overrides it for this session. Both single and batch
  admissions respect the cap; existing runs are never stopped by a cap change.
  Use `/subagents settings` to edit both controls or `/subagents reset` to return
  to saved defaults.

## The allowlist also decides what LOADS

For confined children, the requested list is first restricted to tools with
verified task adapters and the trusted tools ticked in `/sandbox`; only the
ticked tools' packages load. `toolExtensions` still chooses which package to
load for a tool (an override), but the child admits it only if that is the
ticked package. Provider extensions can still load as trusted runtime
dependencies. Nested spawning and
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
  ordered tool-name sequences and default token/cost lines. Pass
  `include: ["cost"]` to `subagent_output` or `subagent_result` for one spend
  line (`spend: 1.2k tok (↑400 ↓800) · $0.0034`) and `include: ["tools"]` for
  one tool-call line (`tools: 7 calls · distinct: bash, read, edit`). The human
  toast may still include elapsed + spend; the model-facing callback does not.
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
- The Subagents lane pins a `main` row above child runs. It shows the
  foreground model, effort, active tool, context tokens, elapsed time, and
  delegation mode. Enter opens its detail sheet. `m` cycles the session mode.
  `ctrl+s` saves that mode as the config default. `x` still stops
  a child run; it never stops main.
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
- The transcript shows up to the latest 25 rows by default; `l` switches
  between 25 and 10 rows. The row count is a cap, not a guarantee: the metadata
  lines (provider, id, model, elapsed, tools, spend, pid, pgid) always stay
  visible, and on a short terminal the transcript shows only as many of its
  newest rows as fit below them. `subagent_result` and `subagent_output` page
  sizes are unaffected.
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

The live widget, default `subagent_list`, concurrency cap, and `session_start` ticker only include runs this pi process spawned (`spawnPid === process.pid`). The on-disk registry stays machine-global for durability. Default `subagent_list` is current-session, newest first, 10 compact rows / 1 KiB. Pass `limit:N` (max 100) or `max_bytes` (max 4 KiB) for an explicit larger page. Pass `all:true` for a global / foreign-session view. Pass `status:[...]` to filter by effective status: `running`, `completed`, `failed`, `killed`, transient `exited`, or durable `orphaned` / `lost`. Id-based `subagent_result` / `subagent_output` default to the current session; pass `all:true` to read a foreign-session id. Unknown ownership is a gap, not “not found”; when the current session identity cannot be read, no run's ownership is treated as verified and `all:true` is required. List pages are reached with the returned `nextCursor` (every run is reachable, not only the first 100). Runs whose metadata is missing or corrupt are reported as gaps and counted on lists, never as nonexistent.

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

Ordinary completion batching does not depend on Pi's `followUpMode`: events
stay in the harness until availability rather than becoming separate queued
follow-ups during the foreground run. Urgent health/failure alerts retain their
existing immediate follow-up behavior. This extension does not change Pi core
or Pi's default follow-up mode.

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
- **Navigator** — lifecycle status and operational health facts remain visible;
  child tool/model incident summaries and history are omitted from rows and detail
  chrome. Tool labels show just their name (for example, `bash`). The original
  transcript, including error results, and transcript-read diagnostics remain available.
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
