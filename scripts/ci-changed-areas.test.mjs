/**
 * Guards the conditional-CI mapping: a path that no area claims, or a shared
 * file, must select every lane rather than silently reducing coverage.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AREA_NAMES, selectAreas } from "./ci-changed-areas.mjs";

const selected = (files) => AREA_NAMES.filter((name) => selectAreas(files)[name]);

test("prose and local state select no lane", () => {
  assert.deepEqual(selected(["README.md", "docs/adr/0001-example.md", ".pi/settings.json"]), []);
});

test("no changed files selects no lane", () => {
  assert.deepEqual(selectAreas([]), Object.fromEntries(AREA_NAMES.map((n) => [n, false])));
});

test("an ordinary package edit selects only the workspace lane", () => {
  assert.deepEqual(selected(["packages/pi-better-read-aloud/src/index.ts"]), ["workspace"]);
});

test("a sandbox edit adds the sandbox lane", () => {
  assert.deepEqual(selected(["packages/pi-better-sandbox/src/index.ts"]).sort(), [
    "sandbox",
    "workspace",
  ]);
});

test("a background-task edit adds sandbox, windows and extensions", () => {
  assert.deepEqual(selected(["packages/pi-better-background-tasks/src/task.ts"]).sort(), [
    "extensions",
    "sandbox",
    "windows",
    "workspace",
  ]);
});

test("the lockfile selects every lane", () => {
  assert.deepEqual(selected(["package-lock.json"]), [...AREA_NAMES]);
});

test("this workflow selects every lane", () => {
  assert.deepEqual(selected([".github/workflows/ci.yml"]), [...AREA_NAMES]);
});

test("a path no area claims selects every lane", () => {
  assert.deepEqual(selected(["vitest.shared.config.ts"]), [...AREA_NAMES]);
});

test("a workspace manifest selects every lane", () => {
  assert.deepEqual(selected(["packages/pi-better-ssh/package.json"]), [...AREA_NAMES]);
});

test("a shared test driver selects every lane", () => {
  assert.deepEqual(selected(["scripts/isolate-registry.mjs"]), [...AREA_NAMES]);
});

test("the sandbox manifest is treated as sandbox code", () => {
  assert.deepEqual(selected(["docs/tests/sandbox-compatibility.smoke.manifest.json"]), ["sandbox"]);
});

test("sandbox contract and acceptance inputs select the sandbox checks", () => {
  for (const path of [
    "docs/adr/0027-sandbox-tools-and-permissions.md",
    "scripts/sandbox-permissions.tui.e2e.test.mjs",
    "packages/pi-better-server/test/support/subagent-offline-model.ts",
    "packages/pi-better-subagents/tests/continuation.test.mjs",
  ]) assert.ok(selected([path]).includes("sandbox"), path);
});
