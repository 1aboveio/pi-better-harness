/**
 * Guards the two gate reducers that live inside ci.yml.
 *
 * Those reducers decide whether a skipped lane is allowed and whether a failed
 * half fails its required check name. They are shell text in YAML, so nothing
 * else in the suite runs them: without this file a typo in `ci` or in the
 * macOS reducer changes what can merge, and CI would only reveal it on the next
 * pull request. Each case below is one merge-rule boundary.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const workflowPath = resolve(import.meta.dirname, "..", ".github", "workflows", "ci.yml");

/** Return the shell body of one `- name: <step>` step inside one job. */
export function extractGate(source, job, stepName) {
  const lines = source.split("\n");
  const jobStart = lines.findIndex((line) => line === `  ${job}:`);
  assert.notEqual(jobStart, -1, `no job named ${job}`);
  const nextJob = lines.findIndex(
    (line, index) => index > jobStart && /^ {2}[a-z0-9-]+:$/.test(line),
  );
  const jobEnd = nextJob === -1 ? lines.length : nextJob;

  const stepStart = lines.findIndex(
    (line, index) => index > jobStart && index < jobEnd && line.trim() === `- name: ${stepName}`,
  );
  assert.notEqual(stepStart, -1, `no step named ${stepName} in ${job}`);

  const runMarker = lines.findIndex(
    (line, index) => index > stepStart && index < jobEnd && line.trim() === "run: |",
  );
  assert.notEqual(runMarker, -1, `no block script for ${stepName}`);

  const body = [];
  for (let index = runMarker + 1; index < jobEnd; index += 1) {
    const line = lines[index];
    if (line.trim().length > 0 && line.length - line.trimStart().length <= 8) {
      break;
    }
    body.push(line.startsWith(" ".repeat(10)) ? line.slice(10) : "");
  }
  const script = body.join("\n").trim();
  assert.ok(script.length > 0, `${stepName} has an empty script`);
  return script;
}

function exitCode(script, env) {
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  assert.equal(result.error, undefined, "bash must be runnable");
  return result.status;
}

const source = readFileSync(workflowPath, "utf8");
const ciGate = extractGate(source, "ci", "Require every test lane");
const macGate = extractGate(source, "macos-sandbox", "Require both macOS halves");

const green = {
  CHANGES_RESULT: "success",
  WORKSPACE_AREA: "true",
  SERVER_AREA: "true",
  WORKSPACE_RESULT: "success",
  SERVER_RESULT: "success",
};

test("ci passes when every affected lane succeeded", () => {
  assert.equal(exitCode(ciGate, green), 0);
});

test("ci passes when unaffected lanes were skipped", () => {
  assert.equal(
    exitCode(ciGate, {
      ...green,
      WORKSPACE_AREA: "false",
      SERVER_AREA: "false",
      WORKSPACE_RESULT: "skipped",
      SERVER_RESULT: "skipped",
    }),
    0,
  );
});

test("ci fails when a lane skipped although its area changed", () => {
  assert.equal(
    exitCode(ciGate, { ...green, WORKSPACE_RESULT: "skipped" }),
    1,
  );
});

test("ci fails when a lane failed or was cancelled", () => {
  assert.equal(exitCode(ciGate, { ...green, SERVER_RESULT: "failure" }), 1);
  assert.equal(exitCode(ciGate, { ...green, WORKSPACE_RESULT: "cancelled" }), 1);
});

test("ci fails when the selector job did not run", () => {
  assert.equal(exitCode(ciGate, { ...green, CHANGES_RESULT: "failure" }), 1);
});

test("the ci gate does not read the resource measurement", () => {
  assert.equal(ciGate.includes("shared-read-resources"), false);
  assert.equal(source.includes("check shared-read-resources"), false);
});

const macGreen = {
  AFFECTED: "true",
  LIFECYCLE_RESULT: "success",
  SUBAGENT_RESULT: "success",
  PACKAGES_RESULT: "success",
  HARNESS_RESULT: "success",
};

test("macos-sandbox passes when every half succeeded", () => {
  assert.equal(exitCode(macGate, macGreen), 0);
});

test("macos-sandbox passes when no sandbox path changed", () => {
  assert.equal(
    exitCode(macGate, {
      AFFECTED: "false",
      LIFECYCLE_RESULT: "skipped",
      SUBAGENT_RESULT: "skipped",
      PACKAGES_RESULT: "skipped",
      HARNESS_RESULT: "skipped",
    }),
    0,
  );
});

test("macos-sandbox fails when any half failed", () => {
  assert.equal(exitCode(macGate, { ...macGreen, SUBAGENT_RESULT: "failure" }), 1);
});

test("macos-sandbox fails when a half skipped although sandbox paths changed", () => {
  assert.equal(exitCode(macGate, { ...macGreen, HARNESS_RESULT: "skipped" }), 1);
});
