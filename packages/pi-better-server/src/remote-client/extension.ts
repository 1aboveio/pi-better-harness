import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DaemonClient } from "../client.ts";
import { resolveTarget, type Target } from "../remote/target.ts";
import { resolveSession } from "../remote/sessions.ts";
import { getPi12Bridge, installPi12Bridge, type Pi12Bridge } from "./pi-1.2-bridge.ts";
import { planPackageSync, readLocalPackageCatalog, type PackageCatalog } from "./packages.ts";
import { RemoteClientSession } from "./session.ts";
import { availableRemoteHosts, chooseRemoteHost, remoteArgumentCompletions, showRemoteHostList } from "./menu.ts";
import { rememberedServerDir, rememberRemoteHost } from "./profiles.ts";
import { browseRemoteSessions } from "./session-browser.ts";
import { withConnectionProgress } from "./connection-progress.ts";

const USAGE = "/remote connect <ssh-alias> [--cwd <remote-path>] [--session <id>] [--remote-dir <server-dir>]";

export function parseRemoteArgs(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words[0] === "connect") words.shift();
  const { values, positionals } = parseArgs({ args: words, allowPositionals: true, options: {
    cwd: { type: "string" }, session: { type: "string" }, "remote-dir": { type: "string" },
  } });
  if (positionals.length !== 1) throw new Error(`Usage: ${USAGE}`);
  return { host: positionals[0]!, cwd: values.cwd, sessionId: values.session, remoteDir: values["remote-dir"] };
}

type RemoteOptions = ReturnType<typeof parseRemoteArgs>;
export interface RemoteClientDependencies { resolveTarget: typeof resolveTarget }
interface LocalFrontend { ui: ExtensionUIContext; cwd: string; bridge: Pi12Bridge; dependencies: RemoteClientDependencies }

export function checkedRemoteWorkspace(requested: string | undefined, actual: string): string {
  if (requested !== undefined && requested !== actual) throw new Error(`Remote session workspace is ${actual}, not the requested ${requested}; nothing was attached`);
  return actual;
}

async function argumentCompletions(prefix: string, connected = false) {
  const hosts = /^connect(?:\s|$)/i.test(prefix.trimStart()) ? await availableRemoteHosts() : [];
  return remoteArgumentCompletions(prefix, connected, hosts);
}

/** UI selections are resolved before any SSH connection is opened. */
export async function chooseRemoteConnection(args: string, ui: Pick<ExtensionUIContext, "select" | "input" | "confirm" | "notify">, hosts?: readonly string[]): Promise<RemoteOptions | undefined> {
  const text = args.trim();
  if (text === "list") {
    const host = await showRemoteHostList(ui, hosts ?? await availableRemoteHosts());
    if (!host || !await ui.confirm(`Connect to ${host}?`, `SSH host: ${host}`)) return undefined;
    return parseRemoteArgs(`connect ${host}`);
  }
  if (!text || text === "connect") {
    const host = await chooseRemoteHost(ui, hosts ?? await availableRemoteHosts());
    return host ? parseRemoteArgs(`connect ${host}`) : undefined;
  }
  return parseRemoteArgs(text);
}

/** Registers the local UI client; remote work never creates a local agent loop. */
export function registerRemoteClient(pi: ExtensionAPI, dependencies: RemoteClientDependencies = { resolveTarget }): void {
  if (VERSION === "1.2.0") installPi12Bridge();
  pi.registerCommand("remote", {
    description: "Connect to a remote server and browse its sessions",
    getArgumentCompletions: (prefix) => argumentCompletions(prefix),
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      try {
        if (VERSION !== "1.2.0") throw new Error(`Native /remote currently requires Pi 1.2.0; this client is ${VERSION}. The local session is unchanged.`);
        if (!ctx.hasUI) throw new Error("/remote requires Pi's interactive terminal UI");
        if (args.trim() === "disconnect") { ui.notify("This Pi session is already local", "info"); return; }
        if (args.trim() === "sessions") { ui.notify("Connect to a remote host first", "info"); return; }
        const options = await chooseRemoteConnection(args, ui);
        if (!options) return;
        if (!ctx.isIdle()) throw new Error("Wait for the local session to finish or abort it before connecting remotely");
        const bridge = getPi12Bridge(ctx.sessionManager);
        if (!bridge) throw new Error("The Pi native remote bridge was not captured. Load this extension at Pi startup, then try /remote again.");
        // Only plain data and stable UI bindings survive the local runtime replacement.
        await connectHost(options, { ui, cwd: ctx.cwd, bridge, dependencies });
      } catch (error) { ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}

async function chooseWorkspace(client: DaemonClient, ui: ExtensionUIContext, host: string): Promise<string | undefined> {
  const listed = await client.call({ type: "client_workspaces" });
  const labels = (listed.data.workspaces as Array<{ path: string }>).map((entry) => entry.path);
  const choice = await ui.select(`New session workspace on ${host}`, [...labels, "Enter another remote path"]);
  if (choice === undefined) return undefined;
  const cwd = labels.includes(choice) ? choice : await ui.input("Remote workspace path", listed.data.root);
  if (!cwd) return undefined;
  if (!cwd.startsWith("/")) throw new Error("The remote workspace must be an absolute path on the server");
  return cwd;
}

async function connectHost(options: RemoteOptions, local: LocalFrontend): Promise<void> {
  const { ui, bridge } = local;
  let target: Target | undefined;
  let client: DaemonClient | undefined;
  let attached = false;
  try {
    const remoteDir = options.remoteDir ?? await rememberedServerDir(options.host);
    await rememberRemoteHost(options.host, remoteDir).catch((error) => ui.notify(`Could not remember remote host: ${error instanceof Error ? error.message : String(error)}`, "warning"));
    const controlPathRoot = join(process.env.PI_REMOTE_TMP ?? "/tmp", `pi-native-${process.getuid?.() ?? process.pid}`);
    const setup = await withConnectionProgress(ui, options.host, async ({ signal, stage }) => {
      let pendingTarget: Target | undefined;
      let pendingClient: DaemonClient | undefined;
      try {
        stage("establishing SSH...");
        pendingTarget = await local.dependencies.resolveTarget({
          host: options.host, agent: "pi", controlPathRoot, signal,
          ...(remoteDir ? { remoteDir } : {}),
          onProgress: phase => stage({ ssh: "establishing SSH...", directory: "finding remote server...", server: "starting or checking Pi server...", forward: "opening SSH tunnel..." }[phase]),
        });
        signal.throwIfAborted();
        stage("contacting Pi server...");
        pendingClient = await DaemonClient.connect(pendingTarget.socketPath, { signal });
        signal.throwIfAborted();
        stage("checking server compatibility...");
        const capabilities = pendingClient.server?.capabilities ?? [];
        if (!["native-client-v1", "session-browser-v1"].every(capability => capabilities.includes(capability))) throw new Error("This daemon does not support the /remote session browser yet. Update pi-better-server on the remote host; the local session is unchanged.");
        return { target: pendingTarget, client: pendingClient };
      } catch (error) {
        pendingClient?.close();
        await pendingTarget?.close().catch(() => undefined);
        throw error;
      }
    }, async (late) => { late.client.close(); await late.target.close(); });
    if (!setup) return;
    target = setup.target;
    client = setup.client;
    const connection = client;
    const transport = target;
    ui.setStatus("pi-remote", `SSH: ${options.host} (sessions)`);
    for (;;) {
      let cwd = options.cwd;
      let sessionId: string;
      let synced = false;
      if (options.sessionId) {
        const selected = await resolveSession(connection, options.sessionId);
        cwd = checkedRemoteWorkspace(cwd, selected.cwd);
        sessionId = selected.sessionId;
      } else {
        const choice = await browseRemoteSessions(ui, connection, options.host, { cwd: options.cwd });
        if (!choice) return;
        if (choice.action === "create") {
          cwd = options.cwd ?? await chooseWorkspace(connection, ui, options.host);
          if (!cwd) continue;
          await syncPackages(connection, local, cwd);
          synced = true;
          const created = await connection.call({ type: "create_session", cwd });
          sessionId = created.sessionId as string;
        } else {
          cwd = checkedRemoteWorkspace(cwd, choice.session.cwd);
          sessionId = choice.session.sessionId;
        }
      }
      if (!synced) await syncPackages(connection, local, cwd!);
      await connection.call({ type: "open_session", sessionId });
      const remote = await RemoteClientSession.connect(connection, sessionId, {
        onDisconnect: () => {
          ui.setStatus("pi-remote", `SSH: ${options.host} (disconnected)`);
          ui.notify(`Disconnected from ${options.host}. Remote work has not been aborted. Use /remote disconnect to return locally, then reconnect.`, "warning");
        },
        localCommandCompletions: (prefix) => argumentCompletions(prefix, true),
        onLocalCommand: async (text) => {
          if (!/^\/remote(?:\s|$)/.test(text)) return false;
          const args = text.replace(/^\/remote(?:\s|$)/, "").trim();
          if (args === "disconnect") { await bridge.disconnect(); return true; }
          const next = !args || args === "sessions"
            ? { host: options.host, remoteDir, cwd: undefined, sessionId: undefined }
            : await chooseRemoteConnection(args, ui);
          if (!next) return true;
          await bridge.disconnect();
          try { await connectHost(next, local); }
          catch (error) { ui.notify(error instanceof Error ? error.message : String(error), "error"); }
          return true;
        },
      });
      try { cwd = checkedRemoteWorkspace(cwd, remote.sessionManager.getCwd()); }
      catch (error) { remote.dispose(); throw error; }
      const dispose = remote.dispose.bind(remote);
      remote.dispose = () => { dispose(); connection.close(); void transport.close(); };
      await bridge.attach(remote);
      attached = true;
      ui.setStatus("pi-remote", `SSH: ${options.host}`);
      ui.notify(`Attached to ${options.host}:${cwd}. /remote opens the server's sessions; /remote disconnect returns locally.`, "info");
      return;
    }
  } finally {
    if (!attached) { client?.close(); await target?.close(); ui.setStatus("pi-remote", undefined); }
  }
}

async function syncPackages(client: DaemonClient, local: Pick<LocalFrontend, "cwd" | "ui">, cwd: string): Promise<void> {
  const { ui } = local;
  const localCatalog = await readLocalPackageCatalog(undefined, local.cwd);
  const remote = (await client.call({ type: "client_packages", cwd })).data as PackageCatalog;
  if (localCatalog.unsupported.length) ui.notify(`Local-only extensions will not be copied: ${localCatalog.unsupported.join(", ")}`, "warning");
  const plan = planPackageSync(localCatalog.packages, remote.packages);
  const changes = [...plan.install];
  for (const conflict of plan.conflicts ?? []) {
    if (!changes.some((entry) => entry.source === conflict.local.source)) changes.push(conflict.local);
  }
  if (!changes.length) return;
  const preview = [
    ...plan.install.map((entry) => `Install: ${JSON.stringify(entry)}`),
    ...(plan.conflicts ?? []).map((entry) => `Replace: ${JSON.stringify(entry.remote)}\nWith: ${JSON.stringify(entry.local)}`),
  ].join("\n\n");
  const approved = await ui.confirm("Sync remote extensions?", `Target workspace: ${cwd}\n\n${preview}\n\nOnly these package declarations are synced. Credentials, provider settings, and local extension source are not copied. Remote-only packages are kept. Trusted project overrides must be managed on the remote host.`);
  if (!approved) return;
  ui.notify("Installing approved remote extensions...", "info");
  await client.call({ type: "client_packages_install", cwd, packages: changes });
}

export default function remoteClientExtension(pi: ExtensionAPI): void { registerRemoteClient(pi); }
