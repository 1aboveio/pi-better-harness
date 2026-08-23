/**
 * Make a sandbox backend resolvable on any host, for the suites that cannot
 * reach the controller with `SandboxSeams`.
 *
 * Most of this package's tests inject seams directly (see `state.test.ts` and
 * `shell.test.ts`). The suites that use this helper cannot: they drive the
 * extension factory, and in one case pi's own extension loader, both of which
 * construct the controller themselves. What that controller reads is the real
 * platform and the real PATH. On macOS a backend always resolves, because
 * `sandbox-exec` is a system binary; on a Linux host without bubblewrap nothing
 * resolves, every protected operation is blocked before it reaches what the test
 * means to assert, and suites about session state, slash-command behaviour,
 * deny-rule plumbing and in-process write containment fail for a reason none of
 * them is about.
 *
 * So when — and only when — this host resolves no backend, put an executable
 * named `bwrap` on PATH. That is exactly the precondition the Linux backend
 * looks for, and supplying it is the same move the seam-injecting suites make,
 * through the lookup the product actually performs. It is never executed here:
 * `write` and `edit` mutate files inside pi's own process, and no suite that
 * calls this spawns a command. The stub exits non-zero with a message rather
 * than pretending to confine anything, so a suite that ever did spawn it would
 * fail loudly instead of passing for the wrong reason.
 *
 * Kernel enforcement is not proved by any of this. It is proved in
 * `foreground-shell.kernel.test.ts`, which resolves a real backend or skips with
 * a reason, and which the platform CI lanes hold to a real backend with
 * `PI_SANDBOX_REQUIRE_BACKEND`.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describeSandboxSupport } from "../../shared-sandbox-core.ts";

const STUB = [
    "#!/bin/sh",
    'echo "pi-better-sandbox tests: the bwrap stub must never be executed" >&2',
    "exit 127",
    "",
].join("\n");

/**
 * Ensure `describeSandboxSupport()` resolves a backend for this process.
 *
 * Returns a cleanup function; on a host that already resolves one it is a no-op
 * and PATH is left untouched.
 */
export function ensureResolvableBackend(): () => void {
    if (describeSandboxSupport().supported) return () => {};

    const dir = realpathSync(mkdtempSync(join(realpathSync("/var/tmp"), "pi-better-sandbox-bwrap-")));
    const stub = join(dir, "bwrap");
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;

    const support = describeSandboxSupport();
    assert.equal(support.supported, true, "the test backend must resolve after the stub is on PATH");
    assert.equal(
        support.supported && support.executable,
        stub,
        "the resolved backend must be the stub, not something else this host happens to have",
    );
    return () => rmSync(dir, { recursive: true, force: true });
}
