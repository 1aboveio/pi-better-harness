import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_ASSIGNMENT = "pi-better-subagents:workflow-assignment";
export interface WorkflowAssignmentRequest {
    ref: { runId: string; step: string };
    callId: string;
    ctx: ExtensionContext;
    input: Record<string, unknown>;
    /** The workflow owner claims the ready item synchronously before launch. */
    admission?: { prompt: string; settled(outcome: { runId?: string; error?: string }): void };
    error?: string;
}

/** Wrap only explicitly workflow-bound launches. The normal spawn path owns all execution permissions. */
export async function launchWorkflowAssignment<P, R extends { details?: unknown; content: readonly { type: string; text?: string }[] }>(
    pi: ExtensionAPI, ctx: ExtensionContext, callId: string, params: P, launch: (params: P) => Promise<R>,
): Promise<R> {
    const input = params as Record<string, unknown>;
    if (!input.workflow) return launch(params);
    const request: WorkflowAssignmentRequest = { ref: input.workflow as WorkflowAssignmentRequest["ref"], callId, ctx, input };
    pi.events.emit(WORKFLOW_ASSIGNMENT, request);
    if (!request.admission) throw new Error(request.error ?? "No active workflow authorized this assignment.");
    const { workflow: _workflow, ...args } = input;
    let result: R;
    try {
        result = await launch({ ...args, prompt: request.admission.prompt } as P);
    } catch (error) {
        request.admission.settled({ error: error instanceof Error ? error.message : String(error) });
        throw error;
    }
    const receipt = result.details as { launched?: boolean; runId?: string } | undefined;
    request.admission.settled(receipt?.launched && receipt.runId ? { runId: receipt.runId }
        : { error: result.content.find(part => part.type === "text")?.text || "Assignment did not launch." });
    return result;
}
