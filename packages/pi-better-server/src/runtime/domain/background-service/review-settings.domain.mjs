// Generated fixed launch domain from packages/pi-better-background-tasks/src/review-settings.ts. Do not edit directly.
import { readHarnessSetting, updateHarnessSetting } from "./shared-harness-settings.domain.mjs";
export const DEFAULT_BACKGROUND_REVIEW_INTERVAL_MINUTES = 10;
const key = "backgroundReviewIntervalMinutes";
function validMinutes(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1440;
}
export function readBackgroundReviewInterval(seams) {
    const value = readHarnessSetting(key, seams);
    return validMinutes(value) ? value : DEFAULT_BACKGROUND_REVIEW_INTERVAL_MINUTES;
}
export function saveBackgroundReviewInterval(minutes, seams) {
    if (!validMinutes(minutes))
        throw new Error("Background review interval must be a whole number from 1 to 1440 minutes.");
    updateHarnessSetting(key, () => minutes, seams);
}
