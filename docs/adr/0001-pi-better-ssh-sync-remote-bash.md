# Sync remote bash lives in `pi-better-ssh`, not in background-tasks

Epic #184 gave `pi-better-background-tasks` durable remote *jobs* (spawn/watch/stop via per-task tmux). Frequent short remote commands for Airflow/Spark need a different contract: wait for stdout/stderr/exit like local `bash`, amortize SSH handshake cost, and keep local bash untouched. That belongs in a new package `pi-better-ssh` with an explicit `remote_bash` tool and `~/.ssh/config` Host aliases, using SSH ControlMaster for sync reuse and leaving long-job lifecycle to the existing bg_task SSH preset.

## Status

proposed

## Considered Options

1. **Extend `pi-better-background-tasks` with sync `remote_bash`** — smallest ship path, but mixes "never block the turn" with "wait for this command" and invites agents to misuse spawn for short CLI checks.
2. **Override built-in `bash` when a host is active** (Pi `examples/extensions/ssh.ts`) — excellent for "this whole session is on host X", surprising for mixed local+remote Airflow workflows where local edits and remote `airflow`/`spark-submit` coexist.
3. **New `pi-better-ssh` with explicit `remote_bash` + SSH-config hosts** — chosen. Clear tool choice, reuses operator SSH config, keeps bg_task focused on durable jobs, and can later share argv/safety helpers with the SSH preset without merging runtimes.

## Consequences

- Connection multiplexing (ControlMaster) becomes in-scope for sync exec; epic #184's "no ControlMaster" non-goal remains true for the background-task package itself.
- Agents must select `remote_bash` (or an active profile helper) instead of inventing `ssh ...` inside local `bash`.
- Long-running remote jobs continue to use `bg_task_*` with structured `ssh`; `pi-better-ssh` should not reimplement tmux job supervision in v1.
