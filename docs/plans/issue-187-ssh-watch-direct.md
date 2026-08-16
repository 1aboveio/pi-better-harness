# Issue 187: SSH direct watch plan

- done - Direct SSH watch normalization: every SSH watch resolves to `remote.session=direct` with no tmux install; proven at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:75`.
- in-progress - Remote poll condition matrix: scripted fake-runner polls prove exit code, stdout/stderr contains, JSON path equals/exists, success/failure precedence, and per-poll durable logs.
- todo - Transport failure: fake SSH exit 255 and runner rejection produce readable failed metadata and durable log evidence.
- todo - Lifecycle parity: fake remote polls prove timeout, terminal callback, and silent cancellation; existing local watcher tests characterize the no-SSH path.
- todo - Public entry points: prove `bg_task_watch` and `bg_task` action watch retain structured SSH input and direct-watch guidance.
- todo - Close-out: package checks, runtime smoke, scope classification, coverage/lint/ledger/scan gates, Review Contract, push, PR, and CI status.
