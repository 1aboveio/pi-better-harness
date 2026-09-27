# pi-better-background-tasks

`pi-better-background-tasks` is a Pi extension for durable background shell tasks, watchers, logs, and status inspection.

## Quick Answer

Use `pi-better-background-tasks` when a command should keep running while the foreground Pi session stays free. It is best for dev servers, long scripts, queue watchers, deploy checks, log tails, and other command-driven work.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-background-tasks.png" alt="pi-better-background-tasks rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-background-tasks.png" alt="pi-better-background-tasks package overview" width="49%" /></p>

## Core Features

- Start long-running commands without blocking the current turn.
- Watch commands until success, failure, or timeout.
- Keep task metadata and logs available across reloads.
- Retain completed task artifacts for seven days, then remove them during rate-limited maintenance.
- Show active work in Pi's background-work navigator.
- Flag running tasks with no observable output or completed poll as stalled.
- Confine local task writes to the project directory when `pi-better-sandbox` is enabled.

## Write Sandbox

When [`pi-better-sandbox`](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-sandbox#readme)
is installed and enabled, every **local** task captures
the effective foreground policy at launch and runs under the platform's write
sandbox: reads and network stay unrestricted, writes are confined to the
canonical project directory, and denied paths stay denied.

The policy is captured once, when the task starts. The foreground sandbox is
inactive by default, so local tasks ordinarily launch unconfined. A later
`/sandbox on`, `/sandbox off`, `/sandbox default on|off`, or a deny-rule change
reaches tasks launched after it; a task
already running — including a watcher resumed in a later Pi session — keeps the
policy it started with.

If the foreground sandbox reports `unavailable` or `failed`, a local launch is
refused with an explanation instead of running unconfined. `/sandbox off` is the
deliberate way to run local tasks unsandboxed.

A task follows Main's permission profile. With Main's Outside project = Write, the
task writes across home and temp but can remove files outside the project only in
temp, hidden home directories, and worktree folders (see
[pi-better-sandbox](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-sandbox#readme)).
On macOS, a task launched with Outside project = Write or Write & delete starts an
APFS local snapshot (`tmutil localsnapshot`) in the background as a recovery aid.
A failed snapshot is noted in the task log and never blocks the task.

Structured remote SSH tasks are unaffected: the foreground sandbox describes this
machine, and remote work keeps its existing remote semantics. Without
`pi-better-sandbox` installed, local tasks behave exactly as they always have.

Reads and network access are never restricted; only writes are. Pi's own
process, `pi.exec` calls, and unrelated third-party extension code stay outside
the guarantee, and confinement is per surface: a confined process on another
first-party surface can still write this one's task registry. Installing
[`pi-better-harness`](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-harness#readme)
installs the sandbox extension, but leaves foreground tools and local background
tasks inactive until a human opts in.

## Remote SSH

For short synchronous remote commands that should return output in the current
turn, install `pi-better-ssh` and use `remote_bash`. Use background tasks for
long-running or durable remote jobs and asynchronous health watches.

Prefer structured `ssh` fields over hand-written `ssh` command lines. A remote
spawn uses a durable tmux session by default, while a remote watch opens one
direct SSH poll per interval and does not require tmux. The package keeps the
same local metadata, logs, terminal statuses, callbacks, and `/reload` recovery
for both.

```json
{
  "name": "remote build",
  "command": "npm run build",
  "ssh": { "host": "build.example", "user": "deploy" },
  "remote": { "workdir": "/srv/app" },
  "timeout_seconds": 1800
}
```

Tmux-backed spawn can install tmux non-interactively when the remote host allows
it and fails closed with copy-pasteable setup guidance when it cannot. Set
`remote.session=direct` only as an explicit escape hatch for short jobs: stop or
timeout can terminate the local SSH client but the remote process may still be
running. See the detailed usage notes for bootstrap policy, watch conditions,
timeouts, and v1 non-goals.

## Reloads and session switches

Tasks belong to the Pi session that started them. After `/reload`, the same
session picks every task back up: watches keep polling, remote tmux output keeps
being collected, and a task that finished during the reload (or exits later) gets
its completion callback exactly once.

After `/new`, `/resume`, fork, or switching to another session, the previous
session's tasks keep running but are paused from Pi's side: watches do not poll,
remote tmux output is not collected, and `timeout_seconds` deadlines are not
enforced until that session is active again. An overdue deadline is enforced as
soon as the session resumes, so a timeout can land late but is never skipped. A
local process that exits in the meantime is recorded as finished, and its
callback is delivered when its session resumes.

## Watch conditions

JSON conditions require a root-prefixed path, such as `$.status` or
`$.terminalFailure`; bare keys such as `status` are rejected before the command
starts. For a command that emits `{"status":"FAILURE","terminalFailure":true}`,
use:

```json
{
  "success_when": { "type": "json_path_equals", "path": "$.status", "value": "SUCCESS" },
  "failure_when": { "type": "json_path_equals", "path": "$.terminalFailure", "value": true }
}
```

Persisted watchers with unsupported paths fail explicitly on their next poll.
Missing JSON fields or invalid JSON output remain retryable; task status shows
the condition evaluation error until a subsequent poll recovers. Keep a finite
timeout to bound watches whose output never becomes evaluable.

## Install

```sh
pi install npm:pi-better-background-tasks
```

Try it for one run:

```sh
pi -e npm:pi-better-background-tasks
```

## Failure observations

Task lifecycle and failure evidence are reported separately. A watch can remain
`running` while a poll or condition evaluator has failed. Status, list, log, and
navigator views show unresolved observations before ordinary progress. A success
match cannot finish a watch while evaluation of its failure condition is broken;
a definite failure match still terminates it.

Observations live in `failures.jsonl` beside task metadata. Recovery requires a
successful evaluation of the same operation. Repeated failures are grouped, and
an explicitly configured nonzero success exit is treated as expected. Verbose
status includes observation details and the journal path. Corrupt or unreadable
evidence is reported as **observation incomplete**.

Pass `operation_id` and `expected_exit_codes` on `bg_task_spawn`, `bg_task_watch`,
or `bg_task` to declare intent before launch; a malformed declaration starts
nothing. An exit code in `expected_exit_codes` (distinct integers 1-255, such as
`[1]` for a no-match probe) is recorded as an **Expected failure** that needs no
action; signals and timeouts never are. When a task with an `operation_id`
succeeds, earlier failed tasks with the same `operation_id`, kind, cwd, SSH
target, and owner (the same session id, or for sessionless tasks the same Pi
process) recover, so a retry with a changed command or timeout
closes the original incident. Observation gaps are never recovered this way, and
no command text is compared.

Task failures are labeled **Action required**; the shared labels also include
**Expected failure** and **Observation incomplete**. Unresolved running failures
become eligible for attention after 60 seconds; observation gaps are eligible
immediately. Each notification lists only the incidents it is delivering;
earlier ones are counted, not repeated. Terminal failures use the normal
completion notification. A delivery receipt is stored only after handoff;
notification delivery does not clear the failure. `callback:false` stays quiet
while all inspection surfaces retain the evidence. Journals follow the task's
existing retention and explicit-clear behavior.

Status, log, and list count and list only failures that need action (**Action
required** and **Observation incomplete**). Expected and closed failures are one
history count line with no incident cursor; pass `history: true` to
`bg_task_status` (or `action:status`) to page them. Incident rows are compact
(120-byte excerpt, evidence such as `output.log#poll=3`); the raw log keeps the
full evidence path.

## When To Use

Use this package for shell commands that need logs, status, cancellation, or completion notifications across a Pi turn.

Do not use it for short commands where the foreground session should wait for the result directly; use `remote_bash` from `pi-better-ssh` instead.

## Compatibility

| Requirement | Support |
|-------------|---------|
| Pi | Required |
| Install method | `pi install npm:pi-better-background-tasks` |
| Development runtime | Node.js 22+ |

## Update Or Remove

```sh
pi update npm:pi-better-background-tasks
pi remove npm:pi-better-background-tasks
```

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-background-tasks/docs/usage.md
- License: https://github.com/1aboveio/pi-better-harness/blob/main/LICENSE
