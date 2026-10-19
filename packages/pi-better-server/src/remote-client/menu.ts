import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { validRemoteHost } from "./profiles.ts";
import { sshHostAliases } from "./ssh-hosts.ts";

type MenuUi = Pick<ExtensionUIContext, "select" | "input">;
const OTHER_HOST = "Connect to another SSH host...";

export async function savedRemoteHosts(agentDir = getAgentDir()): Promise<string[]> {
  let files;
  try { files = await readdir(join(agentDir, "remote-client", "hosts"), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const hosts = new Set<string>();
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    try {
      const host = decodeURIComponent(file.name.slice(0, -5));
      if (validRemoteHost(host)) hosts.add(host);
    } catch { /* Ignore unrelated or malformed filenames. */ }
  }
  return [...hosts].sort((a, b) => a.localeCompare(b));
}

export async function availableRemoteHosts(agentDir = getAgentDir(), configPath?: string): Promise<string[]> {
  const [history, aliases] = await Promise.all([savedRemoteHosts(agentDir), sshHostAliases(configPath)]);
  return [...new Set([...history, ...aliases].filter(validRemoteHost))].sort((a, b) => a.localeCompare(b));
}

export async function showRemoteHostList(ui: Pick<ExtensionUIContext, "select" | "notify">, hosts: readonly string[]): Promise<void> {
  if (!hosts.length) { ui.notify("No SSH host aliases or remote connection history found", "info"); return; }
  await ui.select("Remote hosts (SSH config and history)", [...hosts]);
}

export async function chooseRemoteHost(ui: MenuUi, hosts: readonly string[]): Promise<string | undefined> {
  const labels = hosts.map((host) => `Connect to ${host}`);
  const choice = await ui.select("Remote", [...labels, OTHER_HOST]);
  if (choice === undefined) return undefined;
  const index = labels.indexOf(choice);
  if (index !== -1) return hosts[index];
  if (choice !== OTHER_HOST) throw new Error("Unknown remote menu choice");
  const host = (await ui.input("SSH host alias"))?.trim();
  if (!host) return undefined;
  if (!validRemoteHost(host)) throw new Error("Enter one SSH alias or user@host, without command arguments");
  return host;
}

export async function chooseRemoteAction(ui: Pick<ExtensionUIContext, "select">, host: string): Promise<"details" | "list" | "disconnect" | undefined> {
  const choice = await ui.select(`Remote: ${host}`, ["Connection details", "List hosts", "Disconnect"]);
  if (choice === undefined) return undefined;
  if (choice === "Connection details") return "details";
  if (choice === "List hosts") return "list";
  if (choice === "Disconnect") return "disconnect";
  throw new Error("Unknown remote menu choice");
}

export function remoteArgumentCompletions(prefix: string, values: readonly string[]) {
  const matches = values.filter((value) => value.toLowerCase().startsWith(prefix.trimStart().toLowerCase()))
    .map((value) => ({ value, label: value, description: value === "disconnect" ? "Return to the local Pi session" : value === "list" ? "List SSH config hosts and connection history" : `Connect to ${value}` }));
  return matches.length ? matches : null;
}