// Generated fixed launch domain from packages/pi-better-background-tasks/src/goal-provider.ts. Do not edit directly.
import { listMetas, onMetaChanged } from "./registry.domain.mjs";
import { getObservedWaitHost } from "./observed-waits.domain.mjs";
import { isTerminalStatus } from "./types.domain.mjs";
import { backgroundTaskProgressAt, observeBackgroundTaskStall } from "./stall.domain.mjs";
import { backgroundGoalObservation, onBackgroundObservation } from "./work-observation.domain.mjs";
const GOAL_READY_EVENT = "pi-better-goal:ready";
const GOAL_REGISTER_PROVIDER_EVENT = "pi-better-goal:register-provider";
const readySubscriptions = new WeakSet();
export function collectBackgroundTaskGoalActivity(metas = listMetas(), ctx, now = Date.now(), durable = []) {
    const items = [
        ...metas.filter((meta) => isVisibleGoalActivity(meta, ctx, now)).map(backgroundTaskToGoalItem),
        ...durable.filter((task) => isVisibleDurableGoalActivity(task, ctx, now)).map(durableTaskToGoalItem),
    ];
    const deadlines = items.filter(item => item.terminal && typeof item.endedAt === "number")
        .map(item => item.endedAt + TERMINAL_GOAL_ACTIVITY_RETENTION_MS).filter(deadline => deadline > now);
    return {
        providerId: "background-tasks",
        label: "Background Tasks",
        items,
        nextDeadline: deadlines.length ? Math.min(...deadlines) : null,
    };
}
export function registerBackgroundTasksGoalProvider(pi) {
    const emitProvider = () => {
        pi.events?.emit(GOAL_REGISTER_PROVIDER_EVENT, {
            id: "background-tasks",
            label: "Background Tasks",
            scope: "session",
            getActivity: async (ctx) => {
                const snapshot = await backgroundGoalObservation(pi, ctx);
                if (snapshot.status !== "ready")
                    throw new Error(snapshot.reason ?? "Background activity is unverified");
                const durable = snapshot.rows.filter((row) => row.meta.durable).map((row) => row.meta);
                const legacy = snapshot.rows.filter((row) => !row.meta.durable).map((row) => row.meta);
                const activity = collectBackgroundTaskGoalActivity(legacy, ctx, Date.now(), durable);
                const deadlines = [activity.nextDeadline, snapshot.nextDeadline].filter((value) => typeof value === "number" && value > Date.now());
                return { ...activity, nextDeadline: deadlines.length ? Math.min(...deadlines) : null };
            },
            // A durable operation change must refresh Goal activity even though it
            // never writes a mutable legacy registry meta.
            onActivityChanged: (notify) => {
                const offRuntime = onBackgroundObservation(pi, notify);
                const offMeta = onMetaChanged(notify);
                const offDurable = getObservedWaitHost(pi)?.onDurableTaskChange(notify);
                return () => {
                    offRuntime();
                    offMeta();
                    offDurable?.();
                };
            },
        });
    };
    if (!readySubscriptions.has(pi)) {
        pi.events?.on?.(GOAL_READY_EVENT, emitProvider);
        readySubscriptions.add(pi);
    }
    emitProvider();
}
const TERMINAL_GOAL_ACTIVITY_RETENTION_MS = 30_000;
function isVisibleGoalActivity(meta, ctx, now) {
    if (meta.dismissedAt !== undefined)
        return false;
    if (ctx && !belongsToGoalActivitySession(meta, ctx))
        return false;
    if (meta.status === "running")
        return true;
    if (!ctx)
        return true;
    if (typeof meta.endedAt !== "number")
        return true;
    return now - meta.endedAt < TERMINAL_GOAL_ACTIVITY_RETENTION_MS;
}
function belongsToGoalActivitySession(meta, ctx) {
    const active = getGoalActivityOrigin(ctx);
    const origin = meta.callbackOrigin;
    if (origin) {
        if (origin.cwd !== active.cwd)
            return false;
        if (origin.sessionId || active.sessionId)
            return origin.sessionId === active.sessionId;
        return true;
    }
    if (active.sessionId)
        return false;
    return meta.cwd === active.cwd;
}
function getGoalActivityOrigin(ctx) {
    let sessionId;
    try {
        sessionId = ctx.sessionManager?.getSessionId();
    }
    catch {
        sessionId = undefined;
    }
    return { cwd: ctx.cwd, sessionId };
}
function isVisibleDurableGoalActivity(task, ctx, now) {
    if (task.dismissedAt !== undefined)
        return false;
    if (ctx) {
        const active = getGoalActivityOrigin(ctx);
        if (task.owner.workspace !== active.cwd)
            return false;
        if (active.sessionId || task.owner.sessionId) {
            if (task.owner.sessionId !== active.sessionId)
                return false;
        }
    }
    if (!task.terminal)
        return true;
    if (!ctx)
        return true;
    if (task.endedAt === undefined)
        return true;
    return now - task.endedAt < TERMINAL_GOAL_ACTIVITY_RETENTION_MS;
}
function durableTaskToGoalItem(task) {
    const item = {
        id: task.id,
        status: task.status,
        active: task.active,
        terminal: task.terminal,
        attention: task.attention,
        startedAt: task.startedAt,
        details: {
            durable: true,
            operationId: task.operationId,
            kind: task.kind,
            cwd: task.cwd,
            command: task.command,
            argv: task.argv,
            logPath: task.logPaths.stdout,
            lastProgressAt: task.endedAt ?? task.startedAt,
            waits: task.waits.map((wait) => `${wait.waitId}:${wait.phase}`),
            ...(task.reason ? { reason: task.reason } : {}),
        },
    };
    if (task.name !== undefined)
        item.label = task.name;
    if (task.endedAt !== undefined)
        item.endedAt = task.endedAt;
    return item;
}
function backgroundTaskToGoalItem(meta) {
    const active = meta.status === "running";
    const terminal = isTerminalStatus(meta.status);
    const stall = observeBackgroundTaskStall(meta);
    const unhealthy = active && stall.state === "stalled";
    const attention = (terminal && meta.status !== "succeeded") || unhealthy;
    const item = {
        id: meta.id,
        status: meta.status,
        active,
        unhealthy,
        terminal,
        attention,
        startedAt: meta.startedAt,
        details: {
            kind: meta.kind,
            callback: meta.callback !== false,
            cwd: meta.cwd,
            command: meta.command,
            argv: meta.argv,
            logPath: meta.logPath,
            spawnPid: meta.spawnPid,
            lastProgressAt: backgroundTaskProgressAt(meta),
            stall: stall.state,
        },
    };
    if (meta.name !== undefined)
        item.label = meta.name;
    if (meta.endedAt !== undefined)
        item.endedAt = meta.endedAt;
    return item;
}
