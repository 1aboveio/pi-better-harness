/**
 * The root script suites never touch the machine's real subagent or
 * background-task registry (#332). `scripts/isolate-registry.mjs` is preloaded
 * by every command that runs `scripts/*.test.mjs`; if it is dropped, these
 * assertions fail instead of the navigator e2e silently leaving
 * `by-parent-active/<pid>/…` markers in `$TMPDIR/pi-better-subagents` again.
 */
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { baseDir as taskBaseDir } from "../packages/pi-better-background-tasks/src/registry.ts";
import { baseDir as subagentBaseDir } from "../packages/pi-better-subagents/registry.ts";

const repoRoot = resolve(import.meta.dirname, "..");

// @covers navigator.detail-overlay
// @level unit
test("both registries resolve inside this test file's private TMPDIR", () => {
  const machineTmp = process.env.PI_SCRIPTS_TEST_MACHINE_TMPDIR;
  const isolated = process.env.PI_SCRIPTS_TEST_ISOLATED_TMPDIR;
  assert.ok(machineTmp && isolated, "scripts/isolate-registry.mjs must be preloaded");
  assert.equal(realpathSync(tmpdir()), isolated);
  const rel = relative(machineTmp, isolated);
  assert.ok(rel && !rel.startsWith("..") && !rel.includes("/") && rel.startsWith("pi-scripts-test-"), rel);
  assert.equal(subagentBaseDir(), join(isolated, "pi-better-subagents"));
  assert.equal(taskBaseDir(), join(isolated, "pi-better-background-tasks"));
});

test("every command that runs scripts/*.test.mjs preloads the isolation module", () => {
  const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;
  const commands = [
    ...Object.entries(scripts).map(([name, command]) => [`package.json ${name}`, command]),
    ...readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8").split("\n").map((line, i) => [`ci.yml:${i + 1}`, line]),
  ];
  const runners = commands.filter(([, command]) => /node\b.*--test\b.*scripts\/[^\s]*\.test\.mjs/.test(command));
  assert.ok(runners.length >= 4, `expected the root test commands, found ${runners.map(([name]) => name).join(", ")}`);
  for (const [name, command] of runners) {
    assert.match(command, /--import \.\/scripts\/isolate-registry\.mjs/, name);
  }
});
