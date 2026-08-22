import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { syncSharedSshCore } from "./sync-shared-ssh-core.mjs";

const fixtureRoot = mkdtempSync(join(tmpdir(), "sync-shared-ssh-core-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

// @covers ssh-core.private-sync
// @level integration
test("syncSharedSshCore replaces the generated consumer tree from canonical source files", () => {
  const sourceRoot = join(fixtureRoot, "packages", "ssh-core");
  const targetRoots = [
    join(fixtureRoot, "packages", "pi-better-background-tasks", "src", "shared-ssh-core"),
    join(fixtureRoot, "packages", "pi-better-ssh", "src", "shared-ssh-core"),
  ];
  mkdirSync(join(sourceRoot, "test-support"), { recursive: true });
  for (const targetRoot of targetRoots) {
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, "stale.ts"), "stale\n");
  }
  writeFileSync(join(sourceRoot, "index.ts"), "export const protocol = true;\n");
  writeFileSync(join(sourceRoot, "test-support", "index.ts"), "export const fake = true;\n");
  writeFileSync(join(sourceRoot, "test-support", "fake-remote-runner.ts"), "export class FakeRemoteRunner {}\n");

  syncSharedSshCore(fixtureRoot);

  for (const targetRoot of targetRoots) {
    assert.equal(
      readFileSync(join(targetRoot, "index.ts"), "utf8"),
      "// Generated from packages/ssh-core/index.ts. Do not edit directly.\nexport const protocol = true;\n",
    );
    assert.equal(
      readFileSync(join(targetRoot, "test-support", "fake-remote-runner.ts"), "utf8"),
      "// Generated from packages/ssh-core/test-support/fake-remote-runner.ts. Do not edit directly.\nexport class FakeRemoteRunner {}\n",
    );
    assert.throws(() => readFileSync(join(targetRoot, "stale.ts"), "utf8"), /ENOENT/);
  }
});
