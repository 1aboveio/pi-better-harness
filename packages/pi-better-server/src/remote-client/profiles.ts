import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function validRemoteHost(host: string): boolean {
  return Boolean(host) && !/^[!-]/.test(host) && !/[\s/\\*?\x00-\x1f\x7f]/.test(host) && host !== "disconnect";
}

function hostProfile(host: string, agentDir: string): string {
  if (!validRemoteHost(host)) throw new Error("Enter one SSH alias or user@host, without command arguments");
  return join(agentDir, "remote-client", "hosts", `${encodeURIComponent(host)}.json`);
}

export async function rememberedServerDir(host: string, agentDir = getAgentDir()): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(hostProfile(host, agentDir), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid saved remote profile for ${host}`);
  const directory = (value as { serverDir?: unknown }).serverDir;
  if (directory === undefined) return undefined;
  if (typeof directory !== "string" || !directory.startsWith("/")) throw new Error(`Saved server directory for ${host} must be absolute`);
  return directory;
}

/** Record entered hosts even when they use the default directory or fail to connect. */
export async function rememberRemoteHost(host: string, serverDir?: string, agentDir = getAgentDir()): Promise<void> {
  const path = hostProfile(host, agentDir);
  if (serverDir !== undefined && !serverDir.startsWith("/")) throw new Error("Remote server directory must be absolute");
  const previous = serverDir ?? await rememberedServerDir(host, agentDir);
  await mkdir(join(agentDir, "remote-client", "hosts"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...(previous ? { serverDir: previous } : {}) })}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}