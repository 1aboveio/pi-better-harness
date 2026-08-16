# Issue 189: SSH resume, timeouts, and operator contract

Authority: issue #184 design and out-of-scope list; issue #189 approved acceptance criteria; contract revision `f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51`.

Approved test seam: background-task runtime/tool behavior with the injectable fake remote runner; local process/watch behavior stays on the existing runtime seam.

| Slice | Acceptance criteria / obligation | State | Proof |
| --- | --- | --- | --- |
| Integrate direct SSH watch | Preserve #187 direct one-shot polling, transport failures, conditions, and local-watch characterization while combining it with #188 tmux spawn | in-progress | pending integration test run |
| Resume persisted remote tasks | Tmux spawn resumes polling without bootstrap/session creation; direct watch resumes its SSH target and conditions; duplicate in-process supervision is avoided | todo | pending RED/GREEN runtime tests |
| Bound remote execution | Explicit/default watch deadlines and spawn deadlines produce `timed_out`; tmux timeout kills the remote session; direct mode reports weak remote-stop semantics | todo | pending RED/GREEN runtime tests |
| Operator-facing contract | Compact launch/status identify host and mode; verbose status retains non-secret support metadata; docs/tool descriptions cover structured SSH, tmux bootstrap/install/needs-user, direct watch/escape hatch, fail-closed behavior, and no ControlMaster | todo | pending tool/e2e/doc assertions |
| Local regression obligation | Local-only spawn/watch behavior and existing callback/log/stop contracts remain unchanged | todo | pending full package suite and typecheck |
| Close-out evidence | Runtime smoke, scope classification, ledger/checklist, lint sweeps, scan-diff, exact-head evidence, CI, and PR Review Contract | todo | pending final HEAD |
