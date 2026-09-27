/**
 * One mechanism, three consumers, one rule: once the sandbox is meant to apply,
 * nothing runs unconfined.
 *
 * Each package owns tests for its own half of this. What only a cross-package
 * test can catch is a consumer that drifts — a vendored copy that is no longer
 * the canonical one, or an adapter that quietly hands back a bare command when
 * the backend cannot be applied. Both would leave every per-package suite green
 * while the product silently stopped confining one of its execution paths.
 *
 * Nothing first-party is mocked here. The only injection is `sandbox-core`'s own
 * platform/PATH seams, which is how a machine that *has* a backend can still
 * exercise the no-backend branch.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

import { describeSandboxSupport, maybeBuildSandboxCommand } from "../packages/sandbox-core/index.ts";
import { ForegroundSandboxBlockedError, ForegroundSandboxController } from "../packages/pi-better-sandbox/state.ts";
import { buildSandboxedShellCommand } from "../packages/pi-better-sandbox/shell.ts";
import {
  ForegroundSandboxBlockedError as BackgroundTaskBlockedError,
  confineCommandSpec,
  planFor,
} from "../packages/pi-better-background-tasks/src/sandbox.ts";
import { maybeBuildSandboxCommand as subagentMaybeBuildSandboxCommand } from "../packages/pi-better-subagents/sandbox.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const support = describeSandboxSupport();

// Disposable, and deliberately not os.tmpdir(): the macOS profile always allows
// writes under /private/var/folders, which is what os.tmpdir() returns there.
const fixtures = mkdtempSync(join(realpathSync("/var/tmp"), "pi-sandbox-fail-closed-"));
after(() => rmSync(fixtures, { recursive: true, force: true }));

/** Seams that select no backend at all, whatever the host actually has. */
const noBackend = { platform: () => "sunos" };

// @covers sandbox.fail-closed
// @level integration
test("the foreground consumer blocks rather than running a shell unconfined", () => {
  const controller = new ForegroundSandboxController(noBackend);
  const status = controller.beginSession(repoRoot, true);

  assert.equal(status.state, "unavailable");
  assert.equal(status.readPolicy, "unrestricted", "reads are never restricted by this sandbox");
  assert.equal(status.networkPolicy, "unrestricted", "network is never restricted by this sandbox");
  assert.throws(
    () => controller.requireLaunchPlan(),
    (error) => {
      assert.ok(error instanceof ForegroundSandboxBlockedError);
      assert.equal(error.status.state, "unavailable");
      return true;
    },
    "an unavailable backend must block the launch, not degrade to an unconfined one",
  );
});

// @covers sandbox.fail-closed
// @level integration
test("the foreground shell wrapper refuses to emit a bare command after backend loss", () => {
  const plan = {
    confined: true,
    profilePath: join(fixtures, "foreground.sb"),
    policy: { writableRoot: repoRoot, home: fixtures },
  };

  // A valid confined plan must still fail closed when its backend disappears.
  assert.throws(
    () => buildSandboxedShellCommand("printf escaped", plan, noBackend),
    /sandbox/i,
    "losing the backend after planning must throw, not return the unwrapped command",
  );

});

// @covers background-task.sandbox-policy-contract
// @level integration
test("the background-task consumer blocks every policy that requires unavailable confinement", () => {
  for (const state of ["unavailable", "failed"]) {
    assert.throws(
      () => planFor({ state, denyWrite: [], reason: `backend is ${state}` }),
      BackgroundTaskBlockedError,
      `a ${state} policy must block a local launch`,
    );
  }

  // An enabled policy with no writable root is the same hazard wearing the
  // enabled label; it must not resolve to an unconfined plan either.
  assert.throws(
    () => planFor({ state: "enabled", denyWrite: [], reason: "root never captured" }),
    BackgroundTaskBlockedError,
  );

  // Both the foreground default-off state and an explicit session opt-out are
  // intentionally unconfined.
  assert.deepEqual(planFor({ state: "inactive", denyWrite: [], reason: "default off" }), {
    confined: false,
  });
  assert.deepEqual(planFor({ state: "disabled", denyWrite: [], reason: "a human turned it off" }), {
    confined: false,
  });
});

// @covers background-task.sandbox-policy-contract
// @level integration
test("a confined background-task plan never spawns the bare command", {
  skip: support.supported ? false : `requires a sandbox backend: ${support.reason}`,
}, () => {

  const spec = { kind: "local", command: "printf ok" };
  const confined = confineCommandSpec(
    spec,
    { confined: true, writableRoot: repoRoot, denyWrite: [] },
    join(fixtures, "profile.sb"),
  );

  assert.notDeepEqual(confined, spec, "a confined plan must rewrite the spec");
  assert.ok(
    JSON.stringify(confined).includes(support.executable),
    `the confined spec must exec the selected backend, got: ${JSON.stringify(confined)}`,
  );
});

// @covers sandbox.spawn-policy
// @level integration
test("the subagent adapter wraps whenever a backend is selected", () => {
  const args = {
    profilePath: join(fixtures, "subagent.sb"),
    writableDir: repoRoot,
    home: repoRoot,
    piBin: "/bin/echo",
    piArgs: ["ok"],
  };

  if (support.supported) {
    const command = subagentMaybeBuildSandboxCommand(args, { sandboxEnabled: true, explicitSandbox: true });
    assert.ok(command, "a selected backend must always return its wrapper");
    assert.equal(command.file, support.executable);
    assert.notEqual(command.file, args.piBin, "the wrapper must never be the bare target");
  }

  // The same call through the shared mechanism the adapter delegates to, with no
  // backend available: an explicit request throws instead of degrading.
  assert.throws(
    () =>
      maybeBuildSandboxCommand(
        {
          profilePath: args.profilePath,
          policy: { writableRoot: args.writableDir, home: args.home },
          execPath: args.piBin,
          execArgs: args.piArgs,
        },
        { sandboxEnabled: true, explicitSandbox: true },
        noBackend,
      ),
    /unsupported on sunos/,
  );
});
