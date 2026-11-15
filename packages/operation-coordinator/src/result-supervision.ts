import { isDeepStrictEqual } from "node:util";
import { getRow, run, type StoreContext } from "./sqlite.ts";
import { getOperation, recordSupervision, recordTerminalOutcome } from "./operations.ts";
import { requireId, requirePath } from "./validate.ts";
import type { RecordTerminalOutcomeInput } from "./types.ts";
import type { OwnerIdentity } from "./types.ts";

const PREFIX = "result-supervision-v1:";
export interface ResultSupervision {
    operationId: string;
    directory: string;
    launchToken: string;
    authorityRef: string | null;
    hostId: string;
    epoch: string;
    owner: OwnerIdentity;
    capability?: { adapter: string; captured: unknown; current: unknown };
}

export function resultSupervisions(ctx: StoreContext, activeOnly = false): ResultSupervision[] {
    const rows = activeOnly
        ? ctx.db.prepare("SELECT s.value FROM operations o JOIN coordinator_state s ON s.key = ? || o.operation_id WHERE o.phase = 'running'").all(PREFIX)
        : ctx.db.prepare("SELECT value FROM coordinator_state WHERE key LIKE ?").all(`${PREFIX}%`);
    return rows
        .map(row => JSON.parse(String(row.value)));
}

export function resultSupervision(ctx: StoreContext, operationId: string): ResultSupervision | null {
    const row = getRow(ctx, "SELECT value FROM coordinator_state WHERE key = ?", PREFIX + requireId("operationId", operationId));
    return row ? JSON.parse(String(row.value)) : null;
}

/** The admitting host has stopped its local route before this exact-owner CAS. */
export function handoffResultSupervision(ctx: StoreContext, input: {
    operationId: string; expectedHostId: string; directory: string; hostId: string; epoch: string;
    capability?: ResultSupervision["capability"];
}): ResultSupervision {
    const operationId = requireId("operationId", input.operationId);
    const hostId = requireId("hostId", input.hostId);
    const epoch = requireId("epoch", input.epoch);
    const directory = requirePath("directory", input.directory);
    return ctx.transaction(() => {
        const previous = resultSupervision(ctx, operationId);
        if (previous) {
            if (previous.directory !== directory || previous.hostId !== hostId || previous.epoch !== epoch
                || !isDeepStrictEqual(previous.capability, input.capability)) {
                throw new Error("supervision-conflict: repeated handoff changed destination or captured authority");
            }
            return previous;
        }
        const operation = getOperation(ctx, operationId);
        if (!operation || operation.supervision?.hostId !== input.expectedHostId) throw new Error("permission-unavailable: exact supervision owner changed");
        const grant = { operationId, directory, hostId, epoch, launchToken: operation.launchToken,
            authorityRef: operation.authorityRef, owner: operation.owner, ...(input.capability ? { capability: input.capability } : {}) };
        recordSupervision(ctx, { operationId, owner: operation.owner, expectedHostId: input.expectedHostId,
            supervision: { hostId }, health: "active" });
        run(ctx, "INSERT INTO coordinator_state (key, value) VALUES (?, ?)", PREFIX + operationId, JSON.stringify(grant));
        return grant;
    });
}

/** A wait's dependency set transfers together, or none of it does. */
export function handoffResultSupervisions(ctx: StoreContext, inputs: Parameters<typeof handoffResultSupervision>[1][]): ResultSupervision[] {
    return ctx.transaction(() => inputs.map(input => handoffResultSupervision(ctx, input)));
}

export function resultScopeManaged(ctx: StoreContext, scope: string): boolean {
    return !!getRow(ctx, "SELECT value FROM coordinator_state WHERE key = ?", "result-scope-v1:" + requireId("scope", scope));
}

export function handoffResultScope(ctx: StoreContext, input: {
    scope: string;
    expectedDiscovery: { hostId: string; token: string } | null;
    grants: Parameters<typeof handoffResultSupervision>[1][];
}): ResultSupervision[] {
    return ctx.transaction(() => {
        const claim = getRow(ctx, "SELECT host_id, token FROM discovery_claims WHERE scope = ?", requireId("scope", input.scope));
        if (claim ? !input.expectedDiscovery || claim.host_id !== input.expectedDiscovery.hostId || claim.token !== input.expectedDiscovery.token : input.expectedDiscovery !== null) {
            throw new Error("supervision-conflict: discovery owner changed during handoff");
        }
        const grants = handoffResultSupervisions(ctx, input.grants);
        run(ctx, "DELETE FROM discovery_claims WHERE scope = ?", input.scope);
        run(ctx, "INSERT OR IGNORE INTO coordinator_state (key, value) VALUES (?, 'managed')", "result-scope-v1:" + input.scope);
        return grants;
    });
}

/** Called by the singleton server after proving the preceding server has exited. */
export function recoverResultSupervision(ctx: StoreContext, input: ResultSupervision): void {
    ctx.transaction(() => {
        const previous = resultSupervision(ctx, input.operationId);
        if (!previous || previous.launchToken !== input.launchToken || previous.directory !== input.directory
            || previous.authorityRef !== input.authorityRef || JSON.stringify(previous.owner) !== JSON.stringify(input.owner)
            || JSON.stringify(previous.capability) !== JSON.stringify(input.capability)) {
            throw new Error("supervision-conflict: execution or captured authority changed");
        }
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
