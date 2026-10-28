import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureHarnessResources, harnessExtensionFilters, preflightHarnessInstall } from "../lib/install-settings.mjs";

const filteredHarness = (extra = {}) => ({
  source: "npm:pi-better-harness",
  ...extra,
  extensions: [...harnessExtensionFilters],
  skills: [],
  prompts: [],
  themes: [],
});

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "harness-install-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("filters Harness and retires only Plan in the selected settings file", () => {
  withTemp((dir) => {
    const target = join(dir, "actual.json");
    const path = join(dir, "settings.json");
    symlinkSync(target, path);
    writeFileSync(target, JSON.stringify({ theme: "dark", packages: ["npm:pi-better-plan@0.9.1", "npm:other", { source: "npm:pi-better-harness", custom: true }] }));
    configureHarnessResources(true, { path });
    const settings = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.packages[0], "npm:other");
    assert.deepEqual(settings.packages[1], filteredHarness({ custom: true }));
    assert.ok(lstatSync(path).isSymbolicLink(), "the settings link must survive the write");
    configureHarnessResources(true, { path });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), settings);
  });
});

test("invalid settings are not overwritten", () => {
  withTemp((dir) => {
    const path = join(dir, "settings.json");
    writeFileSync(path, "{bad");
    assert.throws(() => configureHarnessResources(false, { path }));
    assert.equal(readFileSync(path, "utf8"), "{bad");
  });
});

test("preflight reports the selected scope and tolerates a missing file", () => {
  withTemp((dir) => {
    const path = join(dir, "settings.json");
    assert.deepEqual(preflightHarnessInstall(false, { path }), { path, harnessRegistered: false });

    writeFileSync(path, JSON.stringify({}));
    assert.equal(preflightHarnessInstall(false, { path }).harnessRegistered, false);
    assert.throws(() => configureHarnessResources(false, { path }), /did not register pi-better-harness/);
    assert.equal(readFileSync(path, "utf8"), "{}");

    writeFileSync(path, JSON.stringify({ packages: ["npm:pi-better-harness@0.32.1"] }));
    assert.equal(preflightHarnessInstall(false, { path }).harnessRegistered, true);

    writeFileSync(path, JSON.stringify({ packages: [{ source: "npm:pi-better-harness" }] }));
    assert.equal(preflightHarnessInstall(false, { path }).harnessRegistered, true);
  });
});

test("unexpected settings shapes are refused without being overwritten", () => {
  const shapes = [
    "[]",
    "null",
    '"text"',
    JSON.stringify({ packages: {} }),
    JSON.stringify({ packages: [null] }),
    JSON.stringify({ packages: [{ source: 42 }] }),
    '{"packages":[{"source":"npm:pi-better-harness"}],"theme":',
  ];
  withTemp((dir) => {
    const path = join(dir, "settings.json");
    for (const shape of shapes) {
      writeFileSync(path, shape);
      assert.throws(() => preflightHarnessInstall(false, { path }), JSON.stringify(shape));
      assert.throws(() => configureHarnessResources(false, { path }), JSON.stringify(shape));
      assert.equal(readFileSync(path, "utf8"), shape);
    }
  });
});

test("Plan is kept when Harness is not registered yet", () => {
  withTemp((dir) => {
    const path = join(dir, "settings.json");
    const original = JSON.stringify({ theme: "dark", packages: ["npm:pi-better-plan@0.9.1", "npm:other"] });
    writeFileSync(path, original);
    assert.throws(() => configureHarnessResources(true, { path }), /did not register pi-better-harness/);
    assert.equal(readFileSync(path, "utf8"), original);
  });
});

test("Plan is retired only in the selected scope", () => {
  withTemp((root) => {
    const agent = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    const globalPath = join(agent, "settings.json");
    const localPath = join(project, ".pi", "settings.json");
    writeFileSync(globalPath, JSON.stringify({ theme: "global", packages: ["npm:pi-better-plan@0.9.1", "npm:pi-better-harness"] }));
    writeFileSync(localPath, JSON.stringify({ theme: "local", packages: ["npm:pi-better-plan@0.9.1", "npm:pi-better-harness"] }));

    const previousCwd = process.cwd();
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    process.chdir(project);
    try {
      configureHarnessResources(false);
      assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")).packages, [filteredHarness()]);
      assert.ok(readFileSync(localPath, "utf8").includes("npm:pi-better-plan@0.9.1"));

      const globalBeforeLocalInstall = readFileSync(globalPath, "utf8");
      configureHarnessResources(true);
      assert.ok(!readFileSync(localPath, "utf8").includes("pi-better-plan"));
      assert.equal(readFileSync(globalPath, "utf8"), globalBeforeLocalInstall);
    } finally {
      process.chdir(previousCwd);
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
    }
  });
});

test("a concurrent settings change is preserved by the filtered write", () => {
  withTemp((dir) => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ theme: "before", packages: ["npm:pi-better-harness"] }));
    preflightHarnessInstall(false, { path });
    // Another Pi process writes after preflight but before the filtered write.
    writeFileSync(path, JSON.stringify({ theme: "concurrent", extra: true, packages: ["npm:other", "npm:pi-better-harness"] }));
    configureHarnessResources(false, { path });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(settings.theme, "concurrent");
    assert.equal(settings.extra, true);
    assert.deepEqual(settings.packages, ["npm:other", filteredHarness()]);
  });
});

test("dangling settings links are refused instead of replaced", () => {
  withTemp((dir) => {
    const target = join(dir, "missing.json");
    const path = join(dir, "settings.json");
    symlinkSync(target, path);
    assert.throws(() => preflightHarnessInstall(false, { path }), /dangling Pi settings link/);
    assert.throws(() => configureHarnessResources(false, { path }), /dangling Pi settings link/);
    assert.ok(lstatSync(path).isSymbolicLink());
    assert.throws(() => lstatSync(target), { code: "ENOENT" });
  });
});

test("unrelated settings and the native Outcome & Todo choice survive the install", () => {
  withTemp((dir) => {
    const path = join(dir, "settings.json");
    const outcomeTodo = { version: 1, enabled: false };
    writeFileSync(path, JSON.stringify({
      theme: "dark",
      piBetterHarness: { toolOutput: "minimal", outcomeTodo },
      packages: ["npm:pi-better-plan@0.9.1", "npm:other", { source: "npm:pi-better-harness", custom: true }],
    }));
    configureHarnessResources(true, { path });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.piBetterHarness, { toolOutput: "minimal", outcomeTodo });
    assert.deepEqual(Object.keys(settings).sort(), ["packages", "piBetterHarness", "theme"]);
    assert.equal(settings.packages[0], "npm:other");
    assert.deepEqual(settings.packages[1], filteredHarness({ custom: true }));
  });
});

test("install adds no Outcome & Todo setting when none exists", () => {
  withTemp((dir) => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ piBetterHarness: { toolOutput: "normal" }, packages: ["npm:pi-better-harness"] }));
    configureHarnessResources(true, { path });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(settings.piBetterHarness, { toolOutput: "normal" });
    assert.equal("outcomeTodo" in settings.piBetterHarness, false);
  });
});
