import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { DaemonClient } from "../client.ts";
import { resolveTarget, type Target } from "../remote/target.ts";
import { resolveSession } from "../remote/sessions.ts";
import { getPi12Bridge, installPi12Bridge } from "./pi-1.2-bridge.ts";
import { planPackageSync, readLocalPackageCatalog, type PackageCatalog } from "./packages.ts";
import { RemoteClientSession } from "./session.ts";

const USAGE = "/remote <ssh-alias> [--cwd <remote-path>] [--session <id>] [--remote-dir <server-dir>]";

export function parseRemoteArgs(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const { values, positionals } = parseArgs({ args: words, allowPositionals: true, options: {
    cwd: { type: "string" }, session: { type: "string" }, "remote-dir": { type: "string" },
  } });
  if (positionals.length !== 1) throw new Error(`Usage: ${USAGE}`);
  return { host: positionals[0]!, cwd: values.cwd, sessionId: values.session, remoteDir: values["remote-dir"] };
}

export function checkedRemoteWorkspace(requested: string | undefined, actual: string): string {
  if (requested !== undefined && requested !== actual) throw new Error(`Remote session workspace is ${actual}, not the requested ${requested}; nothing was attached`);
  return actual;
}

/** Registers the local UI client; it never starts a local model/provider for remote work. */
export default function remoteClientExtension(pi: ExtensionAPI): void {
  if (VERSION === "1.2.0") installPi12Bridge();
  pi.registerCommand("remote", {
    description: "Connect this native Pi UI to a remote Pi workspace over SSH",
    handler: async (args, ctx) => {
      // The command context is invalidated when its local runtime is retired.
      const ui = ctx.ui;
      let target: Target | undefined;
      let client: DaemonClient | undefined;
      let attached = false;
      try {
        if (VERSION !== "1.2.0") throw new Error(`Native /remote currently requires Pi 1.2.0; this client is ${VERSION}. The local session is unchanged.`);
        if (!ctx.hasUI) throw new Error("/remote requires Pi's interactive terminal UI");
        if (!ctx.isIdle()) throw new Error("Wait for the local session to finish or abort it before connecting remotely");
        const options = parseRemoteArgs(args);
        const bridge = getPi12Bridge(ctx.sessionManager);
        if (!bridge) throw new Error("The Pi native remote bridge was not captured. Load this extension at Pi startup, then try /remote again.");
        const remoteDir = options.remoteDir ?? await rememberedServerDir(options.host);
        // OpenSSH appends a temporary suffix; keep mux sockets short even for long agent paths.
        const controlPathRoot = join(process.env.PI_REMOTE_TMP ?? "/tmp", `pi-native-${process.getuid?.() ?? process.pid}`);
        target = await resolveTarget({ host: options.host, controlPathRoot, ...(remoteDir ? { remoteDir } : {}) });
        client = await DaemonClient.connect(target.socketPath);
        if (!client.server?.capabilities?.includes("native-client-v1")) throw new Error("This daemon does not support the native /remote client yet. Update pi-better-server on the remote host; the local session is unchanged.");
        const connection = client;
        const transport = target;
        let cwd = options.cwd;
        let sessionId: string | undefined;
        if (options.sessionId) {
          const selected = await resolveSession(connection, options.sessionId);
          cwd = checkedRemoteWorkspace(cwd, selected.cwd);
          sessionId = selected.sessionId;
        }
        if (!cwd) {
          const listed = await connection.call({ type: "client_workspaces" });
          const workspaces = listed.data.workspaces as Array<{ name: string; path: string }>;
          const labels = workspaces.map((entry) => entry.path);
          const choice = await ui.select(`Workspace on ${options.host}`, [...labels, "Enter another remote path"]);
          if (choice === undefined) return;
          cwd = labels.includes(choice) ? choice : await ui.input("Remote workspace path", listed.data.root);
          if (!cwd) return;
          if (!cwd.startsWith("/")) throw new Error("The remote workspace must be an absolute path on the server");
        }
        await syncPackages(connection, ctx, cwd);
        if (!sessionId) {
          const listed = await connection.call({ type: "list_sessions" });
          const sessions = (listed.data.sessions as Array<{ sessionId: string; cwd: string; name?: string; ownership?: string }>).filter((entry) => entry.cwd === cwd && !entry.ownership);
          const choices = sessions.map((entry) => `${entry.name ?? "Session"} (${entry.sessionId})`);
          const choice = sessions.length ? await ui.select("Remote session", ["Start a new session", ...choices]) : "Start a new session";
          if (choice === undefined) return;
          if (choice === "Start a new session") {
            const created = await connection.call({ type: "create_session", cwd });
            sessionId = created.sessionId as string;
          } else {
            sessionId = sessions[choices.indexOf(choice)]!.sessionId;
          }
        }
        await connection.call({ type: "open_session", sessionId });
        const remote = await RemoteClientSession.connect(connection, sessionId, {
          onDisconnect: () => {
            ui.setStatus("pi-remote", `SSH: ${options.host} (disconnected)`);
            ui.notify(`Disconnected from ${options.host}. Remote work has not been aborted. Use /remote disconnect to return locally, then reconnect.`, "warning");
          },
          onLocalCommand: async (text) => {
            if (!/^\/remote(?:\s|$)/.test(text)) return false;
            if (text.trim() !== "/remote disconnect") throw new Error("Use /remote disconnect before choosing another remote connection");
            await bridge.disconnect();
            return true;
          },
        });
        try { cwd = checkedRemoteWorkspace(cwd, remote.sessionManager.getCwd()); }
        catch (error) { remote.dispose(); throw error; }
        const dispose = remote.dispose.bind(remote);
        remote.dispose = () => {
          dispose();
          connection.close();
          void transport.close();
        };
        await bridge.attach(remote);
        attached = true;
        ui.setStatus("pi-remote", `SSH: ${options.host}`);
        if (remoteDir) await rememberServerDir(options.host, remoteDir).catch(() => ui.notify("Connected, but could not save the remote server directory for the next connection", "warning"));
        ui.notify(`Connected to ${options.host}:${cwd}. Agent and tools execute remotely. /remote disconnect returns locally without stopping remote work.`, "info");
      } catch (error) {
        ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        if (!attached) {
          client?.close();
          await target?.close();
        }
      }
    },
  });
}

async function syncPackages(client: DaemonClient, ctx: ExtensionCommandContext, cwd: string): Promise<void> {
  const local = await readLocalPackageCatalog(undefined, ctx.cwd);
  const remote = (await client.call({ type: "client_packages", cwd })).data as PackageCatalog;
  if (local.unsupported.length) ctx.ui.notify(`Local-only extensions will not be copied: ${local.unsupported.join(", ")}`, "warning");
  const plan = planPackageSync(local.packages, remote.packages);
  const changes = [...plan.install];
  for (const conflict of plan.conflicts ?? []) {
    if (!changes.some((entry) => entry.source === conflict.local.source)) changes.push(conflict.local);
  }
  if (!changes.length) return;
  const preview = [
    ...plan.install.map((entry) => `Install: ${JSON.stringify(entry)}`),
    ...(plan.conflicts ?? []).map((entry) => `Replace: ${JSON.stringify(entry.remote)}\nWith: ${JSON.stringify(entry.local)}`),
  ].join("\n\n");
  const approved = await ctx.ui.confirm("Sync remote extensions?", `Target workspace: ${cwd}\n\n${preview}\n\nOnly these package declarations are synced. Credentials, provider settings, and local extension source are not copied. Remote-only packages are kept. Trusted project overrides must be managed on the remote host.`);
  if (!approved) return;
  ctx.ui.notify("Installing approved remote extensions...", "info");
  await client.call({ type: "client_packages_install", cwd, packages: changes });
}

function hostProfile(host: string): string {
  return join(getAgentDir(), "remote-client", "hosts", `${encodeURIComponent(host)}.json`);
}

async function rememberedServerDir(host: string): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(hostProfile(host), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || typeof (value as { serverDir?: unknown }).serverDir !== "string") throw new Error(`Invalid saved remote profile for ${host}`);
  const directory = (value as { serverDir: string }).serverDir;
  if (!directory.startsWith("/")) throw new Error(`Saved server directory for ${host} must be absolute`);
  return directory;
}

async function rememberServerDir(host: string, serverDir: string): Promise<void> {
  const directory = join(getAgentDir(), "remote-client", "hosts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = hostProfile(host);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ serverDir })}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}