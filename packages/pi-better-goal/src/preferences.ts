import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GoalPreferences {
  autoContinue: boolean;
  conversationalResume: boolean;
  pauseOnEscape: boolean;
}

export interface GoalPreferenceSeams {
  agentDir?: () => string;
}

export function goalPreferencesPath(seams: GoalPreferenceSeams = {}): string {
  return join((seams.agentDir ?? getAgentDir)(), "extensions", "pi-better-goal-preferences.json");
}

export function readGoalPreferences(seams: GoalPreferenceSeams = {}): GoalPreferences {
  const path = goalPreferencesPath(seams);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { autoContinue: true, conversationalResume: true, pauseOnEscape: true };
    }
    throw new Error(`Goal preferences at ${path} could not be read: ${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Goal preferences at ${path} are not valid JSON: ${messageOf(error)}`);
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
  const preferences = { ...readGoalPreferences(seams), [key]: enabled };
  const path = goalPreferencesPath(seams);
  const pending = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(pending, `${JSON.stringify({ version: 1, ...preferences }, null, 2)}\n`, "utf8");
    renameSync(pending, path);
  } catch (error) {
    throw new Error(`Goal preferences at ${path} could not be written: ${messageOf(error)}`);
  } finally {
    rmSync(pending, { force: true });
  }
  return preferences;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
