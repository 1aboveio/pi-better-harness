import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { inspectDaemonOwner } from "../../packages/pi-better-server/src/daemon-owner.ts";

/** The caller captures the daemon identity when its private runtime becomes ready. */
export async function stopOwnedRuntime(serverDir, expectedOwner) {
  const owner = inspectDaemonOwner(serverDir);
  if (owner.status === "missing" || owner.status === "dead") return;
  assert.equal(owner.status, "live", "fixture runtime ownership must be known before cleanup");
  assert.deepEqual(owner.owner, expectedOwner, "cleanup must not stop a replacement runtime");
  try { process.kill(owner.owner.pid, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  const deadline = Date.now() + 10000;
  for (;;) {
    const current = inspectDaemonOwner(serverDir);
    if (current.status === "missing" || current.status === "dead") return;
    assert.deepEqual(current, owner, "runtime ownership changed during fixture shutdown");
    assert.ok(Date.now() < deadline, `fixture runtime ${owner.owner.pid} did not stop`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Only for a fixture created by this test, after its processes have stopped. */
export function removeOwnedFixture(root) {
  function unsealDirectories(directory) {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) unsealDirectories(join(directory, entry.name));
    }
  }
  // File modes and symlink targets are never changed, including sealed artifacts.
  unsealDirectories(root);
  rmSync(root, { recursive: true, force: true });
}
