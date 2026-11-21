// Generated fixed launch domain from packages/pi-better-subagents/permission-policy.ts. Do not edit directly.
/** Optional sandbox-extension policy, mirrored per Pi event bus at launch time. */
import { defaultSubagentTools, parseSubagentTools } from "./shared-task-tools.domain.mjs";
export const SANDBOX_POLICY_CHANNEL = "pi-better-sandbox:policy";
export const SANDBOX_POLICY_REQUEST_CHANNEL = "pi-better-sandbox:policy-request";
/** Largest single-command cap a timer can hold: 2_147_483 seconds is 2_147_483_000 ms. */
export const MAX_COMMAND_TIMEOUT_SECONDS = 2_147_483;
/** A positive finite number of seconds no larger than {@link MAX_COMMAND_TIMEOUT_SECONDS}. */
export function isCommandTimeoutSeconds(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_COMMAND_TIMEOUT_SECONDS;
}
/**
 * Resolve the optional command switches. Absent `shell` is On (the historical
 * behavior); an absent or null cap means no cap. Invalid values never reach
 * here: the bus snapshot validator refuses them first.
 */
export function resolveCommandSettings(permissions) {
    return Object.freeze({
        shell: permissions?.shell !== false,
        commandTimeoutSeconds: isCommandTimeoutSeconds(permissions?.commandTimeoutSeconds)
            ? permissions.commandTimeoutSeconds
            : null,
    });
}
const mirrors = new WeakMap();
function busOf(pi) {
    const bus = pi?.events;
    if (!bus || typeof bus !== "object")
        return undefined;
    const candidate = bus;
    return typeof candidate.on === "function" && typeof candidate.emit === "function" ? candidate : undefined;
}
function profile(value) {
    if (!value || typeof value !== "object")
        throw new Error("Invalid sandbox permission profile.");
    const p = value;
    const credential = (v) => v === "off" || v === "read" || v === "read-write";
    const access = (v) => credential(v) || v === "write";
    if (typeof p.enabled !== "boolean" || typeof p.commands !== "boolean" || typeof p.network !== "boolean" ||
        !access(p.projectFiles) || !access(p.outsideProject) || !credential(p.storedCredentials) ||
        (p.processAccess !== undefined && p.processAccess !== "off" && p.processAccess !== "read") ||
        (p.shell !== undefined && typeof p.shell !== "boolean") ||
        (p.commandTimeoutSeconds !== undefined && p.commandTimeoutSeconds !== null && !isCommandTimeoutSeconds(p.commandTimeoutSeconds))) {
        throw new Error("Invalid sandbox permission profile; update permissions in the sandbox UI.");
    }
    // Copy only what the publisher sent: absent optional settings keep their default meaning.
    return Object.freeze({
        enabled: p.enabled, commands: p.commands, network: p.network,
        projectFiles: p.projectFiles, outsideProject: p.outsideProject, storedCredentials: p.storedCredentials,
        ...(p.processAccess === undefined ? {} : { processAccess: p.processAccess }),
        ...(p.shell === undefined ? {} : { shell: p.shell }),
        ...(p.commandTimeoutSeconds === undefined ? {} : { commandTimeoutSeconds: p.commandTimeoutSeconds }),
    });
}
function backgroundPolicy(value) {
    if (!value || typeof value !== 'object')
        throw new Error('Invalid Background policy snapshot');
    const p = value;
    if (!['inactive', 'enabled', 'disabled', 'unavailable', 'failed'].includes(String(p.state)))
        throw new Error('Invalid Background policy state');
    return Object.freeze({ state: String(p.state), ...(p.permissions ? { permissions: profile(p.permissions) } : {}),
        ...(typeof p.writableRoot === 'string' ? { writableRoot: p.writableRoot } : {}),
        ...(Array.isArray(p.denyWrite) && p.denyWrite.every(item => typeof item === 'string') ? { denyWrite: [...p.denyWrite] } : {}),
        ...(typeof p.reason === 'string' ? { reason: p.reason } : {}) });
}
function readPolicy(data) {
    if (!data || typeof data !== "object")
        return undefined;
    const p = data;
    if (!["inactive", "enabled", "disabled", "unavailable", "failed"].includes(String(p.state)))
        return undefined;
    return Object.freeze({
        ...(p.background === undefined ? {} : { backgroundPolicy: backgroundPolicy(p.background) }),
        ...(p.permissions === undefined ? {} : { permissions: profile(p.permissions) }),
        ...(p.subagentPermissions === undefined ? {} : { subagentPermissions: profile(p.subagentPermissions) }),
        ...(p.subagentTools === undefined ? {} : { subagentTools: parseSubagentTools(p.subagentTools) }),
    });
}
/** Subscribe before launching; request a replay for either extension load order. */
export function observeSandboxPermissions(pi) {
    const bus = busOf(pi);
    if (!bus || mirrors.has(bus))
        return;
    const mirror = {};
    mirrors.set(bus, mirror);
    bus.on(SANDBOX_POLICY_CHANNEL, (data) => {
        try {
            const next = readPolicy(data);
            if (next) {
                mirror.policy = next;
                mirror.error = undefined;
            }
        }
        catch (error) {
            mirror.error = error;
        }
    });
    bus.emit(SANDBOX_POLICY_REQUEST_CHANNEL, undefined);
}
export function currentSandboxPermissions(pi) {
    observeSandboxPermissions(pi);
    const bus = busOf(pi);
    if (!bus)
        return undefined;
    bus.emit(SANDBOX_POLICY_REQUEST_CHANNEL, undefined);
    const mirror = mirrors.get(bus);
    if (mirror?.error)
        throw mirror.error;
    return mirror?.policy;
}
/** Resolve before allocating a run. Absent settings require an explicit sandbox request. */
export function resolveSubagentPermissions(pi, requestedSandbox, saved) {
    const snapshot = currentSandboxPermissions(pi);
    const tools = snapshot?.subagentTools ?? defaultSubagentTools();
    if (snapshot?.permissions?.enabled && !snapshot.permissions.commands) {
        throw new Error("Main sandbox profile disables commands. Enable commands in the sandbox UI before launching a subagent.");
    }
    const child = snapshot?.subagentPermissions;
    const requested = saved?.sandbox ?? requestedSandbox;
    if (child?.enabled && requested === false) {
        if (saved) {
            throw new Error(`Cannot continue ${saved.runId}: the saved launch recipe has confinement Off, but the current Subagents profile requires it On. Launch a new run with a new recipe.`);
        }
        throw new Error("Subagent sandbox is enforced by the human-enabled profile; sandbox:false cannot bypass it. Change Subagents permissions in the sandbox UI.");
    }
    const sandboxEnabled = child?.enabled === true || requested === true;
    const activationSource = saved ? "saved launch recipe"
        : child?.enabled ? "current Subagents profile"
            : requestedSandbox !== undefined ? "launch request"
                : child ? "current Subagents profile" : "default (no Subagents profile)";
    if (!child || !sandboxEnabled)
        return { sandboxEnabled, enforced: false, activationSource, tools };
    if (!child.enabled)
        return { sandboxEnabled, enforced: true, activationSource, inactiveProfile: true, tools };
    // Starting Pi is runtime work. These capabilities constrain task tools;
    // they do not disable provider transport or the fixed file-operation worker.
    const { enabled: _enabled, ...permissions } = child;
    return { sandboxEnabled, enforced: true, activationSource, permissions, tools };
}
export function effectiveWorkerProcessAccess(plan) {
    return plan.inactiveProfile ? "read" : plan.permissions?.processAccess ?? "off";
}
export function describeSubagentProcessPolicy(plan, platform) {
    const activation = `Worker confinement: ${plan.sandboxEnabled ? "On" : "Off"} (${plan.activationSource}).`;
    const refresh = plan.activationSource === "saved launch recipe"
        ? " Changing confinement requires a new run with a new recipe."
        : "";
    if (!plan.sandboxEnabled)
        return `${activation} No worker task-sandbox process policy is applied.${refresh}`;
    const access = effectiveWorkerProcessAccess(plan) === "read" ? "Read" : "Off";
    const source = plan.inactiveProfile ? "task sandbox defaults; Subagents profile Off"
        : plan.permissions ? "current Subagents profile" : "default (no Subagents profile)";
    const macOS = platform === "darwin" ? " macOS Seatbelt can deny absolute /bin/ps even with Process Read." : "";
    return `${activation} Worker Process access: ${access} (${source}).${refresh}${macOS}`;
}
/**
 * Consumer capability handshake for the shell / direct-application / time controls.
 *
 * The producer (`pi-better-sandbox`) publishes `shell` and
 * `commandTimeoutSeconds` in the Subagents permission profile. A consumer that
 * predates this contract silently ignores both: a `shell:false` profile would
 * still hand the child a shell, and a cap would never be applied. So the producer
 * emits `pi-better-subagents:execution-adapter-request` before it admits a
 * subagent launch under either setting, and refuses the launch when this package
 * does not answer.
 *
 * Request payload: `{ version: 1, name: "subagent_spawn" | "subagent_spawn_batch", reply(value) }`.
 * Reply: `{ version: 1, parameters }` where `parameters` is the exact object
 * registered for that tool, so the producer binds admission to this package's own
 * registration rather than to a copied schema. The reply is the whole wire
 * contract: the producer reads nothing else from this package, so no descriptor
 * or status event is published here.
 *
 * The event bus establishes compatibility, not authentication: the producer still
 * checks the tool's host-owned source, as it does for background admission.
 */
export const EXECUTION_ADAPTER_REQUEST_CHANNEL = "pi-better-subagents:execution-adapter-request";
export const EXECUTION_ADAPTER_VERSION = 1;
/** One live installation per bus: `shutdown` is both the reload and the session end. */
const installations = new WeakMap();
/**
 * Answer the producer's admission request for one of this package's own tools.
 *
 * Each call replaces the previous installation on the same bus, so a reload or a
 * second factory registration serves the newest schema snapshot instead of the
 * one captured by whichever load happened to run first. `session_shutdown`
 * removes the answer, so a closed session leaves no compatibility proof behind
 * for the next one.
 */
export function announceExecutionAdapter(pi, options) {
    const bus = busOf(pi);
    if (!bus)
        return;
    installations.get(bus)?.shutdown();
    const { parametersFor } = options;
    // The producer asks only while Shell scripts is Off or a command time limit is
    // set. Without the guarded direct-application builtin this package cannot honor
    // Shell scripts Off, so it proves no compatibility rather than letting the
    // producer drop the restriction (ADR 0019: reject, never silently drop).
    const answerable = options.runApplication === true;
    const unsubscribe = bus.on(EXECUTION_ADAPTER_REQUEST_CHANNEL, (data) => {
        if (!answerable)
            return;
        const request = (data ?? {});
        if (request.version !== EXECUTION_ADAPTER_VERSION || typeof request.name !== "string" ||
            typeof request.reply !== "function")
            return;
        const parameters = parametersFor(request.name);
        // No reply for a tool this package does not register: the launch stays refused.
        if (parameters)
            request.reply(Object.freeze({ version: EXECUTION_ADAPTER_VERSION, parameters }));
    });
    let active = true;
    const installation = {
        shutdown() {
            if (!active)
                return;
            active = false;
            // A newer installation has already replaced this one; leave it in place.
            if (installations.get(bus) === installation)
                installations.delete(bus);
            if (typeof unsubscribe === "function")
                unsubscribe();
        },
    };
    installations.set(bus, installation);
    // `pi.on` is absent in narrow fixtures that only carry an event bus.
    const onLifecycle = pi?.on;
    if (typeof onLifecycle === "function") {
        onLifecycle.call(pi, "session_shutdown", installation.shutdown);
    }
}
