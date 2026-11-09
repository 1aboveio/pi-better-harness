import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { RunRemote, RuntimePlatform } from "./managed-types.ts";

/**
 * $HOME/.pi/remote-server.json is an atomic, user-local version-1 registration.
 * Discovery order: explicit PI_SERVER_COMMAND (absolute executable, not shell code),
 * registration, then only ~/.pi-better-server/bin/pi-server. Never scan other roots.
 * Explicit server-directory selection overrides defaultServerDir, not agentDir.
 * Bootstrap registers this file; existing deployments must register their own paths.
 */
export interface InstalledRuntime {
  version: 1;
  agent: "pi";
  launcher: string;
  agentDir: string;
  defaultServerDir: string;
}

export const INSTALL_GUIDANCE = "Install/register pi-better-server with scripts/bootstrap-host.sh, or set PI_SERVER_COMMAND to an absolute installed pi-server launcher. No packages were installed.";

export function absolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} must be a literal absolute path`);
  }
  return value;
}

export function parseRuntime(text: string): InstalledRuntime {
  const data = JSON.parse(text) as Partial<InstalledRuntime> | null;
  if (!data || data.version !== 1 || data.agent !== "pi") throw new Error("Unsupported installed Pi runtime registration (expected version 1, agent pi)");
  return {
    version: 1, agent: "pi",
    launcher: absolutePath(data.launcher, "runtime.launcher"),
    agentDir: absolutePath(data.agentDir, "runtime.agentDir"),
    defaultServerDir: absolutePath(data.defaultServerDir, "runtime.defaultServerDir"),
  };
}

export function registeredRuntime(env: NodeJS.ProcessEnv = process.env): InstalledRuntime | undefined {
  const path = join(env.HOME || homedir(), ".pi", "remote-server.json");
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Runtime discovery: cannot read ${path}: ${String(error)}`);
  }
  try { return parseRuntime(text); }
  catch (error) { throw new Error(`Runtime discovery: invalid ${path}: ${String(error)}`); }
}

/** Used by a known launcher to describe itself, including pre-registration bootstrap installs. */
export function launcherRuntime(env: NodeJS.ProcessEnv = process.env): InstalledRuntime {
  const home = env.HOME || homedir();
  const agentDir = resolve(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"));
  return parseRuntime(JSON.stringify({
    version: 1, agent: "pi",
    launcher: env.PI_SERVER_COMMAND || env.PI_SERVER_LAUNCHER || join(home, ".pi-better-server", "bin", "pi-server"),
    agentDir,
    defaultServerDir: resolve(env.PI_SERVER_DIR || join(agentDir, "server")),
  }));
}

export function discoverLocalRuntime(): (InstalledRuntime & { discoveryEnv?: Record<string, string> }) | undefined {
  const explicit = process.env.PI_SERVER_COMMAND || process.env.PI_SERVER_LAUNCHER;
  const registered = explicit ? undefined : registeredRuntime();
  const runtime = explicit ? launcherRuntime() : registered ?? launcherRuntime();
  try { accessSync(runtime.launcher, constants.X_OK); }
  catch (error) {
    // Local development/manual daemons never required an installed launcher. Keep that transport path.
    if (!explicit && !registered && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Runtime discovery: launcher not executable: ${runtime.launcher}. ${INSTALL_GUIDANCE}`);
  }
  // Registration owns these paths; the client's agent/server environment must not rewrite its identity.
  return registered ? { ...runtime, discoveryEnv: {
    PI_CODING_AGENT_DIR: registered.agentDir,
    PI_SERVER_DIR: registered.defaultServerDir,
  } } : runtime;
}

export interface RemoteRuntimeProbe {
  home: string;
  platform: RuntimePlatform;
  runtime?: InstalledRuntime;
  explicitCommand?: string;
}

/** Read-only managed probe. Legacy discovery deliberately keeps its existing failure contract. */
export async function probeRemoteRuntime(run: RunRemote, options: { command?: string; timeoutMs?: number; signal?: AbortSignal; registration?: boolean } = {}): Promise<RemoteRuntimeProbe> {
  options.signal?.throwIfAborted();
  const command = options.command ? absolutePath(options.command, "PI_SERVER_COMMAND") : undefined;
  const result = await run(`${command ? `PI_SERVER_COMMAND=${shellQuote(command)}; export PI_SERVER_COMMAND\n` : ""}if [ -n "\${PI_SERVER_COMMAND:-}" ]; then
  case "$PI_SERVER_COMMAND" in /*) ;; *) printf '%s\\n' 'Runtime probe: PI_SERVER_COMMAND must be an absolute launcher path' >&2; exit 1 ;; esac
fi
printf '%s\\n' "$HOME" "$(uname -s)" "$(uname -m)" "\${PI_SERVER_COMMAND:-}"
if ${options.registration === false ? "false" : '[ -n "${PI_SERVER_COMMAND:-}" ]'}; then
  printf 'registered\\n'
  exec "$PI_SERVER_COMMAND" runtime --agent pi
elif ${options.registration === false ? "false" : '[ -e "$HOME/.pi/remote-server.json" ] || [ -L "$HOME/.pi/remote-server.json" ]'}; then
  printf 'registered\\n'
  cat "$HOME/.pi/remote-server.json"
elif ${options.registration === false ? "false" : '[ -x "$HOME/.pi-better-server/bin/pi-server" ]'}; then
  printf 'registered\\n'
  exec "$HOME/.pi-better-server/bin/pi-server" runtime --agent pi
else
  printf 'absent\\n'
fi`, undefined, options.timeoutMs ?? 15_000);
  options.signal?.throwIfAborted();
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`Runtime probe: ${result.stderr || "remote command failed"}`);
  const [home, os, arch, explicitCommand, state, ...registration] = result.stdout.split("\n");
  absolutePath(home, "remote HOME");
  const platform = `${os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : "unsupported"}-${arch === "x86_64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : "unsupported"}`;
  if (!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(platform)) throw new Error(`Runtime probe: unsupported platform ${os}/${arch}`);
  const text = registration.join("\n").trim();
  if (!text && state === "registered") throw new Error("Runtime probe: registration or explicit launcher returned no registration");
  return { home: home!, platform: platform as RuntimePlatform, ...(explicitCommand ? { explicitCommand: absolutePath(explicitCommand, "PI_SERVER_COMMAND") } : {}), ...(text ? { runtime: parseRuntime(text) } : {}) };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Discovery needs only the remote shell: JSON is parsed and validated by the caller, not by shell tools. */
export function remoteRuntimeScript(command?: string): string {
  const override = command ? `PI_SERVER_COMMAND=${shellQuote(absolutePath(command, "PI_SERVER_COMMAND"))}; export PI_SERVER_COMMAND\n` : "";
  return `${override}if [ -n "\${PI_SERVER_COMMAND:-}" ]; then
  case "$PI_SERVER_COMMAND" in /*) ;; *) printf '%s\\n' 'Runtime discovery: PI_SERVER_COMMAND must be an absolute launcher path' >&2; exit 1 ;; esac
  exec "$PI_SERVER_COMMAND" runtime --agent pi
elif [ -f "$HOME/.pi/remote-server.json" ]; then
  cat "$HOME/.pi/remote-server.json"
elif [ -x "$HOME/.pi-better-server/bin/pi-server" ]; then
  exec "$HOME/.pi-better-server/bin/pi-server" runtime --agent pi
else
  printf '%s\\n' ${shellQuote(`Runtime discovery: ${INSTALL_GUIDANCE}`)} >&2
  exit 1
fi`;
}
