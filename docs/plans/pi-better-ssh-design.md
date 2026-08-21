# pi-better-ssh design

Authority: conversation choices (sync remote bash; `remote_bash` + profiles; `~/.ssh/config`; shared `ssh-core` with tmux helpers; extract-then-build); ADR `docs/adr/0001-pi-better-ssh-sync-remote-bash.md`; ADR `docs/adr/0002-ssh-core-shared-package.md`; epic #184 out-of-scope note that ControlMaster was deferred from background-tasks *as a product dependency*, not forever forbidden in a shared library.

Status: **proposed design — not implemented**.

## Problem

Agents doing Airflow / Spark / cluster ops issue many short remote commands (`airflow dags list`, `yarn application -list`, `hdfs dfs -ls`, log greps). Today that becomes:

```bash
ssh user@host 'cd /opt/airflow && airflow dags list'
```

inside the local `bash` tool. That is error-prone (quoting, `BatchMode`, jump hosts, cwd) and pays a full SSH handshake on every tool call. Epic #184 already solved *durable remote jobs* via `bg_task` + per-task tmux. It deliberately left connection reuse and sync remote shells out of scope. Those are the missing pieces for this workload.

Building sync remote bash as a second copy of SSH argv / identity / tmux bootstrap would fork the safety contract. The monorepo already has a pattern for this: private shared packages (`log-utils`, `callback-batcher`, …) synced into publishable extensions.

## Architecture

```
                    ┌─────────────────────────┐
                    │   packages/ssh-core     │  private workspace
                    │  identity, argv, mux,   │
                    │  runner seam, tmux      │
                    │  bootstrap/session API  │
                    └───────────┬─────────────┘
                                │ synced / imported
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│ pi-better-background-    │       │ pi-better-ssh            │
│ tasks                    │       │ (publishable extension)  │
│                          │       │                          │
│ spawn/watch/stop policy  │       │ remote_bash              │
│ task meta, logs,         │       │ ssh_profile / ssh_mux    │
│ callbacks, navigator     │       │ footer chip              │
│ uses ssh-core for SSH +  │       │ uses ssh-core for SSH +  │
│ per-task tmux lifecycle  │       │ ControlMaster sync exec  │
└──────────────────────────┘       └──────────────────────────┘
```

## Package responsibilities

### `packages/ssh-core` (private, not a Pi extension, not published)

Owns the **remote SSH protocol**:

| Area | Contents |
| --- | --- |
| Identity | Normalize `host` / `user` / `port` / `identity_file` / `jump` / `options`; resolve `target`; reject empty/whitespace tokens |
| Safe argv | Local `shell:false` ssh argv with required `BatchMode`, connect timeout, `-T`; options that cannot be disabled |
| Remote script | Workdir / env / optional preamble wrapping with safe encoding |
| Runner seam | Injectable `RemoteRunner` (`runOnce` / `spawn`) so CI uses fakes |
| ControlMaster | ControlPath keying, ensure/reuse/reopen/cleanup, status |
| Tmux helpers | Probe, package-manager install policy, needs-user guidance, session start / poll / kill / name helpers |

Does **not** own: Pi tools, task registry/meta, callbacks, navigator UI, goal activity, profile footer chrome, spawn-vs-watch product policy.

Source of truth today to extract: `packages/pi-better-background-tasks/src/remote-task-preset.ts` (+ related SSH types in `types.ts`, fake runner under `test-support/`).

Distribution: same as other internals — `private: true` workspace package, vendored into consumers via the existing sync script (or a dedicated sync entry), so published npm tarballs stay self-contained.

### `packages/pi-better-ssh` (publishable Pi extension)

Owns the **sync remote shell product**:

- Tools: `remote_bash`, `ssh_profile`, `ssh_mux`
- Active profile + footer status chip
- Truncation / bash-like result shaping
- Prompt guidelines: short remote → `remote_bash`; long remote → `bg_task_*` with `ssh`
- Not in `pi-better-harness` meta package on first publish

### `packages/pi-better-background-tasks` (existing)

Keeps owning durable **job** semantics:

- `bg_task_spawn` / `watch` / `stop` / logs / callbacks / navigator / reload resume
- Policy: spawn defaults to per-task tmux; watch is direct one-shot
- Becomes a *consumer* of `ssh-core` instead of inlining the preset

Optional later optimization (not required for extract correctness): when a ControlMaster for the target already exists (e.g. from `pi-better-ssh` in the same Pi process), bg_task control/poll argv may reuse it. Job correctness must not depend on mux.

## Non-goals (v1)

- Interactive password / keyboard-interactive auth.
- Full remote IDE (default override of `read` / `write` / `edit` / `ls` / `grep` / `find`).
- Persistent interactive shell / PTY attach / prompt-scraping sticky shell.
- Guaranteed remote kill for direct (non-tmux) fire-and-forget SSH.
- Windows OpenSSH matrix.
- Publishing `ssh-core` to npm.
- Putting `pi-better-ssh` into the harness meta package on first release.
- Making background-task correctness depend on ControlMaster.

## Goals (v1)

1. One shared SSH safety/tmux protocol (`ssh-core`).
2. Behavior-preserving extraction: existing bg_task SSH tests stay green after the move.
3. Sync `remote_bash` with ControlMaster amortization.
4. Local `bash` stays local; remote work is explicit.
5. Hosts addressed via `~/.ssh/config` Host aliases (and `user@host`).
6. Clear split: short sync vs long durable jobs.

## Recommended reuse strategy: hybrid

| Workload | Mechanism | Owner |
| --- | --- | --- |
| Frequent short sync commands | SSH ControlMaster + `remote_bash` | `pi-better-ssh` on `ssh-core` |
| Long-running remote jobs | Per-task remote tmux | `background-tasks` on `ssh-core` |
| Remote health polls | Direct one-shot SSH | `background-tasks` on `ssh-core` |

**Why not shared-tmux-first for sync?** Sync CLI output is correct as one remote command, not `tmux send-keys` + pane capture. Sticky shell state is fragile; use `workdir` / `env` / preamble instead. Per-task tmux remains the long-job lifecycle tool.

**ControlMaster (in `ssh-core`, used first by `pi-better-ssh`):**

- Ensure master on first sync call to a target; slaves reuse `ControlPath`.
- Socket under harness-owned `0700` dir, keyed by stable hash of connection identity (+ session scope).
- `ControlPersist` grace (proposal: 600s); best-effort cleanup on dispose/exit.
- Stale socket → one reopen, then fail.
- bg_task may ignore mux initially; optional reuse later.

## Agent-facing surface (`pi-better-ssh`)

| Tool | Purpose |
| --- | --- |
| `remote_bash` | Run one remote command; block for result (like local bash). |
| `ssh_profile` | `action: list \| use \| status \| clear` — session default host/workdir. |
| `ssh_mux` | `action: status \| stop` — inspect/tear down ControlMaster. |

`remote_bash` parameters (draft): `command` (required); `host` (optional if profile active); `workdir`; `timeout`; `env`; structured overrides `user` / `port` / `identity_file` / `jump` / `options` with required safety options enforced by `ssh-core`.

Active profile sets session defaults and a footer chip `SSH: host:workdir (mux up|down)`. Profiles name SSH config hosts; they are not a parallel host database.

v1 does **not** override built-in `bash` or route `!` through SSH by default.

## Execution model

```
remote_bash(command, host?)
  → resolve target (explicit host || active profile)
  → ssh-core.ensureMux(target)
  → ssh-core.buildExecArgv({ identity, remoteScript, mux: true })
  → runner.runOnce / streaming slave ssh
  → truncate like Pi bash; return bash-shaped result + mux details
```

Long job path (unchanged product behavior, new implementation home):

```
bg_task_spawn(..., ssh, remote)
  → ssh-core.expandRemoteTask(...) / bootstrapTmux / startTmuxSession
  → background-tasks owns meta, local log copy, stop → ssh-core.killTmuxSession
```

Remote shell policy for sync (proposal): prefer `bash -c` + optional preamble over always `bash -lc`. Final AC after probing operator hosts.

## Delivery order (extract then build)

| Slice | What | Proof |
| --- | --- | --- |
| **S0** | Design/ADR accepted (this doc) | review |
| **S1** | Create `packages/ssh-core`; move identity, argv, runner seam, tmux helpers out of `remote-task-preset.ts`; sync into background-tasks; thin preset wrapper remains for task-specific intent types | existing `remote-task-preset.test.ts` + runtime/e2e SSH tests green with no intentional behavior change |
| **S2** | Add ControlMaster API to `ssh-core` with unit/fake-runner tests; background-tasks does not have to call it yet | ssh-core mux tests |
| **S3** | Scaffold `pi-better-ssh` with `remote_bash` (may ship mux from day one once S2 exists) | new package tests |
| **S4** | `ssh_profile` + footer; `ssh_mux` tool | package tests + light e2e |
| **S5** | Docs cross-links; bg_task usage points short remote work at `pi-better-ssh`; optional "reuse mux if present" on bg_task control path | docs/contract tests |
| **S6** | (Later) optional full-session bash override mode | separate ADR |

S1 is the highest-risk slice and must be behavior-preserving. Prefer mechanical move + re-export shims over clever redesign in the same PR.

## Security & safety

- `BatchMode=yes` always; never wait on password prompts.
- ControlPath directory mode `0700`.
- Identity *path* may appear in verbose status; never key material.
- Quoting owned by `ssh-core` (local `shell:false`; safe remote script encoding).
- `ProxyJump` / `jump` without shell interpolation.

## Failure modes (operator-visible)

| Case | Behavior |
| --- | --- |
| No `host` and no active profile | Hard error with usage hint |
| Auth / host key failure | Fail fast; surface ssh stderr |
| Mux socket stale | One reopen; then fail |
| Timeout on sync | Kill slave ssh; mux master remains |
| Remote non-zero | Return exit code + output (like local bash) |
| Tmux missing (bg spawn) | Existing needs-user / install policy via `ssh-core` |

## Testing strategy

- **`ssh-core`**: unit tests for argv, identity, script wrap, mux keying, tmux bootstrap matrix — all on fake runner (port existing preset tests).
- **`background-tasks`**: keep current SSH runtime/e2e/golden coverage as the extraction acceptance gate.
- **`pi-better-ssh`**: tool schema/contract tests; fake-runner exec; truncation; profile resolve.
- Live SSH only behind an explicit opt-in env flag.

## Open questions for implementation ACs

1. Default remote shell invocation for sync: `bash -c` + preamble vs `bash -lc`?
2. `ControlPersist` default seconds? (proposal: 600)
3. `remote_bash`: command string only in v1, or also remote `argv` + `shell:false`?
4. Persist active profile across `/reload`? (proposal: yes)
5. Sync script: extend `scripts/sync-shared-log-utils.mjs` vs add `sync-shared-ssh-core.mjs`?
6. After S1, keep `expandSshRemoteTaskPreset` as a thin bg_task-specific façade over `ssh-core`, or rename call sites to `ssh-core` APIs directly?

## Decision summary

- Add private **`ssh-core`** shared by both packages (including tmux helpers).
- **Extract from background-tasks first**, prove with existing tests, **then** build **`pi-better-ssh`**.
- Sync product tool: **`remote_bash`**; hosts via **`~/.ssh/config`**.
- Reuse: **ControlMaster for sync**; **per-task tmux for long jobs**.
- Do not override local bash in v1; do not publish `ssh-core`; do not meta-bundle `pi-better-ssh` on first release.
