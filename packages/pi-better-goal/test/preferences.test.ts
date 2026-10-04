import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { goalPreferencesPath, readGoalPreferences, writeGoalPreference } from "../src/preferences.js";

test("missing preferences default to enabled and changes preserve independent saved controls", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seams = { agentDir: () => root };
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: true, conversationalResume: true, pauseOnEscape: true });
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
  writeFileSync(path, JSON.stringify({ version: 1, autoContinue: false }));
  assert.deepEqual(readGoalPreferences(seams), { autoContinue: false, conversationalResume: true, pauseOnEscape: true });
  writeFileSync(path, JSON.stringify({ version: 1, autoContinue: false, conversationalResume: false }));
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
  for (const raw of ["{", "null", '{"version":2}', '{"version":1,"autoContinue":"off"}', '{"version":1,"conversationalResume":0}', '{"version":1,"pauseOnEscape":"off"}']) {
    writeFileSync(path, raw);
    assert.throws(() => readGoalPreferences(seams), /Goal preferences .* (not valid JSON|must contain version 1)/);
    assert.throws(() => writeGoalPreference("autoContinue", false, seams), /Goal preferences .* (not valid JSON|must contain version 1)/);
    assert.throws(() => readGoalPreferences(seams), /Goal preferences .* (not valid JSON|must contain version 1)/, "a failed update cannot replace an invalid file with defaults");
  }
});

test("unavailable preference storage reports an error rather than treating it as a missing file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "extensions"), "not a directory");
  assert.throws(() => writeGoalPreference("autoContinue", false, { agentDir: () => root }), /Goal preferences .* could not be (read|written)/);
});
