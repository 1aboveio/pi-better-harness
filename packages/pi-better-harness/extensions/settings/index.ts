import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentInstructions, manageInstructions, validateInstructionsPrompt } from "../../lib/instructions.mjs";
import { readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.ts";
import { openSupervisorScenarios, readSupervisorSettings, setSupervisorEnabled } from "./supervisor.ts";
import registerNativeCompaction, { nativeCompactionSetting } from "../native-compaction/index.ts";
import { chooseHarnessSetting } from "./page.ts";
import { createSettingsRegistry } from "./registry.ts";
import { changeCallbackSetting, getCallbackSettings, saveCallbackDefault } from "pi-better-background-tasks/src/shared-callback-batcher.ts";

import { getNavigatorView, loadNavigatorView, setNavigatorView } from "pi-better-background-tasks/src/shared-navigator.ts";

export default function harnessSettingsExtension(pi: ExtensionAPI): void {
  registerNativeCompaction(pi);
  const registry = createSettingsRegistry(pi);
  const view = { id: "navigator-view", label: "View", values: ["tree", "flatten"],
    get: getNavigatorView, change: (value: string) => setNavigatorView(value) };
  const supervisorMode = {
    id: "supervisor-mode", label: "Supervisor mode (Beta)", values: ["Off", "On"],
    description: "Run the selected scenarios for sessions sharing this agent directory. Turning the mode off keeps your selections.",
    get() {
      try { return readSupervisorSettings().enabled ? "On" : "Off"; }
      catch { return "Unavailable"; }
    },
    change(value: string) { setSupervisorEnabled(value === "On"); },
  };
  pi.on("session_start", () => { try { loadNavigatorView(); } catch { /* settings command reports read errors */ } });
  pi.on("session_start", () => registry.refresh());
  pi.on("session_shutdown", () => registry.dispose());

  pi.registerCommand("harness-settings", {
    description: "Open loaded package settings",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Harness settings requires the interactive TUI.", "warning"); return; }
      loadNavigatorView();
      registry.refresh();
      let selected: string | undefined;
      const reported = new Set<string>();
      const readSettings = (): ReturnType<typeof getCallbackSettings> => {
        try { return getCallbackSettings(ctx); }
        catch (error) {
          const message = `Callback default unavailable. Using When idle. ${error instanceof Error ? error.message : String(error)}`;
          if (!reported.has(message)) { ctx.ui.notify(message, "error"); reported.add(message); }
          return { mode: "hold", source: "default" };
        }
      };
      while (true) {
        const links = registry.list();
        const agentDir = getAgentDir();
        let prompt: string | undefined;
        let readError: Error | undefined;
        try { prompt = currentInstructions(agentDir); }
        catch (error) { readError = error instanceof Error ? error : new Error(String(error)); }
        const state = readError ? "Unavailable" : prompt === undefined ? "Off" : "On";
        try {
          selected = await chooseHarnessSetting(ctx, links, selected, {
            get: readSettings,
            change: mode => changeCallbackSetting(pi, ctx, mode),
            save: () => saveCallbackDefault(readSettings().mode),
          }, [...registry.controls(), nativeCompactionSetting, supervisorMode], view, [
            { id: "supervisor:scenarios", label: "Supervisor scenarios", kind: "page",
              description: "Choose which scenarios run when Supervisor mode is on." },
            { id: "instructions:toggle", label: "Harness instructions (Beta)", kind: "toggle", value: state,
              description: "Toggle the global APPEND_SYSTEM.md block. Applies on startup or /reload." },
            ...(prompt === undefined ? [] : [{ id: "instructions:edit", label: "Instructions prompt", kind: "editor" as const,
              description: "Edit the Markdown included in the Harness block." }]),
          ]);
        } catch (error) {
          ctx.ui.notify(`Settings unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
        if (!selected) return;
        if (selected === "supervisor:scenarios") {
          try { await openSupervisorScenarios(ctx); }
          catch (error) { ctx.ui.notify(`Supervisor mode: ${error instanceof Error ? error.message : String(error)}`, "error"); }
          continue;
        }
        if (selected.startsWith("instructions:")) {
          try {
            if (readError) throw readError;
            if (selected === "instructions:edit" && prompt !== undefined) {
              const edited = await ctx.ui.editor("Harness instructions", prompt);
              if (edited === undefined) continue;
              const next = validateInstructionsPrompt(edited);
              manageInstructions("sync", agentDir, {
                previous: prompt,
                saveSource: () => updateHarnessSetting("instructionsPrompt", () => next),
              });
            } else if (prompt === undefined) {
              if (readHarnessSetting("instructionsFile") === false) {
                updateHarnessSetting("instructionsFile", current => current === false ? undefined : current);
              }
              manageInstructions("enable", agentDir);
            } else {
              manageInstructions("disable", agentDir);
            }
          } catch (error) {
            ctx.ui.notify(`Harness instructions: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          continue;
        }
        const link = links.find(item => `link:${item.id}` === selected);
        if (!link) continue;
        try { await link.open(ctx); }
        catch (error) { ctx.ui.notify(`Settings unavailable: ${error instanceof Error ? error.message : String(error)}`, "error"); }
      }
    },
  });
}
