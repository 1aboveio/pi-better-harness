// Generated fixed launch domain from packages/pi-better-subagents/timing-notifications.ts. Do not edit directly.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./registry.domain.mjs";
function receiptPath(id, key) {
    return join(runDir(id), "timing-receipts", createHash("sha256").update(key).digest("hex") + ".json");
}
/** Recipient-only append. The manager reads this receipt, never acknowledges on behalf of another session. */
export function receiptTimingWake(id, key, at) {
    mkdirSync(join(runDir(id), "timing-receipts"), { recursive: true });
    if (timingWakeReceipt(id, key) !== undefined)
        return;
    const path = receiptPath(id, key), temporary = `${path}.${randomUUID()}`;
    try {
        const fd = openSync(temporary, "wx", 0o600);
        try {
            writeFileSync(fd, JSON.stringify({ key, at }));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(temporary, path);
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
export function timingWakeReceipt(id, key) {
    try {
        const value = JSON.parse(readFileSync(receiptPath(id, key), "utf8"));
        return value.key === key && Number.isFinite(value.at) ? value.at : undefined;
    }
    catch {
        return undefined;
    }
}
export const MAX_PENDING_TIMING_WAKES = 64;
/** Keep detailed notices bounded. Overflow is explicit and directs the recipient
 * to retained run evidence instead of silently pretending each call was delivered. */
export function appendTimingWake(pending, wake) {
    if (pending.some(item => item.key === wake.key))
        return pending;
    if (pending.length < MAX_PENDING_TIMING_WAKES)
        return [...pending, wake];
    if (pending.some(item => item.key === "timing-overflow"))
        return pending;
    return [...pending, { kind: "tool-wait", key: "timing-overflow", content: "Additional timing notifications accumulated while this recipient was unavailable. Inspect subagent_result and the retained run log for current progress and tool-call details." }];
}
export function removeTimingReceipt(id, key) { rmSync(receiptPath(id, key), { force: true }); }
