// Generated fixed launch domain from packages/pi-better-subagents/shared-operation-coordinator/src/task-lifetime.ts. Do not edit directly.
// Generated from packages/operation-coordinator/src/task-lifetime.ts. Do not edit directly.
/** Absolute wall-clock limit, including time spent waiting for a runner. */
export const MAX_TASK_LIFETIME_MS = 24 * 60 * 60 * 1000;
export function taskDeadline(startedAt, requestedDeadline) {
    return Math.min(startedAt + MAX_TASK_LIFETIME_MS, requestedDeadline ?? Infinity);
}
