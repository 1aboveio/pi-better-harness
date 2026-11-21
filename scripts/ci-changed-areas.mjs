/**
 * Decide which CI lanes a change has to prove.
 *
 * The workflow keeps every job and the four required check names, so a skipped
 * lane would leave a required context unreported and block the pull request.
 * Instead each lane asks this script whether its area changed and exits early
 * when it did not. The mapping below is the only place that decides which paths
 * belong to which area.
 *
 * Two rules keep the selection from under-proving:
 * - A shared file (lockfile, root config, this workflow) selects every area.
 * - A changed path that no area claims selects every area, so a new top-level
 *   file or config cannot silently skip the lanes that would have tested it.
 *
 * Usage: node scripts/ci-changed-areas.mjs
 *   Reads GITHUB_BASE_REF, diffs it against HEAD, writes `area=true|false`
 *   lines to GITHUB_OUTPUT. Every area is true when the base ref is unknown or
 *   the diff cannot be computed.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const AREA_NAMES = ["workspace", "sandbox", "windows", "server", "extensions"];

/** A change here can invalidate any lane's assumptions. */
const SHARED = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "agent-catalog.yaml",
  ".github/workflows/ci.yml",
  "scripts/ci-changed-areas.mjs",
  // Every lane that installs or isolates a registry shares these.
  "scripts/isolate-registry.mjs",
  "scripts/test-ci-workspaces.mjs",
  // A workspace manifest change can reach any lane that imports that package.
  "packages/*/package.json",
];

/** Paths whose change exercises a lane. Glob `**` spans directories. */
const AREA_PATTERNS = {
  workspace: ["packages/**", "scripts/**", "bin/**"],
  sandbox: [
    "packages/sandbox-core/**",
    "packages/task-sandbox/**",
    "packages/pi-better-sandbox/**",
    "packages/sandbox-diagnostics/**",
    "packages/pi-better-subagents/**",
    "packages/pi-better-background-tasks/**",
    "docs/adr/0027-sandbox-tools-and-permissions.md",
    "scripts/sandbox-permissions.tui.e2e.test.mjs",
    "packages/pi-better-server/test/support/subagent-offline-model.ts",
    "packages/pi-better-server/test/support/subagent-launch-sdk.mjs",
    "packages/pi-better-server/test/support/native-message-framing.mjs",
    "packages/pi-better-server/src/runtime/domain/subagents/**",
    "packages/pi-better-server/src/runtime/domain/sandbox-policy/**",
    "scripts/require-sandbox-backend.mjs",
    "scripts/run-sandbox-golden.mjs",
    "scripts/sandbox-compatibility.golden.mjs",
    "scripts/sync-shared-sandbox-core.mjs",
    "scripts/sync-task-sandbox.mjs",
    "scripts/harness-session.e2e.test.mjs",
    "docs/tests/sandbox-compatibility.smoke.manifest.json",
  ],
  windows: [
    "packages/pi-better-background-tasks/**",
    "packages/ssh-core/**",
    "packages/pi-better-ssh/**",
  ],
  server: [
    "packages/pi-better-server/**",
    "packages/pi-better-subagents/**",
    "packages/operation-coordinator/**",
    "packages/stall-detector/**",
    "packages/failure-observations/**",
    "packages/render-scheduler/**",
    "packages/pi-better-goal/**",
    "packages/harness-settings/**",
    "packages/pi-better-plan/**",
    "packages/pi-better-model-router/**",
  ],
  extensions: [
    "packages/pi-better-background-tasks/**",
    "packages/navigator/**",
    "packages/ssh-core/**",
    "packages/pi-better-ssh/**",
  ],
};

/** Paths that cannot change what any lane runs: prose, images and local state. */
const NOT_CODE = [
  /^docs\//,
  /^\.pi\//,
  /\.md$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.pi-del-probe-\d+$/,
];

/** A path named literally by an area stays code even when it sits under prose. */
const EXPLICIT_CODE = new Set(
  Object.values(AREA_PATTERNS)
    .flat()
    .filter((pattern) => !pattern.includes("*")),
);

function isCode(file) {
  return EXPLICIT_CODE.has(file) || !NOT_CODE.some((pattern) => pattern.test(file));
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
}

const SHARED_MATCHERS = SHARED.map(globToRegExp);
const AREA_MATCHERS = Object.fromEntries(
  AREA_NAMES.map((name) => [name, AREA_PATTERNS[name].map(globToRegExp)]),
);

function allAreas(value) {
  return Object.fromEntries(AREA_NAMES.map((name) => [name, value]));
}

/**
 * Map changed repository-relative paths onto the areas CI must prove.
 *
 * Pure so the mapping can be tested without a git checkout.
 */
export function selectAreas(changedFiles) {
  const areas = allAreas(false);
  const code = changedFiles
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .filter(isCode);

  if (code.length === 0) {
    return areas;
  }
  for (const file of code) {
    if (SHARED_MATCHERS.some((pattern) => pattern.test(file))) {
      return allAreas(true);
    }
    const matched = AREA_NAMES.filter((name) =>
      AREA_MATCHERS[name].some((pattern) => pattern.test(file)),
    );
    if (matched.length === 0) {
      return allAreas(true);
    }
    for (const name of matched) {
      areas[name] = true;
    }
  }
  return areas;
}

/** Changed paths between the pull request base and HEAD, or null when unknown. */
export function readChangedFiles(env = process.env) {
  const base = env.GITHUB_BASE_REF || env.CI_BASE_REF;
  if (!base) {
    return null;
  }
  try {
    const output = execFileSync("git", ["diff", "--name-only", `origin/${base}...HEAD`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.split("\n");
  } catch (error) {
    console.error(`Could not diff against origin/${base}: ${error.message}`);
    return null;
  }
}

function main() {
  const changed = readChangedFiles();
  const areas = changed === null ? allAreas(true) : selectAreas(changed);
  if (changed === null) {
    console.log("No usable base ref: every area is in scope.");
  } else {
    console.log(`${changed.filter((file) => file.trim()).length} changed path(s):`);
    for (const name of AREA_NAMES) {
      console.log(`  ${name}=${areas[name]}`);
    }
  }
  const outputPath = process.env.GITHUB_OUTPUT;
  const lines = AREA_NAMES.map((name) => `${name}=${areas[name]}`).join("\n");
  if (outputPath) {
    appendFileSync(outputPath, `${lines}\n`);
  } else {
    console.log(lines);
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main();
}
