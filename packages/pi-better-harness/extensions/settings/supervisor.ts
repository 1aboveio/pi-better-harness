import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.ts";

const key = "supervisorMode";
const options = new Map([
  ["ci-observation", "CI observation recovery"],
  ["stall-diagnosis", "Diagnose stalled Goals"],
  ["scope-review", "Review Goal scope"],
  ["shared-fault", "Shared daemon fault diagnosis"],
  ["shared-decisions", "Consolidate authorization requests"],
  ["commitment-followup", "Follow up on recovery commitments"],
]);

function decode(raw: unknown): { enabled: boolean; scenarios: string[]; revision?: string } {
  if (raw === undefined) return { enabled: false, scenarios: [] };
  if (typeof raw !== "object" || raw === null || !("enabled" in raw) ||
      typeof raw.enabled !== "boolean" || !("scenarios" in raw) || !Array.isArray(raw.scenarios) ||
      !raw.scenarios.every((id: unknown) => typeof id === "string")) {
    throw new Error("Invalid Supervisor mode settings.");
  }
  return { enabled: raw.enabled, scenarios: raw.scenarios, revision: "revision" in raw && typeof raw.revision === "string" ? raw.revision : undefined };
}

// Atomic settings writes replace the inode. Avoid locking and parsing on every observed tool.
let cache: { stamp: string; scenarios: string[]; revision: string } | undefined;
export function enabledScenarios(): string[] {
  try {
    const path = harnessSettingsPath();
    const file = statSync(path, { throwIfNoEntry: false });
    if (!file) return [];
    const stamp = [path, file.dev, file.ino, file.ctimeMs, file.size].join("/");
    if (cache?.stamp === stamp) return cache.scenarios;
    const setting = decode(readHarnessSetting(key));
    cache = { stamp, revision: setting.revision ?? "initial", scenarios: setting.enabled ? setting.scenarios : [] };
    return cache.scenarios;
  } catch { return []; }
}

export function scenarioRevision(scenario: string) {
  if (enabledScenarios().includes(scenario)) return cache?.revision;
}

export function readSupervisorSettings() {
  return decode(readHarnessSetting(key));
}

export function setSupervisorEnabled(enabled: boolean) {
  updateHarnessSetting(key, raw => {
    const current = decode(raw);
    return current.enabled === enabled ? raw : { ...current, enabled, revision: randomUUID() };
  });
}

export async function openSupervisorScenarios(ctx: Pick<ExtensionCommandContext, "ui">): Promise<void> {
  const { createSettingsMenu } = await import("./menu.ts");
  let selected: string | undefined;
  while (true) {
    const { enabled, scenarios } = readSupervisorSettings();
    const choice = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => createSettingsMenu({
      title: "Supervisor scenarios", theme, selected, height: () => tui.terminal?.rows ?? 32,
      sections: [{
        title: enabled ? "Supervisor mode is on" : "Supervisor mode is off",
        items: [...options].map(([id, label]) => ({
          id, label, kind: "toggle", value: scenarios.includes(id) ? "[x]" : "[ ]",
          description: enabled ? "Checked scenarios run for sessions sharing this agent directory."
            : "Checked scenarios will run when you turn on Supervisor mode.",
        })),
      }],
      activate: item => done(item.id),
      back: () => done(undefined),
    }));
    if (choice === undefined) return;
    selected = choice;
    const include = !scenarios.includes(choice);
    updateHarnessSetting(key, raw => {
      const current = decode(raw);
      if (current.scenarios.includes(choice) === include) return raw;
      const next = include ? [...current.scenarios, choice] : current.scenarios.filter(id => id !== choice);
      return { ...current, scenarios: next, revision: randomUUID() };
    });
  }
}
