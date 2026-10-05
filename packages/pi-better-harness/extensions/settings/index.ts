import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chooseHarnessSetting } from "./page.ts";
import { createSettingsRegistry } from "./registry.ts";

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
      while (true) {
        const links = registry.list();
        if (!links.length) { ctx.ui.notify("No package settings are available.", "info"); return; }
        selected = await chooseHarnessSetting(ctx, links, selected);
        if (!selected) return;
        const link = links.find(item => `link:${item.id}` === selected);
        if (!link) continue;
        try { await link.open(ctx); }
        catch (error) { ctx.ui.notify(`Settings unavailable: ${error instanceof Error ? error.message : String(error)}`, "error"); }
      }
    },
  });
}
