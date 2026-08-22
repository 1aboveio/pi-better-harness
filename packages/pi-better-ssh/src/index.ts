import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSshMuxRegistry } from "./mux-registry.js";
import type { SshMuxEntryMap, SshMuxRegistry } from "./mux-registry.js";
import { createProcessRemoteRunner } from "./process-runner.js";
import {
  createSshProfile,
  formatSshProfileChip,
  listSshHostAliases,
  profileStateEntry,
  restoreSshProfile,
  SSH_PROFILE_ENTRY_TYPE,
} from "./profile.js";
import type { SshProfile } from "./profile.js";
import { executeRemoteBash, resolveRemoteBashConnection } from "./remote-bash.js";
import type { RemoteBashDependencies, RemoteBashResult } from "./remote-bash.js";
import { resolveSshCommand } from "./shared-ssh-core/index.js";

const STATUS_KEY = "pi-better-ssh";

const RemoteBashParams = Type.Object({
  command: Type.String({ description: "Bash command string to execute remotely." }),
  host: Type.Optional(Type.String({ description: "SSH Host alias or user@host target. Optional when an active SSH profile supplies the host." })),
  workdir: Type.Optional(Type.String({ description: "Remote working directory applied before the command." })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout). Cancels only this SSH slave command." })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Remote environment variables exported before the command." })),
  user: Type.Optional(Type.String({ description: "Structured SSH user override." })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535, description: "Structured SSH port override." })),
  identity_file: Type.Optional(Type.String({ description: "Structured SSH identity file path." })),
  jump: Type.Optional(Type.String({ description: "Structured SSH jump host passed with -J." })),
  options: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional SSH -o key/value options. Callers cannot disable required BatchMode, connect-timeout, no-TTY, or mux safety options." })),
});

const SshMuxParams = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("stop")]),
  all: Type.Optional(Type.Boolean({ description: "Apply to every ControlMaster known in this Pi process for the current session." })),
  host: Type.Optional(Type.String({ description: "SSH Host alias or user@host target. Defaults to the active profile." })),
  user: Type.Optional(Type.String({ description: "Structured SSH user override." })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
  identity_file: Type.Optional(Type.String()),
  jump: Type.Optional(Type.String()),
  options: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const SshProfileParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("use"),
    Type.Literal("status"),
    Type.Literal("clear"),
  ]),
  host: Type.Optional(Type.String({ description: "SSH config Host alias or user@host. Required for use." })),
  workdir: Type.Optional(Type.String({ description: "Default remote working directory." })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Default remote environment variables." })),
});

export interface RegisterRemoteBashDependencies {
  runner: RemoteBashDependencies["runner"];
  controlPathRoot?: string;
  getActiveProfile?: () => SshProfile | undefined;
  muxRegistry?: SshMuxRegistry;
  onResult?: (result: RemoteBashResult, params: { host?: string }, ctx: ExtensionContext) => void | Promise<void>;
}

export interface RegisterSshExtensionDependencies extends RegisterRemoteBashDependencies {
  sshConfigPath?: string;
  muxEntries?: SshMuxEntryMap;
}

export function registerRemoteBashTool(pi: ExtensionAPI, dependencies: RegisterRemoteBashDependencies): void {
  pi.registerTool({
    name: "remote_bash",
    label: "Remote Bash",
    description: `Run one short remote bash command synchronously over a reusable SSH ControlMaster. Pass an SSH Host alias or user@host, or omit host when an active SSH profile supplies it; optional workdir, env, timeout, and structured identity fields are supported. Required SSH safety options cannot be disabled. Returns remote output and exitCode without turning a non-zero remote exit into a tool failure. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first), with full output saved locally. For long-running remote work, use bg_task_spawn (or bg_task_* lifecycle tools) with structured ssh instead. Pi's built-in bash remains local.`,
    promptSnippet: "Run a short synchronous remote command through safe reusable SSH",
    promptGuidelines: [
      "Use remote_bash for short synchronous remote commands instead of writing ssh commands inside local bash.",
      "Use bg_task_spawn with structured ssh for long-running or durable remote work instead of remote_bash.",
    ],
    parameters: RemoteBashParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionScope = ctx.sessionManager.getSessionId();
      const activeProfile = dependencies.getActiveProfile?.();
      const result = await executeRemoteBash(params, {
        runner: dependencies.runner,
        sessionScope,
        ...(dependencies.controlPathRoot ? { controlPathRoot: dependencies.controlPathRoot } : {}),
        ...(activeProfile ? { activeProfile } : {}),
        ...(dependencies.muxRegistry ? { muxRegistry: dependencies.muxRegistry } : {}),
      }, signal);
      await dependencies.onResult?.(result, params, ctx);
      return {
        content: [{ type: "text" as const, text: formatToolResult(result, params.timeout) }],
        details: result,
      };
    },
  });
}

export function registerSshExtension(pi: ExtensionAPI, dependencies: RegisterSshExtensionDependencies): void {
  let activeProfile: SshProfile | undefined;
  const muxRegistry = dependencies.muxRegistry ?? createSshMuxRegistry({
    runner: dependencies.runner,
    ...(dependencies.controlPathRoot ? { controlPathRoot: dependencies.controlPathRoot } : {}),
    ...(dependencies.muxEntries ? { entries: dependencies.muxEntries } : {}),
  });

  registerRemoteBashTool(pi, {
    ...dependencies,
    muxRegistry,
    getActiveProfile: () => activeProfile,
    onResult: (result, params, ctx) => {
      if (activeProfile && params.host === undefined) {
        setFooter(ctx, activeProfile, result.mux.state);
      }
    },
  });

  const resolveMuxTarget = (params: {
    host?: string;
    user?: string;
    port?: number;
    identity_file?: string;
    jump?: string;
    options?: Record<string, string>;
  }) => {
    const host = params.host ?? activeProfile?.host;
    if (!host) {
      throw new Error("ssh_mux requires host (an SSH Host alias or user@host) or an active SSH profile");
    }
    const ssh = resolveRemoteBashConnection({
      command: "true",
      host,
      ...(params.user !== undefined ? { user: params.user } : {}),
      ...(params.port !== undefined ? { port: params.port } : {}),
      ...(params.identity_file !== undefined ? { identity_file: params.identity_file } : {}),
      ...(params.jump !== undefined ? { jump: params.jump } : {}),
      ...(params.options !== undefined ? { options: params.options } : {}),
    });
    return resolveSshCommand({ command: "true", ssh });
  };

  const queryMux = async (profile: SshProfile, sessionScope: string) => {
    try {
      const status = await muxRegistry.statusTarget(resolveMuxTarget({ host: profile.host }), sessionScope);
      return { state: status.state, target: status.target, detail: status.detail };
    } catch (error) {
      return {
        state: "down" as const,
        target: profile.host,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const setFooter = (ctx: ExtensionContext, profile: SshProfile | undefined, muxState?: "up" | "down"): void => {
    try {
      ctx.ui.setStatus(STATUS_KEY, profile ? formatSshProfileChip(profile, muxState ?? "down") : undefined);
    } catch {
      // Footer status is best-effort in non-interactive and partial harness contexts.
    }
  };

  const refreshFooter = async (ctx: ExtensionContext) => {
    if (!activeProfile) {
      setFooter(ctx, undefined);
      return undefined;
    }
    const mux = await queryMux(activeProfile, ctx.sessionManager.getSessionId());
    setFooter(ctx, activeProfile, mux.state);
    return mux;
  };

  pi.registerTool({
    name: "ssh_profile",
    label: "SSH Profile",
    description: "List SSH config Host aliases and manage the active session default host, workdir, and environment. Profile state is stored in the Pi session and survives /reload; it does not create a separate host inventory.",
    promptSnippet: "List or manage the active SSH default profile",
    parameters: SshProfileParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "list") {
        const aliases = listSshHostAliases(dependencies.sshConfigPath);
        const details = { action: "list" as const, aliases, active: activeProfile ?? null };
        return { content: [{ type: "text" as const, text: formatProfileList(aliases, activeProfile) }], details };
      }
      if (params.action === "use") {
        const aliases = listSshHostAliases(dependencies.sshConfigPath);
        activeProfile = createSshProfile(params, aliases, dependencies.sshConfigPath);
        pi.appendEntry(SSH_PROFILE_ENTRY_TYPE, profileStateEntry(activeProfile));
        const mux = await refreshFooter(ctx);
        const details = { action: "use" as const, active: activeProfile, mux };
        return { content: [{ type: "text" as const, text: `Active SSH profile: ${formatSshProfileChip(activeProfile, mux?.state ?? "down")}` }], details };
      }
      if (params.action === "clear") {
        activeProfile = undefined;
        pi.appendEntry(SSH_PROFILE_ENTRY_TYPE, profileStateEntry(undefined));
        setFooter(ctx, undefined);
        const details = { action: "clear" as const, active: null };
        return { content: [{ type: "text" as const, text: "Active SSH profile cleared." }], details };
      }

      const mux = activeProfile ? await refreshFooter(ctx) : undefined;
      const details = { action: "status" as const, active: activeProfile ?? null, ...(mux ? { mux } : {}) };
      return {
        content: [{
          type: "text" as const,
          text: activeProfile
            ? formatSshProfileChip(activeProfile, mux?.state ?? "down")
            : "No active SSH profile.",
        }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "ssh_mux",
    label: "SSH Mux",
    description: "Inspect or stop the SSH ControlMaster for one target, the active profile, or all masters observed in this Pi process for the current session.",
    promptSnippet: "Inspect or stop reusable SSH ControlMaster connections",
    parameters: SshMuxParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const identityFields = [params.host, params.user, params.port, params.identity_file, params.jump, params.options];
      if (params.all && identityFields.some((value) => value !== undefined)) {
        throw new Error("ssh_mux all cannot be combined with target identity fields");
      }
      const sessionScope = ctx.sessionManager.getSessionId();
      if (params.all) {
        const results = params.action === "status"
          ? await muxRegistry.statusAll(sessionScope)
          : await muxRegistry.stopAll(sessionScope);
        const masters = results.map(muxResultDetails);
        if (activeProfile) {
          const activeTarget = resolveMuxTarget({ host: activeProfile.host }).identity.target;
          const activeMux = masters.find((master) => master.target === activeTarget);
          if (params.action === "stop") setFooter(ctx, activeProfile, "down");
          else if (activeMux) setFooter(ctx, activeProfile, activeMux.state === "up" ? "up" : "down");
        }
        const details = { action: params.action, scope: "all" as const, masters };
        return { content: [{ type: "text" as const, text: formatMuxResults(masters) }], details };
      }

      const resolved = resolveMuxTarget(params);
      const result = params.action === "status"
        ? await muxRegistry.statusTarget(resolved, sessionScope)
        : await muxRegistry.stopTarget(resolved, sessionScope);
      const masters = [muxResultDetails(result)];
      if (activeProfile) {
        const activeTarget = resolveMuxTarget({ host: activeProfile.host }).identity.target;
        if (resolved.identity.target === activeTarget) {
          setFooter(ctx, activeProfile, result.state === "up" ? "up" : "down");
        }
      }
      const details = { action: params.action, scope: "target" as const, masters };
      return { content: [{ type: "text" as const, text: formatMuxResults(masters) }], details };
    },
  });

  const restore = async (ctx: ExtensionContext): Promise<void> => {
    activeProfile = restoreSshProfile(ctx.sessionManager.getBranch());
    await refreshFooter(ctx);
  };
  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async (_event, ctx) => setFooter(ctx, undefined));
}

export default function sshExtension(pi: ExtensionAPI): void {
  registerSshExtension(pi, { runner: createProcessRemoteRunner() });
}

function formatProfileList(aliases: string[], active: SshProfile | undefined): string {
  const lines = aliases.length > 0
    ? aliases.map((alias) => `${active?.host === alias ? "*" : "-"} ${alias}`)
    : ["(no literal Host aliases found in ~/.ssh/config)"];
  if (active && !aliases.includes(active.host)) lines.unshift(`* ${active.host} (active user@host profile)`);
  return lines.join("\n");
}

function muxResultDetails(result: { state: string; target: string; controlPath: string; detail: string }) {
  return {
    target: result.target,
    state: result.state,
    controlPath: result.controlPath,
    detail: result.detail,
  };
}

function formatMuxResults(results: Array<{ target: string; state: string; detail: string }>): string {
  if (results.length === 0) return "No SSH ControlMasters are known for this session.";
  return results.map((result) => `${result.target}: mux ${result.state} - ${result.detail}`).join("\n");
}

function formatToolResult(result: RemoteBashResult, timeoutSeconds?: number): string {
  let text = result.output || "(no output)";
  if (result.truncated && result.truncation && result.fullOutputPath) {
    const startLine = result.truncation.totalLines - result.truncation.outputLines + 1;
    const endLine = result.truncation.totalLines;
    text += result.truncation.truncatedBy === "lines"
      ? `\n\n[Showing lines ${startLine}-${endLine} of ${result.truncation.totalLines}. Full output: ${result.fullOutputPath}]`
      : `\n\n[Showing lines ${startLine}-${endLine} of ${result.truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${result.fullOutputPath}]`;
  }
  if (result.timedOut) return `${text}\n\nCommand timed out after ${timeoutSeconds} seconds`;
  if (result.cancelled) return `${text}\n\nCommand cancelled`;
  if (result.exitCode !== 0 && result.exitCode !== undefined) {
    return `${text}\n\nCommand exited with code ${result.exitCode}`;
  }
  return text;
}
