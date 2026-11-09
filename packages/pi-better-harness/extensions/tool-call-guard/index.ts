import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingsControl } from "../settings/registry.ts";
import { readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.ts";
import { blockReason, detectForegroundWait, type WaitMatch } from "./waits.ts";

const SETTING_KEY = "toolCallGuard";

interface GuardSetting { version?: unknown; enabled?: unknown }

/**
 * Block a foreground command that waits on an external system.
 *
 * Returns the block result from `tool_call`, which pi turns into a failed tool result carrying
 * `reason`. Nothing is executed. `isEnabled` is read per call so the setting takes effect
 * without reloading the extension.
 */
export function installToolCallGuard(
  pi: ExtensionAPI,
  isEnabled: () => boolean,
  onBlock?: (match: WaitMatch, command: string) => void,
): void {
  pi.on("tool_call", (event) => {
    if (!isEnabled()) return;
    if (event.toolName !== "bash") return;
    // `input` is the current SDK field; older typings and some hosts expose `args`.
    const payload = event as { input?: { command?: unknown }; args?: { command?: unknown } };
    const command = payload.input?.command ?? payload.args?.command;
    if (typeof command !== "string") return;
    const match = detectForegroundWait(command);
    if (!match) return;
    onBlock?.(match, command);
    return { block: true, reason: blockReason(match) };
  });
}

export default function toolCallGuardExtension(pi: ExtensionAPI): void {
  let enabled = true;

  const read = (): void => {
    const value = readHarnessSetting<GuardSetting>(SETTING_KEY);
    if (value !== undefined && (value?.version !== 1 || typeof value.enabled !== "boolean")) {
      throw new Error("Invalid tool-call guard setting in global settings.json.");
    }
    enabled = value?.enabled !== false;
  };

  const setting: SettingsControl = {
    id: "tool-call-guard", label: "Tool call guard", values: ["On", "Off"],
    get: () => enabled ? "On" : "Off",
    change(value: string, _ctx: ExtensionCommandContext) {
      if (value !== "On" && value !== "Off") throw new Error("Invalid tool-call guard value.");
      updateHarnessSetting(SETTING_KEY, () => ({ version: 1, enabled: value === "On" }));
      enabled = value === "On";
    },
  };

  const register = () => pi.events.emit("harness-settings:register", setting);
  let stopSettings: (() => void) | undefined;
  const subscribe = () => { stopSettings ??= pi.events.on("harness-settings:request", register); };

  subscribe();
  register();
  installToolCallGuard(pi, () => enabled);

  pi.on("session_start", () => {
    subscribe();
    try { read(); }
    catch {
      // A malformed value must not take the session down; fall back to guarding.
      enabled = true;
    }
    register();
  });

  pi.on("session_shutdown", () => {
    stopSettings?.();
    stopSettings = undefined;
  });
}
