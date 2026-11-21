import { createHash } from "node:crypto";
import { StoreError } from "./errors.ts";
import { getRow, getRows, columnText, run, type StoreContext } from "./sqlite.ts";
import { requireWait } from "./rows.ts";
import { holdFailedResume } from "./waits.ts";
import { getAssignmentOutcome, recordAssignmentOutcome } from "./assignment-outcomes.ts";
import type { HoldFailedResumeInput } from "./types.ts";

export interface RepairResumeInput extends HoldFailedResumeInput {
    /** Verified original checkpoint, not the failed attempt's new entry. */
    checkpointId: string;
    expectedCancelEpoch: number;
}

/** The exact exit is fenced and the allowance committed in the same transaction. */
export function repairFailedResume(ctx: StoreContext, input: RepairResumeInput) {
    return ctx.transaction(() => {
        const wait = requireWait(ctx, input.waitId, input.generation);
        const assignmentId = wait.origin?.assignmentRef;
        if (!assignmentId || !wait.park || input.checkpointId !== wait.park.checkpointId) {
            throw new StoreError("resume-proof", "Repair requires the assignment's original checkpoint identity.");
        }
        if (wait.cancelEpoch !== input.expectedCancelEpoch) throw new StoreError("stale-cancel-epoch", "Repair cancellation epoch changed.");
        const publication = getRow(ctx, "SELECT claim_id FROM resume_claims WHERE claim_id = ? AND claim_token = ? AND attempt_id = ? AND launch_token = ? AND wait_id = ? AND generation = ? AND cancel_epoch = ?", input.claimId, input.claimToken, input.attemptId, input.launchToken, wait.waitId, wait.generation, wait.cancelEpoch);
        if (!publication) throw new StoreError("claim-state", "Repair does not match the exact published writer.");
        const fault = JSON.stringify({ category: "unacknowledged-exit", checkpointId: input.checkpointId,
            dependencies: wait.dependencies.map((d) => [d.operationId, d.terminalRevision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) });
        const key = createHash("sha256").update(JSON.stringify([assignmentId, wait.waitId, wait.generation, fault])).digest("hex");
        const prior = getRow(ctx, "SELECT claim_id FROM assignment_repairs WHERE fault_key = ?", key);
        const terminal = getAssignmentOutcome(ctx, assignmentId);
        if (terminal) {
            holdFailedResume(ctx, input);
            return { phase: "held" as const, repaired: false };
        }
        // Duplicate exit notifications cannot exhaust a repair that has not run.
        if (prior && columnText(prior, "claim_id") === input.claimId) return { phase: wait.phase, repaired: false };
        holdFailedResume(ctx, input);
        if (prior) {
            const binding = getRow(ctx, "SELECT recipient_json FROM assignment_bindings WHERE assignment_id = ?", assignmentId);
            if (!binding) throw new StoreError("foreign-owner", "Repair has no captured parent recipient.");
            recordAssignmentOutcome(ctx, { assignmentId, owner: wait.owner, recipient: JSON.parse(columnText(binding, "recipient_json")),
                revision: 1, outcome: "failed", reason: "Automatic repair repeated the same unacknowledged-exit fault; the one-repair allowance is exhausted.",
                processUncertain: false, evidence: [{ kind: "summary", ref: `repair:${key}`, summary: input.reason }],
                waits: getRows(ctx, "SELECT wait_id, generation FROM waits WHERE json_extract(origin_json, '$.assignmentRef') = ?", assignmentId).map((row) => {
                    const linked = requireWait(ctx, columnText(row, "wait_id"), Number(row.generation));
                    return { waitId: linked.waitId, generation: linked.generation, cancelEpoch: linked.cancelEpoch };
                }) });
            return { phase: "held" as const, repaired: false };
        }
        run(ctx, "INSERT INTO assignment_repairs VALUES (?, ?, ?, ?, ?, ?)", key, assignmentId, wait.waitId, wait.generation, fault, input.claimId);
        run(ctx, "UPDATE waits SET phase = 'ready', phase_reason = 'bounded-repair', updated_at = ? WHERE wait_id = ? AND generation = ?", ctx.now(), wait.waitId, wait.generation);
        return { phase: "ready" as const, repaired: true };
    });
}
