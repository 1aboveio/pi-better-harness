// Generated from packages/operation-coordinator/src/result-supervision.ts. Do not edit directly.
import { getRow, run, type StoreContext } from "./sqlite.ts";
import { getOperation, recordSupervision, recordTerminalOutcome } from "./operations.ts";
import { requireId, requirePath } from "./validate.ts";
import type { RecordTerminalOutcomeInput } from "./types.ts";

const PREFIX = "result-supervision-v1:";
export interface ResultSupervision {
    operationId: string;
    directory: string;
    launchToken: string;
    authorityRef: string | null;
    hostId: string;
    epoch: string;
}

export function resultSupervisions(ctx: StoreContext): ResultSupervision[] {
    return ctx.db.prepare("SELECT value FROM coordinator_state WHERE key LIKE ?").all(`${PREFIX}%`)
        .map(row => JSON.parse(String(row.value)));
}

export function resultSupervision(ctx: StoreContext, operationId: string): ResultSupervision | null {
    const row = getRow(ctx, "SELECT value FROM coordinator_state WHERE key = ?", PREFIX + requireId("operationId", operationId));
    return row ? JSON.parse(String(row.value)) : null;
}

/** The admitting host has stopped its local route before this exact-owner CAS. */
export function handoffResultSupervision(ctx: StoreContext, input: {
    operationId: string; expectedHostId: string; directory: string; hostId: string; epoch: string;
}): ResultSupervision {
    const operationId = requireId("operationId", input.operationId);
    const hostId = requireId("hostId", input.hostId);
    const epoch = requireId("epoch", input.epoch);
    const directory = requirePath("directory", input.directory);
    return ctx.transaction(() => {
        const previous = resultSupervision(ctx, operationId);
        if (previous) return previous;
        const operation = getOperation(ctx, operationId);
        if (!operation || operation.supervision?.hostId !== input.expectedHostId) throw new Error("permission-unavailable: exact supervision owner changed");
        const grant = { operationId, directory, hostId, epoch, launchToken: operation.launchToken,
            authorityRef: operation.authorityRef };
        recordSupervision(ctx, { operationId, owner: operation.owner, expectedHostId: input.expectedHostId,
            supervision: { hostId }, health: "active" });
        run(ctx, "INSERT INTO coordinator_state (key, value) VALUES (?, ?)", PREFIX + operationId, JSON.stringify(grant));
        return grant;
    });
}

/** Called by the singleton server after proving the preceding server has exited. */
export function recoverResultSupervision(ctx: StoreContext, input: ResultSupervision): void {
    ctx.transaction(() => {
        const previous = resultSupervision(ctx, input.operationId);
        if (!previous || previous.launchToken !== input.launchToken) throw new Error("supervision-conflict: execution changed");
        const operation = getOperation(ctx, input.operationId)!;
        if (operation.terminalRevision > 0) return;
        recordSupervision(ctx, { operationId: input.operationId, owner: operation.owner,
            expectedHostId: previous.hostId, supervision: { hostId: input.hostId }, health: "active" });
        run(ctx, "UPDATE coordinator_state SET value = ? WHERE key = ?", JSON.stringify(input), PREFIX + input.operationId);
    });
}

export function publishSupervisedResult(ctx: StoreContext, input: {
    operationId: string; epoch: string; publication: RecordTerminalOutcomeInput;
}) {
    return ctx.transaction(() => {
        const grant = resultSupervision(ctx, input.operationId);
        const operation = getOperation(ctx, input.operationId);
        if (!grant || grant.epoch !== input.epoch || operation?.supervision?.hostId !== grant.hostId
            || operation.launchToken !== grant.launchToken || input.publication.operationId !== input.operationId) {
            throw new Error("stale-runtime-epoch: result supervision changed");
        }
        return recordTerminalOutcome(ctx, input.publication);
    });
}
