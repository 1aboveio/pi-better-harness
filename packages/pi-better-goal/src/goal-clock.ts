import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { GoalSnapshot } from "./types.js";

export interface GoalTiming {
  activeSeconds: number;
  elapsedSeconds: number;
}

export const COMPLETED_GOAL_RETENTION_SECONDS = 30;
export const ACTIVE_GOAL_REFRESH_MS = 10_000;

export function isGoalClockVisible(
  goal: GoalSnapshot,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (goal.status !== "complete" || goal.completedAt === null) {
    return true;
  }
  return now - goal.completedAt < COMPLETED_GOAL_RETENTION_SECONDS;
}

export function goalClockRefreshDelayMs(goal: GoalSnapshot, nowMs = Date.now()): number | null {
  if (goal.status === "active") {
    return ACTIVE_GOAL_REFRESH_MS;
  }
  if (goal.status !== "complete" || goal.completedAt === null) {
    return null;
  }
  const deadlineMs = (goal.completedAt + COMPLETED_GOAL_RETENTION_SECONDS) * 1_000;
  return deadlineMs > nowMs ? deadlineMs - nowMs : null;
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
  fg?: (color: string, value: string) => string,
): string {
  if (width <= 0) {
    return "";
  }

  const timing = goalTiming(goal, now);
  const heading = `goal ${goal.status}`;
  const active = formatClockDuration(timing.activeSeconds);
  const fixedWidth = visibleWidth(`▸ ${heading} ${active} `);
  if (fixedWidth >= width) {
    return truncateToWidth(`▸ ${heading} ${active}`, width);
  }
  const objective = truncateToWidth(goal.objective, width - fixedWidth);
  return styleGoalRailLine("▸", heading, `${active} ${objective}`, fg);
}

function styleGoalRailLine(
  marker: string,
  heading: string,
  tail: string,
  fg?: (color: string, value: string) => string,
): string {
  if (!fg) return `${marker} ${heading} ${tail}`;
  return `${fg("dim", marker)} ${fg("warning", heading)} ${fg("dim", tail)}`;
}
