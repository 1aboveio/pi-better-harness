# Issue 185 SSH preset seam plan

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| AC3, AC4, AC6: remote command expands to safe `shell:false` SSH argv through one injectable runner seam | preset expansion | done | `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:26` |
| AC1, AC2: spawn/watch/action schemas accept structured `ssh` and minimal `remote` fields | tool contract | todo | pending |
| AC5: task metadata and compact surfaces retain/show SSH target and remote command | runtime metadata and labels | in-progress | runtime proven at `packages/pi-better-background-tasks/src/runtime.test.ts:67` and `packages/pi-better-background-tasks/src/runtime.test.ts:147`; labels pending |
| AC7: omitting `ssh` preserves local spawn/watch behavior | local characterization/regression | todo | existing runtime/e2e suites |
| AC8: tool descriptions steer remote work to structured `ssh` | tool contract | todo | pending |
| Coverage and close-out gates | generated evidence | todo | pending |
