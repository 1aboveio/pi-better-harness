import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApplyPatchToolDefinition } from "./shared-task-apply-patch.ts";
import { createTaskFileOperations } from "./shared-task-files.ts";

/** Ordinary worker implementation. Confined workers install their own guarded definition. */
export default function childApplyPatch(pi: ExtensionAPI): void {
    const files = createTaskFileOperations({ requireLaunchPlan: () => ({ confined: false }) });
    const tool = createApplyPatchToolDefinition(process.cwd(), {
        readFile: files.read.readFile, writeFile: files.write.writeFile, mkdir: files.write.mkdir,
        remove: files.remove.remove, checkWrite: files.check.write, checkRemove: files.check.remove,
    }, withFileMutationQueue);
    pi.registerTool(tool as Parameters<ExtensionAPI["registerTool"]>[0]);
}
