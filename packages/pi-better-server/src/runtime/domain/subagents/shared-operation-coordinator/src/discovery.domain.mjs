// Generated fixed launch domain from packages/pi-better-subagents/shared-operation-coordinator/src/discovery.ts. Do not edit directly.
// Generated from packages/operation-coordinator/src/discovery.ts. Do not edit directly.
/**
 * Cross-process discovery coordination.
 *
 * Per-operation `supervision` authority decides who may inspect an operation.
 * A separate discovery claim decides which process pays for the global running
 * scan and sidecar directory walk. Followers read only their indexed assigned
 * operations and cheap change-notification state.
 *
 * The claim is not a lease with elapsed-time expiry: replacement is proven by
 * process identity or an exact-token release. Acquisition is compare-and-swap
 * against the observed claim, so simultaneous contenders cannot both scan.
 */
import { StoreError } from "./errors.domain.mjs";
import { columnNumber, columnText, getRow, run, } from "./sqlite.domain.mjs";
import { requireId } from "./validate.domain.mjs";
const CHANGE_REVISION_KEY = "change_revision";
const DISCOVERY_TOKEN_LIMIT = 200;
function mapClaim(row) {
    return {
        scope: columnText(row, "scope"),
        hostId: columnText(row, "host_id"),
        token: columnText(row, "token"),
        claimedAt: columnNumber(row, "claimed_at"),
        updatedAt: columnNumber(row, "updated_at"),
    };
}
function readClaim(ctx, scope) {
    const row = getRow(ctx, "SELECT * FROM discovery_claims WHERE scope = ?", scope);
    return row ? mapClaim(row) : null;
}
export function readDiscoveryClaim(ctx, scope) {
    return readClaim(ctx, requireId("scope", scope));
}
/** Read scope transfer and its discovery claim from one SQLite snapshot. */
export function readDiscoveryState(ctx, scope) {
    scope = requireId("scope", scope);
    const row = getRow(ctx, `SELECT d.*, EXISTS(SELECT 1 FROM coordinator_state WHERE key = ?) AS managed
        FROM (SELECT 1) LEFT JOIN discovery_claims d ON d.scope = ?`, "result-scope-v1:" + scope, scope);
    return { managed: Number(row.managed) === 1, claim: row.scope == null ? null : mapClaim(row) };
}
export function tryClaimDiscovery(ctx, input) {
    const scope = requireId("scope", input.scope);
    const hostId = requireId("hostId", input.hostId);
    const token = requireId("token", input.token);
    if (token.length > DISCOVERY_TOKEN_LIMIT) {
        throw new StoreError("validation", `Invalid token: must be at most ${DISCOVERY_TOKEN_LIMIT} characters`);
    }
    const expectedHostId = input.expected === null ? null : requireId("expected.hostId", input.expected.hostId);
    const expectedToken = input.expected === null ? null : requireId("expected.token", input.expected.token);
    return ctx.transaction(() => {
        if (getRow(ctx, "SELECT value FROM coordinator_state WHERE key = ?", "result-scope-v1:" + scope))
            return null;
        const current = readClaim(ctx, scope);
        if (input.expected === null) {
            if (current)
                return null;
        }
        else if (!current || current.hostId !== expectedHostId || current.token !== expectedToken) {
            return null;
        }
        const at = ctx.now();
        run(ctx, `INSERT INTO discovery_claims (scope, host_id, token, claimed_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(scope) DO UPDATE SET
                 host_id = excluded.host_id,
                 token = excluded.token,
                 claimed_at = excluded.claimed_at,
                 updated_at = excluded.updated_at`, scope, hostId, token, at, at);
        return readClaim(ctx, scope);
    });
}
export function releaseDiscoveryClaim(ctx, input) {
    const scope = requireId("scope", input.scope);
    const hostId = requireId("hostId", input.hostId);
    const token = requireId("token", input.token);
    return ctx.transaction(() => run(ctx, "DELETE FROM discovery_claims WHERE scope = ? AND host_id = ? AND token = ?", scope, hostId, token) > 0);
}
/** Monotonic revision for registration, authority changes and terminal publication. */
export function getChangeRevision(ctx) {
    const row = getRow(ctx, "SELECT value FROM coordinator_state WHERE key = ?", CHANGE_REVISION_KEY);
    if (!row)
        return 0;
    const revision = Number(columnText(row, "value"));
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new StoreError("store-corruption", "The coordinator change revision is not a non-negative integer.");
    }
    return revision;
}
/** Called only inside an existing store transaction. */
export function bumpChangeRevision(ctx) {
    run(ctx, `INSERT INTO coordinator_state (key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`, CHANGE_REVISION_KEY);
}
