import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { GoalSnapshot } from "./types.js";

export interface GoalTiming {
  activeSeconds: number;
  elapsedSeconds: number;
}

export function goalTiming(goal: GoalSnapshot, now = Math.floor(Date.now() / 1000)): GoalTiming {
  const activeDelta =
    goal.status === "active" && goal.activeStartedAt !== null
      ? Math.max(0, now - goal.activeStartedAt)
      : 0;
  const end = goal.completedAt ?? now;

  return {
    activeSeconds: goal.usage.activeSeconds + activeDelta,
    elapsedSeconds: Math.max(0, end - goal.createdAt),
  };
}

export function formatClockDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function formatGoalClock(
  goal: GoalSnapshot,
  now = Math.floor(Date.now() / 1000),
): string {
  const timing = goalTiming(goal, now);
  return (
    `Goal [${goal.status}]: ${goal.objective}` +
    ` | active ${formatClockDuration(timing.activeSeconds)}` +
    ` | elapsed ${formatClockDuration(timing.elapsedSeconds)}`
  );
}

export function renderGoalClockLine(
  goal: GoalSnapshot,
  width: number,
  now = Math.floor(Date.now() / 1000),
): string {
  if (width <= 0) {
    return "";
  }

  const timing = goalTiming(goal, now);
  const clocks =
    `active ${formatClockDuration(timing.activeSeconds)}` +
    ` | elapsed ${formatClockDuration(timing.elapsedSeconds)}`;
  const prefix = `Goal [${goal.status}]: ${goal.objective}`;
  const availablePrefix = width - visibleWidth(clocks) - 3;
  const content =
    availablePrefix > 0
      ? `${truncateToWidth(prefix, availablePrefix)} | ${clocks}`
      : truncateToWidth(
          `A ${formatClockDuration(timing.activeSeconds)} E ${formatClockDuration(timing.elapsedSeconds)}`,
          width,
        );
  const padding = " ".repeat(Math.max(0, width - visibleWidth(content)));
  return padding + content;
}
