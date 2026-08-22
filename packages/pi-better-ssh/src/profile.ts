import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SSH_PROFILE_ENTRY_TYPE = "pi-better-ssh-profile";

export interface SshProfile {
  host: string;
  workdir?: string;
  env?: Record<string, string>;
}

interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

export function defaultSshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}

export function listSshHostAliases(configPath = defaultSshConfigPath()): string[] {
  let config: string;
  try {
    config = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const aliases = new Set<string>();
  for (const line of config.split(/\r?\n/)) {
    const directive = line.trim().match(/^Host\s+(.+?)(?:\s+#.*)?$/i);
    if (!directive) continue;
    for (const token of directive[1]!.trim().split(/\s+/)) {
      if (!token || token.startsWith("!") || /[*?]/.test(token)) continue;
      aliases.add(token);
    }
  }
  return [...aliases].sort((left, right) => left.localeCompare(right));
}

export function createSshProfile(
  input: { host?: string; workdir?: string; env?: Record<string, string> },
  aliases: readonly string[],
  configPath = defaultSshConfigPath(),
): SshProfile {
  const host = input.host?.trim();
  if (!host) throw new Error("ssh_profile use requires host (an SSH config Host alias or user@host)");
  if (/\s/.test(host) || host.startsWith("@") || host.endsWith("@")) {
    throw new Error("ssh_profile host must be an SSH config Host alias or user@host");
  }
  if (!host.includes("@") && !aliases.includes(host)) {
    throw new Error(`ssh_profile host ${JSON.stringify(host)} is not a Host alias in ${configPath}; use a configured alias or user@host`);
  }

  const workdir = input.workdir?.trim();
  if (input.workdir !== undefined && !workdir) {
    throw new Error("ssh_profile workdir must not be empty");
  }
  const env = validateEnvironment(input.env);
  return {
    host,
    ...(workdir ? { workdir } : {}),
    ...(env ? { env } : {}),
  };
}

export function restoreSshProfile(entries: Iterable<SessionEntryLike>): SshProfile | undefined {
  let active: SshProfile | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SSH_PROFILE_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as { version?: unknown; active?: unknown };
    if (data.version !== 1) continue;
    if (data.active === null) {
      active = undefined;
      continue;
    }
    const restored = validateStoredProfile(data.active);
    if (restored) active = restored;
  }
  return active;
}

export function profileStateEntry(active: SshProfile | undefined): { version: 1; active: SshProfile | null } {
  return { version: 1, active: active ? cloneProfile(active) : null };
}

export function formatSshProfileChip(profile: SshProfile, muxState: "up" | "down"): string {
  return `SSH: ${profile.host}${profile.workdir ? `:${profile.workdir}` : ""} (mux ${muxState})`;
}

function validateStoredProfile(value: unknown): SshProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { host?: unknown; workdir?: unknown; env?: unknown };
  if (typeof candidate.host !== "string" || !candidate.host.trim() || /\s/.test(candidate.host)) return undefined;
  if (candidate.workdir !== undefined && (typeof candidate.workdir !== "string" || !candidate.workdir.trim())) return undefined;
  const env = validateEnvironment(candidate.env, false);
  if (candidate.env !== undefined && !env) return undefined;
  return {
    host: candidate.host,
    ...(typeof candidate.workdir === "string" ? { workdir: candidate.workdir } : {}),
    ...(env ? { env } : {}),
  };
}

function validateEnvironment(value: unknown, throwOnInvalid = true): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (throwOnInvalid) throw new Error("ssh_profile env must be a string map");
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== "string") {
      if (throwOnInvalid) throw new Error(`ssh_profile env contains an invalid variable ${JSON.stringify(name)}`);
      return undefined;
    }
    env[name] = entry;
  }
  return env;
}

function cloneProfile(profile: SshProfile): SshProfile {
  return {
    host: profile.host,
    ...(profile.workdir ? { workdir: profile.workdir } : {}),
    ...(profile.env ? { env: { ...profile.env } } : {}),
  };
}
