import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { validRemoteHost } from "./profiles.ts";
import { sshHostAliases } from "./ssh-hosts.ts";

type MenuUi = Pick<ExtensionUIContext, "select" | "input">;
const OTHER_HOST = "Connect to another SSH host...";
const LOCAL_HOST_LABEL = "Connect to localhost (this machine, no SSH)";
export const LOCAL_HOST = "localhost";

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

export async function showRemoteHostList(ui: Pick<ExtensionUIContext, "select" | "notify">, hosts: readonly string[]): Promise<string | undefined> {
  if (!hosts.length) { ui.notify("No SSH host aliases or remote connection history found", "info"); return; }
  const selected = await ui.select("Remote hosts (SSH config and history)", [...hosts]);
  if (selected !== undefined && !hosts.includes(selected)) throw new Error("Unknown remote host selection");
  return selected;
}

export async function chooseRemoteHost(ui: MenuUi, hosts: readonly string[]): Promise<string | undefined> {
  const labels = hosts.map((host) => `Connect to ${host}`);
  const choice = await ui.select("Remote", [LOCAL_HOST_LABEL, ...labels, OTHER_HOST]);
  if (choice === undefined) return undefined;
  if (choice === LOCAL_HOST_LABEL) return LOCAL_HOST;
  const index = labels.indexOf(choice);
  if (index !== -1) return hosts[index];
  if (choice !== OTHER_HOST) throw new Error("Unknown remote menu choice");
  const host = (await ui.input("SSH host alias"))?.trim();
  if (!host) return undefined;
  if (!validRemoteHost(host)) throw new Error("Enter one SSH alias or user@host, without command arguments");
  return host;
}

export function remoteArgumentCompletions(prefix: string, connected = false, hosts: readonly string[] = []) {
  const input = prefix.trimStart().toLowerCase();
  if (/^(connect|pull)(?:\s|$)/.test(input)) {
    const action = input.split(/\s+/, 1)[0]!;
    const hostPrefix = input.slice(action.length).trimStart();
    const candidates = action === "connect" ? [LOCAL_HOST, ...hosts.filter((host) => host !== LOCAL_HOST)] : [...hosts];
    const matches = candidates.filter((host) => host.toLowerCase().startsWith(hostPrefix))
      .map((host) => ({ value: `${action} ${host}`, label: host,
        description: host === LOCAL_HOST ? "Connect to the daemon on this machine" : `${action === "connect" ? "Connect to" : "Pull session from"} ${host}` }));
    return matches.length ? matches : null;
  }
  const values = connected ? ["connect", "list", "sessions", "pull", "disconnect"] : ["connect", "list", "pull"];
  const descriptions: Record<string, string> = {
    connect: "Connect to a remote host", list: "List SSH config hosts and connection history",
    sessions: "Open the server session browser", disconnect: "Return to the local Pi session",
    pull: "Transfer a remote session to this machine",
  };
  const matches = values.filter((value) => value.startsWith(input))
    .map((value) => ({ value, label: value, description: descriptions[value] }));
  return matches.length ? matches : null;
}