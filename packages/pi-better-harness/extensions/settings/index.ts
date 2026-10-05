import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SuggestionEngine, buildSuggestionContext } from "../prompt-suggestions/engine.ts";
import { generateSuggestion } from "../prompt-suggestions/provider.ts";
import { readPreferences, writeEnabled } from "../prompt-suggestions/preferences.ts";
import { installGhostEditor, type GhostEditor } from "../prompt-suggestions/editor.ts";
import { chooseHarnessSetting } from "./page.ts";
import { createSettingsRegistry } from "./registry.ts";

const USAGE_ENTRY = "pi-better-harness-suggestion-usage";

export default function harnessSettingsExtension(pi: ExtensionAPI): void {
  const registry = createSettingsRegistry(pi);
  let ctx: ExtensionContext;
  let enabled = false;
  let paused = false;
  let editor: GhostEditor | undefined;
  let engine: SuggestionEngine | undefined;
  let userTurn = false;
  let revision = 0;
  let turnRevision = 0;
  let reason = "disabled";
  let transportReason: string | undefined;
  let usage: Record<string, number> = {};


  function cancel(state: string): void {
    reason = state;
    engine?.cancel(state);
    editor?.clear();
  }
  function install(): void {
    if (editor || ctx.mode !== "tui") return;
    editor = installGhostEditor(ctx, {
      changed() { revision++; cancel("editor changed"); },
      accepted() { engine?.noteAccepted(); reason = "accepted"; revision++; },
      unused() { engine?.noteUnused(); },
    });
  }
  function recordUsage(value: unknown): void {
    const source = value as Record<string, unknown> | undefined;
    const record: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
      if (typeof source?.[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0) record[key] = source[key];
    }
    const cost = source?.cost as { total?: unknown } | undefined;
    if (typeof cost?.total === "number" && cost.total > 0 && Number.isFinite(cost.total)) record.cost = cost.total;
    if (!Object.keys(record).length) return;
    record.reportedRequests = 1;
    for (const [key, amount] of Object.entries(record)) usage[key] = (usage[key] ?? 0) + amount;
    pi.appendEntry(USAGE_ENTRY, record);
  }
  function startEngine(): void {
    engine?.dispose();
    engine = new SuggestionEngine({
      generate: async (context, signal) => {
        try { return await generateSuggestion(ctx, context, signal); }
        catch (error) {
          // The transport exposes only its own sanitized errors, never SDK payloads.
          transportReason = error instanceof Error ? error.message : "Provider unavailable";
          throw error;
        }
      },
      onSuggestion(text) {
        if (enabled && !paused && ctx.isIdle() && !ctx.hasPendingMessages() && editor?.show(text)) reason = "ready";
        else reason = "editor unavailable";
      },
      onState(state, reportedUsage) {
        reason = state === "error" ? transportReason ?? "Provider unavailable" : state;
        if (state === "generating") {
          transportReason = undefined;
          usage.requests = (usage.requests ?? 0) + 1;
          pi.appendEntry(USAGE_ENTRY, { requests: 1 });
        }
        if (reportedUsage) recordUsage(reportedUsage);
        if (state.startsWith("error")) paused = true;
      },
    });
  }

  pi.on("session_start", (_event, current) => {
    ctx = current;
    registry.refresh();
    paused = false;
    userTurn = false;
    usage = {};

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === USAGE_ENTRY) {
        const data = entry.data as Record<string, number>;
        for (const [key, value] of Object.entries(data ?? {})) if (typeof value === "number" && value >= 0 && Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
      }
    }
    try { enabled = readPreferences().enabled; } catch (error) {
      enabled = false;
      ctx.ui.notify(`Prompt suggestions disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    reason = enabled ? "waiting for a user turn" : "disabled";
    if (ctx.mode === "tui") { startEngine(); if (enabled) install(); }
  });
  pi.on("input", (event) => {
    userTurn = event.source === "interactive" && !event.images?.length && !/^[\/!]/.test(event.text.trimStart());
    cancel("input submitted");
  });
  pi.on("agent_start", () => { turnRevision = revision; cancel("agent running"); });
  pi.on("agent_settled", () => {
    const eligible = userTurn && enabled && !paused && ctx.mode === "tui" && revision === turnRevision &&
      ctx.isIdle() && !ctx.hasPendingMessages() && editor?.available();
    userTurn = false;
    if (!eligible) return;
    const context = buildSuggestionContext(ctx.sessionManager.getBranch());
    if (context) engine?.schedule(context);
    else reason = "no eligible conversation";
  });
  const boundary = () => { userTurn = false; cancel("session boundary changed"); };
  pi.on("session_before_switch", boundary);
  pi.on("session_before_fork", boundary);
  pi.on("session_before_tree", boundary);
  pi.on("session_before_compact", boundary);
  pi.on("session_compact", boundary);
  pi.on("session_tree", boundary);
  pi.on("model_select", () => { paused = false; userTurn = false; cancel("model changed"); });
  pi.on("session_shutdown", () => { engine?.dispose(); editor?.dispose(); registry.dispose(); });

  pi.registerCommand("harness-settings", {
    description: "Configure Harness and open loaded package settings",
    handler: async (_args, current) => {
      if (current.mode !== "tui") { current.ui.notify("Harness settings requires the interactive TUI.", "warning"); return; }
      ctx = current;
      cancel("settings open");
      userTurn = false;
      registry.refresh();
      let selected: string | undefined;
      while (true) {
        const links = registry.list();
        selected = await chooseHarnessSetting(current, enabled, links, selected);
        if (!selected) return;
        try {
          if (selected === "suggestions") {
            if (!enabled && !await current.ui.confirm("Enable prompt suggestions?", "Recent conversation text will be sent to your active model. Extra usage may be charged. This uses Pi's provider connection even when task Network access is Off.")) continue;
            writeEnabled(!enabled);
            enabled = !enabled;
            paused = false;
            if (enabled) install();
            cancel(enabled ? "waiting for a user turn" : "disabled");
          } else if (selected === "status") {
            const text = [
              `Prompt suggestions: ${enabled ? "on" : "off"}${paused ? " (paused)" : ""}`,
              `Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable"}`,
              `Last state: ${paused ? transportReason ?? reason : reason}`,
              `Auxiliary tokens: ${usage.totalTokens ?? "unknown"}`,
              `Input: ${usage.input ?? "unknown"}; output: ${usage.output ?? "unknown"}; cache read: ${usage.cacheRead ?? "unknown"}`,
              `Reported cost: ${usage.cost === undefined ? "unknown" : `$${usage.cost.toFixed(6)}`}`,
              `Attempts without usage data: ${(usage.requests ?? 0) - (usage.reportedRequests ?? 0)}. Separate from Pi session totals.`,
            ].join("\n");
            await current.ui.select(text, ["Back"]);
          } else {
            const link = links.find(item => `link:${item.id}` === selected);
            if (link) await link.open(current);
          }
        } catch (error) { current.ui.notify(`Settings unavailable: ${error instanceof Error ? error.message : String(error)}`, "error"); }
      }
    },
  });
}