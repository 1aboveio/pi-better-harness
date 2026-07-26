# Issue #39 Work List

- [done] Characterize the existing `sandboxSupported` macOS-only query and preserve the caller's unsupported-platform policy in `index.ts` unchanged; `tests/sandbox_profile.test.mjs`.
- [done] Move sandbox backend selection behind `sandbox.ts` while preserving the `sandboxSupported` and `buildSandboxCommand` contracts; `tests/sandbox_profile.test.mjs`.
- [done] Remove the sandbox-test import-failure vacuous pass and verify the test fails when its product module is unavailable; `tests/sandbox_profile.test.mjs`.
- [done] Run unit, focused sandbox, macOS sandbox, closeout gates, self-review, and PR contract. Unit/closeout checks pass; macOS shell probes are blocked by this harness's nested sandbox restriction and are recorded in the PR contract.
