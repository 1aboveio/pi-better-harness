# Issue 186 remote tmux bootstrap plan

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| AC1: probe reports a usable tmux path and version | preset bootstrap probe | done | `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:6` |
| AC2, AC3: ordered PM detection and root / `sudo -n` / brew install policy | package and privilege resolution | done | `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:49` |
| AC4: successful install re-probes and discloses host mutation | install success | done | `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:49` |
| AC5, AC6: all closed outcomes provide host-scoped install and verify guidance, including probe-only mode | operator guidance | done | `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:112` |
| AC7: bootstrap has an enforced whole-operation timeout | bounded external runner | done | `packages/pi-better-background-tasks/src/process.test.ts:22`; `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:275` |
| AC8: every scenario uses the preset seam's fake external runner | seam-level scenario matrix | done | `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:8` |
| Coverage and close-out gates | generated evidence and PR contract | todo | pending final HEAD |
