import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { goalPreferencesPath, readGoalPreferences, writeGoalPreference } from "../src/preferences.js";

test("missing preferences default to enabled and changes preserve independent saved controls", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seams = { agentDir: () => root };
  assert.equal(goalPreferencesPath(seams), join(root, "settings.json"));
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: true, conversationalResume: true, pauseOnEscape: true });
  assert.equal(existsSync(goalPreferencesPath(seams)), false, "reading defaults does not persist them");
  writeGoalPreference("autoContinue", false, seams);
  writeGoalPreference("conversationalResume", false, seams);
  writeGoalPreference("pauseOnEscape", false, seams);
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: false, conversationalResume: false, pauseOnEscape: false });
  writeGoalPreference("autoContinue", true, seams);
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: true, conversationalResume: false, pauseOnEscape: false });
  writeGoalPreference("pauseOnEscape", true, seams);
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: true, conversationalResume: false, pauseOnEscape: true });
});

test("partial versioned preferences preserve defaults for controls not yet saved", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seams = { agentDir: () => root };
  const path = goalPreferencesPath(seams);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ piBetterHarness: { goal: { version: 1, autoContinue: false } } }));
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: false, conversationalResume: true, pauseOnEscape: true });
  writeFileSync(path, JSON.stringify({ piBetterHarness: { goal: { version: 1, autoContinue: false, conversationalResume: false } } }));
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: false, conversationalResume: false, pauseOnEscape: true });
  writeGoalPreference("pauseOnEscape", false, seams);
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: false, conversationalResume: false, pauseOnEscape: false });
});

test("invalid preferences report an error and are not overwritten by a setting update", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seams = { agentDir: () => root };
  const path = goalPreferencesPath(seams);
  mkdirSync(dirname(path), { recursive: true });
  for (const raw of ["{", ...[null, { version: 2 }, { version: 1, autoContinue: "off" },
    { version: 1, conversationalResume: 0 }, { version: 1, pauseOnEscape: "off" }]
    .map((goal) => JSON.stringify({ piBetterHarness: { goal } }))]) {
    writeFileSync(path, raw);
    assert.throws(() => readGoalPreferences(seams), /Goal preferences .* (not valid JSON|must contain version 1)/);
    assert.throws(() => writeGoalPreference("autoContinue", false, seams), /Goal preferences .* (not valid JSON|must contain version 1)/);
    assert.throws(() => readGoalPreferences(seams), /Goal preferences .* (not valid JSON|must contain version 1)/, "a failed update cannot replace an invalid file with defaults");
    assert.equal(readFileSync(path, "utf8"), raw);
  }
});

test("unavailable preference storage reports an error rather than treating it as a missing file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "settings.json"));
  assert.throws(() => writeGoalPreference("autoContinue", false, { agentDir: () => root }), /Goal preferences .* could not be (read|written)/);
});

test("legacy preferences migrate on read and global updates preserve unrelated settings", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seams = { agentDir: () => root };
  const path = goalPreferencesPath(seams);
  const unrelated = { theme: "light", piBetterHarness: { callbacks: { mode: "immediate" } } };
  writeFileSync(path, JSON.stringify(unrelated));
  const legacyPath = join(root, "extensions", "pi-better-goal-preferences.json");
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({ version: 1, autoContinue: false, pauseOnEscape: false }));

  assert.deepEqual(readGoalPreferences(seams), { autoContinue: false, conversationalResume: true, pauseOnEscape: false });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    ...unrelated,
    piBetterHarness: { ...unrelated.piBetterHarness, goal: {
      version: 1, autoContinue: false, conversationalResume: true, pauseOnEscape: false,
    } },
  });
  writeGoalPreference("conversationalResume", false, seams);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    ...unrelated,
    piBetterHarness: { ...unrelated.piBetterHarness, goal: {
      version: 1, autoContinue: false, conversationalResume: false, pauseOnEscape: false,
    } },
  });

  writeFileSync(legacyPath, "{invalid JSON");
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: false, conversationalResume: false, pauseOnEscape: false },
    "the global key remains authoritative even when legacy storage changes");
});

test("a setting update migrates legacy controls before changing one preference", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seams = { agentDir: () => root };
  const legacyPath = join(root, "extensions", "pi-better-goal-preferences.json");
  mkdirSync(dirname(legacyPath), { recursive: true });
  const legacy = JSON.stringify({ version: 1, autoContinue: false, conversationalResume: false });
  writeFileSync(legacyPath, legacy);
  assert.deepEqual(writeGoalPreference("pauseOnEscape", false, seams), {
    autoContinue: false, conversationalResume: false, pauseOnEscape: false,
  });
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: false, conversationalResume: false, pauseOnEscape: false });
});

test("invalid legacy preferences are not migrated or overwritten", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seams = { agentDir: () => root };
  const path = goalPreferencesPath(seams);
  const rawSettings = JSON.stringify({ theme: "light", piBetterHarness: { callbacks: { mode: "immediate" } } });
  writeFileSync(path, rawSettings);
  const legacyPath = join(root, "extensions", "pi-better-goal-preferences.json");
  mkdirSync(dirname(legacyPath), { recursive: true });
  for (const raw of ["{", '{"version":2}', '{"version":1,"autoContinue":"off"}']) {
    writeFileSync(legacyPath, raw);
    assert.throws(() => readGoalPreferences(seams), /Goal preferences .* (not valid JSON|must contain version 1)/);
    assert.throws(() => writeGoalPreference("autoContinue", false, seams), /Goal preferences .* (not valid JSON|must contain version 1)/);
    assert.equal(readFileSync(path, "utf8"), rawSettings);
    assert.equal(readFileSync(legacyPath, "utf8"), raw);
  }
});
