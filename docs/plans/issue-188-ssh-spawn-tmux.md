# Issue 188 SSH tmux spawn plan

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| AC1, AC2, AC5: default tmux mode bootstraps before a stable detached session start and fails closed | tmux launch lifecycle | done | `runtime.test.ts` - `defaults SSH spawn to a durable tmux session and captures remote output` |
| AC3, AC8: remote output reaches the durable local log and normal success/failure callbacks remain active | tmux supervision | in-progress | success/output proven by `runtime.test.ts` - `defaults SSH spawn to a durable tmux session and captures remote output`; failure/callback pending |
| AC4: stop kills the named remote tmux session before cancellation and suppresses callbacks | tmux stop lifecycle | todo | pending TDD integration test |
| AC6: successful tmux installation is disclosed in durable metadata and status text | bootstrap disclosure | todo | pending TDD integration/e2e tests |
| AC7: explicit direct mode skips bootstrap, warns about weak stop, and never claims remote kill | direct escape hatch | todo | pending TDD integration/e2e tests |
| AC9: metadata stores remote mode, stable session name, and host identity | status and navigator metadata | todo | pending TDD integration/e2e tests |
| AC10: lifecycle coverage uses the fake remote runner and no live SSH | external-boundary test topology | todo | pending package suite and mock-policy gates |
| Coverage and close-out gates | generated evidence and PR contract | todo | pending final HEAD |
