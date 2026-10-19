import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DaemonClient } from "../client.ts";
import { resolveTarget, type Target } from "../remote/target.ts";
import { resolveSession } from "../remote/sessions.ts";
import { getPi12Bridge, installPi12Bridge } from "./pi-1.2-bridge.ts";
import { planPackageSync, readLocalPackageCatalog, type PackageCatalog } from "./packages.ts";
import { RemoteClientSession } from "./session.ts";
import { availableRemoteHosts, chooseRemoteAction, chooseRemoteHost, remoteArgumentCompletions, showRemoteHostList } from "./menu.ts";
import { rememberedServerDir, rememberRemoteHost } from "./profiles.ts";

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
    description: "Open remote connection options or connect to an SSH host",
    getArgumentCompletions: async (prefix) => remoteArgumentCompletions(prefix, [...new Set(["list", ...await availableRemoteHosts()])]),
    handler: async (args, ctx) => {
      // The command context is invalidated when its local runtime is retired.
      const ui = ctx.ui;
      let target: Target | undefined;
      let client: DaemonClient | undefined;
      let attached = false;
      try {
        if (VERSION !== "1.2.0") throw new Error(`Native /remote currently requires Pi 1.2.0; this client is ${VERSION}. The local session is unchanged.`);
        if (!ctx.hasUI) throw new Error("/remote requires Pi's interactive terminal UI");
        if (args.trim() === "list") { await showRemoteHostList(ui, await availableRemoteHosts()); return; }
        if (args.trim() === "disconnect") { ui.notify("This Pi session is already local", "info"); return; }
        if (!ctx.isIdle()) throw new Error("Wait for the local session to finish or abort it before connecting remotely");
        const chosenHost = args.trim() ? undefined : await chooseRemoteHost(ui, await availableRemoteHosts());
        if (!args.trim() && !chosenHost) return;
        const options = parseRemoteArgs(args.trim() || chosenHost!);
        const bridge = getPi12Bridge(ctx.sessionManager);
        if (!bridge) throw new Error("The Pi native remote bridge was not captured. Load this extension at Pi startup, then try /remote again.");
        const remoteDir = options.remoteDir ?? await rememberedServerDir(options.host);
        await rememberRemoteHost(options.host, remoteDir).catch((error) => ui.notify(`Could not remember remote host: ${error instanceof Error ? error.message : String(error)}`, "warning"));
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
            const command = text.trim();
            const action = command === "/remote" ? await chooseRemoteAction(ui, options.host) : command === "/remote disconnect" ? "disconnect" : command === "/remote list" ? "list" : undefined;
            if (!["/remote", "/remote disconnect", "/remote list"].includes(command)) throw new Error("Use /remote to open connection options, /remote list to list hosts, or /remote disconnect before choosing another host");
            if (action === "disconnect") await bridge.disconnect();
            else if (action === "list") await showRemoteHostList(ui, await availableRemoteHosts());
            else if (action === "details") ui.notify(`Host: ${options.host}\nWorkspace: ${remote.sessionManager.getCwd()}\nSession: ${remote.sessionId}\nModel: ${remote.model?.provider ?? "unknown"}/${remote.model?.id ?? "unknown"}`, "info");
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
