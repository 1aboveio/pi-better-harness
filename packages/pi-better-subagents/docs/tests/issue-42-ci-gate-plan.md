# Issue #42 Incremental Plan

| Slice | State | Proof |
|---|---|---|
| Environment-inheritance child proof runs through the selected sandbox | done | `tests/ci_gate.test.mjs`; `tests/test_env_inherit.sh` exact `SEEN=` assertion |
| Real model/web, authenticated gh, and headless-isolation child smokes remain available | done | `tests/run_all.sh`; existing scenario assertions |
| Linux CI requires Ubuntu bubblewrap confinement | done | `.github/workflows/ci.yml` (`linux-sandbox`) |
| macOS CI retains deterministic sandbox-exec assertions | done | `tests/ci_gate.test.mjs`; `.github/workflows/ci.yml` |
| Closeout evidence and review contract | done | no-surface oracle, scan, contract-revision, PR body |