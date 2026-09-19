import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

export interface GoalCommandBinding {
  name: string;
  source: "skill" | "prompt" | "extension";
  path: string;
  args: string;
}

export function leadingCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!, args: match[2]?.trim() ?? "" } : null;
}

export function resolveGoalCommand(pi: ExtensionAPI, text: string): GoalCommandBinding | null {
  const parsed = leadingCommand(text);
  if (!parsed) return null;
  if (parsed.name === "goal") throw new Error("A goal cannot invoke /goal recursively.");
  const command = pi.getCommands().find((item) => item.name === parsed.name);
  if (!command) throw new Error(`Unknown command /${parsed.name}.`);
  if (!command.sourceInfo.path) throw new Error(`Command /${parsed.name} has no stable source path.`);
  return { name: command.name, source: command.source, path: command.sourceInfo.path, args: parsed.args };
}

export function commandAvailable(pi: ExtensionAPI, binding: GoalCommandBinding): boolean {
  return (binding.source === "extension" || existsSync(binding.path)) &&
    pi.getCommands().some((command) => command.name === binding.name &&
    command.source === binding.source && command.sourceInfo.path === binding.path);
}

export function commandInvocation(binding: GoalCommandBinding, continuation = false): string {
  const args = continuation
    ? `${binding.args ? `${binding.args}\n\n` : ""}Continue the existing goal using the current session state. Do not restart completed work.`
    : binding.args;
  return `/${binding.name}${args ? ` ${args}` : ""}`;
}