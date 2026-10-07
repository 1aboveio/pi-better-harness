import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installMinimalOutputHook, loadToolPrototype, loadCompactionPrototype, type MinimalOutputHook } from "./hook.ts";
import type { SettingsControl } from "../settings/registry.ts";
import { readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.ts";

const ENTRY = "pi-better-harness-tool-output";

export default function minimalOutputExtension(pi: ExtensionAPI): void {
  let hook: MinimalOutputHook | undefined;
  let enabled = false;
  let running = false;
  let initialDefault: boolean | undefined;

  function defaultEnabled(): boolean {
    if (initialDefault !== undefined) return initialDefault;
    const value = readHarnessSetting<{ version?: unknown; enabled?: unknown }>("toolOutput");
    if (value !== undefined && (value?.version !== 1 || typeof value.enabled !== "boolean")) {
      throw new Error("Invalid tool-output default in global settings.json.");
    }
    return initialDefault = value?.enabled === true;
  }

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
      hook = installMinimalOutputHook(await loadToolPrototype(), () => ctx.ui.theme, await loadCompactionPrototype());
      return true;
    } catch (error) {
      ctx.ui.notify(`Minimal tool output is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    }
  }

  async function restore(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") return;
    try { enabled = defaultEnabled(); }
    catch (error) {
      enabled = false;
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY) {
        const data = entry.data as { version?: unknown; enabled?: unknown } | undefined;
        if (data?.version === 1 && typeof data.enabled === "boolean") enabled = data.enabled;
      }
    }
    // Observe transcript components from startup, so the toggle also redraws existing rows.
    if (await ensureHook(ctx)) {
      hook!.restoreCompletedCalls(ctx.sessionManager.getBranch().flatMap(entry =>
        entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : []));
      if (enabled) collapseTools(ctx);
      hook!.setEnabled(enabled);
    } else enabled = false;
    status(ctx);
  }

  async function change(value: string, ctx: ExtensionContext): Promise<void> {
    if (value !== "Normal" && value !== "Minimal") throw new Error("Invalid tool output mode.");
    if (!await ensureHook(ctx)) throw new Error("Tool output settings are unavailable in this Pi runtime.");
    const data = { version: 1, enabled: value === "Minimal" };
    try { pi.appendEntry(ENTRY, data); }
    catch (error) { data.version = 0; data.enabled = enabled; throw error; }
    try { updateHarnessSetting("toolOutput", () => ({ version: 1, enabled: data.enabled })); }
    catch (error) {
      data.version = 0;
      data.enabled = enabled;
      // The session entry may already be on disk; restore its prior effective value too.
      pi.appendEntry(ENTRY, { version: 1, enabled });
      throw error;
    }
    enabled = data.enabled;
    if (enabled) collapseTools(ctx);
    hook!.setEnabled(enabled);
    if (enabled && !running) hook!.completeRun();
    status(ctx);
  }

  const setting: SettingsControl = {
    id: "tool-output", label: "Tool output", values: ["Normal", "Minimal"],
    get: () => enabled ? "Minimal" : "Normal", change,
  };
  const register = () => pi.events.emit("harness-settings:register", setting);
  let stopSettings: (() => void) | undefined;
  const subscribe = () => { stopSettings ??= pi.events.on("harness-settings:request", register); };
  subscribe();
  register();
  pi.on("session_start", async (_event, ctx) => { initialDefault = undefined; subscribe(); await restore(ctx); register(); });
  pi.on("session_tree", async (_event, ctx) => { await restore(ctx); });
  pi.on("agent_start", () => { running = true; });
  pi.on("agent_settled", (_event, ctx) => {
    running = false;
    if (enabled) ctx.ui.setToolsExpanded(false);
    hook?.completeRun();
  });

  pi.on("session_shutdown", () => {
    stopSettings?.();
    stopSettings = undefined;
    hook?.dispose();
    hook = undefined;
    enabled = false;
    running = false;
    initialDefault = undefined;
  });

  pi.registerCommand("tool-output", {
    description: "[minimal|normal] — Fold tool output into single-line call headers, or restore normal output. No argument toggles. Display only.",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trimStart().toLowerCase();
      const matches = [
        { value: "minimal", label: "minimal", description: "Show compact call headers without result bodies" },
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
      try { await change((mode ? mode === "minimal" : !enabled) ? "Minimal" : "Normal", ctx); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); return; }
      ctx.ui.notify(enabled
        ? "Minimal tool output on. Compact call headers remain visible. Ctrl+O reveals results."
        : "Normal tool output restored.", "info");
    },
  });
}
