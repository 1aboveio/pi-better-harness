# pi-better-ssh

A Pi extension for short synchronous remote commands over safe, reusable SSH connections. It adds `remote_bash`; Pi's built-in `bash` remains local.

## Install

```bash
pi install npm:pi-better-ssh
```

Configure destinations as `Host` aliases in `~/.ssh/config`, or pass `user@host` directly.

## Tool

`remote_bash` requires `command` and `host`. It also accepts remote `workdir`, `env`, a timeout in seconds, and structured `user`, `port`, `identity_file`, `jump`, and SSH `options` overrides.

```json
{
  "command": "airflow dags list",
  "host": "airflow-prod",
  "workdir": "/opt/airflow",
  "env": { "AIRFLOW_HOME": "/opt/airflow" },
  "timeout": 30
}
```

Commands run through `bash -c` with safely quoted workdir and environment setup. SSH uses `shell:false`, `BatchMode=yes`, a bounded connect timeout, no TTY, and a harness-owned ControlMaster. Caller options cannot disable those requirements. A command timeout terminates only the slave SSH process; the reusable master remains available.

Remote non-zero exits are returned as normal tool results with `output` and `exitCode`. Output follows Pi bash limits: the last 2,000 lines or 50KB, whichever is reached first. Complete truncated output is retained in a local temporary file.

Use `remote_bash` for short commands that need an immediate result. Use `bg_task_spawn` and the `bg_task_*` lifecycle tools with structured `ssh` for long-running or durable remote jobs.
