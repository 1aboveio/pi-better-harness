// Packaging contract for the vendored callback batcher (#324).
//
// `scripts/sync-shared-log-utils.mjs` copies `packages/callback-batcher/index.ts`
// into both callback consumers, and both import the copy at runtime. A tarball
// missing it fails to load, so the release gates must name it the same way they
// name the failure-observations and log-utils copies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { selectPackedResult } from "./stage-harness-dependencies.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

// workspace -> path of the vendored copy inside that package's tarball.
const consumers = {
  "pi-better-subagents": "shared-callback-batcher.ts",
  "pi-better-background-tasks": "src/shared-callback-batcher.ts",
};
// Vendored modules whose tarball presence the release gates must assert. The
// failure-observations rows pin that this test's reading of the workflows
// matches the guards that already existed.
const guarded = {
  ...consumers,
  "pi-better-subagents#failure": "shared-failure-observations.ts",
  "pi-better-background-tasks#failure": "src/shared-failure-observations.ts",
};
const pkgOf = (key) => key.split("#")[0];

test("the sync script vendors the batcher into exactly the guarded consumers", () => {
  const sync = read("scripts/sync-shared-log-utils.mjs");
  const targets = [...sync.matchAll(/"packages\/([^/"]+)\/([^"]*shared-callback-batcher\.ts)"/g)]
    .map(([, pkg, path]) => `${pkg}:${path}`).sort();
  assert.deepEqual(targets, Object.entries(consumers).map(([pkg, path]) => `${pkg}:${path}`).sort());
});

test("both consumers ship the same batcher implementation", () => {
  const expected = "// Generated from packages/callback-batcher/index.ts. Do not edit directly.\n" +
    read("packages/callback-batcher/index.ts");
  for (const [pkg, path] of Object.entries(consumers)) {
    assert.equal(read(`packages/${pkg}/${path}`), expected, `${pkg}/${path}`);
  }
});

for (const [pkg, path] of Object.entries(consumers)) {
  test(`packing ${pkg} includes ${path}`, () => {
    const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "-w", `packages/${pkg}`], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const files = selectPackedResult(stdout).files.map((file) => file.path);
    assert.ok(files.includes(path), `tarball must carry ${path}; got:\n${files.join("\n")}`);
  });
}

// A list entry that ends the list carries no line continuation, so that backslash is optional.
function assertsPath(list, path) {
  return new RegExp(`^\\s+${path.replaceAll(".", "\\.")}(?: \\\\)?\\s*$`, "m").test(list);
}

// Returns the body of one `case "$PACKAGE"` arm in publish.yml's pack check.
function publishArm(workflow, pkg) {
  const match = workflow.match(new RegExp(`\\n\\s+${pkg}\\)\\n([\\s\\S]*?)\\n\\s+;;`));
  assert.ok(match, `publish.yml has no pack-check arm for ${pkg}`);
  return match[1];
}

test("publish.yml's pack check asserts every vendored copy, per package and in the bundle", () => {
  const workflow = read(".github/workflows/publish.yml");
  const bundle = publishArm(workflow, "pi-better-harness");
  for (const [key, path] of Object.entries(guarded)) {
    const pkg = pkgOf(key);
    assert.match(publishArm(workflow, pkg), new RegExp(`check_pack_file /tmp/package-pack\\.json ${path.replaceAll(".", "\\.")}(\\n|$)`),
      `${pkg} arm must check ${path}`);
    assert.ok(bundle.includes(`node_modules/${pkg}/${path} \\`), `bundle arm must check node_modules/${pkg}/${path}`);
  }
});

test("ci.yml's bundled-tarball assertions name every extension the bundle loads", () => {
  const workflow = read(".github/workflows/ci.yml");
  const start = workflow.indexOf("- name: Package dry run");
  assert.ok(start !== -1, "ci.yml has no Package dry run step");
  const rest = workflow.slice(start);
  const nextStep = rest.indexOf("\n      - name:");
  const step = nextStep === -1 ? rest : rest.slice(0, nextStep);
  for (const path of JSON.parse(read("packages/pi-better-harness/package.json")).pi.extensions) {
    assert.ok(assertsPath(step, path), `ci.yml must assert ${path}`);
  }
});

test("publish.yml's Harness arm asserts every extension the bundle loads", () => {
  const arm = publishArm(read(".github/workflows/publish.yml"), "pi-better-harness");
  const manifest = JSON.parse(read("packages/pi-better-harness/package.json"));
  for (const path of manifest.pi.extensions) {
    assert.ok(assertsPath(arm, path), `Harness arm must assert ${path}`);
  }
});

// A component's tarball presence is not its version: a stale staged copy would ship a
// bundle that declares one version and carries another, which no path assertion catches.
test("publish.yml's Harness arm compares staged component versions with their workspaces", () => {
  const arm = publishArm(read(".github/workflows/publish.yml"), "pi-better-harness");
  assert.match(arm, /harness\.bundledDependencies/, "must iterate the declared bundled dependencies");
  assert.match(arm, /staged \$\{staged\} is not the workspace/, "must fail when the staged version differs");
});

test("ci.yml's bundled-tarball assertions name every vendored copy", () => {
  const workflow = read(".github/workflows/ci.yml");
  const step = workflow.slice(workflow.indexOf("- name: Package dry run"));
  const list = step.slice(0, step.indexOf("\n          do\n"));
  for (const [key, path] of Object.entries(guarded)) {
    assert.ok(list.includes(`node_modules/${pkgOf(key)}/${path} \\`), `ci.yml must assert node_modules/${pkgOf(key)}/${path}`);
  }
});
