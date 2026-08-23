import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { evaluateBackendRequirement, requireSandboxBackend } from "./require-sandbox-backend.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

const linux = {
  supported: true,
  platform: "linux",
  backend: "linux-bubblewrap",
  executable: "/usr/bin/bwrap",
};

// @covers sandbox-core.backend-probe
// @level unit
test("a missing backend is a failure, never a pass with a skipped suite", () => {
  const result = evaluateBackendRequirement(
    {
      supported: false,
      platform: "linux",
      backend: undefined,
      executable: undefined,
      reason: "Linux sandbox requires executable bubblewrap (bwrap) on PATH.",
    },
    "linux-bubblewrap",
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /bubblewrap/);
  assert.match(result.message, /failure rather than a skipped suite/);
});

// @covers sandbox-core.backend-probe
// @level unit
test("a backend other than the one the lane exists for is a failure", () => {
  const result = evaluateBackendRequirement(
    { supported: true, platform: "darwin", backend: "macos-seatbelt", executable: "/usr/bin/sandbox-exec" },
    "linux-bubblewrap",
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /Expected the linux-bubblewrap backend/);
});

// @covers sandbox-core.backend-probe
// @level unit
test("the expected backend passes, and no expectation accepts any backend", () => {
  assert.equal(evaluateBackendRequirement(linux, "linux-bubblewrap").ok, true);
  assert.equal(evaluateBackendRequirement(linux, undefined).ok, true);
  assert.match(evaluateBackendRequirement(linux, undefined).message, /\/usr\/bin\/bwrap/);
});

// @covers sandbox-core.backend-probe
// @level integration
test("the probe reads the same backend selection the real-kernel suites gate on", async () => {
  const result = await requireSandboxBackend(undefined, repoRoot);
  const support = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'import("./packages/sandbox-core/index.ts").then(({ describeSandboxSupport }) => ' +
          "console.log(JSON.stringify(describeSandboxSupport())));",
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );

  assert.equal(result.ok, support.supported);
  if (support.supported) {
    assert.match(result.message, new RegExp(support.backend));
  }
});

// @covers sandbox-core.backend-probe
// @level integration
test("the CLI exits non-zero when the lane's backend is not the selected one", () => {
  // Every runner selects at most one backend, so requiring a backend that does
  // not exist on any platform exercises the failing exit path everywhere.
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/require-sandbox-backend.mjs", "windows-nonexistent"],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /backend|available/);
      return true;
    },
  );
});
