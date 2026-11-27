/**
 * Load project context from the linked worktree that owns the working directory.
 *
 * A linked worktree is its own project root: its context file is the one Pi
 * should send, without the main checkout's file that ancestor loading also
 * collects. The global context file under the agent directory is kept, because
 * it does not belong to either checkout.
 *
 * Filters only, and returns nothing, so Pi keeps publishing prompt sections and
 * the cached prompt prefix (ADR 0016, ADR 0021).
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { restrictContextFilesToWorktree } from "../worktree-context.ts";

export default function projectContextExtension(pi: ExtensionAPI): void {
    pi.on("before_agent_start", (event) => {
        restrictContextFilesToWorktree(event.systemPromptOptions, getAgentDir());
    });
}
