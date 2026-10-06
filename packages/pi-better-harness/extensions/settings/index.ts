import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chooseHarnessSetting } from "./page.ts";
import { createSettingsRegistry } from "./registry.ts";
import { changeCallbackSetting, getCallbackSettings, saveCallbackDefault } from "pi-better-background-tasks/src/shared-callback-batcher.ts";

export default function harnessSettingsExtension(pi: ExtensionAPI): void {
  const registry = createSettingsRegistry(pi);
  pi.on("session_start", () => registry.refresh());
  pi.on("session_shutdown", () => registry.dispose());

  pi.registerCommand("harness-settings", {
    description: "Open loaded package settings",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Harness settings requires the interactive TUI.", "warning"); return; }
      registry.refresh();
      let selected: string | undefined;
      const reported = new Set<string>();
      const readSettings = (): ReturnType<typeof getCallbackSettings> => {
        try { return getCallbackSettings(ctx); }
        catch (error) {
          const message = `Callback default unavailable; using Wait until idle: ${error instanceof Error ? error.message : String(error)}`;
          if (!reported.has(message)) { ctx.ui.notify(message, "error"); reported.add(message); }
          return { mode: "hold", source: "default" };
        }
      };
      while (true) {
        const links = registry.list();
        try {
          selected = await chooseHarnessSetting(ctx, links, selected, {
            get: readSettings,
            change: mode => changeCallbackSetting(pi, ctx, mode),
            save: () => saveCallbackDefault(readSettings().mode),
          });
        } catch (error) {
          ctx.ui.notify(`Settings unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
        if (!selected) return;
        const link = links.find(item => `link:${item.id}` === selected);
        if (!link) continue;
        try { await link.open(ctx); }
        catch (error) { ctx.ui.notify(`Settings unavailable: ${error instanceof Error ? error.message : String(error)}`, "error"); }
      }
    },
  });
}
