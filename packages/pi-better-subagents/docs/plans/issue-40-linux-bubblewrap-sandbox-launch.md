# Issue #40: Linux bubblewrap sandbox launch

- [done] Discover executable `bwrap` on Linux without execution and retain explicit/default/opt-out policy; `tests/sandbox_profile.test.mjs` discovery and policy cases.
- [done] Build the bubblewrap command with the canonical workdir, read-only root, small writable allowlist, shared network, and preserved child argv; `tests/sandbox_profile.test.mjs` topology case.
- [done] Launch the generated command with real first-party detached spawning and prove a selected failing backend does not execute the child; `tests/sandbox_profile.test.mjs` fail-closed case and `tests/linux_bubblewrap.integration.mjs` real-backend CI case.
- [done] Configure and verify the Ubuntu queue runner's AppArmor user-namespace control before the real test: the workflow reads back the control and runs bwrap with the production mount topology, so any installed-but-unusable selected backend still fails the lane.
- [done] Record runtime evidence and coverage checklist, run closeout gates and high-risk self-review, and publish the stacked PR contract.
