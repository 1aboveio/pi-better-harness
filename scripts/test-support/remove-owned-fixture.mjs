import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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
