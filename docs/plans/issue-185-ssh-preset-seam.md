# Issue 185 SSH preset seam plan

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| AC3, AC4, AC6: remote command expands to safe `shell:false` SSH argv through one injectable runner seam | preset expansion | done | `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:26` |
| AC1, AC2: spawn/watch/action schemas accept structured `ssh` and minimal `remote` fields | tool contract | done | `packages/pi-better-background-tasks/src/e2e.test.ts:59` |
| AC5: task metadata and compact surfaces retain/show SSH target and remote command | runtime metadata and labels | done | runtime at `packages/pi-better-background-tasks/src/runtime.test.ts:67` / `packages/pi-better-background-tasks/src/runtime.test.ts:147`; labels at `packages/pi-better-background-tasks/src/e2e.test.ts:125` |
| AC7: omitting `ssh` preserves local spawn/watch behavior | local characterization/regression | done | package suite: 11 files / 50 tests pass, including unchanged local runtime/e2e/golden paths |
| AC8: tool descriptions steer remote work to structured `ssh` | tool contract | done | `packages/pi-better-background-tasks/src/e2e.test.ts:59` |
| Coverage and close-out gates | generated evidence | in-progress | checklist validation/lints/scan pass; root ledger and CI adoption are inherited blockers recorded in `docs/tests/_generated/coverage-checklist-185.md` |
