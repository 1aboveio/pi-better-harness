# Issue 187: SSH direct watch plan

- done - Direct SSH watch normalization: every SSH watch resolves to `remote.session=direct` with no tmux install; proven at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:75`.
- done - Remote poll condition matrix: all condition types at `packages/pi-better-background-tasks/src/runtime.test.ts:112`; interval evidence and failure precedence at `packages/pi-better-background-tasks/src/runtime.test.ts:135`.
- done - Transport failure: SSH exit 255 at `packages/pi-better-background-tasks/src/runtime.test.ts:168`; runner rejection evidence at `packages/pi-better-background-tasks/src/runtime.test.ts:198`.
- in-progress - Lifecycle parity: fake remote polls prove timeout, terminal callback, and silent cancellation; existing local watcher tests characterize the no-SSH path.
- todo - Public entry points: prove `bg_task_watch` and `bg_task` action watch retain structured SSH input and direct-watch guidance.
- todo - Close-out: package checks, runtime smoke, scope classification, coverage/lint/ledger/scan gates, Review Contract, push, PR, and CI status.
