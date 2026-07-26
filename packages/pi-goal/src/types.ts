import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const EXTENSION_NAME = "pi-better-goal";
export const EXTENSION_VERSION = "0.1.0";

export const EVENT_READY = "pi-better-goal:ready";
export const EVENT_REGISTER_PROVIDER = "pi-better-goal:register-provider";
export const EVENT_ACTIVITY = "pi-better-goal:activity";
export const EVENT_TERMINAL_ATTENTION = "pi-better-goal:terminal-attention";

export type ActivityCategory =
  | "foreground-running"
  | "background-running"
  | "idle-waiting"
  | "complete";

export type BackgroundWorkStatus =
  | "running"
  | "orphaned"
  | "completed"
  | "failed"
  | "killed"
  | "lost"
  | "exited"
  | string;

export interface BackgroundWorkItem {
  id: string;
  label?: string;
  status: BackgroundWorkStatus;
  active: boolean;
  unhealthy?: boolean;
  terminal?: boolean;
  attention?: boolean;
  startedAt?: number;
  endedAt?: number;
  details?: Record<string, unknown>;
}

export interface BackgroundProviderSnapshot {
  providerId: string;
  label?: string;
  items: BackgroundWorkItem[];
}

export interface BackgroundActivityProvider {
  id: string;
  label?: string;
  getActivity(ctx: ExtensionContext): BackgroundProviderSnapshot | Promise<BackgroundProviderSnapshot>;
}

export interface ActivitySnapshot {
  version: 1;
  category: ActivityCategory;
  foregroundRunning: boolean;
  backgroundRunning: boolean;
  activeBackgroundCount: number;
  unhealthyBackgroundCount: number;
  terminalAttentionCount: number;
  providers: BackgroundProviderSnapshot[];
  generatedAt: number;
}

export type GoalStatus = "active" | "paused" | "budgetLimited" | "complete";

export interface GoalUsage {
  tokensUsed: number;
  activeSeconds: number;
}

export interface GoalSnapshot {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  usage: GoalUsage;
  createdAt: number;
  updatedAt: number;
  activeStartedAt: number | null;
  completedAt: number | null;
}
