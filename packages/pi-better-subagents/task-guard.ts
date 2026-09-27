/** Installed as the final inline extension by the trusted native launcher. */
import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeSandboxSupport } from "./shared-sandbox-core.ts";
import { installTaskTools, TASK_BUILTINS } from "./shared-task-sandbox.ts";
import { parseTaskPolicy } from "./task-policy.ts";
import { SANDBOX_POLICY_CHANNEL, SANDBOX_POLICY_REQUEST_CHANNEL } from "./permission-policy.ts";
import { failureDispositionTool, intentBashDefinition } from "./child-incidents.ts";
import { DISPOSITION_TOOL } from "./incident-model.ts";

const TRUSTED_INLINE_SOURCE = "<inline:task-sandbox>";

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
        // The disposition tool performs no file or command I/O; only this inline registration is admitted.
        admitExtensionTool: (name, _input, sourcePath) => name === DISPOSITION_TOOL && sourcePath === TRUSTED_INLINE_SOURCE,
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
            const selected = policy.tools.filter((name) => (TASK_BUILTINS as readonly string[]).includes(name));
            boundary.assertInstalled(selected);
            const activated = selected.length ? [...selected, DISPOSITION_TOOL] : selected;
            pi.setActiveTools(activated);
            const active = new Set(pi.getActiveTools());
            if (active.size !== activated.length || activated.some((name) => !active.has(name))) {
                throw new Error("SDK did not activate the guarded tool set; refusing to start the task.");
            }
            pi.events.emit(SANDBOX_POLICY_CHANNEL, status);
            // A typed lifecycle marker, never inferred from assistant prose.
            process.stdout.write(`${JSON.stringify({ type: "task_sandbox_ready", root: policy.root, tools: selected })}\n`);
        } catch (error) { fatal(error); }
    });
}
