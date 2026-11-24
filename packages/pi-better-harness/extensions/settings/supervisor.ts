import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.ts";

const key = "supervisorMode";
const observation = "ci-observation";

function decode(raw: unknown): { enabled: boolean; scenarios: string[] } {
  if (raw === undefined) return { enabled: false, scenarios: [] };
  if (typeof raw !== "object" || raw === null || !("enabled" in raw) ||
      typeof raw.enabled !== "boolean" || !("scenarios" in raw) || !Array.isArray(raw.scenarios) ||
      !raw.scenarios.every((id: unknown) => typeof id === "string")) {
    throw new Error("Invalid Supervisor mode settings.");
  }
  return { enabled: raw.enabled, scenarios: raw.scenarios };
}

export async function openSupervisorSettings(ctx: Pick<ExtensionCommandContext, "ui">): Promise<void> {
  while (true) {
    const { enabled, scenarios } = decode(readHarnessSetting(key));
    const mode = enabled ? "Turn Supervisor mode off" : "Turn Supervisor mode on";
    const selected = scenarios.includes(observation);
    const scenario = `[${selected ? "x" : " "}] CI observation recovery`;
    const choices = enabled ? [mode, scenario] : [mode];
    const choice = await ctx.ui.select("Supervisor mode", choices);
    if (choice === undefined) return;
    updateHarnessSetting(key, raw => {
      const current = decode(raw);
      if (choice === mode) return { ...current, enabled: !enabled };
      if (!current.enabled || choice !== scenario) return current;
      const updated = new Set(current.scenarios);
      if (selected) updated.delete(observation);
      else updated.add(observation);
      return { ...current, scenarios: [...updated] };
    });
  }
}
