/** Installed as the final inline extension by the trusted native launcher. */
import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalizePath, describeSandboxSupport } from "./shared-sandbox-core.ts";
import { GUARDED_TASK_TOOLS, installTaskTools, TASK_BUILTINS } from "./shared-task-sandbox.ts";
import { parseTaskPolicy, type TaskPolicy } from "./task-policy.ts";
import { SANDBOX_POLICY_CHANNEL, SANDBOX_POLICY_REQUEST_CHANNEL } from "./permission-policy.ts";
import { failureDispositionTool, intentBashDefinition } from "./child-incidents.ts";
import { DISPOSITION_TOOL } from "./incident-model.ts";

const TRUSTED_INLINE_SOURCE = "<inline:task-sandbox>";

function inside(root: string, path: string): boolean {
    return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * A trusted extension tool is admitted only when its name AND its canonical
 * source lie inside the package root the parent recorded, and a network tool
 * only while Network access is On. Another package registering the same name
 * is refused.
 */
export function trustedToolRefusal(policy: TaskPolicy, name: string, sourcePath: string | undefined): string | undefined {
    const entry = policy.extensionTools.find((tool) => tool.name === name);
    if (!entry) return `${name} is not a trusted tool for this run`;
    if (entry.network && !policy.permissions.network) return `${name} needs Network access, which is Off`;
    if (!sourcePath || sourcePath.startsWith("<")) return `${name} has no package source`;
    let canonical: string;
    try { canonical = canonicalizePath(sourcePath); } catch { return `${name} source cannot be resolved`; }
    if (!inside(entry.root, canonical)) return `${name} comes from ${sourcePath}, not the trusted package ${entry.package}`;
    return undefined;
}

export default function taskGuard(pi: ExtensionAPI, input: unknown, fatal: (error: unknown) => never): void {
    const policy = parseTaskPolicy(input);
    const support = describeSandboxSupport();
    if (!support.supported) throw new Error(`Task sandbox unavailable: ${support.reason}`);
    const plan = Object.freeze({
        confined: true as const, profilePath: policy.profilePath,
        policy: Object.freeze({ writableRoot: policy.root, home: policy.home, permissions: policy.permissions, denyWrite: policy.denyWrite,
            runtimeCompatibility: true, runtimeWrite: Object.freeze([policy.scratch]) }),
    });
    const controller = Object.freeze({ requireLaunchPlan: () => plan });
    let shellPath: string | undefined;
    let currentCwd = process.cwd();
    const boundary = installTaskTools(pi, { controller, cwd: process.cwd(), shellPath: () => shellPath,
        trustedSources: [TRUSTED_INLINE_SOURCE],
        // Structured command intent (#315): validated before the confined command runs.
        bashDefinition: (cwd, operations) => intentBashDefinition(cwd, operations) as any,
        applyPatch: policy.applyPatch,
        // The disposition tool performs no file or command I/O; only this inline registration is admitted.
        // Trusted tools are admitted by name and package (ADR 0009).
        admitExtensionTool: (name, _input, sourcePath) => (name === DISPOSITION_TOOL && sourcePath === TRUSTED_INLINE_SOURCE) ||
            trustedToolRefusal(policy, name, sourcePath) === undefined,
    });
    pi.registerTool(failureDispositionTool(() => currentCwd) as any);
    const profile = Object.freeze({ enabled: true, ...policy.permissions });
    const status = Object.freeze({
        state: "enabled", projectRoot: policy.root, writableRoot: policy.root,
        denyWrite: policy.denyWrite, platform: process.platform, backend: support.backend, executable: support.executable,
        permissions: profile, subagentPermissions: profile,
        readPolicy: "restricted", networkPolicy: policy.permissions.network ? "unrestricted" : "blocked",
        reason: "Immutable child task policy; Pi runtime operations remain trusted.",
    });
    pi.events.on(SANDBOX_POLICY_REQUEST_CHANNEL, () => pi.events.emit(SANDBOX_POLICY_CHANNEL, status));
    pi.on("session_start", (_event, ctx) => {
        try {
            shellPath = SettingsManager.create(ctx.cwd, policy.agentDir, { projectTrusted: false }).getShellPath();
            currentCwd = ctx.cwd;
            boundary.register(ctx.cwd);
            const builtins: readonly string[] = policy.applyPatch ? [...TASK_BUILTINS, ...GUARDED_TASK_TOOLS] : TASK_BUILTINS;
            const selected = policy.tools.filter((name) => builtins.includes(name));
            boundary.assertInstalled(selected);
            const inventory = pi.getAllTools();
            const trusted: string[] = [];
            const refused: { name: string; reason: string }[] = [];
            for (const name of policy.tools) {
                if (builtins.includes(name) || !policy.extensionTools.some((tool) => tool.name === name)) continue;
                const registered = inventory.find((tool) => tool.name === name);
                const reason = registered ? trustedToolRefusal(policy, name, registered.sourceInfo?.path) : `${name} was not registered by its package`;
                if (reason) refused.push({ name, reason }); else trusted.push(name);
            }
            const activated = selected.length || trusted.length ? [...selected, ...trusted, DISPOSITION_TOOL] : selected;
            pi.setActiveTools(activated);
            const active = new Set(pi.getActiveTools());
            if (active.size !== activated.length || activated.some((name) => !active.has(name))) {
                throw new Error("SDK did not activate the guarded tool set; refusing to start the task.");
            }
            pi.events.emit(SANDBOX_POLICY_CHANNEL, status);
            // A typed lifecycle marker, never inferred from assistant prose.
            process.stdout.write(`${JSON.stringify({ type: "task_sandbox_ready", root: policy.root, tools: selected,
                ...(trusted.length ? { trusted } : {}), ...(refused.length ? { refused } : {}) })}\n`);
        } catch (error) { fatal(error); }
    });
}
