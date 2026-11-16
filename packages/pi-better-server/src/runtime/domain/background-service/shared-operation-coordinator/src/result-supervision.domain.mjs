// Generated fixed launch domain from packages/pi-better-background-tasks/src/shared-operation-coordinator/src/result-supervision.ts. Do not edit directly.
// Generated from packages/operation-coordinator/src/result-supervision.ts. Do not edit directly.
import { isDeepStrictEqual } from "node:util";
import { getRow, run } from "./sqlite.domain.mjs";
import { getOperation, recordSupervision, recordTerminalOutcome } from "./operations.domain.mjs";
import { requireId, requirePath } from "./validate.domain.mjs";
const PREFIX = "result-supervision-v1:";
/** A bounded observation page. A gap requires restoring active authority, not history. */
export function resultSupervisionChanges(ctx, after) {
    const generation = String(ctx.db.prepare("SELECT generation FROM assignment_change_source WHERE singleton=1").get().generation);
    const bounds = ctx.db.prepare("SELECT min(seq) AS first, max(seq) AS last FROM assignment_changes").get();
    const last = Number(bounds.last ?? 0);
    const reset = !after || after.generation !== generation || after.seq > last
        || (bounds.first !== null && after.seq < Number(bounds.first) - 1);
    const rows = reset ? [] : ctx.db.prepare("SELECT seq, entity, entity_id FROM assignment_changes WHERE seq>? ORDER BY seq LIMIT 128").all(after.seq);
    const seq = reset ? last : Number(rows.at(-1)?.seq ?? after.seq);
    return { generation, seq, reset, more: seq < last,
        operationIds: [...new Set(rows.filter(row => row.entity === "background:operation").map(row => String(row.entity_id)))] };
}
export function resultSupervisions(ctx, activeOnly = false) {
    const rows = activeOnly
        ? ctx.db.prepare("SELECT s.value FROM operations o JOIN coordinator_state s ON s.key = ? || o.operation_id WHERE o.phase = 'running'").all(PREFIX)
        : ctx.db.prepare("SELECT value FROM coordinator_state WHERE key LIKE ?").all(`${PREFIX}%`);
    return rows
        .map(row => JSON.parse(String(row.value)));
}
export function resultSupervision(ctx, operationId) {
    const row = getRow(ctx, "SELECT value FROM coordinator_state WHERE key = ?", PREFIX + requireId("operationId", operationId));
    return row ? JSON.parse(String(row.value)) : null;
}
/** The admitting host has stopped its local route before this exact-owner CAS. */
export function handoffResultSupervision(ctx, input) {
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
        if (!operation || operation.supervision?.hostId !== input.expectedHostId)
            throw new Error("permission-unavailable: exact supervision owner changed");
        const grant = { operationId, directory, hostId, epoch, launchToken: operation.launchToken,
            authorityRef: operation.authorityRef, owner: operation.owner, ...(input.capability ? { capability: input.capability } : {}) };
        recordSupervision(ctx, { operationId, owner: operation.owner, expectedHostId: input.expectedHostId,
            supervision: { hostId }, health: "active" });
        run(ctx, "INSERT INTO coordinator_state (key, value) VALUES (?, ?)", PREFIX + operationId, JSON.stringify(grant));
        return grant;
    });
}
/** A wait's dependency set transfers together, or none of it does. */
export function handoffResultSupervisions(ctx, inputs) {
    return ctx.transaction(() => inputs.map(input => handoffResultSupervision(ctx, input)));
}
export function resultScopeManaged(ctx, scope) {
    return !!getRow(ctx, "SELECT value FROM coordinator_state WHERE key = ?", "result-scope-v1:" + requireId("scope", scope));
}
export function handoffResultScope(ctx, input) {
    return ctx.transaction(() => {
        const claim = getRow(ctx, "SELECT host_id, token FROM discovery_claims WHERE scope = ?", requireId("scope", input.scope));
        if (claim ? !input.expectedDiscovery || claim.host_id !== input.expectedDiscovery.hostId || claim.token !== input.expectedDiscovery.token : input.expectedDiscovery !== null) {
            throw new Error("supervision-conflict: discovery owner changed during handoff");
        }
        const grants = handoffResultSupervisions(ctx, input.grants);
        // Registration precedes sidecar creation. Check durable records inside
        // this transaction, including old records whose scope is unknown.
        const stranded = getRow(ctx, `SELECT operation_id FROM operations o
            WHERE phase = 'running' AND observer_kind = 'local-supervisor'
            AND COALESCE(json_extract(supervision_json, '$.resultAdapter'), 0) != 1
            AND (json_extract(supervision_json, '$.resultScope') IS NULL
                OR json_extract(supervision_json, '$.resultScope') = ?)
            AND NOT EXISTS (SELECT 1 FROM coordinator_state s WHERE s.key = ? || o.operation_id)
            LIMIT 1`, input.scope, PREFIX);
        if (stranded)
            throw new Error("permission-unavailable: untransferred legacy operation prevents scope handoff");
        run(ctx, "DELETE FROM discovery_claims WHERE scope = ?", input.scope);
        run(ctx, "INSERT OR IGNORE INTO coordinator_state (key, value) VALUES (?, 'managed')", "result-scope-v1:" + input.scope);
        return grants;
    });
}
/** Called by the singleton server after proving the preceding server has exited. */
export function recoverResultSupervision(ctx, input) {
    ctx.transaction(() => {
        const previous = resultSupervision(ctx, input.operationId);
        if (!previous || previous.launchToken !== input.launchToken || previous.directory !== input.directory
            || previous.authorityRef !== input.authorityRef || JSON.stringify(previous.owner) !== JSON.stringify(input.owner)
            || JSON.stringify(previous.capability) !== JSON.stringify(input.capability)) {
            throw new Error("supervision-conflict: execution or captured authority changed");
        }
        const operation = getOperation(ctx, input.operationId);
        if (operation.terminalRevision > 0)
            return;
        recordSupervision(ctx, { operationId: input.operationId, owner: operation.owner,
            expectedHostId: previous.hostId, supervision: { hostId: input.hostId }, health: "active" });
        run(ctx, "UPDATE coordinator_state SET value = ? WHERE key = ?", JSON.stringify(input), PREFIX + input.operationId);
    });
}
export function publishSupervisedResult(ctx, input) {
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
