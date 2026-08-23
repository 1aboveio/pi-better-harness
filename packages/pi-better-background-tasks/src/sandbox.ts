/**
 * Foreground write-sandbox policy for locally launched background tasks.
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
 * 2. **Fail closed.** Once the foreground state says a sandbox should apply, a
 *    missing or unusable backend blocks the launch. The local command is never
 *    retried unconfined behind the operator's back. The single exception is an
 *    explicitly `disabled` state, which is a human's deliberate decision.
 *
 * The contract is duplicated here rather than imported: `pi-better-sandbox` is
 * an optional peer that this package must keep working without. Two channel
 * names and a payload shape are the entire coupling, and both packages own
 * tests that pin them.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { commandExecution } from "./process.js";
import { maybeBuildSandboxCommand, type SandboxSeams } from "./shared-sandbox-core.js";
import type { CommandSpec } from "./types.js";

/** Channel `pi-better-sandbox` publishes every effective-policy change on. */
export const FOREGROUND_SANDBOX_POLICY_CHANNEL = "pi-better-sandbox:policy";

/** Channel a consumer emits on to ask for the current policy. */
export const FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL = "pi-better-sandbox:policy-request";

/**
 * What the foreground sandbox is doing right now.
 *
 * - `enabled`     - confine locally launched tasks.
 * - `disabled`    - a human switched protection off; launch tasks as before.
 * - `unavailable` - no backend on this platform; block protected launches.
 * - `failed`      - protection cannot be applied here; block protected launches.
 */
export type ForegroundSandboxState = "enabled" | "disabled" | "unavailable" | "failed";

/** The published snapshot, narrowed to the fields a task launch needs. */
export interface ForegroundSandboxPolicy {
  readonly state: ForegroundSandboxState;
  /** The only writable subtree while `state` is `enabled`. */
  readonly writableRoot?: string | undefined;
  /** Canonical paths that stay non-writable inside the writable root. */
  readonly denyWrite: readonly string[];
  /** Human-readable evidence for why `state` is what it is. */
  readonly reason: string;
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
      `Foreground sandbox is ${policy.state}; this local background task was blocked rather than launched unconfined. ${detail ?? policy.reason}`,
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
    };

const UNCONFINED: ForegroundSandboxPlan = { confined: false };

const VALID_STATES = new Set<string>(["enabled", "disabled", "unavailable", "failed"]);

/**
 * The latest snapshot per event bus.
 *
 * Keyed by the bus rather than kept in one module variable so that separate Pi
 * sessions inside one process (and separate tests) cannot read each other's
 * policy.
 */
const mirrors = new WeakMap<PolicyEventBus, { policy: ForegroundSandboxPolicy | undefined }>();

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
function readPolicy(data: unknown): ForegroundSandboxPolicy | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  if (typeof value.state !== "string" || !VALID_STATES.has(value.state)) return undefined;
  const writableRoot = typeof value.writableRoot === "string" ? value.writableRoot : undefined;
  const denyWrite = Array.isArray(value.denyWrite)
    ? value.denyWrite.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    state: value.state as ForegroundSandboxState,
    writableRoot,
    denyWrite: Object.freeze([...denyWrite]),
    reason: typeof value.reason === "string" ? value.reason : "No reason was published.",
  };
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

  const mirror: { policy: ForegroundSandboxPolicy | undefined } = { policy: undefined };
  mirrors.set(events, mirror);
  events.on(FOREGROUND_SANDBOX_POLICY_CHANNEL, (data) => {
    const policy = readPolicy(data);
    if (policy) mirror.policy = policy;
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
  return mirrors.get(events)?.policy;
}

/**
 * Decide how a local launch must be confined, before the task has an id, a
 * directory, or a log.
 *
 * Throws for every state that is neither confinable nor a human's explicit
 * opt-out, which is what keeps a blocked launch from leaving task state behind.
 */
export function resolveForegroundSandboxPlan(pi: unknown): ForegroundSandboxPlan {
  return planFor(currentForegroundSandboxPolicy(pi));
}

/** The plan for one already-read policy. Exposed for tests and reuse. */
export function planFor(policy: ForegroundSandboxPolicy | undefined): ForegroundSandboxPlan {
  // No sandbox extension is publishing: this package is installed on its own and
  // keeps its historical unsandboxed behaviour.
  if (!policy) return UNCONFINED;
  if (policy.state === "disabled") return UNCONFINED;
  if (policy.state !== "enabled" || !policy.writableRoot) {
    throw new ForegroundSandboxBlockedError(policy);
  }
  return { confined: true, writableRoot: policy.writableRoot, denyWrite: policy.denyWrite };
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
): CommandSpec {
  if (!plan.confined) return spec;

  const { execPath, execArgs } = commandExecution(spec);
  // The generated profile is written here, so its directory must exist before
  // the backend builds the command.
  mkdirSync(dirname(profilePath), { recursive: true });
  let command;
  try {
    command = maybeBuildSandboxCommand(
      {
        profilePath,
        policy: {
          writableRoot: plan.writableRoot,
          denyWrite: plan.denyWrite,
          home: homedir(),
        },
        execPath,
        execArgs,
      },
      // `explicitSandbox` because the foreground state already said a sandbox
      // applies: an absent or unusable backend must throw here rather than hand
      // back an unwrapped command.
      { sandboxEnabled: true, explicitSandbox: true },
      seams,
    );
  } catch (error) {
    throw blocked(plan, error instanceof Error ? error.message : String(error));
  }
  if (!command) throw blocked(plan, "no sandbox backend was applied");

  return { ...spec, argv: [command.file, ...command.fileArgs], shell: false };
}

function blocked(plan: ForegroundSandboxPlan & { confined: true }, detail: string): Error {
  return new ForegroundSandboxBlockedError(
    {
      state: "failed",
      writableRoot: plan.writableRoot,
      denyWrite: plan.denyWrite,
      reason: detail,
    },
    detail,
  );
}
