/**
 * The harness ships `pi-better-sandbox` by default, and "by default" is spread
 * across six files that have to agree: the root development manifest, the
 * published meta package's manifest, its extension shims, the installer's
 * component list, the pack staging script, and the release workflows. Any one of
 * them can be updated alone, and the result is a package that installs but never
 * loads, or loads in development but is missing from the tarball.
 *
 * These check that those six agree, so a default capability cannot be half
 * shipped.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { componentPackages } from "../packages/pi-better-harness/lib/cli.mjs";
import { selectPackedResult } from "./stage-harness-dependencies.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const harnessDir = join(repoRoot, "packages/pi-better-harness");

const readJson = (path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
const rootManifest = readJson("package.json");
const harnessManifest = readJson("packages/pi-better-harness/package.json");
const sandboxManifest = readJson("packages/pi-better-sandbox/package.json");
const readWorkflow = (name) => readFileSync(join(repoRoot, ".github/workflows", name), "utf8");

/** The package each harness extension shim re-exports, in manifest order. */
function shimmedPackages() {
  return harnessManifest.pi.extensions.map((entry) => {
    const shim = readFileSync(join(harnessDir, entry), "utf8");
    const match = /\.\.\/\.\.\/node_modules\/([^/"]+)\/([^"]+)/.exec(shim);
    assert.ok(match, `${entry} must re-export a bundled dependency's entry point, got: ${shim}`);
    return { entry, packageName: match[1], entryPath: match[2] };
  });
}

// @covers harness.default-capability
// @level integration
test("the root development manifest loads the sandbox extension", () => {
  const entry = "./packages/pi-better-sandbox/index.ts";
  assert.ok(
    rootManifest.pi.extensions.includes(entry),
    `pi install . must load the sandbox; got ${JSON.stringify(rootManifest.pi.extensions)}`,
  );
  for (const extension of rootManifest.pi.extensions) {
    assert.ok(existsSync(join(repoRoot, extension)), `${extension} does not exist`);
  }
});

// @covers harness.default-capability
// @level integration
test("the published meta package loads the sandbox extension by default", () => {
  const shims = shimmedPackages();
  assert.ok(
    shims.some((shim) => shim.packageName === "pi-better-sandbox"),
    `the harness must bundle the sandbox; got ${JSON.stringify(shims.map((s) => s.packageName))}`,
  );

  for (const { entry, packageName, entryPath } of shims) {
    assert.ok(existsSync(join(harnessDir, entry)), `${entry} does not exist`);
    // Resolved against the workspace source rather than the staged copy, so this
    // catches a shim pointing at an entry point the package never publishes.
    const workspaceEntry = join(repoRoot, "packages", packageName, entryPath);
    assert.ok(existsSync(workspaceEntry), `${entry} points at a missing entry: ${workspaceEntry}`);
  }
});

// @covers harness.default-capability
// @level integration
test("the installer configures and removes the sandbox alongside the other components", () => {
  assert.ok(
    componentPackages.includes("pi-better-sandbox"),
    `the installer must manage the sandbox; got ${JSON.stringify(componentPackages)}`,
  );

  const shimmed = shimmedPackages().map((shim) => shim.packageName);
  assert.deepEqual(
    [...componentPackages].sort(),
    [...shimmed].sort(),
    "the installer's components and the bundled extensions must be the same set",
  );
});

// @covers harness.default-capability
// @level integration
test("every component is a bundled dependency pinned at its workspace version", () => {
  assert.deepEqual(
    [...harnessManifest.bundledDependencies].sort(),
    [...componentPackages].sort(),
    "every installer component must also be bundled into the meta package tarball",
  );

  for (const packageName of componentPackages) {
    const workspaceVersion = readJson(`packages/${packageName}/package.json`).version;
    assert.equal(
      harnessManifest.dependencies[packageName],
      workspaceVersion,
      `${packageName} is pinned at ${harnessManifest.dependencies[packageName]} but the workspace is at ${workspaceVersion}`,
    );
  }
});

// @covers harness.default-capability
// @level integration
test("pack staging stages exactly the bundled components", () => {
  const staging = readFileSync(join(repoRoot, "scripts/stage-harness-dependencies.mjs"), "utf8");
  const staged = staging
    .slice(staging.indexOf("const packageNames = ["), staging.indexOf("];", staging.indexOf("const packageNames = [")))
    .match(/"([^"]+)"/g)
    .map((quoted) => quoted.slice(1, -1));

  assert.deepEqual(
    [...staged].sort(),
    [...harnessManifest.bundledDependencies].sort(),
    "a bundled dependency that is never staged is missing from the published tarball",
  );
});

// @covers sandbox.no-launcher
// @level unit
test("the sandbox package ships no launcher executable", () => {
  assert.equal(sandboxManifest.bin, undefined, "users invoke ordinary `pi`; there is no launcher");
  assert.ok(!existsSync(join(repoRoot, "packages/pi-better-sandbox/bin")));
  assert.deepEqual(sandboxManifest.files, ["*.ts", "README.md", "LICENSE"]);
  assert.deepEqual(sandboxManifest.pi.extensions, ["./index.ts"]);
});

// @covers harness.default-capability
// @level integration
test("the sandbox is independently publishable through the release workflow", () => {
  const publish = readWorkflow("publish.yml");
  assert.match(publish, /^ {10}- pi-better-sandbox$/m, "publish.yml must offer the package as a choice");
  assert.match(
    publish,
    /pi-better-sandbox\) WORKSPACE="packages\/pi-better-sandbox" ;;/,
    "publish.yml must resolve the package to its workspace",
  );
  // Release verification has to assert the vendored shared module, because a
  // stale or absent copy is exactly the failure a passing typecheck hides.
  assert.match(publish, /check_pack_file \/tmp\/package-pack\.json shared-sandbox-core\.ts/);
});

// @covers harness.default-capability
// @level integration
test("CI asserts the sandbox and its shared module are in the bundled tarball", () => {
  const ci = readWorkflow("ci.yml");
  for (const path of [
    "extensions/sandbox/index.ts",
    "node_modules/pi-better-sandbox/index.ts",
    "node_modules/pi-better-sandbox/shared-sandbox-core.ts",
    "node_modules/pi-better-subagents/shared-sandbox-core.ts",
    "node_modules/pi-better-background-tasks/src/shared-sandbox-core.ts",
  ]) {
    assert.ok(ci.includes(`${path} \\`) || ci.includes(`${path}\n`), `ci.yml must assert ${path}`);
  }
});

// @covers harness.default-capability
// @level integration
test("the bundled tarball carries the sandbox extension and its synchronized shared module", () => {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "-w", "packages/pi-better-harness"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pack = selectPackedResult(stdout);
  const packed = pack.files.map((file) => file.path);

  for (const path of [
    "extensions/sandbox/index.ts",
    "node_modules/pi-better-sandbox/index.ts",
    "node_modules/pi-better-sandbox/shared-sandbox-core.ts",
    "node_modules/pi-better-subagents/shared-sandbox-core.ts",
    "node_modules/pi-better-background-tasks/src/shared-sandbox-core.ts",
  ]) {
    assert.ok(packed.includes(path), `bundled tarball is missing ${path}:\n${packed.join("\n")}`);
  }

  // Every bundled copy of the shared mechanism is the one the private package
  // owns; a drifted copy would confine differently in the tarball than in tests.
  const canonical = readFileSync(join(repoRoot, "packages/sandbox-core/index.ts"), "utf8");
  for (const staged of [
    "node_modules/pi-better-sandbox/shared-sandbox-core.ts",
    "node_modules/pi-better-subagents/shared-sandbox-core.ts",
    "node_modules/pi-better-background-tasks/src/shared-sandbox-core.ts",
  ]) {
    const contents = readFileSync(join(harnessDir, staged), "utf8");
    assert.ok(
      contents.endsWith(canonical),
      `${staged} in the staged tarball is not the canonical sandbox-core source`,
    );
  }

  assert.ok(
    !packed.some((path) => path.startsWith("node_modules/pi-better-sandbox/bin/")),
    "the bundled sandbox must ship no launcher executable",
  );
});
