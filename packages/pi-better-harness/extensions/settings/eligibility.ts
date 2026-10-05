import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface EligibilityContributor {
  id: string;
  blocked(): boolean;
}

/** Trusted package callbacks are queried live, not snapshots of an earlier idle state. */
export function createEligibilityRegistry(pi: ExtensionAPI) {
  const contributors = new Map<string, EligibilityContributor>();
  const conflicts = new Set<string>();
  const stop = pi.events.on("harness-suggestions:register", (candidate: unknown) => {
    const value = candidate as Partial<EligibilityContributor> | null;
    if (!value || !/^[a-z][a-z0-9-]*$/.test(value.id ?? "") || typeof value.blocked !== "function") return;
    if (conflicts.has(value.id!)) return;
    const prior = contributors.get(value.id!);
    if (prior && prior.blocked !== value.blocked) { conflicts.add(value.id!); contributors.delete(value.id!); return; }
    contributors.set(value.id!, value as EligibilityContributor);
  });
  return {
    refresh() { contributors.clear(); conflicts.clear(); pi.events.emit("harness-suggestions:request", undefined); },
    blocked() {
      if (conflicts.size) return true;
      for (const item of contributors.values()) {
        try { if (item.blocked() !== false) return true; } catch { return true; }
      }
      return false;
    },
    dispose() { stop(); contributors.clear(); conflicts.clear(); },
  };
}