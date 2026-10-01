import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installMinimalOutputHook, loadContainerPrototype, loadMutedText, loadToolPrototype, type MinimalOutputHook } from "./hook.ts";

const ENTRY = "pi-better-harness-tool-output";

export default function minimalOutputExtension(pi: ExtensionAPI): void {
  let hook: MinimalOutputHook | undefined;
  let enabled = false;

  function status(ctx: ExtensionContext): void {
    ctx.ui.setStatus(ENTRY, enabled ? "tools: minimal" : undefined);
  }

  function collapseTools(ctx: ExtensionContext): void {
    // setToolsExpanded is a no-op when already false; force a redraw of restored transcript rows.
    if (!ctx.ui.getToolsExpanded()) ctx.ui.setToolsExpanded(true);
    ctx.ui.setToolsExpanded(false);
  }

  async function ensureHook(ctx: ExtensionContext): Promise<boolean> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Minimal tool output is available only in Pi's interactive TUI.", "warning");
      return false;
    }
    if (hook) return true;
    try {
      const [toolPrototype, containerPrototype, muted] = await Promise.all([
        loadToolPrototype(),
        loadContainerPrototype().catch(() => undefined),
        loadMutedText().catch(() => undefined),
      ]);
      hook = installMinimalOutputHook(toolPrototype, containerPrototype, muted);
      return true;
    } catch (error) {
      ctx.ui.notify(`Minimal tool output is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY) {
        const data = entry.data as { enabled?: unknown } | undefined;
        if (typeof data?.enabled === "boolean") enabled = data.enabled;
      }
    }
    // Observe transcript components from startup, so the toggle also redraws existing rows.
    if (await ensureHook(ctx)) {
      if (enabled) collapseTools(ctx);
      hook!.setEnabled(enabled);
    } else enabled = false;
    status(ctx);
  });

  pi.on("session_shutdown", () => {
    hook?.dispose();
    hook = undefined;
    enabled = false;
  });

  pi.registerCommand("tool-output", {
    description: "[minimal|normal] — Fold finished tool runs, or restore normal output. No argument toggles. Display only.",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trimStart().toLowerCase();
      const matches = [
        { value: "minimal", label: "minimal", description: "Fold finished tool runs after the next model text" },
        { value: "normal", label: "normal", description: "Restore ordinary tool output" },
      ].filter((option) => option.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode && mode !== "minimal" && mode !== "normal") {
        ctx.ui.notify("Usage: /tool-output [minimal|normal]", "warning");
        return;
      }
      if (!await ensureHook(ctx)) return;
      enabled = mode ? mode === "minimal" : !enabled;
      if (enabled) collapseTools(ctx);
      hook!.setEnabled(enabled);
      pi.appendEntry(ENTRY, { version: 1, enabled });
      status(ctx);
      ctx.ui.notify(enabled
        ? hook!.foldsTurns
          ? "Minimal tool output on. Finished tool runs fold after the next model text. Ctrl+O reveals them; click a folded run when the terminal supports it."
          : "Minimal tool output on, but turn folding is unavailable in this Pi version. Ctrl+O reveals results."
        : "Normal tool output restored.", "info");
    },
  });
}
