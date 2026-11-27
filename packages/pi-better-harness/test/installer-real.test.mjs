import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { configureHarnessResources, harnessExtensionFilters, preflightHarnessInstall } from "../lib/install-settings.mjs";

const BUNDLED_EXTENSIONS = [
  "extensions/sandbox/index.ts",
  "extensions/subagents/index.ts",
  "extensions/background-tasks/index.ts",
  "extensions/ssh/index.ts",
  "extensions/goal/index.ts",
  ...harnessExtensionFilters,
];

const STANDALONE = [
  ["pi-better-sandbox", "index.ts"],
  ["pi-better-subagents", "src/index.ts"],
  ["pi-better-background-tasks", "src/index.ts"],
  ["pi-better-ssh", "src/index.ts"],
  ["pi-better-goal", "src/index.ts"],
];

function posix(path) {
  return path.split("\\").join("/");
}

function writeFixturePackage(root, name, extensions, version = "1.0.0") {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name,
    version,
    type: "module",
    pi: { extensions },
  }));
  for (const entry of extensions) {
    const path = join(dir, entry);
    mkdirSync(dirname(path), { recursive: true });
    const symbol = `${name}_${entry}`.replace(/[^a-zA-Z0-9]/g, "_");
    writeFileSync(path, `export default function ${symbol}() {}\n`);
  }
  return dir;
}

// Mirrors how `pi install --local` stores npm packages. The fixtures are real
// package directories with a `pi.extensions` manifest, so Pi's own resource
// selection runs against them without touching the registry.
function prepareInstallation(root) {
  const home = join(root, "home");
  const agent = join(root, "agent");
  const project = join(root, "project");
  const npmRoot = join(project, ".pi", "npm", "node_modules");
  mkdirSync(home, { recursive: true });
  mkdirSync(agent, { recursive: true });
  mkdirSync(npmRoot, { recursive: true });

  writeFixturePackage(npmRoot, "pi-better-harness", BUNDLED_EXTENSIONS);
  for (const [name, entry] of STANDALONE) writeFixturePackage(npmRoot, name, [entry]);

  const settingsPath = join(project, ".pi", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    theme: "dark",
    piBetterHarness: { toolOutput: "minimal", outcomeTodo: { version: 1, enabled: false } },
    packages: [
      "npm:pi-better-plan@0.9.1",
      ...STANDALONE.map(([name]) => `npm:${name}`),
      "npm:pi-better-harness",
    ],
  }, null, 2));

  return { home, agent, project, settingsPath };
}

async function withRealPi(fn) {
  const root = mkdtempSync(join(tmpdir(), "harness-real-install-"));
  const paths = prepareInstallation(root);
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = paths.home;
  process.env.USERPROFILE = paths.home;
  process.env.PI_CODING_AGENT_DIR = paths.agent;
  try {
    return await fn(paths);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(root, { recursive: true, force: true });
  }
}

function expectedEnabled(project) {
  return [
    ...STANDALONE.map(([name, entry]) => posix(relative(project, join(project, ".pi", "npm", "node_modules", name, entry)))),
    ...harnessExtensionFilters.map((entry) => posix(relative(project, join(project, ".pi", "npm", "node_modules", "pi-better-harness", entry)))),
  ].sort();
}

test("production filters resolve to exactly the Harness-owned extensions plus standalone components", async () => {
  await withRealPi(async ({ agent, project, settingsPath }) => {
    assert.equal(preflightHarnessInstall(true, { path: settingsPath }).harnessRegistered, true);
    configureHarnessResources(true, { path: settingsPath });
    assert.equal(preflightHarnessInstall(true, { path: settingsPath }).harnessRegistered, true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.piBetterHarness, { toolOutput: "minimal", outcomeTodo: { version: 1, enabled: false } });
    assert.ok(!settings.packages.some((entry) => String(entry.source ?? entry).startsWith("npm:pi-better-plan")));
    const harness = settings.packages.find((entry) => entry.source === "npm:pi-better-harness");
    assert.deepEqual(harness, {
      source: "npm:pi-better-harness",
      extensions: [...harnessExtensionFilters],
      skills: [],
      prompts: [],
      themes: [],
    });

    const settingsManager = SettingsManager.create(project, agent);
    const manager = new DefaultPackageManager({ cwd: project, agentDir: agent, settingsManager });
    const resolved = await manager.resolve();
    const enabled = resolved.extensions
      .filter((entry) => entry.enabled)
      .map((entry) => posix(relative(project, entry.path)))
      .sort();
    assert.deepEqual(enabled, expectedEnabled(project), "only one copy of each component extension may be enabled");

    const harnessRoot = join(project, ".pi", "npm", "node_modules", "pi-better-harness");
    const disabled = new Set(
      resolved.extensions.filter((entry) => !entry.enabled).map((entry) => posix(relative(project, entry.path))),
    );
    for (const bundled of BUNDLED_EXTENSIONS.filter((entry) => !harnessExtensionFilters.includes(entry))) {
      assert.ok(disabled.has(posix(relative(project, join(harnessRoot, bundled)))), `${bundled} must be filtered out`);
    }

    const goalCopies = enabled.filter((path) => path.includes("/pi-better-goal/"));
    assert.deepEqual(goalCopies, [".pi/npm/node_modules/pi-better-goal/src/index.ts"]);
  });
});

test("the real Pi resource loader loads each selected extension once", async () => {
  await withRealPi(async ({ agent, project, settingsPath }) => {
    configureHarnessResources(true, { path: settingsPath });
    const settingsManager = SettingsManager.create(project, agent);
    const loader = new DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager });
    await loader.reload();

    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, [], "all filtered fixture extensions must load cleanly");
    const paths = loaded.extensions.map((extension) => posix(relative(project, extension.path))).sort();
    assert.deepEqual(paths, expectedEnabled(project));
  });
});
