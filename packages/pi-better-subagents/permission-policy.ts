/** Optional sandbox-extension policy, mirrored per Pi event bus at launch time. */
export const SANDBOX_POLICY_CHANNEL = "pi-better-sandbox:policy";
export const SANDBOX_POLICY_REQUEST_CHANNEL = "pi-better-sandbox:policy-request";

type Access = "off" | "read" | "read-write";
export type PermissionProfile = Readonly<{
    enabled: boolean;
    projectFiles: Access;
    outsideProject: Access;
    storedCredentials: Access;
    commands: boolean;
    network: boolean;
}>;
export type PermissionSnapshot = Readonly<{
    permissions?: PermissionProfile;
    subagentPermissions?: PermissionProfile;
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
    const access = (v: unknown): v is Access => v === "off" || v === "read" || v === "read-write";
    if (typeof p.enabled !== "boolean" || typeof p.commands !== "boolean" || typeof p.network !== "boolean" ||
        !access(p.projectFiles) || !access(p.outsideProject) || !access(p.storedCredentials)) {
        throw new Error("Invalid sandbox permission profile; update permissions in the sandbox UI.");
    }
    return Object.freeze({
        enabled: p.enabled, commands: p.commands, network: p.network,
        projectFiles: p.projectFiles, outsideProject: p.outsideProject, storedCredentials: p.storedCredentials,
    });
}

function readPolicy(data: unknown): PermissionSnapshot | undefined {
    if (!data || typeof data !== "object") return undefined;
    const p = data as Record<string, unknown>;
    if (!["inactive", "enabled", "disabled", "unavailable", "failed"].includes(String(p.state))) return undefined;
    return Object.freeze({
        ...(p.permissions === undefined ? {} : { permissions: profile(p.permissions) }),
        ...(p.subagentPermissions === undefined ? {} : { subagentPermissions: profile(p.subagentPermissions) }),
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

/** Resolve before allocating a run. Absent settings retain the legacy default-on policy. */
export function resolveSubagentPermissions(pi: unknown, requestedSandbox: boolean | undefined): {
    sandboxEnabled: boolean;
    enforced: boolean;
    permissions?: Omit<PermissionProfile, "enabled">;
} {
    const snapshot = currentSandboxPermissions(pi);
    if (snapshot?.permissions?.enabled && !snapshot.permissions.commands) {
        throw new Error("Main sandbox profile disables commands. Enable commands in the sandbox UI before launching a subagent.");
    }
    const child = snapshot?.subagentPermissions;
    if (!child) return { sandboxEnabled: requestedSandbox !== false, enforced: false };
    if (child.enabled && requestedSandbox === false) {
        throw new Error("Subagent sandbox is enforced by the human-enabled profile; sandbox:false cannot bypass it. Change Subagents permissions in the sandbox UI.");
    }
    const sandboxEnabled = child.enabled || requestedSandbox === true;
    if (!sandboxEnabled) return { sandboxEnabled: false, enforced: false };
    if (!child.commands) throw new Error("Subagents profile disables commands. Enable commands in the sandbox UI before launching a subagent.");
    if (!child.network) {
        throw new Error("Subagents profile disables network, including model requests. Child provider isolation is not available; enable network in the sandbox UI before launching a subagent.");
    }
    const { enabled: _enabled, ...permissions } = child;
    return { sandboxEnabled: true, enforced: true, permissions };
}
