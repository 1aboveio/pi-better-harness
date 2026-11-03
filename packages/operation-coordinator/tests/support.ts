/**
 * Shared fixtures for the coordinator store tests.
 *
 * Every test gets its own SQLite file under a temporary directory, so reopen and
 * replay are exercised against real durable state rather than a shared handle.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStoreError, openStore, type OwnerIdentity, type Store, type StoreOptions } from "../index.ts";

const directories: string[] = [];

export interface Harness {
    store: Store;
    path: string;
    /** Close and reopen the same database file, proving the record is on disk. */
    reopen(options?: Partial<StoreOptions>): Store;
    /** Close the current handle without deleting the file. */
    closeStore(): void;
}

export function createHarness(): Harness {
    const directory = mkdtempSync(join(tmpdir(), "operation-coordinator-"));
    directories.push(directory);
    const path = join(directory, "operations.sqlite");
    let store = openStore({ path });
    const harness: Harness = {
        get store() {
            return store;
        },
        path,
        reopen(options = {}) {
            store.close();
            store = openStore({ path, ...options });
            return store;
        },
        closeStore() {
            store.close();
        },
    };
    return harness;
}

export function cleanupHarnesses(): void {
    while (directories.length > 0) {
        const directory = directories.pop();
        if (directory) rmSync(directory, { recursive: true, force: true });
    }
}

/** The parent session from ADR 0020's replay scenario. */
export const parentOwner: OwnerIdentity = {
    kind: "parent-session",
    sessionId: "01a1a186-2daa-7346-ac9e-24b10043ade9",
    workspace: "/workspace/harness",
    branchId: "main",
    goalId: null,
};

/** A worker conversation parked on a local build. */
export const workerOwner: OwnerIdentity = {
    kind: "worker-conversation",
    sessionId: "worker-conversation-1",
    workspace: "/workspace/harness",
    branchId: "main",
    goalId: null,
};

/** A second worker conversation, used for foreign-ownership refusals. */
export const otherWorkerOwner: OwnerIdentity = {
    kind: "worker-conversation",
    sessionId: "worker-conversation-2",
    workspace: "/workspace/harness",
    branchId: "main",
    goalId: null,
};

export const observer = { kind: "background-tasks", version: "1.0.0" };

export interface RegisterOperationOverrides {
    operationId?: string;
    taskId?: string;
    launchToken?: string;
    owner?: OwnerIdentity;
}

export function registerOperation(store: Store, overrides: RegisterOperationOverrides = {}) {
    const operationId = overrides.operationId ?? "op-build-1";
    return store.registerOperation({
        operationId,
        taskId: overrides.taskId ?? `bg_${operationId}`,
        launchToken: overrides.launchToken ?? `launch_${operationId}`,
        owner: overrides.owner ?? workerOwner,
        observer,
        supervision: { hostId: "host-1", runnerId: "runner-1" },
        authorityRef: "permission-revision:7",
    });
}

export function settleOperation(
    store: Store,
    operationId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "lost" = "succeeded",
    owner: OwnerIdentity = workerOwner,
    eventId = `event_${operationId}`,
) {
    return store.recordTerminalOutcome({
        operationId,
        eventId,
        outcome,
        owner,
        evidence: outcome === "lost"
            ? []
            : [
                { kind: "terminal-record", ref: `/logs/${operationId}/terminal.json`, summary: "exit 0" },
                { kind: "log", ref: `/logs/${operationId}/build.log`, summary: "build output tail" },
            ],
        reason: outcome === "lost" ? "runner disappeared without terminal evidence" : undefined,
    });
}

export const parkIntent = {
    attemptId: "attempt-worker-1",
    checkpointId: "checkpoint-worker-1",
    writerLeaseId: "lease-worker-1",
};

export const parkProof = {
    checkpointRecorded: true,
    writerLeaseReleased: true,
    writerPidGone: true,
};

/** Assert a typed refusal, and return it for further message assertions. */
export function expectStoreError(
    body: () => unknown,
    code: string,
    pattern?: RegExp,
) {
    try {
        body();
    } catch (error) {
        assert.ok(
            isStoreError(error),
            `expected a StoreError(${code}), received ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        );
        assert.equal(error.code, code, `unexpected refusal code; message was: ${error.message}`);
        if (pattern) assert.match(error.message, pattern);
        return error;
    }
    assert.fail(`expected a StoreError(${code}), but the call succeeded`);
}

/** Read the owner of a wait generation as a compact comparable string. */
export function ownerLabel(owner: OwnerIdentity): string {
    return `${owner.kind}:${owner.sessionId}:${owner.branchId ?? "-"}`;
}
