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

function run(root) {
  return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
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

test("returns failure and stops before later workspace tests", (t) => {
  const root = fixture(t);
  workspace(root, "alpha", { scripts: { test: "node -e \"process.exit(7)\"" } });
  workspace(root, "later", { scripts: { test: "node -e \"console.log('SHOULD_NOT_RUN')\"" } });
  workspace(root, "pi-better-server", {});
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Lifecycle script `test` failed/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});
