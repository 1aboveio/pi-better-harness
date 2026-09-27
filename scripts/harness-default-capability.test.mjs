/**
 * Check that the development manifest, installer and published bundle agree.
 * Packaging assertions inspect npm's output so source formatting and workflow
 * wording cannot stand in for a loadable extension in the tarball.
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
  assert.ok(
    rootManifest.pi.extensions.includes("./packages/pi-better-ssh/src/index.ts"),
    "pi install . must load synchronous SSH tools",
  );
});

// @covers harness.default-capability
// @level integration
test("the installer and bundle declare the same managed components", () => {
  assert.ok(
    componentPackages.includes("pi-better-sandbox"),
    `the installer must manage the sandbox; got ${JSON.stringify(componentPackages)}`,
  );

  assert.deepEqual(
    [...componentPackages].sort(),
    [...harnessManifest.bundledDependencies].sort(),
    "the installer's components and bundled dependencies must be the same set",
  );
});

// @covers harness.default-capability
// @level integration
test("plan is present in local development and every published harness surface", () => {
  assert.ok(
    rootManifest.pi.extensions.includes("./packages/pi-better-plan/src/index.ts"),
    "the root development manifest must load plan",
  );
  assert.ok(componentPackages.includes("pi-better-plan"), "the npm installer must manage plan");
  assert.equal(harnessManifest.dependencies["pi-better-plan"], readJson("packages/pi-better-plan/package.json").version);
  assert.ok(harnessManifest.bundledDependencies.includes("pi-better-plan"));

});

// @covers harness.default-capability
// @level integration
test("every component is a bundled dependency pinned at its workspace version", () => {

  for (const packageName of componentPackages) {
    const workspaceVersion = readJson(`packages/${packageName}/package.json`).version;
    assert.equal(
      harnessManifest.dependencies[packageName],
      workspaceVersion,
      `${packageName} is pinned at ${harnessManifest.dependencies[packageName]} but the workspace is at ${workspaceVersion}`,
    );
    const component = readJson(`packages/${packageName}/package.json`);
    for (const [dependency, version] of Object.entries(component.dependencies ?? {})) {
      if (componentPackages.includes(dependency)) continue;
      assert.equal(
        harnessManifest.dependencies[dependency],
        version,
        `${packageName} needs ${dependency}@${version} at install time`,
      );
    }
  }
});

// @covers sandbox.no-launcher
// @level unit
test("the sandbox package ships no launcher executable", () => {
  assert.equal(sandboxManifest.bin, undefined, "users invoke ordinary `pi`; there is no launcher");
  assert.ok(!existsSync(join(repoRoot, "packages/pi-better-sandbox/bin")));
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

  for (const packageName of harnessManifest.bundledDependencies) {
    const component = readJson(`packages/${packageName}/package.json`);
    for (const entry of component.pi.extensions) {
      const path = `node_modules/${packageName}/${entry.replace(/^\.\//, "")}`;
      assert.ok(packed.includes(path), `bundled component entry is missing: ${path}`);
    }
  }

  for (const path of [
    "extensions/sandbox/index.ts",
    "extensions/ssh/index.ts",
    "extensions/plan/index.ts",
    "node_modules/pi-better-sandbox/index.ts",
    "node_modules/pi-better-sandbox/shared-sandbox-core.ts",
    "node_modules/pi-better-subagents/shared-sandbox-core.ts",
    "node_modules/pi-better-background-tasks/src/shared-sandbox-core.ts",
    "node_modules/pi-better-ssh/src/index.ts",
    "node_modules/pi-better-ssh/src/shared-ssh-core/index.ts",
    "node_modules/pi-better-plan/src/index.ts",
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
