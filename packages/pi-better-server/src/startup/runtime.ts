import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
