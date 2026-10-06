import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface SettingsLink {
  id: string;
  label: string;
  command: string;
  open(ctx: ExtensionCommandContext): Promise<void> | void;
}

export interface SettingsControl {
  id: string;
  label: string;
  values: string[];
  get(): string;
  change(value: string, ctx: ExtensionCommandContext): Promise<void> | void;
}

export function createSettingsRegistry(pi: ExtensionAPI) {
  const links = new Map<string, SettingsLink>();
  const controls = new Map<string, SettingsControl>();
  const conflicts = new Set<string>();
  const stop = pi.events.on("harness-settings:register", (candidate: unknown) => {
    const link = candidate as Partial<SettingsLink & SettingsControl> | null;
    if (!link || !/^[a-z][a-z0-9-]*$/.test(link.id ?? "") || typeof link.label !== "string") return;
    const control = Array.isArray(link.values) && link.values.length > 1 && link.values.every(value => typeof value === "string")
      && typeof link.get === "function" && typeof link.change === "function";
    if (!control && (typeof link.command !== "string" || !link.command.startsWith("/") || typeof link.open !== "function")) return;
    if (conflicts.has(link.id!)) return;
    const prior = links.get(link.id!);
    const priorControl = controls.get(link.id!);
    if ((prior && (control || prior.open !== link.open)) ||
      (priorControl && (!control || priorControl.change !== link.change || priorControl.get !== link.get))) {
      links.delete(link.id!); controls.delete(link.id!); conflicts.add(link.id!); return;
    }
    if (control) controls.set(link.id!, link as SettingsControl);
    else links.set(link.id!, link as SettingsLink);
  });
  return {
    refresh() { links.clear(); controls.clear(); conflicts.clear(); pi.events.emit("harness-settings:request", undefined); },
    list() { return [...links.values()].sort((a, b) => a.label.localeCompare(b.label)); },
    controls() { return [...controls.values()].sort((a, b) => a.label.localeCompare(b.label)); },
    dispose() { stop(); links.clear(); controls.clear(); conflicts.clear(); },
  };
}
