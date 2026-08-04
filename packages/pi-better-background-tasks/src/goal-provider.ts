import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listMetas } from "./registry.js";
import type { BackgroundTaskMeta } from "./types.js";
import { isTerminalStatus } from "./types.js";
import { backgroundTaskProgressAt, observeBackgroundTaskStall } from "./stall.js";

const GOAL_READY_EVENT = "pi-better-goal:ready";
const GOAL_REGISTER_PROVIDER_EVENT = "pi-better-goal:register-provider";
const readySubscriptions = new WeakSet<ExtensionAPI>();

export interface GoalBackgroundWorkItem {
  id: string;
  label?: string;
  status: string;
  active: boolean;
  unhealthy?: boolean;
  terminal?: boolean;
  attention?: boolean;
  startedAt?: number;
  endedAt?: number;
  details?: Record<string, unknown>;
}

export interface GoalBackgroundProviderSnapshot {
  providerId: string;
  label?: string;
  items: GoalBackgroundWorkItem[];
}

export function collectBackgroundTaskGoalActivity(
  metas: BackgroundTaskMeta[] = listMetas(),
  ctx?: ExtensionContext,
  now = Date.now(),
): GoalBackgroundProviderSnapshot {
  return {
    providerId: "background-tasks",
    label: "Background Tasks",
    items: metas
      .filter((meta) => isVisibleGoalActivity(meta, ctx, now))
      .map(backgroundTaskToGoalItem),
  };
}

export function registerBackgroundTasksGoalProvider(pi: ExtensionAPI): void {
  const emitProvider = (): void => {
    pi.events?.emit(GOAL_REGISTER_PROVIDER_EVENT, {
      id: "background-tasks",
      label: "Background Tasks",
      getActivity: (ctx: ExtensionContext) => collectBackgroundTaskGoalActivity(listMetas(), ctx),
    });
  };

  if (!readySubscriptions.has(pi)) {
    pi.events?.on?.(GOAL_READY_EVENT, emitProvider);
    readySubscriptions.add(pi);
  }
  emitProvider();
}

const TERMINAL_GOAL_ACTIVITY_RETENTION_MS = 30_000;

function isVisibleGoalActivity(meta: BackgroundTaskMeta, ctx: ExtensionContext | undefined, now: number): boolean {
  if (meta.dismissedAt !== undefined) return false;
  if (ctx && !belongsToGoalActivitySession(meta, ctx)) return false;
  if (meta.status === "running") return true;
  if (!ctx) return true;
  if (typeof meta.endedAt !== "number") return true;
  return now - meta.endedAt < TERMINAL_GOAL_ACTIVITY_RETENTION_MS;
}

function belongsToGoalActivitySession(meta: BackgroundTaskMeta, ctx: ExtensionContext): boolean {
  const active = getGoalActivityOrigin(ctx);
  const origin = meta.callbackOrigin;
  if (origin) {
    if (origin.cwd !== active.cwd) return false;
    if (origin.sessionId || active.sessionId) return origin.sessionId === active.sessionId;
    return true;
  }
  if (active.sessionId) return false;
  return meta.cwd === active.cwd;
}

function getGoalActivityOrigin(ctx: ExtensionContext) {
  let sessionId: string | undefined;
  try {
    sessionId = ctx.sessionManager?.getSessionId();
  } catch {
    sessionId = undefined;
  }
  return { cwd: ctx.cwd, sessionId };
}

function backgroundTaskToGoalItem(meta: BackgroundTaskMeta): GoalBackgroundWorkItem {
  const active = meta.status === "running";
  const terminal = isTerminalStatus(meta.status);
  const stall = observeBackgroundTaskStall(meta);
  const unhealthy = active && stall.state === "stalled";
  const attention = (terminal && meta.status !== "succeeded") || unhealthy;
  const item: GoalBackgroundWorkItem = {
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
  if (meta.name !== undefined) item.label = meta.name;
  if (meta.endedAt !== undefined) item.endedAt = meta.endedAt;
  return item;
}