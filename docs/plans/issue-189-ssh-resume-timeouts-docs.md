# Issue 189: SSH resume, timeouts, and operator contract

Authority: issue #184 design and out-of-scope list; issue #189 approved acceptance criteria; contract revision `f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51`.

Approved test seam: background-task runtime/tool behavior with the injectable fake remote runner; local process/watch behavior stays on the existing runtime seam.

| Slice | Acceptance criteria / obligation | State | Proof |
| --- | --- | --- | --- |
| Integrate direct SSH watch | Preserve #187 direct one-shot polling, transport failures, conditions, and local-watch characterization while combining it with #188 tmux spawn | done | package typecheck + 11 files / 85 tests passed at merge commit `b3fb89a` |
| Resume persisted remote tasks | Tmux spawn resumes polling without bootstrap/session creation; direct watch resumes its SSH target and conditions; duplicate in-process supervision is avoided | done | `runtime.test.ts`: "resumes a persisted tmux session..." and "resumes a persisted direct SSH watch..."; focused suite 48/48 passed |
| Bound remote execution | Explicit/default watch deadlines and spawn deadlines produce `timed_out`; tmux timeout kills the remote session; direct mode reports weak remote-stop semantics | done | `runtime.test.ts`: SSH tmux/watch/direct timeout tests; focused suite 48/48 passed |
| Operator-facing contract | Compact launch/status identify host and mode; verbose status retains non-secret support metadata; docs/tool descriptions cover structured SSH, tmux bootstrap/install/needs-user, direct watch/escape hatch, fail-closed behavior, and no ControlMaster | done | `e2e.test.ts` tool/docs/status contract tests; package README + `docs/usage.md`; full package suite GREEN |
| Local regression obligation | Local-only spawn/watch behavior and existing callback/log/stop contracts remain unchanged | done | package typecheck + 11 files / 92 tests passed, including local watch characterization and golden path |
| Close-out evidence | Runtime smoke, scope classification, ledger/checklist, lint sweeps, scan-diff, exact-head evidence, CI, and PR Review Contract | in-progress | local/root suites, runtime smoke, scope classification, lint sweeps, empty scan findings, and checklist validation complete; final push/CI/PR evidence pending |
