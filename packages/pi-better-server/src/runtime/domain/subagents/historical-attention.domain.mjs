// Generated fixed launch domain from packages/pi-better-subagents/historical-attention.ts. Do not edit directly.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableSubagentRoot } from "./session-store.domain.mjs";
import { parkedWaits } from "./worker-waits.domain.mjs";
/** Discovery is not adoption: the captured owner and wait evidence stay untouched. */
export function historicalWaits(origin) {
    if (!origin)
        return [];
    return parkedWaits().filter(({ record }) => record.ownerWorkspace === origin.cwd
        && record.ownerSessionId !== origin.sessionId);
}
export function attentionRevision(waits) {
    return createHash("sha256").update(JSON.stringify(waits.map(({ runId, record }) => [
        runId, record.waitId, record.generation, record.phase, record.heldReason,
        record.cancelReason, record.resumedBy, record.resumeLaunchToken,
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
}
function receiptPath(workspace) {
    return join(durableSubagentRoot(), `historical-attention-${createHash("sha256").update(workspace).digest("hex")}.json`);
}
export function attentionDismissed(workspace, revision) {
    try {
        return JSON.parse(readFileSync(receiptPath(workspace), "utf8")).revision === revision;
    }
    catch {
        return false;
    }
}
export function dismissAttention(workspace, revision) {
    mkdirSync(durableSubagentRoot(), { recursive: true });
    const path = receiptPath(workspace);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, revision }), { mode: 0o600 });
    renameSync(temp, path);
}
