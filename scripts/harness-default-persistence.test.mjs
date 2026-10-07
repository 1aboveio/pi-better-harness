import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGoalPreferences, writeGoalPreference } from "../packages/pi-better-goal/src/preferences.ts";
import { readSandboxDefault, writeSandboxDefault } from "../packages/pi-better-sandbox/preferences.ts";
import { readPermissionSettings, writePermissionSettings } from "../packages/pi-better-sandbox/permission-settings.ts";
import { readDenyRuleOverride, writeDenyRuleOverride } from "../packages/pi-better-sandbox/deny-rules.ts";
import { getCallbackSettings, saveCallbackDefault } from "../packages/callback-batcher/index.ts";
import { loadConfig, setConfigForTests, writeSubagentSettings } from "../packages/pi-better-subagents/config.ts";

test("standalone package saves share global settings without replacing each other's defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "all-harness-defaults-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify({ theme: "light", piBetterHarness: { toolOutput: { version: 1, enabled: true } } }));
  try {
    writeGoalPreference("autoContinue", false);
    saveCallbackDefault("steer");
    writeSandboxDefault("on");
    const permissions = readPermissionSettings();
    permissions.main.enabled = false;
    writePermissionSettings(permissions);
    writeDenyRuleOverride([".env"]);
    writeSubagentSettings({ delegationMode: "coordinator", maxConcurrent: 6 });
    writeGoalPreference("pauseOnEscape", false);
    setConfigForTests(undefined);
    assert.equal(loadConfig().maxConcurrent, 6);
    assert.equal(loadConfig().delegationMode, "coordinator");
    assert.deepEqual(readGoalPreferences(), { autoContinue: false, conversationalResume: true, pauseOnEscape: false });
    assert.equal(getCallbackSettings({}).mode, "steer");
    assert.equal(readSandboxDefault(), "on");
    assert.equal(readPermissionSettings().main.enabled, false);
    assert.deepEqual(readDenyRuleOverride(), [".env"]);
    const global = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(global.theme, "light");
    assert.deepEqual(global.piBetterHarness.toolOutput, { version: 1, enabled: true });
    assert.deepEqual(Object.keys(global.piBetterHarness).sort(), ["callbacks", "goal", "sandbox", "sandboxDenyRules", "sandboxPermissions", "subagents", "toolOutput"]);
  } finally {
    setConfigForTests(undefined);
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(root, { recursive: true, force: true });
  }
});