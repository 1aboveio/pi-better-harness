import { join } from "node:path";
import { evaluateDeleteAccess, evaluateWriteAccess, type CompiledSandboxWritePolicy } from "./shared-sandbox-core.ts";

export interface WorktreeFailure {
    toolName: string;
    isError: boolean;
    input: Record<string, unknown>;
    content: readonly { type: string; text?: string }[];
}

// Require all three observations: an actual failed Git call, Git naming the index
// and OS denial, and the captured policy refusing that specific filesystem operation.
export function deniedGitOperation(
    event: WorktreeFailure,
    gitDir: string,
    policy: CompiledSandboxWritePolicy,
): string | undefined {
    if (!event.isError) return;
    let operation: string | undefined;
    if (
        event.toolName === "run_application" &&
        typeof event.input.executable === "string" &&
        /^(?:\/usr\/bin\/|\/bin\/)?git$/.test(event.input.executable) &&
        Array.isArray(event.input.args)
    ) {
        operation = event.input.args[0];
    } else if (event.toolName === "bash" && typeof event.input.command === "string") {
        // A compound shell command can print diagnostics from a different program.
        const command = event.input.command.trim();
        if (!/[;&|<>$`\n]/.test(command))
            operation = /^(?:\/usr\/bin\/|\/bin\/)?git\s+([a-z-]+)(?:\s|$)/.exec(command)?.[1];
    }
    if (
        !operation ||
        !/^(?:add|commit|checkout|switch|reset|merge|rebase|restore|stash|cherry-pick|update-index|rm|mv|apply)$/.test(
            operation,
        )
    )
        return;
    const index = join(gitDir, "index"),
        lock = index + ".lock";
    for (const block of event.content) {
        if (block.type !== "text" || !block.text) continue;
        for (const line of block.text.split("\n")) {
            if (
                !/^(?:fatal|error): /i.test(line) ||
                !/(?:permission denied|operation not permitted|read-only file system)\s*$/i.test(line)
            )
                continue;
            if (line.includes("'" + lock + "'") && !evaluateWriteAccess(lock, policy).allowed) return operation;
            if (
                (line.includes("'" + lock + "'") || line.includes("'" + index + "'")) &&
                /renam|unlink|remov/i.test(line) &&
                !evaluateDeleteAccess(lock, policy).allowed
            )
                return operation;
        }
    }
}

export function worktreePolicyNotice(gitDir: string, policy: CompiledSandboxWritePolicy): string | undefined {
    const lock = join(gitDir, "index.lock");
    if (!evaluateWriteAccess(lock, policy).allowed)
        return "The current sandbox profile denies writes to the shared Git index.";
    if (!evaluateDeleteAccess(lock, policy).allowed)
        return "The current sandbox profile restricts renaming or removing the shared Git index lock.";
}

export function worktreeDenialText(operation: string, cwd: string): string {
    return (
        "The sandbox denied git " +
        operation +
        " access to linked worktree metadata. Review the changes in " +
        cwd +
        " or continue this conversation with recover_in_clone:true."
    );
}
