/** Optional sandbox-extension policy, mirrored per Pi event bus at launch time. */
import { defaultSubagentTools, parseSubagentTools, type SubagentToolSettings } from "./shared-task-tools.ts";
export const SANDBOX_POLICY_CHANNEL = "pi-better-sandbox:policy";
export const SANDBOX_POLICY_REQUEST_CHANNEL = "pi-better-sandbox:policy-request";

type Access = "off" | "read" | "write" | "read-write";
type CredentialAccess = "off" | "read" | "read-write";

/** Largest single-command cap a timer can hold: 2_147_483 seconds is 2_147_483_000 ms. */
export const MAX_COMMAND_TIMEOUT_SECONDS = 2_147_483;

/** A positive finite number of seconds no larger than {@link MAX_COMMAND_TIMEOUT_SECONDS}. */
export function isCommandTimeoutSeconds(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_COMMAND_TIMEOUT_SECONDS;
}

export type PermissionProfile = Readonly<{
    enabled: boolean;
    projectFiles: Access;
    outsideProject: Access;
    storedCredentials: CredentialAccess;
    /** Master switch for task command execution. */
    commands: boolean;
    network: boolean;
    /**
     * Optional refinement of `commands`: may a task command be interpreted by a
     * shell? Absent means yes (the historical behavior). Off confines a task to
     * directly launched applications through the guarded run_application tool.
     */
    shell?: boolean;
    /**
     * Optional outer cap for one task command, in seconds. Absent or null means
     * no cap; a value is validated here and copied into the immutable child policy.
     */
    commandTimeoutSeconds?: number | null;
    processAccess?: "off" | "read";
}>;

/** The resolved command switches a launch uses: absent settings take their documented default. */
export type CommandSettings = Readonly<{ shell: boolean; commandTimeoutSeconds: number | null }>;

/**
 * Resolve the optional command switches. Absent `shell` is On (the historical
 * behavior); an absent or null cap means no cap. Invalid values never reach
 * here: the bus snapshot validator refuses them first.
 */
export function resolveCommandSettings(
    permissions: { shell?: boolean; commandTimeoutSeconds?: number | null } | undefined,
): CommandSettings {
    return Object.freeze({
        shell: permissions?.shell !== false,
        commandTimeoutSeconds: isCommandTimeoutSeconds(permissions?.commandTimeoutSeconds)
            ? permissions.commandTimeoutSeconds
            : null,
    });
}
export type PermissionSnapshot = Readonly<{
    permissions?: PermissionProfile;
    subagentPermissions?: PermissionProfile;
    subagentTools?: SubagentToolSettings;
}>;

type EventBus = {
    on(channel: string, handler: (data: unknown) => void): unknown;
    emit(channel: string, data: unknown): void;
};
const mirrors = new WeakMap<EventBus, { policy?: PermissionSnapshot; error?: Error }>();

function busOf(pi: unknown): EventBus | undefined {
    const bus = (pi as { events?: unknown } | undefined)?.events;
    if (!bus || typeof bus !== "object") return undefined;
    const candidate = bus as Partial<EventBus>;
    return typeof candidate.on === "function" && typeof candidate.emit === "function" ? candidate as EventBus : undefined;
}

function profile(value: unknown): PermissionProfile {
    if (!value || typeof value !== "object") throw new Error("Invalid sandbox permission profile.");
    const p = value as Record<string, unknown>;
    const credential = (v: unknown): v is CredentialAccess => v === "off" || v === "read" || v === "read-write";
    const access = (v: unknown): v is Access => credential(v) || v === "write";
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

function readPolicy(data: unknown): PermissionSnapshot | undefined {
    if (!data || typeof data !== "object") return undefined;
    const p = data as Record<string, unknown>;
    if (!["inactive", "enabled", "disabled", "unavailable", "failed"].includes(String(p.state))) return undefined;
    return Object.freeze({
        ...(p.permissions === undefined ? {} : { permissions: profile(p.permissions) }),
        ...(p.subagentPermissions === undefined ? {} : { subagentPermissions: profile(p.subagentPermissions) }),
        ...(p.subagentTools === undefined ? {} : { subagentTools: parseSubagentTools(p.subagentTools) }),
    });
}

/** Subscribe before launching; request a replay for either extension load order. */
export function observeSandboxPermissions(pi: unknown): void {
    const bus = busOf(pi);
    if (!bus || mirrors.has(bus)) return;
    const mirror: { policy?: PermissionSnapshot; error?: Error } = {};
    mirrors.set(bus, mirror);
    bus.on(SANDBOX_POLICY_CHANNEL, (data) => {
        try {
            const next = readPolicy(data);
            if (next) { mirror.policy = next; mirror.error = undefined; }
        } catch (error) {
            mirror.error = error as Error;
        }
    });
    bus.emit(SANDBOX_POLICY_REQUEST_CHANNEL, undefined);
}

export function currentSandboxPermissions(pi: unknown): PermissionSnapshot | undefined {
    observeSandboxPermissions(pi);
    const bus = busOf(pi);
    if (!bus) return undefined;
    bus.emit(SANDBOX_POLICY_REQUEST_CHANNEL, undefined);
    const mirror = mirrors.get(bus);
    if (mirror?.error) throw mirror.error;
    return mirror?.policy;
}

/** Resolve before allocating a run. Absent settings require an explicit sandbox request. */
export function resolveSubagentPermissions(pi: unknown, requestedSandbox: boolean | undefined): {
    sandboxEnabled: boolean;
    enforced: boolean;
    permissions?: Omit<PermissionProfile, "enabled">;
    /** Which extension tools a confined child may use; defaults when no settings are published. */
    tools: SubagentToolSettings;
} {
    const snapshot = currentSandboxPermissions(pi);
    const tools = snapshot?.subagentTools ?? defaultSubagentTools();
    if (snapshot?.permissions?.enabled && !snapshot.permissions.commands) {
        throw new Error("Main sandbox profile disables commands. Enable commands in the sandbox UI before launching a subagent.");
    }
    const child = snapshot?.subagentPermissions;
    if (!child) return { sandboxEnabled: requestedSandbox === true, enforced: false, tools };
    if (child.enabled && requestedSandbox === false) {
        throw new Error("Subagent sandbox is enforced by the human-enabled profile; sandbox:false cannot bypass it. Change Subagents permissions in the sandbox UI.");
    }
    const sandboxEnabled = child.enabled || requestedSandbox === true;
    if (!sandboxEnabled) return { sandboxEnabled: false, enforced: false, tools };
    // Starting Pi is runtime work. These capabilities constrain task tools;
    // they do not disable provider transport or the fixed file-operation worker.
    const { enabled: _enabled, ...permissions } = child;
    return { sandboxEnabled: true, enforced: true, permissions, tools };
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

export type ExecutionAdapterRequest = Readonly<{
    version?: unknown;
    name?: unknown;
    reply?: (value: unknown) => void;
}>;

type ExecutionAdapterInstallation = { shutdown(): void };

/** One live installation per bus: `shutdown` is both the reload and the session end. */
const installations = new WeakMap<EventBus, ExecutionAdapterInstallation>();

/**
 * Answer the producer's admission request for one of this package's own tools.
 *
 * Each call replaces the previous installation on the same bus, so a reload or a
 * second factory registration serves the newest schema snapshot instead of the
 * one captured by whichever load happened to run first. `session_shutdown`
 * removes the answer, so a closed session leaves no compatibility proof behind
 * for the next one.
 */
export function announceExecutionAdapter(pi: unknown, options: {
    /** Exact registered `parameters` object for a tool this package registers, if any. */
    parametersFor: (name: string) => object | undefined;
    /** The guarded run_application builtin is installed for confined children. */
    runApplication: boolean;
}): void {
    const bus = busOf(pi);
    if (!bus) return;
    installations.get(bus)?.shutdown();
    const { parametersFor } = options;
    // The producer asks only while Shell scripts is Off or a command time limit is
    // set. Without the guarded direct-application builtin this package cannot honor
    // Shell scripts Off, so it proves no compatibility rather than letting the
    // producer drop the restriction (ADR 0019: reject, never silently drop).
    const answerable = options.runApplication === true;
    const unsubscribe: unknown = bus.on(EXECUTION_ADAPTER_REQUEST_CHANNEL, (data) => {
        if (!answerable) return;
        const request = (data ?? {}) as ExecutionAdapterRequest;
        if (request.version !== EXECUTION_ADAPTER_VERSION || typeof request.name !== "string" ||
            typeof request.reply !== "function") return;
        const parameters = parametersFor(request.name);
        // No reply for a tool this package does not register: the launch stays refused.
        if (parameters) request.reply(Object.freeze({ version: EXECUTION_ADAPTER_VERSION, parameters }));
    });
    let active = true;
    const installation: ExecutionAdapterInstallation = {
        shutdown() {
            if (!active) return;
            active = false;
            // A newer installation has already replaced this one; leave it in place.
            if (installations.get(bus) === installation) installations.delete(bus);
            if (typeof unsubscribe === "function") (unsubscribe as () => void)();
        },
    };
    installations.set(bus, installation);
    // `pi.on` is absent in narrow fixtures that only carry an event bus.
    const onLifecycle = (pi as { on?: unknown } | null | undefined)?.on;
    if (typeof onLifecycle === "function") {
        (onLifecycle as (event: string, handler: () => void) => unknown).call(pi, "session_shutdown", installation.shutdown);
    }
}
