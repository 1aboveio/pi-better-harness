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
import { StoreError } from "./errors.ts";
import {
    columnNumber,
    columnText,
    getRow,
    run,
    type StoreContext,
} from "./sqlite.ts";
import { requireId } from "./validate.ts";
import type {
    DiscoveryClaimRecord,
    ReleaseDiscoveryClaimInput,
    TryClaimDiscoveryInput,
} from "./types.ts";

const CHANGE_REVISION_KEY = "change_revision";
const DISCOVERY_TOKEN_LIMIT = 200;

function mapClaim(row: Record<string, unknown>): DiscoveryClaimRecord {
    return {
        scope: columnText(row, "scope"),
        hostId: columnText(row, "host_id"),
        token: columnText(row, "token"),
        claimedAt: columnNumber(row, "claimed_at"),
        updatedAt: columnNumber(row, "updated_at"),
    };
}

function readClaim(ctx: StoreContext, scope: string): DiscoveryClaimRecord | null {
    const row = getRow(ctx, "SELECT * FROM discovery_claims WHERE scope = ?", scope);
    return row ? mapClaim(row) : null;
}

export function readDiscoveryClaim(ctx: StoreContext, scope: unknown): DiscoveryClaimRecord | null {
    return readClaim(ctx, requireId("scope", scope));
}

export function tryClaimDiscovery(
    ctx: StoreContext,
    input: TryClaimDiscoveryInput,
): DiscoveryClaimRecord | null {
    const scope = requireId("scope", input.scope);
    const hostId = requireId("hostId", input.hostId);
    const token = requireId("token", input.token);
    if (token.length > DISCOVERY_TOKEN_LIMIT) {
        throw new StoreError("validation", `Invalid token: must be at most ${DISCOVERY_TOKEN_LIMIT} characters`);
    }
    const expectedHostId = input.expected === null ? null : requireId("expected.hostId", input.expected.hostId);
    const expectedToken = input.expected === null ? null : requireId("expected.token", input.expected.token);

    return ctx.transaction(() => {
        const current = readClaim(ctx, scope);
        if (input.expected === null) {
            if (current) return null;
        } else if (!current || current.hostId !== expectedHostId || current.token !== expectedToken) {
            return null;
        }
        const at = ctx.now();
        run(
            ctx,
            `INSERT INTO discovery_claims (scope, host_id, token, claimed_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(scope) DO UPDATE SET
                 host_id = excluded.host_id,
                 token = excluded.token,
                 claimed_at = excluded.claimed_at,
                 updated_at = excluded.updated_at`,
            scope,
            hostId,
            token,
            at,
            at,
        );
        return readClaim(ctx, scope);
    });
}

export function releaseDiscoveryClaim(
    ctx: StoreContext,
    input: ReleaseDiscoveryClaimInput,
): boolean {
    const scope = requireId("scope", input.scope);
    const hostId = requireId("hostId", input.hostId);
    const token = requireId("token", input.token);
    return ctx.transaction(() =>
        run(
            ctx,
            "DELETE FROM discovery_claims WHERE scope = ? AND host_id = ? AND token = ?",
            scope,
            hostId,
            token,
        ) > 0
    );
}

/** Monotonic revision for registration, authority changes and terminal publication. */
export function getChangeRevision(ctx: StoreContext): number {
    const row = getRow(ctx, "SELECT value FROM coordinator_state WHERE key = ?", CHANGE_REVISION_KEY);
    if (!row) return 0;
    const revision = Number(columnText(row, "value"));
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new StoreError("store-corruption", "The coordinator change revision is not a non-negative integer.");
    }
    return revision;
}

/** Called only inside an existing store transaction. */
export function bumpChangeRevision(ctx: StoreContext): void {
    run(
        ctx,
        `INSERT INTO coordinator_state (key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
        CHANGE_REVISION_KEY,
    );
}
