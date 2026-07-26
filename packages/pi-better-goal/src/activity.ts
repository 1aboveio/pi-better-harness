import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  ActivityCategory,
  ActivitySnapshot,
  BackgroundActivityProvider,
  BackgroundProviderSnapshot,
  BackgroundWorkItem,
  GoalSnapshot,
} from "./types.js";

export interface BackgroundDrainTracker {
  goalId: string;
  activeSignature: string;
}

export interface BackgroundDrainPlan {
  nextTracker: BackgroundDrainTracker | null;
  wakeSignature: string | null;
}

export function activeItems(snapshot: ActivitySnapshot): BackgroundWorkItem[] {
  return snapshot.providers.flatMap((provider) => provider.items.filter((item) => item.active));
}

export function attentionItems(snapshot: ActivitySnapshot): BackgroundWorkItem[] {
  return snapshot.providers.flatMap((provider) => provider.items.filter((item) => item.attention));
}

export function activeSignature(snapshot: ActivitySnapshot): string {
  return activeItems(snapshot)
    .map((item) => `${item.id}:${item.status}`)
    .sort()
    .join("|");
}

export function terminalAttentionSignature(snapshot: ActivitySnapshot): string {
  return attentionItems(snapshot)
    .map((item) => `${item.id}:${item.status}`)
    .sort()
    .join("|");
}

export function planBackgroundDrainWake(
  tracker: BackgroundDrainTracker | null,
  goal: GoalSnapshot | null,
  snapshot: ActivitySnapshot,
): BackgroundDrainPlan {
  if (goal?.status !== "active") {
    return { nextTracker: null, wakeSignature: null };
  }

  const active = activeSignature(snapshot);
  if (active) {
    return {
      nextTracker: { goalId: goal.goalId, activeSignature: active },
      wakeSignature: null,
    };
  }

  if (!snapshot.backgroundRunning && tracker?.goalId === goal.goalId && tracker.activeSignature) {
    return {
      nextTracker: null,
      wakeSignature: `${goal.goalId}:${tracker.activeSignature}`,
    };
  }

  return { nextTracker: tracker?.goalId === goal.goalId ? tracker : null, wakeSignature: null };
}

export function summarizeActiveBackground(snapshot: ActivitySnapshot): string {
  const active = activeItems(snapshot);
  if (active.length === 0) {
    return "No active background work.";
  }
  return active
    .map((item) => {
      const label = item.label ? `${item.label} (${item.id})` : item.id;
      const health = item.unhealthy ? ", unhealthy" : "";
      return `${label}: ${item.status}${health}`;
    })
    .join("; ");
}

export async function collectActivitySnapshot(
  ctx: ExtensionContext,
  providers: Iterable<BackgroundActivityProvider>,
  foregroundRunning: boolean,
  now = Date.now(),
): Promise<ActivitySnapshot> {
  const providerSnapshots: BackgroundProviderSnapshot[] = [];

  for (const provider of providers) {
    try {
      const snapshot = await provider.getActivity(ctx);
      const normalized: BackgroundProviderSnapshot = {
        providerId: snapshot.providerId || provider.id,
        items: snapshot.items,
      };
      const label = snapshot.label ?? provider.label;
      if (label !== undefined) {
        normalized.label = label;
      }
      providerSnapshots.push(normalized);
    } catch (error) {
      const failedSnapshot: BackgroundProviderSnapshot = {
        providerId: provider.id,
        items: [
          {
            id: `${provider.id}:provider-error`,
            status: "failed",
            active: false,
            terminal: true,
            attention: true,
            details: {
              error: error instanceof Error ? error.message : String(error),
            },
          },
        ],
      };
      if (provider.label !== undefined) {
        failedSnapshot.label = provider.label;
      }
      providerSnapshots.push(failedSnapshot);
    }
  }

  const activeBackgroundCount = providerSnapshots.reduce(
    (sum, provider) => sum + provider.items.filter((item) => item.active).length,
    0,
  );
  const unhealthyBackgroundCount = providerSnapshots.reduce(
    (sum, provider) => sum + provider.items.filter((item) => item.active && item.unhealthy).length,
    0,
  );
  const terminalAttentionCount = providerSnapshots.reduce(
    (sum, provider) => sum + provider.items.filter((item) => !item.active && item.attention).length,
    0,
  );

  const category: ActivityCategory = foregroundRunning
    ? "foreground-running"
    : activeBackgroundCount > 0
      ? "background-running"
      : "idle-waiting";

  return {
    version: 1,
    category,
    foregroundRunning,
    backgroundRunning: activeBackgroundCount > 0,
    activeBackgroundCount,
    unhealthyBackgroundCount,
    terminalAttentionCount,
    providers: providerSnapshots,
    generatedAt: now,
  };
}