import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  harnessSettingsPath,
  readHarnessSetting,
  updateHarnessSetting,
  type HarnessSettingsSeams,
} from "./shared-harness-settings.js";

export interface GoalPreferences {
  autoContinue: boolean;
  conversationalResume: boolean;
  pauseOnEscape: boolean;
}

export interface GoalPreferenceSeams extends HarnessSettingsSeams {}

export function goalPreferencesPath(seams: GoalPreferenceSeams = {}): string {
  return harnessSettingsPath(seams);
}

export function readGoalPreferences(seams: GoalPreferenceSeams = {}): GoalPreferences {
  const path = goalPreferencesPath(seams);
  const legacyPath = join((seams.agentDir ?? getAgentDir)(), "extensions", "pi-better-goal-preferences.json");
  try {
    const value = readHarnessSetting<unknown>("goal", seams, {
      path: legacyPath,
      parse: (value) => ({ version: 1, ...parseGoalPreferences(value, legacyPath) }),
    });
    return parseGoalPreferences(value, path);
  } catch (error) {
    if (messageOf(error).startsWith("Goal preferences at ")) throw error;
    if (error instanceof SyntaxError || /not valid JSON/.test(messageOf(error))) {
      throw new Error(`Goal preferences at ${path} are not valid JSON: ${messageOf(error)}`);
    }
    throw new Error(`Goal preferences at ${path} could not be read: ${messageOf(error)}`);
  }
}

function parseGoalPreferences(parsed: unknown, path: string): GoalPreferences {
  if (parsed === undefined) {
    return { autoContinue: true, conversationalResume: true, pauseOnEscape: true };
  }
  const value = parsed as Partial<GoalPreferences> & { version?: unknown } | null;
  if (value?.version !== 1 ||
      (value.autoContinue !== undefined && typeof value.autoContinue !== "boolean") ||
      (value.conversationalResume !== undefined && typeof value.conversationalResume !== "boolean") ||
      (value.pauseOnEscape !== undefined && typeof value.pauseOnEscape !== "boolean")) {
    throw new Error(`Goal preferences at ${path} must contain version 1 and boolean autoContinue/conversationalResume/pauseOnEscape settings.`);
  }
  return {
    autoContinue: value.autoContinue ?? true,
    conversationalResume: value.conversationalResume ?? true,
    pauseOnEscape: value.pauseOnEscape ?? true,
  };
}

/** Persist one control without replacing another session's saved choices. */
export function writeGoalPreference(
  key: keyof GoalPreferences,
  enabled: boolean,
  seams: GoalPreferenceSeams = {},
): GoalPreferences {
  // Migrate legacy preferences before updating the authoritative value under lock.
  readGoalPreferences(seams);
  const path = goalPreferencesPath(seams);
  try {
    const { version: _version, ...preferences } = updateHarnessSetting("goal", (current) => ({
      version: 1,
      ...parseGoalPreferences(current, path),
      [key]: enabled,
    }), seams);
    return preferences;
  } catch (error) {
    if (messageOf(error).startsWith("Goal preferences at ")) throw error;
    throw new Error(`Goal preferences at ${path} could not be written: ${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
