# pi-better-ssh design

Authority: conversation choice (sync remote bash; reuse advice; design-doc-first; `remote_bash` + profiles; reuse `~/.ssh/config`); ADR `docs/adr/0001-pi-better-ssh-sync-remote-bash.md`; epic #184 out-of-scope note that ControlMaster was deferred from background-tasks.

Status: **proposed design — not implemented**.

## Problem

Agents doing Airflow / Spark / cluster ops issue many short remote commands (`airflow dags list`, `yarn application -list`, `hdfs dfs -ls`, log greps). Today that becomes:

```bash
ssh user@host 'cd /opt/airflow && airflow dags list'
```

inside the local `bash` tool. That is error-prone (quoting, `BatchMode`, jump hosts, cwd) and pays a full SSH handshake on every tool call. Epic #184 already solved *durable remote jobs* via `bg_task` + per-task tmux. It deliberately left connection reuse and interactive/sync remote shells out of scope. Those are the missing pieces for this workload.

## Non-goals (v1)

- Replacing or rewriting the #184 bg_task SSH preset.
- Interactive password / keyboard-interactive auth (fail fast with `BatchMode`, same as bg_task).
- Full remote IDE: overriding `read` / `write` / `edit` / `ls` / `grep` / `find` by default.
- Persistent interactive shell / PTY attach UX / `send-keys` into a shared shell that preserves cwd/env across calls by scraping prompts.
- Guaranteeing remote process kill for fire-and-forget direct SSH (bg_task already documents that weakness).
- Windows OpenSSH matrix.
- Auto-installing OpenSSH client locally.

## Goals (v1)

1. **Sync remote exec** that waits for stdout/stderr/exit and returns a bash-like truncated result.
2. **Amortize connection cost** across many short calls in one Pi session.
3. **Keep local `bash` local** — remote work uses an explicit tool.
4. **Address hosts via `~/.ssh/config` Host aliases** (and ordinary `user@host`), not a parallel connection inventory.
5. **Compose with bg_task SSH** for long jobs without duplicating tmux lifecycle.
6. **Agent-safe defaults**: `BatchMode`, connect timeout, no TTY on the exec path, structured argv (`shell:false` locally).

## Recommended reuse strategy: hybrid

| Workload | Mechanism | Why |
| --- | --- | --- |
| Frequent short sync commands (`remote_bash`) | **SSH ControlMaster / ControlPath** | Handshake once; each call is a cheap mux slave. No remote daemon required. Correctness does not depend on prompt scraping. |
| Long-running remote jobs | **Existing `bg_task_*` + per-task tmux** | Already ships durable logs, real remote stop, reload resume. Keep that contract. |
| Optional later | Shared remote "workspace" tmux | Only if operators need sticky remote cwd/env/conda across sync calls. Not required to fix handshake cost. |

**Why not shared-tmux-first for sync?**

- Sync CLI output is easiest and most correct as one SSH remote command (`ssh host -- cmd`), not `tmux send-keys` + pane capture.
- Sticky shell state (activated venv, `cd`, exported vars) sounds nice for Spark, but prompt detection and interleaved output are fragile and hard to test. Prefer an explicit `workdir` / `env` / optional `preamble` on each call (or a profile default) in v1.
- Epic #184 already owns per-task tmux. A second "always-on host tmux" for sync would confuse stop/lifecycle semantics.

**ControlMaster details (proposed):**

- On first `remote_bash` to a target in a Pi process, ensure a local master: `ssh -o ControlMaster=auto -o ControlPersist=<N> -o ControlPath=<socket> … -fN` (or equivalent `-M -S` form).
- Subsequent calls add `-o ControlPath=<same>` (and still enforce `BatchMode`, connect timeout, `-T`).
- Socket path under a harness-owned directory (e.g. OS temp / `XDG_RUNTIME_DIR`), keyed by a stable hash of `{user,host,port,identity,jump}` plus Pi session id — never a predictable world-writable path.
- Master lifetime: Pi session / process lifetime with `ControlPersist` grace (proposal: 10 minutes). Clean up sockets on extension dispose / process exit best-effort.
- If the operator's `~/.ssh/config` already enables multiplexing for that Host, prefer not fighting it: inject only required safety options; document that pre-existing ControlPath configs are compatible when they point at a usable master.
- Multiplexing failure (socket gone, master dead) → one transparent re-open, then surface the error. Do not hang.
- **Do not** make bg_task's correctness depend on ControlMaster in v1. Optionally, a later slice can teach the bg_task SSH argv builder to *reuse* an existing master when present; that is an optimization, not a dependency.

## Package shape

New publishable workspace: `packages/pi-better-ssh` → npm `pi-better-ssh`.

- **Not** in the `pi-better-harness` meta package for the first release (same posture as `pi-better-read-aloud`).
- May later share pure helpers (SSH argv construction, identity normalization) with `pi-better-background-tasks` via a tiny internal module — only after the sync contract stabilizes. No runtime coupling in v1.

## Agent-facing surface

### Tools

| Tool | Purpose |
| --- | --- |
| `remote_bash` | Run one remote command; block for result (like local bash). |
| `ssh_profile` | `action: list \| use \| status \| clear` — optional active default host for subsequent `remote_bash` calls that omit `host`. |
| `ssh_mux` | `action: status \| stop` — inspect/tear down ControlMaster for a target or all. Operator/agent escape hatch; not required on the happy path. |

`remote_bash` parameters (draft):

- `command` (required) — remote command string; executed by remote login/non-login shell policy documented below.
- `host` (optional if an active profile exists) — SSH config Host alias or `user@host`.
- `workdir` (optional) — remote cwd for this call; default from active profile or remote `$HOME`/`pwd`.
- `timeout` (optional, seconds) — default aligned with Pi bash expectations; kill the *local* slave ssh on timeout (mux master stays up).
- `env` (optional) — extra remote env vars for this call only.
- Structured overrides only when Host alias is insufficient: `user`, `port`, `identity_file`, `jump`, `options` — same shape spirit as bg_task `ssh`, with the same required safety options that cannot be disabled.

### Active profile

- `ssh_profile use host=airflow-prod workdir=/opt/airflow` sets session-local defaults.
- Footer/status chip: `SSH: airflow-prod:/opt/airflow (mux up|down)`.
- `clear` restores "no default host"; `remote_bash` without `host` then errors clearly.
- Profiles do **not** invent a parallel host database: they name SSH config hosts and attach optional `workdir` / default `env` / label.

### What we deliberately do not do in v1

- Override built-in `bash` when a profile is active (Pi example `ssh.ts` mode). Can be a v2 flag for "entire session is remote" workflows.
- Route `!` user bash through SSH by default. Optional later via `user_bash` hook when a profile is active.

## Execution model

```
remote_bash(command, host?)
  → resolve target (explicit host || active profile)
  → ensure ControlMaster for target
  → build local argv:
      ssh -o BatchMode=yes -o ConnectTimeout=10 -T
         -o ControlPath=…  [-o ControlMaster=auto … on ensure]
         [port/user/identity/jump/options]
         -- target
         remote_script
  → remote_script wraps: cd workdir (if set); env assignments; command
  → stream stdout+stderr to tool updates; truncate like Pi bash (50KB / 2000 lines)
  → return { output, exitCode, cancelled, truncated, details: { host, target, workdir, mux: up|reopened|direct } }
```

Remote shell policy (proposal): run with `ssh host -- bash -lc <script>` only if we need login-profile semantics; prefer `bash -c` with an optional profile-configured `preamble` (`source ~/.bashrc` fragment) so Airflow/Spark modules can be loaded without always taking a full login tax. Final choice belongs in implementation ACs after probing typical operator hosts.

## Relationship to `pi-better-background-tasks`

| Concern | Owner |
| --- | --- |
| Sync short remote CLI | `pi-better-ssh` `remote_bash` |
| Connection mux | `pi-better-ssh` |
| Long remote job + durable log + remote stop | `bg_task_spawn` + SSH tmux (existing) |
| Remote poll / health watch | `bg_task_watch` + SSH direct (existing) |
| Prompt guidance | Both: "short remote → `remote_bash`; long remote → `bg_task_*` with `ssh`" |

Shared later (optional): extract `expandSshArgv` / identity types so both packages emit identical safety options. Not a launch blocker.

## Security & safety

- `BatchMode=yes` always; never wait on password prompts.
- ControlPath directory mode `0700`; sockets not world-accessible.
- Do not log private key paths' file contents; identity *path* in verbose status is OK (same as bg_task).
- Quoting owned by the package (local `shell:false` argv; remote script built with safe encoding, e.g. base64 or carefully JSON-stringified fragments — follow bg_task / Pi ssh example lessons).
- Respect OpenSSH `ProxyJump` / `jump` without shell interpolation.

## Failure modes (operator-visible)

| Case | Behavior |
| --- | --- |
| No `host` and no active profile | Hard error with usage hint |
| Auth failure / host key | Fail fast; surface ssh stderr; do not retry forever |
| Mux socket stale | One reopen; then fail |
| Timeout | Kill slave ssh; report timeout; mux master remains |
| Remote command non-zero | Return exit code + output (not an exception) — same as local bash |
| SSH config Host missing | OpenSSH error surfaced verbatim |

## Testing strategy

- Unit: argv builder, ControlPath keying, profile resolve, script wrapping, truncation.
- Fake SSH runner seam (mirror bg_task `RemoteRunner` / `FakeRemoteRunner`) — no live SSH in default CI.
- Optional opt-in live test behind env flag against a local `sshd` or container.
- Contract tests: tool schemas, prompt snippets steering agents away from raw `ssh` in local bash, docs mention hybrid with bg_task.

## Rollout slices (suggested issues after approval)

1. **Scaffold + `remote_bash` without mux** — structured host, safe argv, workdir, timeout, truncation; each call is a fresh ssh (behavior ceiling = today's hand-rolled ssh, but safer).
2. **ControlMaster ensure/reuse/cleanup + `ssh_mux`** — the latency win.
3. **`ssh_profile` use/list/status/clear + footer chip**.
4. **Docs, prompt guidelines, gallery; optional helper note in bg_task usage pointing at `pi-better-ssh` for sync**.
5. **(Later)** Optional share of SSH argv helpers with bg_task; optional "reuse mux if present" on bg_task control path; optional full-session bash override mode.

## Open questions for implementation ACs

1. Default remote shell invocation: `bash -c` + preamble vs `bash -lc`?
2. `ControlPersist` default seconds?
3. Should `remote_bash` accept `argv: string[]` + `shell:false` remote-side, or only a command string in v1?
4. Session persistence of active profile across `/reload` (yes/no)? Proposal: yes, store under session-scoped state next to other harness metadata.
5. Name bikeshed: `remote_bash` vs `ssh_exec` vs `ssh_bash` — current preference `remote_bash` (pairs with local `bash`).

## Decision summary

- Build **`pi-better-ssh`** as a design-first new package.
- Primary tool: **`remote_bash`** (sync).
- Hosts: **`~/.ssh/config` aliases**.
- Reuse: **ControlMaster for sync**; **existing bg_task tmux for long jobs**.
- Do not override local bash in v1.
- Do not put this into the harness meta package on first publish.
