import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RunCallbackOrigin } from "./registry.ts";
import { durableSubagentRoot } from "./session-store.ts";
import { parkedWaits, type ParkedWait } from "./worker-waits.ts";

/** Discovery is not adoption: the captured owner and wait evidence stay untouched. */
export function historicalWaits(origin: RunCallbackOrigin | undefined): ParkedWait[] {
    if (!origin) return [];
    return parkedWaits().filter(({ record }) => record.ownerWorkspace === origin.cwd
        && record.ownerSessionId !== origin.sessionId);
}

export function attentionRevision(waits: ParkedWait[]): string {
    return createHash("sha256").update(JSON.stringify(waits.map(({ runId, record }) => [
        runId, record.waitId, record.generation, record.phase, record.heldReason,
        record.cancelReason, record.resumedBy, record.resumeLaunchToken,
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
}

function receiptPath(workspace: string): string {
    return join(durableSubagentRoot(), `historical-attention-${createHash("sha256").update(workspace).digest("hex")}.json`);
}
export function attentionDismissed(workspace: string, revision: string): boolean {
    try { return JSON.parse(readFileSync(receiptPath(workspace), "utf8")).revision === revision; }
    catch { return false; }
}
export function dismissAttention(workspace: string, revision: string): void {
    mkdirSync(durableSubagentRoot(), { recursive: true });
    const path = receiptPath(workspace);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, revision }), { mode: 0o600 });
    renameSync(temp, path);
}
