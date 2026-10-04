import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGoalSettingsPage } from "../src/settings-page.js";
import type { GoalPreferences } from "../src/preferences.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as Theme;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("settings rows toggle independently, serialize saves, and Escape closes without further changes", async () => {
  let preferences: GoalPreferences = { autoContinue: true, conversationalResume: true, pauseOnEscape: true };
  let closes = 0;
  const changes: string[] = [];
  const page = createGoalSettingsPage(theme, {
    get: () => preferences,
    async change(key, enabled) {
      changes.push(key);
      preferences = { ...preferences, [key]: enabled };
    },
  }, () => {}, () => { closes++; });
  page.handleInput!(" ");
  page.handleInput!(" ");
  await flush();
  assert.deepEqual(changes, ["autoContinue"]);
  assert.deepEqual(preferences, { autoContinue: false, conversationalResume: true, pauseOnEscape: true });
  page.handleInput!("\x1b[B");
  page.handleInput!("\r");
  await flush();
  assert.deepEqual(preferences, { autoContinue: false, conversationalResume: false, pauseOnEscape: true });
  page.handleInput!("\x1b[B");
  page.handleInput!(" ");
  await flush();
  assert.deepEqual(preferences, { autoContinue: false, conversationalResume: false, pauseOnEscape: false });
  assert.match(page.render(80).join("\n"), /Pause on Esc\s+Off/);
  page.handleInput!("\x1b");
  assert.equal(closes, 1);
  assert.deepEqual(changes, ["autoContinue", "conversationalResume", "pauseOnEscape"]);
  for (const width of [1, 16, 39, 40, 80]) {
    assert.ok(page.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("failed saves leave values unchanged and allow retry", async () => {
  let preferences: GoalPreferences = { autoContinue: true, conversationalResume: true, pauseOnEscape: true };
  let attempts = 0;
  const page = createGoalSettingsPage(theme, {
    get: () => preferences,
    async change(key, enabled) {
      if (++attempts === 1) throw new Error("Permission denied");
      preferences = { ...preferences, [key]: enabled };
    },
  }, () => {}, () => {});
  page.handleInput!("\r");
  await flush();
  assert.equal(preferences.autoContinue, true);
  assert.match(page.render(80).join("\n"), /Permission denied/);
  page.handleInput!("\r");
  await flush();
  assert.equal(preferences.autoContinue, false);
  assert.match(page.render(80).join("\n"), /Saved\./);
});