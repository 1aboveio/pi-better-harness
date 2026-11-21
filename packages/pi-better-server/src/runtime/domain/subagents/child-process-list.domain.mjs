// Generated fixed launch domain from packages/pi-better-subagents/child-process-list.ts. Do not edit directly.
import { createProcessListToolDefinition } from "./shared-task-process-list.domain.mjs";
/** Keep the fixed, bounded inventory contract when no task sandbox is active. */
export default function childProcessList(pi) {
    const tool = createProcessListToolDefinition(process.cwd(), { requireLaunchPlan: () => ({ confined: false }) }, () => "read");
    pi.registerTool(tool);
}
