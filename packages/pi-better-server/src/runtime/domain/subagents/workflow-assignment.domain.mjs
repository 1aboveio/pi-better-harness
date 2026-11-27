// Generated fixed launch domain from packages/pi-better-subagents/workflow-assignment.ts. Do not edit directly.
export const WORKFLOW_ASSIGNMENT = "pi-better-subagents:workflow-assignment";
/** Wrap only explicitly workflow-bound launches. The normal spawn path owns all execution permissions. */
export async function launchWorkflowAssignment(pi, ctx, callId, params, launch) {
    const input = params;
    if (!input.workflow)
        return launch(params);
    const request = { ref: input.workflow, callId, ctx, input };
    pi.events.emit(WORKFLOW_ASSIGNMENT, request);
    if (!request.admission)
        throw new Error(request.error ?? "No active workflow authorized this assignment.");
    const { workflow: _workflow, ...args } = input;
    let result;
    try {
        result = await launch({ ...args, prompt: request.admission.prompt });
    }
    catch (error) {
        request.admission.settled({ error: error instanceof Error ? error.message : String(error) });
        throw error;
    }
    const receipt = result.details;
    request.admission.settled(receipt?.launched && receipt.runId ? { runId: receipt.runId }
        : { error: result.content.find(part => part.type === "text")?.text || "Assignment did not launch." });
    return result;
}
