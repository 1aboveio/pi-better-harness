import { readHarnessSetting, updateHarnessSetting, type HarnessSettingsSeams } from "./shared-harness-settings.ts";

export const DEFAULT_BACKGROUND_REVIEW_INTERVAL_MINUTES = 10;
const key = "backgroundReviewIntervalMinutes";

function validMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1440;
}

export function readBackgroundReviewInterval(seams?: HarnessSettingsSeams): number {
  const value = readHarnessSetting(key, seams);
  return validMinutes(value) ? value : DEFAULT_BACKGROUND_REVIEW_INTERVAL_MINUTES;
}

export function saveBackgroundReviewInterval(minutes: number, seams?: HarnessSettingsSeams): void {
  if (!validMinutes(minutes)) throw new Error("Background review interval must be a whole number from 1 to 1440 minutes.");
  updateHarnessSetting(key, () => minutes, seams);
}
