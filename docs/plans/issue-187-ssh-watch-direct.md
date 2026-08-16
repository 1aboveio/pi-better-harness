# Issue 187: SSH direct watch plan

- done - Direct SSH watch normalization: every SSH watch resolves to `remote.session=direct` with no tmux install; proven at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:75`.
- done - Remote poll condition matrix: all condition types at `packages/pi-better-background-tasks/src/runtime.test.ts:112`; interval evidence and failure precedence at `packages/pi-better-background-tasks/src/runtime.test.ts:135`.
- done - Transport failure: SSH exit 255 at `packages/pi-better-background-tasks/src/runtime.test.ts:168`; runner rejection evidence at `packages/pi-better-background-tasks/src/runtime.test.ts:198`.
- done - Lifecycle parity: terminal callbacks at `packages/pi-better-background-tasks/src/runtime.test.ts:262`, cancellation silence at `packages/pi-better-background-tasks/src/runtime.test.ts:299`, and local characterization at `packages/pi-better-background-tasks/src/runtime.test.ts:55`.
- done - Public entry points: structured SSH schema at `packages/pi-better-background-tasks/src/e2e.test.ts:60`; direct-watch guidance at `packages/pi-better-background-tasks/src/e2e.test.ts:88`.
- in-progress - Close-out: package checks, runtime smoke, scope classification, coverage/lint/ledger/scan gates, Review Contract, push, PR, and CI status.
