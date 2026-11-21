// Generated fixed launch domain from packages/pi-better-subagents/child-apply-patch.ts. Do not edit directly.
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createApplyPatchToolDefinition } from "./shared-task-apply-patch.domain.mjs";
import { createTaskFileOperations } from "./shared-task-files.domain.mjs";
/** Ordinary worker implementation. Confined workers install their own guarded definition. */
export default function childApplyPatch(pi) {
    const files = createTaskFileOperations({ requireLaunchPlan: () => ({ confined: false }) });
    const tool = createApplyPatchToolDefinition(process.cwd(), {
        readFile: files.read.readFile, writeFile: files.write.writeFile, mkdir: files.write.mkdir,
        remove: files.remove.remove, checkWrite: files.check.write, checkRemove: files.check.remove,
    }, withFileMutationQueue);
    pi.registerTool(tool);
}
