/**
 * Wire protocol for the on-demand Background Tasks coordinator.
 *
 * One coordinator process owns shared discovery, supervisor reconciliation and
 * maintenance for a canonical state directory. Pi processes connect over a Unix
 * local socket (a named pipe on Windows). Clients subscribe with their execution
 * owners; the coordinator sends only durable change hints for those owners.
 *
 * A hint is not a model turn and not a delivery. The receiving host re-reads its
 * own operation/wait/outbox records and applies the existing Pi-side callback,
 * branch and evidence rules. Nothing in this protocol can start a model.
 */
import type {
    OwnerIdentity,
    RetentionPreview,
    RetentionProtection,
    RetentionUnitRecord,
} from "../shared-operation-coordinator/index.ts";

export const COORDINATOR_PROTOCOL_VERSION = 2 as const;

export interface CoordinatorStats {
    pid: number;
    startedAt: number;
    connectedClients: number;
    /** Central running-operation scans, independent of client count. */
    runningScans: number;
    /** Full terminal-history reads are never on the idle path. */
    terminalScans: number;
    changeReads: number;
    reconciledTerminal: number;
    lastScanAt: number | null;
    lastChangeSeq: number;
}

export type CoordinatorRequest =
    | { type: "hello"; version: number; clientId: string; requestId?: string }
    | { type: "subscribe"; version: number; clientId: string; owners: OwnerIdentity[]; cursors?: Record<string, number>; sinceSeq?: number; requestId?: string }
    | { type: "reconcile"; version: number; clientId: string; requestId?: string }
    | { type: "stats"; version: number; clientId: string; requestId?: string }
    | { type: "retention-preview"; version: number; clientId: string; cutoff: number; limit: number; requestId?: string }
    | { type: "retention-apply"; version: number; clientId: string; cutoff: number; limit: number; requestId?: string };

export interface CoordinatorRetentionCandidateView {
    candidate: {
        operationId: string;
        taskId: string;
        terminalOutcome: string | null;
        terminalAt: number | null;
    };
    artifactProtected: string | null;
}

export type CoordinatorReply =
    | { type: "hello"; version: number; pid: number; startedAt: number; latestSeq: number; requestId?: string }
    | { type: "subscribed"; owners: number; latestSeq: number; requestId?: string }
    | { type: "catchup"; changes: import("../shared-operation-coordinator/index.ts").CoordinatorChange[]; latestSeq: number; ownerKey: string; cursor: number; reset?: boolean; requestId?: string }
    | { type: "change"; change: import("../shared-operation-coordinator/index.ts").CoordinatorChange; requestId?: string }
    | { type: "stats"; stats: CoordinatorStats; requestId?: string }
    | {
        type: "retention-preview";
        preview: RetentionPreview;
        artifactProtected: Array<{ operationId: string; reason: string }>;
        requestId?: string;
    }
    | { type: "retention-apply"; preview: RetentionPreview; units: RetentionUnitRecord[]; failed: Array<{ operationId: string; error: string }>; requestId?: string }
    | { type: "reconciled"; latestSeq: number; requestId?: string }
    | { type: "error"; code: string; reason: string; requestId?: string }
    | { type: "pong"; requestId?: string };

export interface CoordinatorSpawnOptions {
    storePath: string;
    supervisorDirectory: string;
    /** Directory holding the lock/socket/log for this canonical store pair. */
    stateDirectory: string;
    /** Test seam: an explicit emitted entrypoint. */
    entryPath?: string;
    /** Working directory for the spawned coordinator (defaults to the client cwd). */
    cwd?: string;
}

export function ownerKey(owner: OwnerIdentity): string {
    return [
        owner.kind,
        owner.sessionId,
        owner.workspace,
        owner.branchId ?? "",
        owner.goalId ?? "",
    ].join("\u0000");
}

export function ownerWireKey(owner: OwnerIdentity): string {
    return ownerKey(owner);
}

export function ownerFromJson(value: unknown): OwnerIdentity | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const owner = value as Partial<OwnerIdentity>;
    if (typeof owner.kind !== "string" || (owner.kind !== "parent-session" && owner.kind !== "worker-conversation")) return undefined;
    if (typeof owner.sessionId !== "string" || owner.sessionId.length === 0) return undefined;
    if (typeof owner.workspace !== "string" || owner.workspace.length === 0) return undefined;
    return {
        kind: owner.kind,
        sessionId: owner.sessionId,
        workspace: owner.workspace,
        branchId: typeof owner.branchId === "string" ? owner.branchId : null,
        goalId: typeof owner.goalId === "string" ? owner.goalId : null,
    };
}

export function protectionReason(protection: RetentionProtection): string {
    return protection;
}
