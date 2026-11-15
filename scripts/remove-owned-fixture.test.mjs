import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { removeOwnedFixture, stopOwnedRuntime } from "./test-support/remove-owned-fixture.mjs";
import { claimDaemonOwner, inspectDaemonOwner } from "../packages/pi-better-server/src/daemon-owner.ts";

test("cleanup works in a clean source layout without a generated runtime client", () => {
  const parent = new URL("../.work/753-ci3/", import.meta.url);
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(new URL("clean-source-", parent));
  try {
    // Include canonical server sources, but never warm ignored build outputs.
    const serverSources = execFileSync("git", ["ls-files", "-z", "--", "packages/pi-better-server"], {
      cwd: new URL("../", import.meta.url), encoding: "utf8",
    }).split("\0").filter(Boolean);
    for (const relative of ["scripts/test-support/remove-owned-fixture.mjs", ...serverSources]) {
      const target = join(root, relative);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(new URL(`../${relative}`, import.meta.url), target);
    }
    assert.equal(existsSync(join(root, "packages/pi-better-subagents/runtime-client")), false);
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { existsSync, mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const { removeOwnedFixture, stopOwnedRuntime } = await import(process.argv[1]);
      const fixture = process.argv[2];
      const release = join(fixture, "agent/managed-runtime/releases/build");
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, "artifact.gz"), "owned fixture");
      await stopOwnedRuntime(join(fixture, "agent/server"), undefined);
      removeOwnedFixture(fixture);
      assert.equal(existsSync(fixture), false);
    `, pathToFileURL(join(root, "scripts/test-support/remove-owned-fixture.mjs")).href, join(root, "owned")], { cwd: root, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    removeOwnedFixture(root);
  }
});

test("owned runtime cleanup refuses a replacement identity before signalling it", async () => {
  const parent = new URL("../.work/753-ci/", import.meta.url);
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(new URL("owner-cleanup-", parent));
  const release = claimDaemonOwner(root);
  try {
    const owner = inspectDaemonOwner(root);
    assert.equal(owner.status, "live");
    await assert.rejects(stopOwnedRuntime(root, { ...owner.owner, token: "another-fixture-owner" }), /must not stop a replacement runtime/);
    assert.deepEqual(inspectDaemonOwner(root), owner);
  } finally {
    release();
    removeOwnedFixture(root);
  }
});

test("owned fixture cleanup removes a sealed runtime without unsealing symlink targets", { skip: process.platform === "win32" ? "POSIX directory permissions" : false }, () => {
  const parent = new URL("../.work/753-ci/", import.meta.url);
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(new URL("cleanup-", parent));
  const fixture = join(root, "fixture");
  const release = join(fixture, "agent/managed-runtime/releases/build");
  const outside = join(root, "outside");
  mkdirSync(release, { recursive: true }); mkdirSync(outside);
  const artifact = join(release, "artifact.gz");
  writeFileSync(artifact, "immutable artifact"); chmodSync(artifact, 0o400); chmodSync(release, 0o500);
  writeFileSync(join(outside, "retained"), "not part of the fixture"); chmodSync(outside, 0o500);
  try {
    if (process.getuid?.() !== 0) assert.throws(() => unlinkSync(artifact), { code: "EACCES" });
    symlinkSync(outside, join(fixture, "outside-link"));
    removeOwnedFixture(fixture);
    assert.equal(existsSync(fixture), false);
    assert.equal(statSync(outside).mode & 0o777, 0o500);
    assert.equal(readFileSync(join(outside, "retained"), "utf8"), "not part of the fixture");
  } finally {
    if (existsSync(fixture)) removeOwnedFixture(fixture);
    chmodSync(outside, 0o700); rmSync(root, { recursive: true, force: true });
  }
});
