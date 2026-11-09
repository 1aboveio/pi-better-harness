/**
 * Retention for Background Tasks history.
 *
 * Two contracts share one safety authority:
 *
 * - the existing daily legacy metadata sweep (`maintenance-core.ts`), whose
 *   `removeMeta` used to delete terminal records without consulting durable
 *   waits/outbox/pins; and
 * - opt-in physical pruning of terminal durable operations and their validated
 *   supervisor artifacts.
 *
 * UI dismissal is separate from destruction: a dismissed row stays until the
 * retention age and every protection allow removal. Durable pruning is disabled
 * by default; the coordinator only applies it when
 * `PI_BG_DURABLE_RETENTION_APPLY=1`. Preview is always read-only.
 */
import {
    existsSync,
    lstatSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type {
    RetentionPreview,
    RetentionUnitRecord,
    Store,
} from "../shared-operation-coordinator/index.ts";
import { runTaskMaintenanceCore } from "../maintenance-core.ts";
import { listMetas } from "../registry.ts";
import type { BackgroundTaskMeta } from "../types.ts";
import { isTerminalStatus } from "../types.ts";
import { supervisorPaths } from "../supervisor/index.ts";

export const DEFAULT_DURABLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SUPERVISOR_TASK_ID = /^bgs_[0-9a-f]{20}$/;

export interface TaskRetentionOptions {
    store: Store;
    supervisorDirectory: string;
    cutoff: number;
    limit: number;
    now?: number;
}

export interface TaskRetentionPreview {
    preview: RetentionPreview;
    artifactProtected: Array<{ operationId: string; reason: string }>;
    legacy: {
        eligible: string[];
        protected: Array<{ id: string; reason: string }>;
    };
}

export interface TaskRetentionApplyResult {
    preview: RetentionPreview;
    units: RetentionUnitRecord[];
    failed: Array<{ operationId: string; error: string }>;
    legacy: {
        removed: number;
        protected: number;
        protectedReasons: string[];
    };
}

interface ArtifactInspection {
    path: string | null;
    protection: string | null;
}

type CallbackMarker = "not-required" | "delivered" | "pending" | "malformed";

function safeJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
        return undefined;
    }
}

/**
 * The observed-waits loader accepts only a finite numeric delivery timestamp.
 * Retention must use the same rule: `null`, a string, NaN or a negative value is
 * not proof of delivery and must keep the callback and its evidence protected.
 */
function callbackMarker(record: Record<string, unknown>): CallbackMarker {
    if (record.callback === false) return "not-required";
    const value = record.callbackDeliveredAt;
    if (value === undefined) return "pending";
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return "delivered";
    return "malformed";
}

/**
 * Validate that a supervisor task directory is runtime-owned before allowing
 * its removal. A missing directory is fine (nothing to delete). Anything
 * unreadable, malformed, symlinked or outside `<supervisor>/tasks` is preserved.
 */
export function inspectSupervisorArtifact(
    supervisorDirectory: string,
    taskId: string,
): ArtifactInspection {
    if (!SUPERVISOR_TASK_ID.test(taskId)) return { path: null, protection: "invalid-supervisor-task-id" };
    if (!supervisorDirectory) return { path: null, protection: "supervisor-directory-unknown" };
    const paths = supervisorPaths(supervisorDirectory, taskId);
    if (!existsSync(paths.dir)) return { path: null, protection: null };
    try {
        const physicalRoot = realpathSync.native(resolve(supervisorDirectory));
        const rootInfo = statSync(physicalRoot);
        if (!rootInfo.isDirectory()) return { path: null, protection: "supervisor-root-not-a-directory" };
        const tasksLexical = join(physicalRoot, "tasks");
        if (!existsSync(tasksLexical)) return { path: null, protection: "supervisor-tasks-root-missing" };
        const tasksInfo = lstatSync(tasksLexical);
        if (tasksInfo.isSymbolicLink() || !tasksInfo.isDirectory()) {
            return { path: null, protection: "supervisor-tasks-root-not-owned" };
        }
        const physicalTasks = realpathSync.native(tasksLexical);
        if (physicalTasks !== join(physicalRoot, "tasks")) {
            return { path: null, protection: "supervisor-tasks-root-outside-owned-root" };
        }
        const taskLexical = join(physicalTasks, taskId);
        const info = lstatSync(taskLexical);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            return { path: null, protection: "supervisor-artifact-not-a-directory" };
        }
        const physicalTask = realpathSync.native(taskLexical);
        if (dirname(physicalTask) !== physicalTasks) {
            return { path: null, protection: "supervisor-artifact-outside-owned-root" };
        }
        const launch = safeJson(join(physicalTask, "launch.json"));
        if (!launch || typeof launch !== "object" || Array.isArray(launch)) {
            return { path: null, protection: "supervisor-launch-record-missing-or-malformed" };
        }
        if ((launch as { taskId?: unknown }).taskId !== taskId) {
            return { path: null, protection: "supervisor-launch-record-id-mismatch" };
        }
        // A callback that has not completed its exact handoff is undelivered
        // work, even when the durable operation looks terminal.
        const observedLexical = join(physicalRoot, "observed");
        const sidecarPath = join(observedLexical, `${taskId}.json`);
        if (existsSync(sidecarPath)) {
            const observedInfo = lstatSync(observedLexical);
            if (observedInfo.isSymbolicLink() || !observedInfo.isDirectory()
                || realpathSync.native(observedLexical) !== observedLexical) {
                return { path: null, protection: "observed-directory-not-owned" };
            }
            const sidecarInfo = lstatSync(sidecarPath);
            if (sidecarInfo.isSymbolicLink() || !sidecarInfo.isFile()) {
                return { path: null, protection: "observed-sidecar-not-owned" };
            }
            const sidecar = safeJson(sidecarPath);
            if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) {
                return { path: null, protection: "observed-sidecar-malformed" };
            }
            const marker = callbackMarker(sidecar as Record<string, unknown>);
            if (marker === "malformed") {
                return { path: null, protection: "observed-callback-delivery-malformed" };
            }
            if (marker === "pending") {
                return { path: null, protection: "undelivered-standalone-callback" };
            }
        }
        return { path: physicalTask, protection: null };
    } catch {
        return { path: null, protection: "supervisor-artifact-unreadable" };
    }
}

function legacyOperationProtection(store: Store, meta: BackgroundTaskMeta): string | null {
    if (!isTerminalStatus(meta.status)) return "nonterminal";
    const operation = store.listOperations({ taskId: meta.id })[0];
    if (operation) return `durable operation ${operation.operationId} exists`;
    if (meta.callback !== false && meta.callbackSentAt === undefined && meta.callbackSuppressedAt === undefined) {
        return "undelivered legacy callback";
    }
    return null;
}

/** Read-only report for both retention contracts. */
export function previewTaskRetention(options: TaskRetentionOptions): TaskRetentionPreview {
    const preview = options.store.previewRetention({ cutoff: options.cutoff, limit: options.limit });
    const artifactProtected: Array<{ operationId: string; reason: string }> = [];
    for (const candidate of preview.candidates) {
        const artifact = inspectSupervisorArtifact(options.supervisorDirectory, candidate.taskId);
        if (artifact.protection) artifactProtected.push({ operationId: candidate.operationId, reason: artifact.protection });
        else if (!wasCallbackRecorded(options.supervisorDirectory, candidate.owner.kind, candidate.taskId)) {
            artifactProtected.push({ operationId: candidate.operationId, reason: "undelivered-standalone-callback" });
        }
    }
    const legacy = previewLegacy(options.store, options.now ?? Date.now());
    return { preview, artifactProtected, legacy };
}

function wasCallbackRecorded(
    supervisorDirectory: string,
    ownerKind: string,
    taskId: string,
): boolean {
    if (ownerKind !== "parent-session") return true;
    const sidecarPath = join(resolve(supervisorDirectory), "observed", `${taskId}.json`);
    if (!existsSync(sidecarPath)) return true; // no callback journal exists for this launch
    const sidecar = safeJson(sidecarPath);
    if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) return false;
    const marker = callbackMarker(sidecar as Record<string, unknown>);
    return marker === "delivered" || marker === "not-required";
}

function previewLegacy(store: Store, now: number): TaskRetentionPreview["legacy"] {
    const eligible: string[] = [];
    const protectedEntries: Array<{ id: string; reason: string }> = [];
    const cutoff = now - DEFAULT_DURABLE_RETENTION_MS;
    try {
        for (const meta of listMetas()) {
            if (!isTerminalStatus(meta.status) || (meta.endedAt ?? meta.startedAt) >= cutoff) continue;
            const reason = legacyOperationProtection(store, meta);
            if (reason) protectedEntries.push({ id: meta.id, reason });
            else eligible.push(meta.id);
        }
    } catch { /* an unreadable registry is never deleted */ }
    return { eligible, protected: protectedEntries };
}

/**
 * Bounded, opt-in physical apply. The store reservation is revalidated at
 * deletion time; a protection added between preview and reserve wins. Files are
 * removed only after the caller has validated the runtime-owned path.
 */
export function applyTaskRetention(options: TaskRetentionOptions): TaskRetentionApplyResult {
    const preview = previewTaskRetention(options);
    const protectedIds = new Set(preview.artifactProtected.map((entry) => entry.operationId));
    const units: RetentionUnitRecord[] = [];
    const failed: Array<{ operationId: string; error: string }> = [];
    const token = `retention_${options.now ?? Date.now()}_${process.pid}`;
    for (const candidate of preview.preview.candidates) {
        if (protectedIds.has(candidate.operationId)) continue;
        const artifact = inspectSupervisorArtifact(options.supervisorDirectory, candidate.taskId);
        if (artifact.protection) {
            failed.push({ operationId: candidate.operationId, error: artifact.protection });
            continue;
        }
        try {
            const unit = options.store.reserveRetention({
                operationId: candidate.operationId,
                cutoff: options.cutoff,
                token,
                artifactRef: artifact.path,
            });
            // Cross the durable fence before the first filesystem mutation. From
            // here a failure holds the reservation as deletion-unknown; it is
            // never released while evidence may already be gone.
            options.store.markRetentionDeletionStarted(unit.operationId, unit.token);
            if (artifact.path) {
                // Revalidate after the fence: the path may have been swapped for
                // a symlink between inspection and this destructive step.
                const recheck = inspectSupervisorArtifact(options.supervisorDirectory, candidate.taskId);
                if (recheck.protection || recheck.path !== artifact.path) {
                    options.store.markRetentionDeletionUnknown(
                        unit.operationId,
                        unit.token,
                        `artifact changed before deletion: ${recheck.protection ?? "path-mismatch"}`,
                    );
                    failed.push({
                        operationId: candidate.operationId,
                        error: recheck.protection ?? "artifact path changed before deletion",
                    });
                    continue;
                }
                try {
                    rmSync(recheck.path, { recursive: true, force: true });
                } catch (error) {
                    options.store.markRetentionDeletionUnknown(
                        unit.operationId,
                        unit.token,
                        `artifact removal failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    failed.push({
                        operationId: candidate.operationId,
                        error: `artifact removal failed: ${error instanceof Error ? error.message : String(error)}`,
                    });
                    continue;
                }
            }
            options.store.markRetentionFilesRemoved(unit.operationId, unit.token);
            units.push(options.store.finalizeRetention(unit.operationId, unit.token));
        } catch (error) {
            const current = options.store.retentionUnit(candidate.operationId);
            if (current?.state === "deleting") {
                try {
                    options.store.markRetentionDeletionUnknown(
                        candidate.operationId,
                        current.token,
                        `cleanup failed after deletion started: ${error instanceof Error ? error.message : String(error)}`,
                    );
                } catch { /* leave the durable fence in place for retry */ }
            }
            failed.push({
                operationId: candidate.operationId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    const legacy = runLegacyRetention(options.store, options.now ?? Date.now());
    return { preview: preview.preview, units, failed, legacy };
}

function runLegacyRetention(store: Store, now: number): TaskRetentionApplyResult["legacy"] {
    const result = runTaskMaintenanceCore({
        now,
        force: false,
        authorizeRemoval: (meta) => {
            const reason = legacyOperationProtection(store, meta);
            return reason ? { allowed: false, reason } : { allowed: true };
        },
    });
    return {
        removed: result.removed,
        protected: result.protected,
        protectedReasons: result.protectedReasons,
    };
}

export interface ScheduledMaintenanceOptions {
    store: Store;
    supervisorDirectory: string;
    now: number;
}

export interface RetentionRecoveryResult {
    released: number;
    completed: number;
    held: number;
}

/**
 * Finish or hold cleanup units left by a crashed coordinator.
 *
 * - `reserved` never crossed the deletion fence, so it is safe to release.
 * - `deleting` crossed the fence. Re-run the validated idempotent removal, then
 *   finalize; if any path/identity check fails, hold it as `deletion-unknown`
 *   rather than reopening references to possibly-deleted evidence.
 * - `files-removed` only needs the database transaction.
 */
export function recoverTaskRetention(options: {
    store: Store;
    supervisorDirectory: string;
    now?: number;
}): RetentionRecoveryResult {
    const result: RetentionRecoveryResult = { released: 0, completed: 0, held: 0 };
    for (const unit of options.store.listRetentionUnits({
        state: ["reserved", "deleting", "files-removed"],
        limit: 100,
    })) {
        try {
            if (unit.state === "reserved") {
                options.store.releaseRetention(
                    unit.operationId,
                    unit.token,
                    "coordinator restart before the deletion fence",
                );
                result.released += 1;
                continue;
            }
            if (unit.state === "deleting") {
                if (unit.taskId) {
                    const inspection = inspectSupervisorArtifact(options.supervisorDirectory, unit.taskId);
                    if (inspection.protection || (inspection.path !== null && inspection.path !== unit.artifactRef)) {
                        options.store.markRetentionDeletionUnknown(
                            unit.operationId,
                            unit.token,
                            `restart recovery cannot prove artifact identity: ${inspection.protection ?? "path-mismatch"}`,
                        );
                        result.held += 1;
                        continue;
                    }
                    if (inspection.path) rmSync(inspection.path, { recursive: true, force: true });
                } else if (unit.artifactRef !== null) {
                    options.store.markRetentionDeletionUnknown(
                        unit.operationId,
                        unit.token,
                        "restart recovery has an artifact reference without a task id",
                    );
                    result.held += 1;
                    continue;
                }
                options.store.markRetentionFilesRemoved(
                    unit.operationId,
                    unit.token,
                    "restart recovery completed the validated removal",
                );
            }
            options.store.finalizeRetention(unit.operationId, unit.token);
            result.completed += 1;
        } catch (error) {
            try {
                const current = options.store.retentionUnit(unit.operationId);
                if (current?.state === "deleting") {
                    options.store.markRetentionDeletionUnknown(
                        unit.operationId,
                        unit.token,
                        `restart recovery failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            } catch { /* keep the durable fence for the next attempt */ }
            result.held += 1;
        }
    }
    return result;
}

/**
 * Backward-compatible alias for the in-flight coordinator integration. New
 * callers should use `recoverTaskRetention`; the helper owns the only correct
 * disposition of `reserved`/`deleting`/`files-removed` units.
 */
export const recoverInterruptedTaskRetention = recoverTaskRetention;

/**
 * The coordinator's periodic maintenance path. Legacy cleanup always runs
 * through its guard; durable physical pruning is opt-in and bounded.
 */
export function runScheduledTaskMaintenance(options: ScheduledMaintenanceOptions): void {
    try {
        recoverInterruptedTaskRetention(options);
    } catch { /* a held unit stays protected; maintenance continues */ }
    try {
        const requestedHintAge = Number(process.env.PI_BG_COORDINATOR_HINT_RETENTION_MS ?? 30 * 24 * 60 * 60 * 1000);
        const hintAge = Number.isSafeInteger(requestedHintAge) && requestedHintAge >= 0
            ? requestedHintAge
            : 30 * 24 * 60 * 60 * 1000;
        options.store.pruneChangesBefore(options.now - hintAge, 10_000);
    } catch { /* hint maintenance cannot prevent result delivery */ }
    runLegacyRetention(options.store, options.now);
    if (process.env.PI_BG_DURABLE_RETENTION_APPLY !== "1") return;
    const requested = Number(process.env.PI_BG_RETENTION_MS ?? DEFAULT_DURABLE_RETENTION_MS);
    const retentionMs = Number.isSafeInteger(requested) && requested >= 0 ? requested : DEFAULT_DURABLE_RETENTION_MS;
    const requestedLimit = Number(process.env.PI_BG_RETENTION_BATCH ?? 25);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(1_000, requestedLimit) : 25;
    applyTaskRetention({
        store: options.store,
        supervisorDirectory: options.supervisorDirectory,
        cutoff: options.now - retentionMs,
        limit,
        now: options.now,
    });
}
