import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { selectWorkspaces } from "./test-ci-workspaces.mjs";

const script = fileURLToPath(new URL("./test-ci-workspaces.mjs", import.meta.url));

function fixture(t, patterns = ["packages/*"]) {
  const root = mkdtempSync(join(tmpdir(), "ci-workspaces-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "packages"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, workspaces: patterns }));
  return root;
}

function workspace(root, dir, pkg) {
  const path = join(root, "packages", dir);
  mkdirSync(path);
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: dir, version: "1.0.0", ...pkg }));
}

function run(root, args = []) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

test("runs new workspaces sequentially with pretest, skipping server and missing scripts", (t) => {
  const root = fixture(t);
  const log = join(root, "events");
  const append = (text) => `node -e "require('fs').appendFileSync(${JSON.stringify(log).replaceAll('"', '\\"')}, '${text}\\n')"`;
  workspace(root, "alpha", { scripts: { pretest: append("alpha pre"), test: append("alpha test") } });
  workspace(root, "new-package", { scripts: { test: append("new test") } });
  workspace(root, "no-test", { scripts: { pretest: append("unexpected pretest") } });
  workspace(root, "pi-better-server", { scripts: { test: append("unexpected server") } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, "utf8"), "alpha pre\nalpha test\nnew test\n");
});

test("rejects missing or malformed server and unsupported patterns", (t) => {
  const root = fixture(t);
  workspace(root, "other", { scripts: { test: "exit 0" } });
  assert.throws(() => selectWorkspaces(root), /Expected exactly one pi-better-server workspace; found 0/);
  workspace(root, "pi-better-server", {});
  writeFileSync(join(root, "packages/pi-better-server/package.json"), "{");
  assert.throws(() => selectWorkspaces(root), /Cannot read package manifest.*pi-better-server/);
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/**"] }));
  assert.throws(() => selectWorkspaces(root), /Unsupported workspace pattern/);
});

test("shards deterministically partition eligible workspaces and preserve npm lifecycle scripts", (t) => {
  const root = fixture(t, ["packages/*", "packages/alpha"]);
  const log = join(root, "events");
  const append = (text) => `node -e "require('fs').appendFileSync(${JSON.stringify(log).replaceAll('"', '\\"')}, '${text}\\n')"`;
  // Create in reverse order to prove selection does not depend on creation order.
  for (const name of ["echo", "delta", "charlie", "bravo", "alpha"]) {
    workspace(root, name, { scripts: { pretest: append(`${name} pre`), test: append(`${name} test`), posttest: append(`${name} post`) } });
  }
  workspace(root, "aardvark-no-test", { scripts: { pretest: append("unexpected pretest") } });
  workspace(root, "beta-server", { name: "pi-better-server", scripts: { test: append("unexpected server") } });
  function events(args) {
    rmSync(log, { force: true });
    const result = run(root, args);
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(log, "utf8").trim().split("\n");
  }
  const lifecycle = (names) => names.flatMap((name) => [`${name} pre`, `${name} test`, `${name} post`]);
  const all = events([]);
  assert.deepEqual(all, lifecycle(["alpha", "bravo", "charlie", "delta", "echo"]));
  assert.deepEqual(events(["--shard", "1/1"]), all);
  const first = events(["--shard", "1/2"]);
  const second = events(["--shard", "2/2"]);
  assert.deepEqual(first, lifecycle(["alpha", "charlie", "echo"]));
  assert.deepEqual(second, lifecycle(["bravo", "delta"]));
  assert.deepEqual([...first, ...second].sort(), [...all].sort());
  assert.deepEqual(events(["--shard", "1/2"]), first);
});

test("valid empty shards succeed without running scripts but still validate workspaces", (t) => {
  const root = fixture(t);
  workspace(root, "alpha", { scripts: { test: "node -e \"process.exit(9)\"" } });
  workspace(root, "pi-better-server", { scripts: { test: "node -e \"process.exit(9)\"" } });
  const result = run(root, ["--shard", "3/3"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  rmSync(join(root, "packages/pi-better-server"), { recursive: true });
  const invalid = run(root, ["--shard", "3/3"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Expected exactly one pi-better-server workspace; found 0/);
});

test("all CI shards run a distinct subagent partition through npm", (t) => {
  const root = fixture(t);
  workspace(root, "pi-better-server", {});
  workspace(root, "pi-better-subagents", { scripts: { test: "node record.cjs", "test:shard": "node record.cjs" } });
  writeFileSync(join(root, "packages/pi-better-subagents/record.cjs"), "console.log('partition=' + process.argv.slice(2).join(','))");
  for (const [args, expected] of [[[], ""], [["--shard", "1/2"], "--test-shard=1/2,tests/*.test.mjs"], [["--shard", "2/2"], "--test-shard=2/2,tests/*.test.mjs"]]) {
    const result = run(root, args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trimEnd().endsWith(`partition=${expected}`));
  }
});

test("invalid arguments fail closed before running any workspace", (t) => {
  const root = fixture(t);
  workspace(root, "alpha", { scripts: { test: "node -e \"console.log('SHOULD_NOT_RUN')\"" } });
  workspace(root, "pi-better-server", {});
  const invalidArgs = [
    ["--shard"], ["--unknown"], ["1/2"], ["--shard=1/2"],
    ["--shard", "1/2", "extra"], ["--shard", "1/2", "--shard", "2/2"],
    ...["", "0/2", "1/0", "3/2", "-1/2", "1/-2", "1.5/2", "1/2.5", "NaN/2", "1/Infinity",
      "1/2/3", "1", "01/2", "1/02", "+1/2", " 1/2", "1/2\n", "1e0/2",
      "9007199254740992/9007199254740992", "1/9007199254740992"].map((value) => ["--shard", value]),
  ];
  for (const args of invalidArgs) {
    const result = run(root, args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /Usage:.*--shard INDEX\/TOTAL/, JSON.stringify(args));
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/, JSON.stringify(args));
  }
});

test("returns failure and stops before later workspace tests, with or without sharding", (t) => {
  const root = fixture(t);
  workspace(root, "alpha", { scripts: { test: "node -e \"process.exit(7)\"" } });
  workspace(root, "later", { scripts: { test: "node -e \"console.log('SHOULD_NOT_RUN')\"" } });
  workspace(root, "pi-better-server", {});
  workspace(root, "beta", { scripts: { test: "node -e \"console.log('SHOULD_NOT_RUN')\"" } });
  const direct = spawnSync("npm", ["run", "test", "--workspace", "packages/alpha"], { cwd: root, encoding: "utf8" });
  assert.notEqual(direct.status, 0);
  for (const args of [[], ["--shard", "1/2"]]) {
    const result = run(root, args);
    assert.equal(result.status, direct.status, result.stderr);
    assert.match(result.stderr, /Lifecycle script `test` failed/);
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
  }
});
