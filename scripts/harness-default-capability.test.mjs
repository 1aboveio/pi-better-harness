/**
 * Check that the development manifest, installer and published bundle agree.
 * Packaging assertions inspect npm's output so source formatting and workflow
 * wording cannot stand in for a loadable extension in the tarball.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { componentPackages } from "../packages/pi-better-harness/lib/cli.mjs";
import {
  selectPackedResult,
  stageHarnessDependencies,
  stagedPackageNames,
} from "./stage-harness-dependencies.mjs";

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
test("Outcome & Todo belongs to Harness and Plan is retired", () => {
  assert.ok(rootManifest.pi.extensions.includes("./packages/pi-better-harness/extensions/task-context/index.ts"));
  assert.ok(harnessManifest.pi.extensions.includes("extensions/task-context/index.ts"));
  assert.ok(!componentPackages.includes("pi-better-plan"));
  assert.equal(harnessManifest.dependencies["pi-better-plan"], undefined);
  assert.ok(!harnessManifest.bundledDependencies.includes("pi-better-plan"));
  const retired = readJson("packages/pi-better-plan/package.json");
  assert.equal(retired.private, true);
  assert.equal(retired.pi, undefined);
  assert.ok(!retired.keywords.includes("pi-package"));
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
  // The staging scope and the declared bundle must be the same packages, so a
  // retired component (Plan) cannot linger in either list.
  assert.deepEqual(
    [...stagedPackageNames].sort(),
    [...harnessManifest.bundledDependencies].sort(),
    "the staging helper must pack exactly the bundled dependencies",
  );

  // A fresh checkout has no Harness node_modules, and npm only runs `prepack`
  // when lifecycle scripts are enabled. Stage explicitly so the artifact below
  // does not depend on leftovers or on the caller's npm configuration.
  stageHarnessDependencies({ ignoreScripts: true });
  assert.ok(
    !existsSync(join(harnessDir, "node_modules", "pi-better-plan")),
    "pi-better-plan is retired and must not stay staged in the bundle",
  );

  const workDir = mkdtempSync(join(tmpdir(), "pi-better-harness-tarball-"));
  try {
    const stdout = execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--pack-destination",
        workDir,
        // Staging above already produced the bundled tree; running the Harness
        // prepack here would only re-stage (and re-sync other packages) mid-test.
        "--ignore-scripts",
        "-w",
        "packages/pi-better-harness",
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const pack = selectPackedResult(stdout);
    assert.ok(pack?.filename, `npm pack reported no tarball: ${stdout.slice(0, 500)}`);

    // Unpack the real tarball: these assertions describe what a user installs,
    // not what happens to sit in the working tree.
    const unpackedDir = join(workDir, "unpacked");
    mkdirSync(unpackedDir);
    execFileSync(
      "tar",
      ["-xzf", join(workDir, pack.filename), "--strip-components=1", "-C", unpackedDir],
      { stdio: "inherit" },
    );

    const packed = pack.files.map((file) => file.path);
    const carries = (path) => {
      assert.ok(packed.includes(path), `bundled tarball is missing ${path}:\n${packed.join("\n")}`);
      assert.ok(existsSync(join(unpackedDir, path)), `${path} is listed but absent from the unpacked tarball`);
    };

    for (const packageName of harnessManifest.bundledDependencies) {
      const component = readJson(`packages/${packageName}/package.json`);
      for (const entry of component.pi.extensions) {
        carries(`node_modules/${packageName}/${entry.replace(/^\.\//, "")}`);
      }
    }

    // Every extension the bundle declares must load from the tarball, including
    // the Outcome & Todo helpers the Harness now owns itself.
    for (const entry of harnessManifest.pi.extensions) {
      carries(entry.replace(/^\.\//, ""));
    }

    for (const path of [
      "extensions/sandbox/index.ts",
      "extensions/ssh/index.ts",
      "extensions/task-context/index.ts",
      "extensions/task-context/outcome-state.ts",
      "extensions/task-context/plan-state.ts",
      "extensions/task-context/plan-render.ts",
      "extensions/task-context/plan-widget.ts",
      "extensions/task-context/plan-presentation.ts",
      "extensions/task-context/workflow-plan.ts",
      "extensions/task-context/workflow-plan-update.ts",
      "extensions/task-context/cancelled-rows.ts",
      "extensions/task-context/shared-execution-policy.ts",
      "extensions/task-context/types.ts",
      "node_modules/pi-better-sandbox/index.ts",
      "node_modules/pi-better-sandbox/shared-sandbox-core.ts",
      "node_modules/pi-better-subagents/shared-sandbox-core.ts",
      "node_modules/pi-better-background-tasks/src/shared-sandbox-core.ts",
      "node_modules/pi-better-ssh/src/index.ts",
      "node_modules/pi-better-ssh/src/shared-ssh-core/index.ts",
    ]) {
      carries(path);
    }

    // Plan is retired: no staged package and no extension shim may come back.
    for (const path of packed) {
      assert.ok(
        !path.startsWith("node_modules/pi-better-plan/") && !path.startsWith("extensions/plan/"),
        `retired Plan artifact in the bundled tarball: ${path}`,
      );
    }

    // Every bundled copy of the shared mechanism is the one the private package
    // owns; a drifted copy would confine differently in the tarball than in tests.
    const canonical = readFileSync(join(repoRoot, "packages/sandbox-core/index.ts"), "utf8");
    for (const staged of [
      "node_modules/pi-better-sandbox/shared-sandbox-core.ts",
      "node_modules/pi-better-subagents/shared-sandbox-core.ts",
      "node_modules/pi-better-background-tasks/src/shared-sandbox-core.ts",
    ]) {
      const contents = readFileSync(join(unpackedDir, staged), "utf8");
      assert.ok(
        contents.endsWith(canonical),
        `${staged} in the packed tarball is not the canonical sandbox-core source`,
      );
    }

    assert.ok(
      !packed.some((path) => path.startsWith("node_modules/pi-better-sandbox/bin/")),
      "the bundled sandbox must ship no launcher executable",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
