import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface SettingsLink {
  id: string;
  label: string;
  command: string;
  open(ctx: ExtensionCommandContext): Promise<void> | void;
}

export function createSettingsRegistry(pi: ExtensionAPI) {
  const links = new Map<string, SettingsLink>();
  const conflicts = new Set<string>();
  const stop = pi.events.on("harness-settings:register", (candidate: unknown) => {
    const link = candidate as Partial<SettingsLink> | null;
    if (!link || !/^[a-z][a-z0-9-]*$/.test(link.id ?? "") || typeof link.label !== "string" ||
      typeof link.command !== "string" || !link.command.startsWith("/") || typeof link.open !== "function") return;
    if (conflicts.has(link.id!)) return;
    const prior = links.get(link.id!);
    if (prior && prior.open !== link.open) { links.delete(link.id!); conflicts.add(link.id!); return; }
    links.set(link.id!, link as SettingsLink);
  });
  return {
    refresh() { links.clear(); conflicts.clear(); pi.events.emit("harness-settings:request", undefined); },
    list() { return [...links.values()].sort((a, b) => a.label.localeCompare(b.label)); },
    dispose() { stop(); links.clear(); conflicts.clear(); },
  };
}