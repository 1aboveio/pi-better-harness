/**
 * Background launch sandbox policy. New publishers provide a separate Background
 * tasks profile; older publishers retain the historical Main-policy behavior.
 * Every task keeps its policy snapshot for its whole lifetime.
 *
 * `pi-better-sandbox` owns the foreground policy and publishes an immutable
 * snapshot of it on `pi.events`. This module is the consumer side of that wire
 * contract: it mirrors the latest snapshot, and turns it into a confined
 * command at the moment a local task launches.
 *
 * Two rules make the behaviour predictable:
 *
 * 1. **Snapshot at launch, never a live reference.** The wrapped executable and
 *    argv are resolved once, when the task starts, and are what the task keeps
 *    running. A later `/sandbox off` or deny-rule change therefore reaches only
 *    tasks launched after it.
 * 2. **Opt-in, then fail closed.** `inactive` and explicitly `disabled` states
 *    launch unconfined. Once foreground policy says confinement applies, a
 *    missing or unusable backend blocks the launch and is never retried
 *    unconfined behind the operator's back.
 *
 * The contract is duplicated here rather than imported: `pi-better-sandbox` is
 * an optional peer that this package must keep working without. Two channel
 * names and a payload shape are the entire coupling, and both packages own
 * tests that pin them.
 */

import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";

import { commandExecution } from "./process.js";
import { baseDir } from "./registry.js";
import { compileWritePolicy, describeSandboxSupport, directApplicationTarget, maybeBuildSandboxCommand, type SandboxSeams } from "./shared-sandbox-core.js";

type SandboxPermissions = {
  /** `write` = read, create and overwrite in place; `read-write` = Write & delete. */
  projectFiles: "off" | "read" | "write" | "read-write";
  outsideProject: "off" | "read" | "write" | "read-write";
  storedCredentials: "off" | "read" | "read-write";
  /** Master switch for command execution. */
  commands: boolean;
  network: boolean;
  /**
   * Optional refinement of `commands`: may a launch command be interpreted by a
   * shell? Absent means yes (the historical behavior). Off confines a launch to
   * a direct executable through `shell: false` argv.
   */
  shell?: boolean;
  /**
   * Optional outer cap for one launch command, in seconds. Absent or null means
   * no cap. A value is validated here and copied into the immutable launch
   * snapshot; it caps each actual command, never a watch's whole lifetime.
   */
  commandTimeoutSeconds?: number | null;
};
import type { CommandSpec, TaskSandboxProvenance } from "./types.js";
import { SandboxDiagnostics, diagnosticPackageVersion, type DiagnosticResource } from "./shared-sandbox-diagnostics.js";

function backgroundDiagnostics(policy: unknown): SandboxDiagnostics | undefined {
  try {
    return new SandboxDiagnostics({ context: "background",
      version: diagnosticPackageVersion(new URL("../package.json", import.meta.url)),
      policy: () => policy,
      backend: () => { const support = describeSandboxSupport(); return support.supported ? support.backend : undefined; },
      onError: () => { console.error("Sandbox diagnostics collection gap; enforcement unchanged."); },
    });
  } catch { return undefined; }
}

/**
 * What an operator can do about a missing backend here.
 *
 * A background task inherits the session's foreground policy, so its remedy is
 * the session's: the slash command. `sandbox:false` is the subagent tool's
 * opt-out and means nothing on this surface. The text is duplicated rather than
 * imported for the same reason the rest of this contract is — `pi-better-sandbox`
 * is an optional peer.
 */
export const FOREGROUND_SANDBOX_REMEDY =
  "Change the controlling Sandbox column in /sandbox, or work in a session that has a backend.";

/** Channel `pi-better-sandbox` publishes every effective-policy change on. */
export const FOREGROUND_SANDBOX_POLICY_CHANNEL = "pi-better-sandbox:policy";

/** Channel a consumer emits on to ask for the current policy. */
export const FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL = "pi-better-sandbox:policy-request";

/** Largest single-command cap a timer can hold: 2_147_483 seconds is 2_147_483_000 ms. */
export const MAX_COMMAND_TIMEOUT_SECONDS = 2_147_483;

/** A positive finite number of seconds no larger than {@link MAX_COMMAND_TIMEOUT_SECONDS}. */
export function isCommandTimeoutSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_COMMAND_TIMEOUT_SECONDS;
}

/** Executables whose whole purpose is to interpret a shell command string. */
const SHELL_EXECUTABLES = Object.freeze([
  "sh", "bash", "zsh", "dash", "ksh", "ksh93", "mksh", "pdksh", "ash", "csh", "tcsh", "fish",
  "yash", "posh", "rbash", "busybox", "pwsh", "powershell", "cmd",
] as const);
const SHELL_NAMES = new Set<string>(SHELL_EXECUTABLES);

function shellExecutableName(path: string): boolean {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  const stem = name.endsWith(".exe") ? name.slice(0, -4) : name;
  return name.length > 0 && (SHELL_NAMES.has(name) || SHELL_NAMES.has(stem));
}

/**
 * Resolve an executable the way spawn will: a relative or bare name against the
 * launch cwd, and a bare name through the launch's PATH. A relative PATH entry
 * is itself resolved against the launch cwd, because the child changes directory
 * before it searches PATH.
 *
 * The candidate must be a regular file this process may execute, so a
 * non-executable shadow earlier on PATH does not stand in for the real target.
 */
function resolvedExecutablePath(executable: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const value = String(executable ?? "");
  if (value.includes("/") || (process.platform === "win32" && value.includes("\\"))) {
    return resolve(cwd, value);
  }
  const path = env.PATH ?? env.Path;
  if (!path) return undefined;
  for (const directory of path.split(delimiter)) {
    const candidate = resolve(cwd, directory || ".", value);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* A PATH entry may vanish, or not be executable. */ }
  }
  return undefined;
}

let shellIdentities: { path: string | undefined; cwd: string; ids: Set<string> } | undefined;

/**
 * Device/inode identities of the known shell binaries on this launch's PATH.
 *
 * A hardlink to a shell can carry any name, so a name check and a symlink's
 * canonical target cannot see it. This mirrors the confined executor's identity
 * check (`task-sandbox/exec.ts`), resolved against the launch cwd and PATH.
 */
function knownShellIdentities(env: NodeJS.ProcessEnv, cwd: string): Set<string> {
  const path = env.PATH ?? env.Path;
  const cached = shellIdentities;
  if (cached && cached.path === path && cached.cwd === cwd) return cached.ids;
  const ids = new Set<string>();
  for (const directory of (path ?? "").split(delimiter)) {
    for (const name of SHELL_EXECUTABLES) {
      try {
        const info = statSync(resolve(cwd, directory || ".", name), { bigint: true });
        if (info.isFile()) ids.add(`${info.dev}:${info.ino}`);
      } catch { /* Not present in this directory. */ }
    }
  }
  shellIdentities = { path, cwd, ids };
  return ids;
}

/**
 * True when `argv[0]` names a shell interpreter directly.
 *
 * With Shell scripts Off, a `shell: false` argv is still a way to ask a shell to
 * run a command (`["/bin/bash", "-c", ...]`). The requested name is checked
 * first, then the executable spawn would resolve against `cwd` and the launch's
 * PATH, then its canonical target, so a symlink or an alternate name pointing at
 * a shell is still refused. A hardlink to a shell is refused by inode identity.
 * Only a direct interpreter is refused: an application that happens to launch a
 * shell itself is a different capability from asking Pi to interpret a command.
 */
export function isShellExecutable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): boolean {
  if (shellExecutableName(executable)) return true;
  const resolved = resolvedExecutablePath(String(executable ?? ""), env, cwd);
  if (!resolved) return false;
  let canonical: string;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    return false;
  }
  if (shellExecutableName(canonical)) return true;
  try {
    const info = statSync(canonical, { bigint: true });
    if (knownShellIdentities(env, cwd).has(`${info.dev}:${info.ino}`)) return true;
  } catch { /* A missing file fails when the launch runs it. */ }
  return false;
}

/**
 * What the foreground sandbox is doing right now.
 *
 * - `inactive`    - default-off foreground policy; launch tasks as before.
 * - `enabled`     - confine locally launched tasks.
 * - `disabled`    - a human switched protection off; launch tasks as before.
 * - `unavailable` - no backend on this platform; block protected launches.
 * - `failed`      - protection cannot be applied here; block protected launches.
 */
export type ForegroundSandboxState = "inactive" | "enabled" | "disabled" | "unavailable" | "failed";

/** The published snapshot, narrowed to the fields a task launch needs. */
export interface ForegroundSandboxPolicy {
  readonly state: ForegroundSandboxState;
  /** The only writable subtree while `state` is `enabled`. */
  readonly writableRoot?: string | undefined;
  /** Canonical paths that stay non-writable inside the writable root. */
  readonly denyWrite: readonly string[];
  /** Human-readable evidence for why `state` is what it is. */
  readonly reason: string;
  readonly permissions?: Readonly<SandboxPermissions & { enabled: boolean }>;
  readonly policySource?: "background" | "main-legacy";
}

/** The minimum `pi.events` surface this module uses. */
export interface PolicyEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): unknown;
}

/** Thrown instead of launching a local task the foreground policy forbids. */
export class ForegroundSandboxBlockedError extends Error {
  readonly policy: ForegroundSandboxPolicy;

  constructor(policy: ForegroundSandboxPolicy, detail?: string) {
    super(
      `${policy.policySource === "background" ? "Background tasks" : "Foreground"} sandbox is ${policy.state}; this local background task was blocked rather than launched unconfined. ${detail ?? policy.reason}`,
    );
    this.name = "ForegroundSandboxBlockedError";
    this.policy = policy;
  }
}

/** How one local launch should be confined. Resolved before any task state exists. */
export type ForegroundSandboxPlan =
  | { readonly confined: false }
  | {
      readonly confined: true;
      readonly writableRoot: string;
      readonly denyWrite: readonly string[];
      readonly permissions?: SandboxPermissions;
    };

const UNCONFINED: ForegroundSandboxPlan = { confined: false };
const launchPolicies = new WeakMap<ForegroundSandboxPlan, ForegroundSandboxPolicy | undefined>();
function capturePlan(plan: ForegroundSandboxPlan, policy: ForegroundSandboxPolicy | undefined): ForegroundSandboxPlan {
  const snapshot = { ...plan };
  launchPolicies.set(snapshot, policy);
  return snapshot;
}

const VALID_STATES = new Set<string>(["inactive", "enabled", "disabled", "unavailable", "failed"]);

/**
 * The latest snapshot per event bus.
 *
 * Keyed by the bus rather than kept in one module variable so that separate Pi
 * sessions inside one process (and separate tests) cannot read each other's
 * policy.
 */
type PolicyMirror = { policy: ForegroundSandboxPolicy | undefined; error?: Error; processAccess?: "off" | "read"; mainConfined?: boolean };
const mirrors = new WeakMap<PolicyEventBus, PolicyMirror>();

function eventBusOf(pi: unknown): PolicyEventBus | undefined {
  const events = (pi as { events?: unknown } | undefined)?.events;
  if (!events || typeof events !== "object") return undefined;
  const candidate = events as Partial<PolicyEventBus>;
  if (typeof candidate.on !== "function" || typeof candidate.emit !== "function") return undefined;
  return candidate as PolicyEventBus;
}

/**
 * Accept a published payload only when it carries a state this module
 * understands, so an unrelated extension emitting on the channel cannot clear a
 * real policy or invent one.
 */
function readPolicy(data: unknown, profile = "Main"): ForegroundSandboxPolicy | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  if (typeof value.state !== "string" || !VALID_STATES.has(value.state)) return undefined;
  const writableRoot = typeof value.writableRoot === "string" ? value.writableRoot : undefined;
  const denyWrite = Array.isArray(value.denyWrite)
    ? value.denyWrite.filter((entry): entry is string => typeof entry === "string")
    : [];
  const permissions = value.permissions === undefined ? undefined : readPermissions(value.permissions);
  if (value.permissions !== undefined && !permissions) {
    throw new Error(`Invalid ${profile} sandbox permission profile; update permissions in the sandbox UI.`);
  }
  return {
    state: value.state as ForegroundSandboxState,
    writableRoot,
    denyWrite: Object.freeze([...denyWrite]),
    reason: typeof value.reason === "string" ? value.reason : "No reason was published.",
    ...(permissions ? { permissions } : {}),
  };
}

function readPermissions(value: unknown): ForegroundSandboxPolicy["permissions"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const credential = (v: unknown) => v === "off" || v === "read" || v === "read-write";
  const access = (v: unknown) => credential(v) || v === "write";
  if (typeof p.enabled !== "boolean" || typeof p.commands !== "boolean" ||
      typeof p.network !== "boolean" || !access(p.projectFiles) ||
      !access(p.outsideProject) || !credential(p.storedCredentials) ||
      (p.processAccess !== undefined && p.processAccess !== "off" && p.processAccess !== "read") ||
      (p.shell !== undefined && typeof p.shell !== "boolean") ||
      (p.commandTimeoutSeconds !== undefined && p.commandTimeoutSeconds !== null &&
        !isCommandTimeoutSeconds(p.commandTimeoutSeconds))) return undefined;
  // Copy only what the publisher sent: absent optional settings keep their
  // documented default meaning instead of being invented here.
  return Object.freeze({
    enabled: p.enabled, commands: p.commands, network: p.network,
    projectFiles: p.projectFiles as SandboxPermissions["projectFiles"],
    outsideProject: p.outsideProject as SandboxPermissions["outsideProject"],
    storedCredentials: p.storedCredentials as SandboxPermissions["storedCredentials"],
    ...(p.shell === undefined ? {} : { shell: p.shell as boolean }),
    ...(p.commandTimeoutSeconds === undefined ? {} : { commandTimeoutSeconds: p.commandTimeoutSeconds as number | null }),
  });
}

/**
 * Start mirroring foreground policy on this session's event bus.
 *
 * Idempotent, and safe in either extension load order. If `pi-better-sandbox`
 * loaded first, its last publication is already gone (the bus has no replay), so
 * we ask for a fresh one on the request channel. If it loads later, its own
 * session-start publication reaches the subscription registered here.
 */
export function observeForegroundSandboxPolicy(pi: unknown): void {
  const events = eventBusOf(pi);
  if (!events || mirrors.has(events)) return;

  const mirror: PolicyMirror = { policy: undefined };
  mirrors.set(events, mirror);
  events.on(FOREGROUND_SANDBOX_POLICY_CHANNEL, (data) => {
    try {
      const published = data && typeof data === "object" ? data as Record<string, unknown> : undefined;
      const hasBackground = published && Object.hasOwn(published, "background");
      const policy = readPolicy(hasBackground ? published.background : data, hasBackground ? "Background tasks" : "Main");
      if (hasBackground && !policy) throw new Error("Invalid Background tasks sandbox policy; update permissions in /sandbox.");
      const access = (value: unknown): unknown => {
        if (!value || typeof value !== "object") return undefined;
        return (value as { permissions?: { processAccess?: unknown } }).permissions?.processAccess;
      };
      mirror.mainConfined = published?.state !== "disabled" && published?.state !== "inactive";
      mirror.processAccess = access(data) === "read" && access(hasBackground ? published.background : data) === "read" ? "read" : "off";
      if (policy) Object.assign(policy, { policySource: hasBackground ? "background" : "main-legacy" });
      if (policy) { mirror.policy = policy; mirror.error = undefined; }
    } catch (error) {
      mirror.error = error as Error;
      mirror.processAccess = "off";
    }
  });
  events.emit(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, undefined);
}

/**
 * The foreground policy as of right now, or `undefined` when no sandbox
 * extension is publishing one.
 *
 * Asks for a re-publication first. Pi's event bus dispatches synchronously, so
 * the answer to that request has already been mirrored by the time this
 * returns; if a future bus were to defer, the last published snapshot is still
 * returned rather than nothing.
 */
export function currentForegroundSandboxPolicy(pi: unknown): ForegroundSandboxPolicy | undefined {
  observeForegroundSandboxPolicy(pi);
  const events = eventBusOf(pi);
  if (!events) return undefined;
  events.emit(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, undefined);
  const mirror = mirrors.get(events);
  if (mirror?.error) throw mirror.error;
  return mirror?.policy;
}

/** Current diagnostics permissions are independent of the task's launch snapshot. */
export function backgroundProcessDiagnosticsAccess(pi: unknown): "read" | "off" | "unknown" | "confined" {
  try { currentForegroundSandboxPolicy(pi); } catch { return "off"; }
  const events = eventBusOf(pi);
  const mirror = events ? mirrors.get(events) : undefined;
  const access = mirror?.processAccess ?? "unknown";
  return access === "read" && mirror?.mainConfined ? "confined" : access;
}

export function sandboxProvenance(plan: ForegroundSandboxPlan, remote = false): TaskSandboxProvenance {
  const policy = launchPolicies.get(plan);
  const policySource = remote ? "remote" : policy?.policySource ?? (policy ? "main-legacy" : "no-publisher");
  if (remote) return { confinement: "unknown", policySource, policySummary: "Remote execution; local sandbox does not establish remote confinement.", changesAffectTask: false };
  if (!plan.confined) return { confinement: "unconfined", policySource,
    policySummary: policy ? "Sandbox disabled at launch." : "No sandbox policy publisher at launch.", changesAffectTask: false };
  const support = describeSandboxSupport();
  const p = plan.permissions;
  return { confinement: "confined", policySource, ...(support.supported ? { backend: support.backend } : {}),
    policySummary: p ? `project=${p.projectFiles}; outside=${p.outsideProject}; credentials=${p.storedCredentials}; commands=${p.commands ? "on" : "off"}; network=${p.network ? "on" : "off"}`
      : "Project write confinement with protected paths.", changesAffectTask: false };
}

/**
 * Decide how a local launch must be confined, before the task has an id, a
 * directory, or a log.
 *
 * Throws for every state that is neither confinable nor intentionally
 * unconfined, which keeps a blocked launch from leaving task state behind.
 */
export function resolveForegroundSandboxPlan(pi: unknown, remote = false, operation?: unknown, tool = "bg_task_spawn"): ForegroundSandboxPlan {
  const policy = currentForegroundSandboxPolicy(pi);
  if (remote && !policy?.permissions) return capturePlan(UNCONFINED, policy); // Preserve legacy SSH behavior.
  try {
    const plan = planFor(policy);
    if (remote && plan.confined) {
      throw new ForegroundSandboxBlockedError(policy!, !plan.permissions?.network
        ? `${policy?.policySource === "background" ? "Background tasks" : "Main"} profile disables network. SSH launches are blocked.`
        : `Structured SSH cannot apply local file and credential permissions yet. Use SSH through confined bash, or change ${policy?.policySource === "background" ? "Background tasks" : "Main"} permissions in /sandbox.`);
    }
    return capturePlan(plan, policy);
  } catch (error) {
    if (error instanceof ForegroundSandboxBlockedError) {
      const resource: DiagnosticResource = policy?.permissions?.enabled && !policy.permissions.commands ? "command-execution"
        : remote && policy?.permissions?.network === false ? "network-access" : "sandbox-backend";
      backgroundDiagnostics(policy)?.observe({ tool, operation, resource, basis: "policy-refusal", outcome: "denied" });
    }
    throw error;
  }
}

/** The plan for one already-read policy. Exposed for tests and reuse. */
export function planFor(policy: ForegroundSandboxPolicy | undefined): ForegroundSandboxPlan {
  // No sandbox extension is publishing: this package is installed on its own and
  // keeps its historical unsandboxed behaviour.
  if (!policy) return UNCONFINED;
  if (policy.permissions?.enabled && !policy.permissions.commands) {
    throw new ForegroundSandboxBlockedError(policy, `${policy.policySource === "background" ? "Background tasks" : "Main"} profile disables commands. Change permissions in /sandbox before launching background tasks.`);
  }
  if (policy.state === "inactive" || policy.state === "disabled") return UNCONFINED;
  if (policy.state !== "enabled" || !policy.writableRoot) {
    throw new ForegroundSandboxBlockedError(policy);
  }
  const permissions = policy.permissions?.enabled ? {
    projectFiles: policy.permissions.projectFiles,
    outsideProject: policy.permissions.outsideProject,
    storedCredentials: policy.permissions.storedCredentials,
    commands: policy.permissions.commands,
    network: policy.permissions.network,
    ...(policy.permissions.shell === undefined ? {} : { shell: policy.permissions.shell }),
    ...(policy.permissions.commandTimeoutSeconds === undefined ? {} : { commandTimeoutSeconds: policy.permissions.commandTimeoutSeconds }),
  } : undefined;
  return { confined: true, writableRoot: policy.writableRoot, denyWrite: policy.denyWrite,
    ...(permissions ? { permissions } : {}) };
}

/**
 * The application, shell, and time switches captured with one launch plan.
 *
 * The Background tasks profile is the gate: when it is off, launches keep their
 * historical unconfined behavior. When it is on, `commands` remains the master
 * switch (enforced by {@link planFor}); this narrows it with the optional
 * `shell` and `commandTimeoutSeconds` fields. An absent `shell` means On, and an
 * absent or null cap means no cap, so a publisher that predates those fields is
 * unchanged.
 */
export interface BackgroundExecutionLimits {
  /** May a launch command be interpreted by a shell? */
  readonly shell: boolean;
  /** Immutable outer cap for one command, in seconds; undefined means unlimited. */
  readonly commandTimeoutSeconds?: number;
}

const UNLIMITED_EXECUTION: BackgroundExecutionLimits = Object.freeze({ shell: true });

/** Read the immutable application switches captured for `plan`. */
export function backgroundExecutionLimits(plan: ForegroundSandboxPlan): BackgroundExecutionLimits {
  const permissions = launchPolicies.get(plan)?.permissions;
  if (!permissions?.enabled) return UNLIMITED_EXECUTION;
  const cap = isCommandTimeoutSeconds(permissions.commandTimeoutSeconds)
    ? permissions.commandTimeoutSeconds
    : undefined;
  return Object.freeze({
    shell: permissions.shell !== false,
    ...(cap === undefined ? {} : { commandTimeoutSeconds: cap }),
  });
}

/**
 * Refuse a launch the captured Background tasks application switches forbid.
 *
 * Called before any task id, directory, log, or metadata exists, so a refused
 * launch leaves nothing behind. `commands: false` is still the master refusal
 * and is raised by {@link planFor}; this is the narrower shell rule. With Shell
 * scripts Off, only a direct executable through `shell: false` argv is allowed.
 * A shell command string and a direct shell interpreter in argv[0] would both
 * reintroduce shell interpretation, and structured SSH carries a remote shell
 * command, so all three are refused.
 *
 * `cwd` is the launch directory the task will actually run in. A relative
 * executable, a relative PATH entry, and an alias found only in that directory
 * are resolved exactly as the launch resolves them, never against Pi's own
 * process cwd.
 */
export function assertBackgroundExecutionAllowed(
  spec: CommandSpec,
  plan: ForegroundSandboxPlan,
  options: { remote?: boolean; cwd?: string } = {},
): void {
  const limits = backgroundExecutionLimits(plan);
  if (limits.shell) return;
  const launchCwd = options.cwd ?? spec.cwd ?? process.cwd();
  const detail = options.remote
    ? "Structured SSH carries a remote shell command, so it cannot run while Shell scripts is Off. Use a local shell:false argv launch, or turn Shell scripts on in /sandbox."
    : spec.shell !== false
      ? "Background tasks profile disables shell commands. Pass shell:false with an argv for a direct executable, or turn Shell scripts on in /sandbox."
      : isShellExecutable(spec.argv?.[0] ?? "", { ...process.env, ...spec.env }, launchCwd)
        ? "Background tasks profile disables shell commands. A direct shell executable is refused; launch the program itself with shell:false, or turn Shell scripts on in /sandbox."
        : undefined;
  if (detail === undefined) return;
  const policy = launchPolicies.get(plan) ?? {
    state: "failed" as const,
    denyWrite: [],
    reason: "The Background tasks profile disables shell commands.",
  };
  throw new ForegroundSandboxBlockedError(policy, detail);
}

/**
 * Wrap a local command in the platform's write sandbox.
 *
 * The result is an ordinary `CommandSpec` whose argv is the backend wrapper
 * around the exact executable and arguments the unconfined spec would have run,
 * so spawning, streaming, timeouts, process-group termination, and env handling
 * all stay on their existing code paths. The generated macOS profile is written
 * to `profilePath`, which callers put inside the task's own directory so a
 * resumed watch re-reads the policy it launched with.
 *
 * `seams` defaults to the real platform and PATH. It exists so a caller — in
 * practice a test — can prove the argv this produces for a backend other than
 * the one the host happens to have.
 */
export function confineCommandSpec(
  spec: CommandSpec,
  plan: ForegroundSandboxPlan,
  profilePath: string,
  seams: SandboxSeams = {},
  /** Receives lines to show with the launch (e.g. a placeholder left in the user's files). */
  onNotice: (line: string) => void = () => {},
  tool = "bg_task_spawn",
): CommandSpec {
  if (!plan.confined) return spec;

  const { execPath, execArgs } = commandExecution(spec);
  const directOnly = spec.shell === false && plan.permissions?.shell === false;
  const target = directOnly
    ? directApplicationTarget(execPath, execArgs, { ...process.env, ...spec.env }, false)
    : { execPath, execArgs };
  // The generated profile is written here, so its directory must exist before
  // the backend builds the command.
  mkdirSync(dirname(profilePath), { recursive: true });
  // Task state is this package's control plane: `meta.json` carries the launch
  // vector a resumed watch re-runs verbatim, and `sandbox.sb` is the profile the
  // launch is confined by. It lives under the system temp directory, which both
  // backends leave writable by design, so a confined task could otherwise
  // rewrite what its own next poll executes and choose its own confinement.
  //
  // Denying the whole registry closes that without moving any state, and without
  // costing the task anything it actually needs: pi writes the registry from
  // outside the sandbox, and the task's log reaches it through a descriptor
  // opened before the launch, which no later mount or profile can revoke.
  //
  // Created here rather than assumed, because the Linux backend materializes an
  // absent denied path as an empty *file* and this one has to be a directory.
  const controlPlane = baseDir();
  mkdirSync(controlPlane, { recursive: true });
  const denyWrite = [...plan.denyWrite, controlPlane];
  const policy = {
    writableRoot: plan.writableRoot,
    denyWrite,
    home: homedir(),
    ...(plan.permissions ? { permissions: plan.permissions } : {}),
  };
  let command;
  try {
    if (plan.permissions && !("permissions" in compileWritePolicy(policy))) {
      throw new Error("permission-aware sandbox core is unavailable; update the sandbox packages before launching");
    }
    command = maybeBuildSandboxCommand(
      {
        profilePath,
        policy,
        ...target,
        ...(directOnly ? { internalHelperExecutable: true } : {}),
      },
      // `explicitSandbox` because the foreground state already said a sandbox
      // applies: an absent or unusable backend must throw here rather than hand
      // back an unwrapped command. The remedy is the foreground one: this policy
      // came from the session, and the session is where it is switched off.
      { sandboxEnabled: true, explicitSandbox: true, remedy: FOREGROUND_SANDBOX_REMEDY },
      seams,
    );
  } catch (error) {
    backgroundDiagnostics(plan)?.observe({ tool, operation: spec, resource: "sandbox-backend", basis: "policy-refusal", outcome: "denied" });
    throw blocked(plan, error instanceof Error ? error.message : String(error));
  }
  if (!command) {
    backgroundDiagnostics(plan)?.observe({ tool, operation: spec, resource: "sandbox-backend", basis: "policy-refusal", outcome: "denied" });
    throw blocked(plan, "no sandbox backend was applied");
  }
  for (const line of command.notices ?? []) onNotice(line);

  return { ...spec, ...(directOnly ? { env: { PATH: "/usr/bin:/bin", HOME: homedir() } } : {}),
    argv: [command.file, ...command.fileArgs], shell: false };
}

function blocked(plan: ForegroundSandboxPlan & { confined: true }, detail: string): Error {
  return new ForegroundSandboxBlockedError(
    {
      state: "failed",
      policySource: launchPolicies.get(plan)?.policySource,
      writableRoot: plan.writableRoot,
      denyWrite: plan.denyWrite,
      reason: detail,
    },
    detail,
  );
}
