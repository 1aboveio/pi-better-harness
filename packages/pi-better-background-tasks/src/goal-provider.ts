import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listMetas } from "./registry.js";
import type { BackgroundTaskMeta } from "./types.js";
import { isTerminalStatus } from "./types.js";

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
): GoalBackgroundProviderSnapshot {
  return {
    providerId: "background-tasks",
    label: "Background Tasks",
    items: metas
      .filter((meta) => meta.dismissedAt === undefined)
      .map(backgroundTaskToGoalItem),
  };
}

export function registerBackgroundTasksGoalProvider(pi: ExtensionAPI): void {
  const emitProvider = (): void => {
    pi.events?.emit(GOAL_REGISTER_PROVIDER_EVENT, {
      id: "background-tasks",
      label: "Background Tasks",
      getActivity: (_ctx: ExtensionContext) => collectBackgroundTaskGoalActivity(),
    });
  };

  if (!readySubscriptions.has(pi)) {
    pi.events?.on?.(GOAL_READY_EVENT, emitProvider);
    readySubscriptions.add(pi);
  }
  emitProvider();
}

function backgroundTaskToGoalItem(meta: BackgroundTaskMeta): GoalBackgroundWorkItem {
  const active = meta.status === "running";
  const terminal = isTerminalStatus(meta.status);
  const attention = terminal && meta.status !== "succeeded";
  const item: GoalBackgroundWorkItem = {
    id: meta.id,
    status: meta.status,
    active,
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
    },
  };
  if (meta.name !== undefined) item.label = meta.name;
  if (meta.endedAt !== undefined) item.endedAt = meta.endedAt;
  return item;
}