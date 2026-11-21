import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProcessListToolDefinition } from "./shared-task-process-list.ts";

/** Keep the fixed, bounded inventory contract when no task sandbox is active. */
export default function childProcessList(pi: ExtensionAPI): void {
    const tool = createProcessListToolDefinition(process.cwd(), { requireLaunchPlan: () => ({ confined: false }) }, () => "read");
    pi.registerTool(tool as Parameters<ExtensionAPI["registerTool"]>[0]);
}
