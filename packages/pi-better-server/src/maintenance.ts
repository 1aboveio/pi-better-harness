import { AgentSession, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "./hosted-session.ts";
import type { SessionRegistry } from "./registry.ts";
import type { IdleSessionsLease } from "./startup/managed-types.ts";

export type MaintenancePurpose = "reload" | "packages" | "upgrade";
export type MaintenanceBusyReason = "maintenance" | "operations" | "work" | "activity" | "dialog" | "unsupported-sdk" | "stopping";

/** A failed idle attempt never waits for or cancels admitted work. The caller owns retry. */
export class MaintenanceBusyError extends Error {
  readonly reason: MaintenanceBusyReason;
  constructor(reason: MaintenanceBusyReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "MaintenanceBusyError";
  }
}

type Admission = { gate: HostMaintenance; closed: boolean; calls: number; persistenceSafe: boolean; reloadEntry: boolean };
type Method = (this: any, ...args: any[]) => any;
type WarmGuard = { state: Admission; methods: Map<string, Method> };
type GuardState = { managers: WeakMap<object, Admission>; installed: WeakSet<object>; supported: WeakSet<object>; tools: WeakSet<object>; warmers?: WeakMap<object, WarmGuard> };
// Multiple module copies must share ownership, and must not wrap the SDK twice.
const key = Symbol.for("pi-better-server.maintenance.sdk-guards.v1");
const globals = globalThis as typeof globalThis & { [key]?: GuardState };
const guards = globals[key] ??= { managers: new WeakMap(), installed: new WeakSet(), supported: new WeakSet(), tools: new WeakSet() };
const warmers = guards.warmers ??= new WeakMap<object, WarmGuard>();
const closedError = () => new Error("Session runtime is closed; close and reopen the session. History is preserved.");

function assertAdmission(state: Admission, metadata = false): void {
  if (state.closed) throw closedError();
  state.gate.assertAdmission(metadata);
}

/** Keep synchronous SDK setters synchronous; hold async admission across every preflight await. */
function tracked(state: Admission | undefined, original: Method, receiver: unknown, args: unknown[], metadata = false): any {
  if (!state) return Reflect.apply(original, receiver, args);
  try { assertAdmission(state, metadata); }
  catch (error) {
    if (original.constructor.name === "AsyncFunction") return Promise.reject(error);
    throw error;
  }
  state.calls++;
  try {
    const result = Reflect.apply(original, receiver, args);
    if (result && typeof result.then === "function") return Promise.resolve(result).finally(() => { state.calls--; });
    state.calls--;
    return result;
  } catch (error) { state.calls--; throw error; }
}

function wrap(proto: object, name: string, invoke: (original: Method, receiver: any, args: any[]) => any): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return false;
  const original = descriptor.value as Method;
  Object.defineProperty(proto, name, { ...descriptor, value: function (this: unknown, ...args: unknown[]) { return invoke(original, this, args); } });
  return true;
}

/** SDK 1.2's status can be inactive while a detached refresh still awaits a provider.
 * Install during construction, before extensions can retain handles or requests start.
 * Track the whole refresh (decision, provider and settlement), independently of run.
 */
function guardCacheWarmer(session: AgentSession, state: Admission): void {
  const warmer = (session as unknown as { _cacheWarmer?: object })._cacheWarmer;
  if (!/^1\.2\./.test(VERSION)) return;
  if (!warmer) { state.persistenceSafe = false; return; }
  if (warmers.has(warmer)) return;
  const runtime = warmer as Record<string, any>;
  const proto = Object.getPrototypeOf(warmer);
  const names = ["start", "schedule", "refresh"];
  // An already-started or overridden warmer cannot prove all prior promises were observed.
  if (!proto || !Object.hasOwn(warmer, "run") || runtime.run !== undefined || !Object.isExtensible(warmer) ||
      typeof Object.getOwnPropertyDescriptor(proto, "status")?.get !== "function" ||
      !names.every(name => !Object.hasOwn(warmer, name) && typeof Object.getOwnPropertyDescriptor(proto, name)?.value === "function") ||
      Object.getOwnPropertyDescriptor(proto, "refresh")?.value.constructor.name !== "AsyncFunction") {
    state.persistenceSafe = false;
    return;
  }
  const methods = new Map<string, Method>();
  for (const name of names) {
    const original = runtime[name] as Method;
    const guarded = function (this: unknown, ...args: unknown[]) {
      // Timer callbacks are fire-and-forget: a fenced refresh is an inert promise,
      // not an unhandled rejection. Never cancel an admitted request here.
      if (state.closed || state.gate.busy) return name === "refresh" ? Promise.resolve() : undefined;
      return tracked(state, original, this, args);
    };
    Object.defineProperty(warmer, name, { configurable: true, writable: true, value: guarded });
    methods.set(name, guarded);
  }
  warmers.set(warmer, { state, methods });
}

function cacheWarmingState(session: AgentSession): "unsupported" | "busy" | "idle" {
  if (!/^1\.2\./.test(VERSION)) return "idle";
  const warmer = (session as unknown as { _cacheWarmer?: Record<string, any> })._cacheWarmer;
  const guard = warmer && warmers.get(warmer);
  if (!warmer || !guard || guard.state !== guards.managers.get(session.sessionManager) ||
      [...guard.methods].some(([name, method]) => warmer[name] !== method)) return "unsupported";
  // Even a stale-context timer is queued background work until the SDK retires it.
  return warmer.run !== undefined ? "busy" : "idle";
}

function guardTools(session: AgentSession): void {
  const state = guards.managers.get(session.sessionManager);
  if (!state) return;
  guardCacheWarmer(session, state);
  // Both supported SDKs expose definitions and build executable tools before binding extensions.
  const runtime = session as unknown as { _toolRegistry: Map<string, { execute: Method }>; _toolDefinitions: Map<string, { definition: { execute: Method } }> };
  if (!(runtime._toolRegistry instanceof Map) || !(runtime._toolDefinitions instanceof Map)) { state.persistenceSafe = false; return; }
  for (const tool of [...runtime._toolRegistry.values(), ...[...runtime._toolDefinitions.values()].map(item => item.definition)]) {
    if (guards.tools.has(tool)) continue;
    const execute = tool.execute;
    tool.execute = function (...args: unknown[]) { return tracked(state, execute, this, args); };
    guards.tools.add(tool);
  }
  // Direct agent entry points are also reachable from SDK consumers.
  const agent = session.agent;
  if (!guards.tools.has(agent)) {
    for (const name of ["prompt", "continue", "steer", "followUp"] as const) {
      const original = agent[name] as Method;
      Object.defineProperty(agent, name, { configurable: true, writable: true, value: function (...args: any[]) { return tracked(state, original, agent, args); } });
    }
    guards.tools.add(agent);
  }
}

/** Install before createAgentSession: constructor-time captures then retain the guard itself. */
function installSdkGuards(): void {
  const proto = AgentSession.prototype;
  if (!guards.installed.has(proto)) {
    // Only the verified prototype ABI can support an upgrade claim. Missing optional
    // methods (nested tools in 0.82) are harmless; missing required guards are not.
    const required = ["prompt", "steer", "followUp", "sendUserMessage", "executeBash", "compact", "navigateTree", "setModel", "cycleModel", "sendCustomMessage", "reload", "_refreshToolRegistry", ...(/^1\.2\./.test(VERSION) ? ["_executeNestedToolCall", "setCacheWarmingMode"] : [])];
    const supported = required.every(name => {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      return descriptor?.configurable && typeof descriptor.value === "function";
    });
    for (const name of ["prompt", "steer", "followUp", "sendUserMessage", "executeBash", "compact", "navigateTree", "setModel", "cycleModel", "_executeNestedToolCall"]) {
      wrap(proto, name, (original, session, args) => tracked(guards.managers.get(session.sessionManager), original, session, args));
    }
    wrap(proto, "sendCustomMessage", (original, session, args) => {
      const options = args[1];
      // A next-turn message is queued work too; only an immediate, non-triggering notice is metadata.
      const metadata = !options?.triggerTurn && options?.deliverAs !== "nextTurn" && !session.isStreaming;
      return tracked(guards.managers.get(session.sessionManager), original, session, args, metadata);
    });
    for (const name of ["setSessionName", "setThinkingLevel", "cycleThinkingLevel", "setActiveToolsByName", "setScopedModels", "setSteeringMode", "setFollowUpMode", "syncQueueModesFromSettings", "setAutoCompactionEnabled", "setAutoRetryEnabled", "setCacheWarmingMode", "recordBashResult", "clearQueue"]) {
      wrap(proto, name, (original, session, args) => tracked(guards.managers.get(session.sessionManager), original, session, args, true));
    }
    wrap(proto, "reload", (original, session, args) => {
      const state = guards.managers.get(session.sessionManager);
      if (!state?.reloadEntry) return tracked(state, original, session, args);
      state.reloadEntry = false;
      return Reflect.apply(original, session, args);
    });
    wrap(proto, "_refreshToolRegistry", (original, session, args) => {
      const result = Reflect.apply(original, session, args);
      guardTools(session);
      return result;
    });
    guards.installed.add(proto);
    if (supported) guards.supported.add(proto);
  }
  const managerProto = SessionManager.prototype;
  if (!guards.installed.has(managerProto)) {
    const supported = ["_persist", "_rewriteFile"].every(name => {
      const descriptor = Object.getOwnPropertyDescriptor(managerProto, name);
      return descriptor?.configurable && typeof descriptor.value === "function";
    });
    for (const name of Object.getOwnPropertyNames(managerProto)) {
      if (!/^(append|branch|resetLeaf|newSession|setSessionFile|createBranchedSession|_persist$|_rewriteFile$|_appendEntry$|_setSessionFile$)/.test(name)) continue;
      wrap(managerProto, name, (original, manager, args) => {
        const state = guards.managers.get(manager);
        // SDK event listeners are fire-and-forget. Revoked writers must be inert, not
        // throw into their settlement path and strand abort()/waitForIdle().
        if (state?.closed) return undefined;
        return tracked(state, original, manager, args, true);
      });
    }
    guards.installed.add(managerProto);
    if (supported) guards.supported.add(managerProto);
  }
}

export function fenceHostedSession(session: AgentSession): void {
  const state = guards.managers.get(session.sessionManager);
  if (state) state.closed = true;
}

export function assertHostedAdmission(session: AgentSession, metadata = false): void {
  const state = guards.managers.get(session.sessionManager);
  if (state) assertAdmission(state, metadata);
}

export function hostedSdkCalls(session: AgentSession): number { return guards.managers.get(session.sessionManager)?.calls ?? 0; }

export async function reloadHostedSession(session: AgentSession): Promise<void> {
  const state = guards.managers.get(session.sessionManager);
  if (state) state.reloadEntry = true;
  try { await session.reload(); }
  finally { if (state) state.reloadEntry = false; }
}

/** The registry, native reload/package host and upgrade activation share this one gate. */
export class HostMaintenance {
  private purpose: MaintenancePurpose | undefined;
  private operations = 0;
  private stopped = false;
  private readonly registry: SessionRegistry;
  constructor(registry: SessionRegistry) { this.registry = registry; installSdkGuards(); }

  get busy(): boolean { return this.stopped || this.purpose !== undefined; }

  assertAdmission(metadata = false): void {
    if (this.stopped) throw new MaintenanceBusyError("stopping", "Session registry is stopping; maintenance admission is permanently closed");
    if (this.purpose && (!metadata || this.purpose === "upgrade")) {
      throw new MaintenanceBusyError("maintenance", "Remote session maintenance is in progress; extensions are being updated. Retry after maintenance.");
    }
  }

  /** Called before the SDK constructor can bind or capture any callbacks. */
  registerManager(manager: SessionManager): void {
    const proto = SessionManager.prototype as unknown as Record<string, unknown>;
    const sessionProto = AgentSession.prototype as unknown as Record<string, unknown>;
    guards.managers.set(manager, {
      gate: this, closed: false, calls: 0, reloadEntry: false,
      persistenceSafe: /^(0\.82|1\.2)\./.test(VERSION) && guards.supported.has(AgentSession.prototype) && guards.supported.has(SessionManager.prototype) &&
        ["_persist", "_rewriteFile"].every(name => typeof proto[name] === "function" && !Object.hasOwn(manager, name)) &&
        ["_buildRuntime", "_refreshToolRegistry", "prompt", "compact", "executeBash"].every(name => typeof sessionProto[name] === "function"),
    });
  }

  revokeManager(manager: SessionManager): void {
    const state = guards.managers.get(manager);
    if (state) state.closed = true;
  }

  enterTool(manager: SessionManager): () => void {
    const state = guards.managers.get(manager)!;
    assertAdmission(state);
    state.calls++;
    let released = false;
    return () => { if (!released) { released = true; state.calls--; } };
  }

  enterSessionOperation(): () => void {
    this.assertAdmission();
    this.operations++;
    let released = false;
    return () => { if (!released) { released = true; this.operations--; } };
  }

  async withIdleSessions<T>(purpose: MaintenancePurpose, run: (sessions: HostedSession[], lease: IdleSessionsLease) => Promise<T>): Promise<T> {
    this.assertAdmission();
    if (this.operations || this.registry.hasPendingOperations) throw new MaintenanceBusyError("operations", "Remote session operations are already in progress");
    const sessions = this.registry.list().filter(item => item.live).map(item => this.registry.get(item.sessionId)!);
    let valid = true;
    let held = false;
    let observing = false;
    const assertIdle = () => {
      if (!valid) throw new Error("Maintenance lease has expired");
      if (this.operations || this.registry.hasPendingOperations) throw new MaintenanceBusyError("operations", "Remote session operations are already in progress");
      for (const hosted of sessions) {
        const warming = cacheWarmingState(hosted.session);
        if (purpose === "upgrade" && (!guards.managers.get(hosted.session.sessionManager)?.persistenceSafe || warming === "unsupported")) throw new MaintenanceBusyError("unsupported-sdk", "Safe upgrade deferred: SDK persistence/admission ABI is unsupported");
        if (hosted.needsInput.length) throw new MaintenanceBusyError("dialog", "Wait for remote dialogs to finish before reloading or upgrading");
        if (hosted.activityChecking) throw new MaintenanceBusyError("activity", "Wait for remote activity observation to finish before reloading or upgrading");
        // Reload continues to allow passive snapshots. Upgrade must also wait for their auth/read awaits.
        if (warming !== "idle" || hosted.executionActive || (purpose === "upgrade" && hosted.operationsActive) || hostedSdkCalls(hosted.session) || hosted.session.pendingMessageCount || !hosted.session.isIdle) {
          throw new MaintenanceBusyError("work", "Wait for remote model, tool, bash, compaction, background work and dialogs to finish before reloading or upgrading");
        }
      }
    };
    assertIdle();
    const assertHeld = () => {
      if (!held || observing) throw new MaintenanceBusyError("activity", "Maintenance is observing activity; no idle fence is held");
      assertIdle();
    };
    if (purpose !== "upgrade") { this.purpose = purpose; held = true; }
    const lease: IdleSessionsLease = {
      assertIdle: assertHeld,
      refreshIdle: async () => {
        if (!valid) throw new Error("Maintenance lease has expired");
        if (observing) throw new MaintenanceBusyError("activity", "Maintenance activity observation is already in progress");
        assertIdle();
        observing = true;
        // Upgrade observation may await arbitrary providers. Keep normal admission
        // open, then recheck the entire live set before reacquiring this fence.
        if (purpose === "upgrade" && held) { this.purpose = undefined; held = false; }
        try {
          await Promise.all(sessions.map(session => session.refreshActivity()));
          if (!valid) throw new Error("Maintenance lease has expired");
          if (purpose === "upgrade") {
            this.assertAdmission();
            const current = this.registry.list().filter(item => item.live).map(item => this.registry.get(item.sessionId)!);
            if (current.length !== sessions.length || current.some(session => !sessions.includes(session))) {
              throw new MaintenanceBusyError("operations", "Remote sessions changed during activity observation; retry maintenance");
            }
          }
          assertIdle();
          if (purpose === "upgrade") { this.purpose = purpose; held = true; }
        } finally { observing = false; }
      },
      commitStop: () => {
        if (purpose !== "upgrade") throw new Error("Only upgrade maintenance may commit stop");
        assertHeld();
        // No await: close every entry and writer before activation publishes and stops the server.
        this.stopped = true;
        for (const session of sessions) session.fence();
      },
    };
    try { await lease.refreshIdle(); return await run(sessions, lease); }
    finally { valid = false; if (!this.stopped && held) this.purpose = undefined; }
  }
}
