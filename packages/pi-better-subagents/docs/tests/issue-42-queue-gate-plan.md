# Issue #42 Incremental Plan

| Slice | State | Proof |
|---|---|---|
| Queue runs exact environment-inheritance child proof through the selected sandbox | done | `tests/queue_gate.test.mjs`; `tests/test_env_inherit.sh` exact `SEEN=` assertion |
| Queue retains real model/web, authenticated gh, and headless-isolation child smokes | done | `tests/run_queue.sh`; existing scenario assertions |
| Linux queue lane requires Ubuntu bubblewrap confinement | done | Retired queue workflow; coverage moved to `.github/workflows/ci.yml` (`linux-sandbox`) |
| macOS PR lane retains deterministic sandbox-exec assertions | done | `tests/queue_gate.test.mjs`; `.github/workflows/ci.yml` |
| Closeout evidence and review contract | done | no-surface oracle, scan, contract-revision, PR body |
