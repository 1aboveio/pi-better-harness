import { statSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.ts";

const key = "supervisorMode";
const options = new Map([
  ["ci-observation", "CI observation recovery"],
  ["stall-diagnosis", "Diagnose stalled Outcomes"],
  ["scope-review", "Review Outcome scope"],
  ["shared-fault", "Shared daemon fault diagnosis"],
  ["shared-decisions", "Consolidate authorization requests"],
  ["commitment-followup", "Follow up on recovery commitments"],
]);

function decode(raw: unknown): { enabled: boolean; scenarios: string[] } {
  if (raw === undefined) return { enabled: false, scenarios: [] };
  if (typeof raw !== "object" || raw === null || !("enabled" in raw) ||
      typeof raw.enabled !== "boolean" || !("scenarios" in raw) || !Array.isArray(raw.scenarios) ||
      !raw.scenarios.every((id: unknown) => typeof id === "string")) {
    throw new Error("Invalid Supervisor mode settings.");
  }
  return { enabled: raw.enabled, scenarios: raw.scenarios };
}

// Atomic settings writes replace the inode. Avoid locking and parsing on every observed tool.
let cache: { stamp: string; scenarios: string[] } | undefined;
export function enabledScenarios(): string[] {
  try {
    const path = harnessSettingsPath();
    const file = statSync(path, { throwIfNoEntry: false });
    if (!file) return [];
    const stamp = [path, file.dev, file.ino, file.ctimeMs, file.size].join("/");
    if (cache?.stamp === stamp) return cache.scenarios;
    const setting = decode(readHarnessSetting(key));
    cache = { stamp, scenarios: setting.enabled ? setting.scenarios : [] };
    return cache.scenarios;
  } catch { return []; }
}

export async function openSupervisorSettings(ctx: Pick<ExtensionCommandContext, "ui">): Promise<void> {
  while (true) {
    const { enabled, scenarios } = decode(readHarnessSetting(key));
    const mode = enabled ? "Turn Supervisor mode off" : "Turn Supervisor mode on";
    const rows = [...options].map(([id, label]) => ({ id, selected: scenarios.includes(id), label: `[${scenarios.includes(id) ? "x" : " "}] ${label}` }));
    const choices = enabled ? [mode, ...rows.map(row => row.label)] : [mode];
    const choice = await ctx.ui.select("Supervisor mode", choices);
    const row = rows.find(item => item.label === choice);
    if (choice === undefined) return;
    updateHarnessSetting(key, raw => {
      const current = decode(raw);
      if (choice === mode) return { ...current, enabled: !enabled };
      if (!current.enabled || !row) return current;
      const updated = new Set(current.scenarios);
      if (row.selected) updated.delete(row.id);
      else updated.add(row.id);
      return { ...current, scenarios: [...updated] };
    });
  }
}
