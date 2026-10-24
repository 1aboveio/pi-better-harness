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
import { availableRemoteHosts, chooseRemoteHost, LOCAL_HOST, remoteArgumentCompletions, showRemoteHostList } from "./menu.ts";
import { rememberedServerDir, rememberRemoteHost } from "./profiles.ts";
import { browseRemoteSessions } from "./session-browser.ts";
import { withConnectionProgress } from "./connection-progress.ts";
import { registerLocalOwnershipGuard } from "../detach/extension.ts";
import { parseRemoteTransferArgs, runRemoteTransfer, type RemoteTransferArgs, type TransferFrontend } from "./transfer-command.ts";
import { observeLocalTransferWork } from "./local-work.ts";
import { browseRemoteFolders } from "./folder-browser.ts";
import { showRemoteProgress } from "./remote-progress.ts";
import { NATIVE_RECONNECT_CAPABILITIES, openUpgradeTransport } from "./upgrade-transport.ts";

const USAGE = "/remote connect <ssh-alias|localhost> [--cwd <remote-path>] [--session <id>] [--remote-dir <server-dir>]";
/** `localhost` names the daemon on this machine: a plain Unix socket, no SSH setup. */
export { LOCAL_HOST };
export const isLocalHost = (host: string): boolean => host === LOCAL_HOST;
const UPGRADE_STAGES: Record<string, string> = {
  artifact: "preparing matching server...", probe: "checking remote platform...", "node-download": "preparing private Node runtime...",
  verifying: "verifying installed server...", "verification-upload": "sending server verification data...",
  "node-upload": "uploading verified Node runtime...", dependencies: "checking server dependencies...", "dependencies-upload": "uploading verified dependencies...",
  staged: "matching server staged...", activating: "activating matching server...", ready: "matching server ready...", deferred: "server update staged; current daemon continues...",
};
const resolveNativeTarget: typeof resolveTarget = options => resolveTarget({ ...options, managedRuntime: true });

export function parseRemoteArgs(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words[0] === "connect") words.shift();
  const { values, positionals } = parseArgs({ args: words, allowPositionals: true, options: {
    cwd: { type: "string" }, session: { type: "string" }, "remote-dir": { type: "string" },
  } });
  if (positionals.length !== 1) throw new Error(`Usage: ${USAGE}`);
  const host = positionals[0] === "local" ? LOCAL_HOST : positionals[0]!;
  return { host, cwd: values.cwd, sessionId: values.session, remoteDir: values["remote-dir"] };
}

type RemoteOptions = ReturnType<typeof parseRemoteArgs>;
export interface RemoteClientDependencies { resolveTarget: typeof resolveTarget }
interface LocalFrontend { ui: ExtensionUIContext; cwd: string; bridge: Pi12Bridge; dependencies: RemoteClientDependencies; localSession?: TransferFrontend["localSession"] }

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
export function registerRemoteClient(pi: ExtensionAPI, dependencies: RemoteClientDependencies = { resolveTarget: resolveNativeTarget }): void {
  registerLocalOwnershipGuard(pi);
  const localWork = observeLocalTransferWork(pi);
  if (VERSION === "1.2.0") installPi12Bridge();
  pi.registerCommand("remote", {
    description: "Connect to a remote server and browse its sessions",
    getArgumentCompletions: (prefix) => argumentCompletions(prefix),
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      try {
        if (VERSION !== "1.2.0") throw new Error(`Native /remote currently requires Pi 1.2.0; this client is ${VERSION}. The local session is unchanged.`);
        if (!ctx.hasUI) throw new Error("/remote requires Pi's interactive terminal UI");
        if (/^pull(?:\s|$)/.test(args.trim())) {
          const transfer = parseRemoteTransferArgs(args);
          const header = ctx.sessionManager.getHeader();
          await runRemoteTransfer(transfer, {
            ui, cwd: ctx.cwd, resolveTarget: dependencies.resolveTarget,
            localSession: {
              manager: ctx.sessionManager, pi, isBusy: () => !ctx.isIdle() || localWork.busy(), assertIdle: () => localWork.check(ctx),
              info: { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
                sessionFile: ctx.sessionManager.getSessionFile(), name: ctx.sessionManager.getSessionName(),
                ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
                ...(header?.timestamp ? { createdAt: header.timestamp } : {}) },
            },
          });
          return;
        }
        if (args.trim() === "disconnect") { ui.notify("This Pi session is already local", "info"); return; }
        if (args.trim() === "sessions") { ui.notify("Connect to a remote host first", "info"); return; }
        const options = await chooseRemoteConnection(args, ui);
        if (!options) return;
        if (!ctx.isIdle()) throw new Error("Wait for the local session to finish or abort it before connecting remotely");
        const bridge = getPi12Bridge(ctx.sessionManager);
        if (!bridge) throw new Error("The Pi native remote bridge was not captured. Load this extension at Pi startup, then try /remote again.");
        // Only plain data and stable UI bindings survive the local runtime replacement.
        const header = ctx.sessionManager.getHeader();
        const localSession: TransferFrontend["localSession"] = ctx.sessionManager.getEntries().length ? {
          manager: ctx.sessionManager, pi, isBusy: () => !ctx.isIdle() || localWork.busy(), assertIdle: () => localWork.check(ctx),
          info: { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile(),
            name: ctx.sessionManager.getSessionName(), ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
            ...(header?.timestamp ? { createdAt: header.timestamp } : {}) },
        } : undefined;
        await connectHost(options, { ui, cwd: ctx.cwd, bridge, dependencies, localSession });
      } catch (error) { ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}

type RemoteSessionChoice = { action: "create"; cwd: string } | { action: "attach"; cwd: string; sessionId: string } | { action: "transfer"; copy: boolean; cwd: string };

/** Connecting does not authorize a handoff: explicitly choose mode and scope first. */
export async function chooseConnectionTransfer(ui: Pick<ExtensionUIContext, "select">, copy?: boolean): Promise<"browse" | { copy: boolean; includeWorkspace: boolean } | undefined> {
  const modes = ["Browse remote sessions", "Move current session here", "Copy current session here"];
  const mode = copy === undefined ? await ui.select("Connected: continue working", modes) : modes[copy ? 2 : 1];
  if (mode === undefined) return undefined;
  if (mode === modes[0]) return "browse";
  if (mode !== modes[1] && mode !== modes[2]) throw new Error("Unknown connection action");
  const scopes = ["Conversation only", "Conversation and workspace files"];
  const scope = await ui.select("Transfer scope", scopes);
  if (scope === undefined) return undefined;
  if (!scopes.includes(scope)) throw new Error("Unknown transfer scope");
  return { copy: mode === modes[2], includeWorkspace: scope === scopes[1] };
}

/** The browser's creation context is not a constraint on existing sessions. */
export async function chooseRemoteSession(client: DaemonClient, ui: ExtensionUIContext, host: string, options: { cwd?: string; sessionId?: string; allowTransfer?: boolean; notice?: string }): Promise<RemoteSessionChoice | undefined> {
  if (options.sessionId) {
    const sessionId = options.sessionId;
    const result = await showRemoteProgress(ui, host, "Finding remote session...", () => resolveSession(client, sessionId));
    if (!result) return undefined;
    const selected = result.value;
    return { action: "attach", cwd: checkedRemoteWorkspace(options.cwd, selected.cwd), sessionId: selected.sessionId };
  }
  let creationCwd = options.cwd;
  if (creationCwd === undefined) {
    const result = await showRemoteProgress(ui, host, "Loading remote browser...", () => client.call({ type: "client_workspaces" }));
    if (!result) return undefined;
    const listed = result.value;
    const root: unknown = listed.data?.root;
    if (typeof root !== "string" || !root.startsWith("/")) throw new Error("The server workspace root must be an absolute remote path");
    creationCwd = root;
  }
  const choice = await browseRemoteSessions(ui, client, host, {
    cwd: creationCwd, allowTransfer: options.allowTransfer, notice: options.notice,
    selectFolder: initialPath => {
      if (client.server && !client.server.capabilities?.includes("folder-browser-v1")) {
        return Promise.reject(new Error("Update pi-better-server on the remote host to browse or create folders. Existing sessions are still available."));
      }
      return browseRemoteFolders(ui, client, host, initialPath);
    },
  });
  if (!choice) return undefined;
  if (choice.action === "attach") return { action: "attach", cwd: checkedRemoteWorkspace(options.cwd, choice.session.cwd), sessionId: choice.session.sessionId };
  const cwd = choice.cwd ?? creationCwd;
  return choice.action === "create" ? { action: "create", cwd } : { action: "transfer", copy: choice.copy, cwd };
}

export async function connectHost(options: RemoteOptions, local: LocalFrontend): Promise<void> {
  const { ui, bridge } = local;
  let target: Target | undefined;
  let client: DaemonClient | undefined;
  let attached = false;
  let endBrowse: (() => void) | undefined;
  const closeInitialTransport = async () => {
    const initialClient = client;
    const initialTarget = target;
    client = undefined;
    target = undefined;
    initialClient?.close();
    await initialTarget?.close();
  };
  try {
    let remoteDir = options.remoteDir ?? await rememberedServerDir(options.host);
    const controlPathRoot = join(process.env.PI_REMOTE_TMP ?? "/tmp", `pi-native-${process.getuid?.() ?? process.pid}`);
    let deferredUpgrade: string | undefined;
    const setup = await withConnectionProgress(ui, options.host, async ({ signal, stage }) => {
      let pendingTarget: Target | undefined;
      let pendingClient: DaemonClient | undefined;
      try {
        const localConnect = isLocalHost(options.host);
        stage(localConnect ? "finding local server..." : "establishing SSH...");
        pendingTarget = await local.dependencies.resolveTarget({
          host: localConnect ? undefined : options.host, agent: "pi", controlPathRoot, signal, managedRuntime: true,
          ...(remoteDir ? { remoteDir } : {}),
          onProgress: phase => stage(localConnect
            ? { directory: "finding local server...", server: "starting or checking Pi server...", ssh: "finding local server...", forward: "connecting to local socket..." }[phase]
            : { ssh: "establishing SSH...", directory: "finding remote server...", server: "starting or checking Pi server...", forward: "opening SSH tunnel..." }[phase]),
          onUpgradeProgress: (phase, detail) => {
            if (phase === "deferred") deferredUpgrade = detail;
            stage(UPGRADE_STAGES[phase] ?? "checking matching server...");
          },
        });
        signal.throwIfAborted();
        stage("contacting Pi server...");
        try {
          pendingClient = await DaemonClient.connect(pendingTarget.socketPath, { signal, hello: { capabilities: [...NATIVE_RECONNECT_CAPABILITIES] } });
        } catch (error) {
          if (!localConnect) throw error;
          throw new Error(`Could not reach the local Pi server at ${pendingTarget.socketPath}: ${error instanceof Error ? error.message : String(error)}. Start it with the pi-better-server CLI or install the native runtime, then retry /remote connect localhost.`);
        }
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
    remoteDir = target.serverDir ?? remoteDir;
    endBrowse = bridge.beginBrowse();
    await rememberRemoteHost(options.host, remoteDir).catch((error) => ui.notify(`Could not remember remote host: ${error instanceof Error ? error.message : String(error)}`, "warning"));
    const notices: string[] = [];
    if (deferredUpgrade) {
      notices.push("Server update deferred; the current daemon and its sessions were left running.");
      const safe = client.server?.capabilities?.includes("safe-upgrade-v1");
      ui.notify(safe ? `Server update staged; activation is deferred. ${deferredUpgrade}`
        : `Server update staged. The current daemon cannot perform a verified automatic handoff and was left running. ${deferredUpgrade}`, safe ? "info" : "warning");
    }
    let connection = client;
    const targetLabel = isLocalHost(options.host) ? "local daemon" : `SSH: ${options.host}`;
    ui.setStatus("pi-remote", `${targetLabel} (sessions)`);
    if (!await syncPackages(connection, local, undefined, { scope: "global", host: options.host, onNotice: message => notices.push(message) })) return;
    let choice: Exclude<RemoteSessionChoice, { action: "transfer" }> | undefined;
    for (;;) {
      const selected = await chooseRemoteSession(connection, ui, options.host, { ...options, allowTransfer: !!local.localSession, notice: notices.join(" ") });
      if (!selected || selected.action !== "transfer") { choice = selected; break; }
      const transferChoice = await chooseConnectionTransfer(ui, selected.copy);
      if (!transferChoice || transferChoice === "browse") continue;
      const result = await runRemoteTransfer({
        direction: "push", host: options.host, remoteDir,
        copy: transferChoice.copy, includeWorkspace: transferChoice.includeWorkspace, cwd: selected.cwd,
      }, { ui, cwd: local.cwd, localSession: local.localSession, resolveTarget: local.dependencies.resolveTarget });
      if (!result) continue;
      choice = { action: "attach", cwd: result.cwd, sessionId: result.sessionId };
      break;
    }
    if (!choice) return;
    let cwd = choice.cwd;
    let sessionId = choice.action === "attach" ? choice.sessionId : "";
    const selectedChoice = choice;
    const opened = await showRemoteProgress(ui, options.host, choice.action === "create" ? "Starting remote session..." : "Opening remote session...", async (): Promise<RemoteClientSession> => {
      if (selectedChoice.action === "create") sessionId = (await connection.call({ type: "create_session", cwd })).sessionId as string;
      await connection.call({ type: "open_session", sessionId });
      return RemoteClientSession.connect(connection, sessionId, {
        reconnectAfterUpgrade: (notice, signal) => openUpgradeTransport(isLocalHost(options.host)
          ? { agent: "pi", managedRuntime: true, ...(remoteDir ? { remoteDir } : {}) }
          : { host: options.host, agent: "pi", controlPathRoot, managedRuntime: true, ...(remoteDir ? { remoteDir } : {}) },
        local.dependencies, signal, notice.buildId),
        onReconnected: replacement => {
          connection = replacement;
          void closeInitialTransport().catch(error => ui.notify(`Remote tunnel cleanup: ${String(error)}`, "warning"));
        },
        onUpgradeStatus: phase => ui.setStatus("pi-remote", phase === "ready"
          ? targetLabel : `${targetLabel} (${phase === "restarting" ? "server restarting" : "reconnecting"})`),
        onDisconnect: () => {
          ui.setStatus("pi-remote", `${targetLabel} (disconnected)`);
          ui.notify(`Disconnected from ${options.host}. Remote work has not been aborted. Use /remote disconnect to return locally, then reconnect.`, "warning");
        },
        localCommandCompletions: (prefix) => argumentCompletions(prefix, true),
        onLocalCommand: async (text) => {
          if (!/^\/remote(?:\s|$)/.test(text)) return false;
          const args = text.replace(/^\/remote(?:\s|$)/, "").trim();
          if (/^pull(?:\s|$)/.test(args)) {
            await pullAttachedSession(parseRemoteTransferArgs(args), {
              ui, cwd: local.cwd, resolveTarget: local.dependencies.resolveTarget,
              connected: { host: options.host, remoteDir, sessionId }, localSession: local.localSession,
            }, connection, remote, () => bridge.disconnect());
            return true;
          }
          if (args === "disconnect") { await bridge.disconnect(); return true; }
          const next = !args || args === "sessions"
            ? { host: options.host, remoteDir, cwd: undefined, sessionId: undefined }
            : await chooseRemoteConnection(args, ui);
          if (!next) return true;
          await bridge.disconnect();
          try { await connectHost(next, { ...local, localSession: undefined }); }
          catch (error) { ui.notify(error instanceof Error ? error.message : String(error), "error"); }
          return true;
        },
      });
    }, { cancellable: false });
    if (!opened) return;
    const remote = opened.value;
    try { cwd = checkedRemoteWorkspace(cwd, remote.sessionManager.getCwd()); }
    catch (error) { remote.dispose(); throw error; }
    const dispose = remote.dispose.bind(remote);
    remote.dispose = () => { dispose(); void closeInitialTransport().catch(() => undefined); };
    await bridge.attach(remote);
    endBrowse = undefined;
    attached = true;
    ui.setStatus("pi-remote", targetLabel);
    ui.notify(`Attached to ${options.host}:${cwd}. /remote opens the server's sessions; /remote disconnect returns locally.`, "info");
  } finally {
    try { endBrowse?.(); }
    finally { if (!attached) { await closeInitialTransport(); ui.setStatus("pi-remote", undefined); } }
  }
}

/** Pull from a native attachment while retaining the source connection identity. */
export async function pullAttachedSession(
  args: RemoteTransferArgs,
  frontend: TransferFrontend & { connected: NonNullable<TransferFrontend["connected"]> },
  connection: DaemonClient,
  remote: RemoteClientSession,
  disconnect: () => Promise<void>,
) {
  const connected = frontend.connected;
  const sameTarget = (args.host ?? connected.host) === connected.host &&
    (args.remoteDir === undefined || args.remoteDir === connected.remoteDir);
  // A copy's result.sessionId names the destination. Resolve and pin the source
  // before transfer so prefixes/names cannot accidentally identify the copy.
  const sourceId = sameTarget
    ? (await resolveSession(connection, args.sessionId ?? connected.sessionId)).sessionId
    : undefined;
  const attachedSource = sourceId === remote.sessionId;
  let result;
  try {
    result = await runRemoteTransfer(sourceId ? { ...args, sessionId: sourceId } : args, frontend);
  } catch (error) {
    if (attachedSource) {
      // Rollback (or a lost completion reply) may already have resumed the source.
      // Snapshot reads obey the daemon's ownership fence; never reopen it here.
      try { await remote.reconcileAfterTransfer(); }
      catch {
        const source = await resolveSession(connection, sourceId!).catch(() => undefined);
        if (source?.ownership === "moved") await disconnect().catch(() => undefined);
      }
    }
    throw error;
  }
  if (result?.direction === "pull" && result.host === connected.host && attachedSource) {
    if (result.copy) await remote.reconcileAfterTransfer();
    else if (result.sessionId === sourceId) await disconnect();
  }
  return result;
}

export async function syncPackages(
  client: DaemonClient, local: Pick<LocalFrontend, "cwd" | "ui">, cwd?: string,
  options: { scope?: "global"; host?: string; onNotice?: (message: string) => void } = {},
): Promise<boolean> {
  const { ui } = local;
  const notice = (message: string) => {
    if (options.onNotice) options.onNotice(message);
    else ui.notify(message, "warning");
  };
  const host = options.host ?? "Remote";
  const global = options.scope === "global";
  if (global && client.server && !client.server.capabilities?.includes("global-package-sync-v1")) {
    notice("Extension sync deferred: this daemon does not support safe host-level updates. Existing sessions were left running; continuing with installed extensions.");
    return true;
  }
  const target = global ? { scope: "global" } : { cwd };
  const catalogs = await showRemoteProgress(ui, host, global ? "Checking remote extensions..." : "Checking workspace extensions...", async () => ({
    localCatalog: await readLocalPackageCatalog(undefined, local.cwd),
    remote: (await client.call({ type: "client_packages", ...target })).data as PackageCatalog,
  }));
  if (!catalogs) return false;
  const { localCatalog, remote } = catalogs.value;
  const unsupported = [...new Set(localCatalog.unsupported)];
  if (unsupported.length) {
    const visible = unsupported.slice(0, 3).map(value => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100));
    notice(`Local-only resources are not synced: ${visible.join(", ")}${unsupported.length > visible.length ? ` (+${unsupported.length - visible.length} more)` : ""}.`);
  }
  const plan = planPackageSync(localCatalog.packages, remote.packages);
  const changes = [...plan.install];
  for (const conflict of plan.conflicts ?? []) {
    if (!changes.some((entry) => entry.source === conflict.local.source)) changes.push(conflict.local);
  }
  if (!changes.length) return true;
  const preview = [
    ...plan.install.map((entry) => `Install: ${JSON.stringify(entry)}`),
    ...(plan.conflicts ?? []).map((entry) => `Replace: ${JSON.stringify(entry.remote)}\nWith: ${JSON.stringify(entry.local)}`),
  ].join("\n\n");
  const targetLabel = global ? "Target: remote host global extensions" : `Target workspace: ${cwd}`;
  const approved = await ui.confirm("Sync remote extensions?", `${targetLabel}\n\n${preview}\n\nOnly these package declarations are synced. Credentials, provider settings, and local extension source are not copied. Remote-only packages are kept. Trusted project overrides must be managed on the remote host.`);
  if (!approved) return true;
  try {
    await showRemoteProgress(ui, host, "Installing approved remote extensions...", () => client.call({ type: "client_packages_install", ...target, packages: changes }), { cancellable: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const deferred = /^Close remote daemon sessions before updating extensions[;.]/.test(message)
      || /^Wait for remote (?:model|work|dialogs|activity observation)\b/.test(message)
      || /^Remote session (?:operations are already|maintenance is) in progress(?:[;. ]|$)/.test(message);
    if (!deferred) throw error;
    notice("Extension update deferred by the remote daemon. No sessions were closed; continuing with installed extensions. Retry when remote work is idle or after migrating the legacy daemon.");
  }
  return true;
}

export default function remoteClientExtension(pi: ExtensionAPI): void { registerRemoteClient(pi); }
