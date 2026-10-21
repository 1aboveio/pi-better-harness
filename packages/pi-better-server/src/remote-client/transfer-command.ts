import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { basename, isAbsolute, join } from "node:path";
import { DaemonClient } from "../client.ts";
import { detachSession, returnSession } from "../detach/detach.ts";
import type { LocalSessionInfo } from "../detach/local-source.ts";
import { assertLocalSessionTransferSafe, markLocalSessionDeparted } from "../detach/extension.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveTarget, type Target } from "../remote/target.ts";
import { resolveSession } from "../remote/sessions.ts";
import { chooseRemoteHost, availableRemoteHosts } from "./menu.ts";
import { rememberedServerDir, validRemoteHost } from "./profiles.ts";
import { parseArgs } from "node:util";
import { localBlockedReason, localStateDir } from "../detach/local-state.ts";
import { withConnectionProgress } from "./connection-progress.ts";
import { showRemoteProgress } from "./remote-progress.ts";

export interface RemoteTransferArgs {
  direction: "push" | "pull";
  host?: string;
  sessionId?: string;
  cwd?: string;
  remoteDir?: string;
  copy: boolean;
  includeWorkspace: boolean;
}

export function parseRemoteTransferArgs(text: string): RemoteTransferArgs {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const direction = words.shift();
  if (direction !== "pull") throw new Error("Use /remote connect to send the local session, or /remote pull to bring a session back");
  const { positionals, values } = parseArgs({ args: words, allowPositionals: true, options: {
    copy: { type: "boolean" }, "with-workspace": { type: "boolean" }, cwd: { type: "string" },
    session: { type: "string" }, "remote-dir": { type: "string" },
  } });
  if (positionals.length > 1) throw new Error("Use one SSH host; choose paths containing spaces in the destination dialog");
  const host = positionals[0];
  if (host && !validRemoteHost(host)) throw new Error("Enter one SSH host alias");
  if (values.cwd !== undefined && !isAbsolute(values.cwd)) throw new Error("--cwd must be an absolute destination path");
  if (values["remote-dir"] !== undefined && !values["remote-dir"].startsWith("/")) throw new Error("--remote-dir must be absolute");
  return { direction, host, copy: values.copy === true, includeWorkspace: values["with-workspace"] === true,
    ...(values.cwd ? { cwd: values.cwd } : {}), ...(values.session ? { sessionId: values.session } : {}),
    ...(values["remote-dir"] ? { remoteDir: values["remote-dir"] } : {}) };
}

export interface TransferFrontend {
  ui: ExtensionUIContext;
  cwd: string;
  /** Present only while the local executor owns the selected session. */
  localSession?: { info: LocalSessionInfo; manager: object; isBusy(): boolean; assertIdle?(): Promise<void>; pi: ExtensionAPI };
  /** Captured connection identity, never a destination directory. */
  connected?: { host: string; remoteDir?: string; sessionId: string };
  resolveTarget?: typeof resolveTarget;
  beforeTransfer?(client: DaemonClient, destination: string): Promise<void>;
}

export interface RemoteTransferOutcome {
  direction: "push" | "pull";
  copy: boolean;
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  host: string;
}

function line(value: string): string { return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }
const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Explicit user command: no transfer begins before the destination and scope are approved. */
export async function runRemoteTransfer(args: RemoteTransferArgs, frontend: TransferFrontend): Promise<RemoteTransferOutcome | undefined> {
  const { ui } = frontend;
  if (args.direction === "push") {
    if (!frontend.localSession || frontend.connected) throw new Error("Push starts from a local session. Use /remote disconnect first.");
    const local = frontend.localSession;
    assertLocalSessionTransferSafe(local.manager);
    await local.assertIdle?.();
    const blocked = localBlockedReason(localStateDir(), local.info.sessionId, local.info.sessionFile);
    if (blocked) throw new Error(blocked);
    if (local.isBusy()) throw new Error("Wait for local work to finish before transferring the session");
  }
  const host = args.host ?? frontend.connected?.host ?? await chooseRemoteHost(ui, await availableRemoteHosts());
  if (!host) return undefined;
  const remoteDir = args.remoteDir ?? (frontend.connected?.host === host ? frontend.connected.remoteDir : undefined) ?? await rememberedServerDir(host);
  let target: Target | undefined;
  let client: DaemonClient | undefined;
  let operationFailed = false;
  try {
    const setup = await withConnectionProgress(ui, host, async ({ signal, stage }) => {
      let pendingTarget: Target | undefined;
      let pendingClient: DaemonClient | undefined;
      try {
        stage("establishing SSH...");
        pendingTarget = await (frontend.resolveTarget ?? resolveTarget)({
          host, agent: "pi", signal, ...(remoteDir ? { remoteDir } : {}),
          onProgress: phase => stage({ ssh: "establishing SSH...", directory: "finding remote server...", server: "starting or checking Pi server...", forward: "opening SSH tunnel..." }[phase]),
        });
        signal.throwIfAborted();
        stage("contacting Pi server...");
        pendingClient = await DaemonClient.connect(pendingTarget.socketPath, { signal });
        signal.throwIfAborted();
        return { target: pendingTarget, client: pendingClient };
      } catch (error) {
        pendingClient?.close();
        await pendingTarget?.close().catch(() => undefined);
        throw error;
      }
    }, async late => { late.client.close(); await late.target.close(); });
    if (!setup) return undefined;
    target = setup.target;
    client = setup.client;
    const connection = client;
    const required = ["session-transfer-v1", "compressed-bundle-v1"];
    if (!required.every(capability => connection.server?.capabilities?.includes(capability))) {
      throw new Error("Update pi-better-server on the remote host for compressed push/pull. No session was transferred.");
    }
    let source: LocalSessionInfo;
    if (args.direction === "push") source = frontend.localSession!.info;
    else {
      let ref = args.sessionId ?? (frontend.connected?.host === host ? frontend.connected.sessionId : undefined);
      if (!ref) {
        const loaded = await showRemoteProgress(ui, host, "Loading remote sessions...", () => connection.call({ type: "list_sessions" }));
        if (!loaded) return undefined;
        const listed = loaded.value.data.sessions as Array<{ sessionId: string; name?: string; cwd: string; ownership?: string }>;
        const available = listed.filter(session => !session.ownership);
        if (!available.length) throw new Error(`No transferable sessions on ${host}`);
        const labels = available.map(session => `${line(session.name || "Untitled session")}  ${session.sessionId}  ${line(session.cwd)}`);
        const selected = await ui.select(`Pull from ${host}`, labels);
        if (selected === undefined) return undefined;
        ref = available[labels.indexOf(selected)]?.sessionId;
        if (!ref) throw new Error("Unknown remote session selection");
      }
      const resolved = await showRemoteProgress(ui, host, "Resolving remote session...", () => resolveSession(connection, ref));
      if (!resolved) return undefined;
      const selected = resolved.value;
      source = { sessionId: selected.sessionId, cwd: selected.cwd, sessionFile: selected.sessionFile, name: selected.name, model: selected.model, createdAt: selected.createdAt };
    }
    let defaultCwd = frontend.cwd;
    if (args.direction === "push" && args.cwd === undefined) {
      const loaded = await showRemoteProgress(ui, host, "Finding remote workspace...", () => connection.call({ type: "client_workspaces" }));
      if (!loaded) return undefined;
      const root: unknown = loaded.value.data.root;
      if (typeof root !== "string" || !root.startsWith("/")) throw new Error("Invalid remote workspace root");
      defaultCwd = root;
    }
    if (args.includeWorkspace) defaultCwd = join(defaultCwd, `${basename(source.cwd)}-${source.sessionId.slice(0, 8)}-${args.copy ? "copy" : "transferred"}`);
    const cwd = args.cwd ?? await ui.input(args.direction === "push" ? "Remote destination folder" : "Local destination folder", defaultCwd);
    if (cwd === undefined) return undefined;
    if (!cwd || !isAbsolute(cwd)) throw new Error("Destination must be an absolute path");
    const mode = args.copy ? "Copy / fork" : "Move / handoff";
    const sourceLabel = args.direction === "push" ? "local" : host;
    const destinationLabel = args.direction === "push" ? host : "local";
    const approved = await ui.confirm(`${mode} session?`, [
      `Session: ${line(source.name || source.sessionId)}`,
      `From: ${sourceLabel}:${line(source.cwd)}`,
      `To: ${destinationLabel}:${line(cwd)}`,
      args.includeWorkspace ? "Scope: conversation and workspace files; destination must be new or empty." : "Scope: conversation only; destination folder must exist. Project files are not changed.",
      "Compression: gzip. Conversation history is not compacted.",
      args.copy ? "A new session ID is created. Both conversations remain independent." : "The source is paused during transfer and stays read-only after the destination acknowledges ownership.",
      "Credentials and machine settings are not transferred. Conversation text may contain sensitive information.",
    ].join("\n"));
    if (!approved) return undefined;
    if (args.direction === "push") {
      await frontend.beforeTransfer?.(connection, cwd);
      await frontend.localSession!.assertIdle?.();
    }
    const shared = { toCwd: cwd, copy: args.copy, includeWorkspace: args.includeWorkspace, compression: "gzip" as const,
      onProgress: (message: string) => ui.notify(message, "info"), connect: async () => connection, host };
    const transferred = await showRemoteProgress(ui, host, "Transferring conversation...", () => args.direction === "push"
      ? detachSession({ ...shared, session: source, isBusy: frontend.localSession!.isBusy })
      : returnSession({ ...shared, ref: source.sessionId,
        ...(frontend.localSession?.info.sessionFile ? { sessionFiles: [frontend.localSession.info.sessionFile] } : {}) }),
    { cancellable: false });
    if (!transferred) return undefined;
    const result = transferred.value;
    if (args.direction === "push" && !args.copy) markLocalSessionDeparted(frontend.localSession!.pi, source.sessionId, frontend.localSession!.manager);
    const follow = args.direction === "push"
      ? `/remote connect ${host} --session ${result.sessionId}${remoteDir ? ` --remote-dir ${remoteDir}` : ""}`
      : "sessionFile" in result && typeof result.sessionFile === "string" ? `pi --session ${shellWord(result.sessionFile)}` : "pi --resume";
    ui.notify(`${args.copy ? "Copied" : "Moved"} session to ${destinationLabel}:${result.cwd}.\n${follow}\n${args.copy ? "The source remains available; changes do not merge automatically." : "The source will not run this session again. Resume at the destination."}`, "info");
    return { direction: args.direction, copy: args.copy, host, sessionId: result.sessionId, cwd: result.cwd,
      ...("sessionFile" in result && result.sessionFile ? { sessionFile: result.sessionFile } : {}) };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    client?.close();
    if (operationFailed) await target?.close().catch(() => undefined);
    else await target?.close();
  }
}