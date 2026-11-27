import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSandboxPermissions, type SandboxPermissionSettings } from "./permissions.ts";

export const SESSION_PERMISSION_ENTRY = "pi-better-sandbox-permissions";

/** Only the active branch contributes policy; the newest entry must validate. */
export function readSessionPermissions(ctx: ExtensionContext): SandboxPermissionSettings | undefined {
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((entry) =>
        entry.type === "custom" && entry.customType === SESSION_PERMISSION_ENTRY);
    if (!entry || entry.type !== "custom") return undefined;
    const data = entry.data as { version?: unknown; permissions?: unknown } | undefined;
    if (!data || data.version !== 1) throw new Error("Unsupported sandbox session permissions version.");
    // Session snapshots have always included Tools. Unlike old global files,
    // an incomplete snapshot must not gain the default trusted-tool grants.
    if (!data.permissions || typeof data.permissions !== "object" ||
        (data.permissions as { subagentTools?: unknown }).subagentTools === undefined) {
        throw new Error("Sandbox session permissions require explicit subagent tool settings.");
    }
    return parseSandboxPermissions(data.permissions);
}

export function appendSessionPermissions(pi: ExtensionAPI, settings: SandboxPermissionSettings): void {
    pi.appendEntry(SESSION_PERMISSION_ENTRY, { version: 1, permissions: parseSandboxPermissions(settings) });
}
