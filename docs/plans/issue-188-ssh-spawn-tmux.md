# Issue 188 SSH tmux spawn plan

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| AC1, AC2, AC5: default tmux mode bootstraps before a stable detached session start and fails closed | tmux launch lifecycle | done | `runtime.test.ts` - `defaults SSH spawn to a durable tmux session and captures remote output` |
| AC3, AC8: remote output reaches the durable local log and normal success/failure callbacks remain active | tmux supervision | done | `runtime.test.ts` - `defaults SSH spawn to a durable tmux session and captures remote output`; `queues normal terminal callbacks for succeeded and failed remote jobs` |
| AC4: stop kills the named remote tmux session before cancellation and suppresses callbacks | tmux stop lifecycle | done | `runtime.test.ts` - `kills the remote tmux session before cancelling without a completion callback` |
| AC6: successful tmux installation is disclosed in durable metadata and status text | bootstrap disclosure | done | `runtime.test.ts` - `persists and discloses a successful automatic tmux installation`; `e2e.test.ts` - `shows SSH target identity in compact status, list, and navigator labels` |
| AC7: explicit direct mode skips bootstrap, warns about weak stop, and never claims remote kill | direct escape hatch | done | `runtime.test.ts` - `runs explicit direct mode without bootstrap and warns that stop is local-only` |
| AC9: metadata stores remote mode, stable session name, and host identity | status and navigator metadata | done | `runtime.test.ts` - `defaults SSH spawn to a durable tmux session and captures remote output`; `e2e.test.ts` - `shows SSH target identity in compact status, list, and navigator labels` |
| AC10: lifecycle coverage uses the fake remote runner and no live SSH | external-boundary test topology | done | package suite: 11 files / 72 tests pass; all remote lifecycle cases use `FakeRemoteRunner` |
| Coverage and close-out gates | generated evidence and PR contract | todo | pending final HEAD |
