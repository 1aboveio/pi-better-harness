// Generated fixed launch domain from packages/pi-better-subagents/assignment-report.ts. Do not edit directly.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { runDir, writeMeta } from "./registry.domain.mjs";
import { credentialFilePaths } from "./shared-sandbox-core.domain.mjs";
import { OperationBridgeError, redactSecret } from "./operation-bridge-types.domain.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, path) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
function retainedBytes(path, limit) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > limit)
            throw new Error("Retained assignment evidence exceeds its bound.");
        const bytes = Buffer.alloc(stat.size);
        if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length)
            throw new Error("Retained assignment evidence changed.");
        return bytes;
    }
    finally {
        closeSync(fd);
    }
}
/** Runs synchronously under the authenticated handler: no yield between authority and persistence. */
export function recordAssignmentReport(id, input, assertAuthority, current) {
    const meta = assertAuthority();
    try {
        return retainAssignmentReport(id, input, meta, assertAuthority, current);
    }
    catch (error) {
        // Refused input is not a committed report: the same writer may correct it.
        // Recheck the live writer before retaining even diagnostic metadata.
        recordAssignmentReportRejection(error instanceof Error ? error.message : String(error), assertAuthority);
        throw error;
    }
}
/** Also used for authenticated bridge refusals that never enter the report handler. */
export function recordAssignmentReportRejection(reason, assertAuthority) {
    const latest = assertAuthority();
    if (!latest.assignmentReport)
        writeMeta({ ...latest, assignmentReportRejection: {
                reason: redactSecret(reason), rejectedAt: Date.now(),
            } });
}
function retainAssignmentReport(id, input, meta, assertAuthority, current) {
    const report = input;
    if (!["complete", "incomplete"].includes(report.status) || !report.reason?.trim() || report.reason.length > 2048
        || !Array.isArray(report.evidence) || report.evidence.length < 1 || report.evidence.length > 4)
        throw new Error("Invalid assignment report.");
    if (report.remaining_work !== undefined && (!Array.isArray(report.remaining_work) || report.remaining_work.length < 1 || report.remaining_work.length > 8
        || report.remaining_work.some((item) => typeof item !== "string" || !item.trim() || item.length > 1024)))
        throw new Error("Remaining work needs 1 to 8 bounded descriptions.");
    if (report.blocker && (!["permission", "external-input"].includes(report.blocker.kind) || !report.blocker.reason?.trim()
        || report.blocker.reason.length > 1024))
        throw new Error("A blocker needs its permission or external-input kind and a concrete reason.");
    if (report.status === "complete" && (report.remaining_work || report.blocker))
        throw new Error("A complete assignment cannot have remaining work or a blocker.");
    const root = realpathSync(meta.cwd);
    const directory = join(runDir(id), "assignment-report-v1");
    const captured = meta.operations?.policy.sandbox?.permissions;
    if (captured && captured.projectFiles !== "read" && captured.projectFiles !== "read-write")
        throw new Error("Captured assignment evidence read permission refused.");
    for (const policy of [current?.permissions, current?.subagentPermissions]) {
        if (policy?.enabled && policy.projectFiles !== "read" && policy.projectFiles !== "read-write")
            throw new Error("Current assignment evidence read permission refused.");
    }
    if (meta.operations?.policy.sandbox && !current?.permissions)
        throw new Error("Current assignment evidence read authority unavailable.");
    // Keep the legacy digest for whole-file reports without the additive fields.
    const request = [report.status, report.reason, report.evidence.map((e) => e.offset === undefined && e.max_bytes === undefined
            ? [e.path, e.explanation] : [e.path, e.explanation, e.offset ?? 0, e.max_bytes])];
    if (report.remaining_work || report.blocker)
        request.push([report.remaining_work ?? null,
            report.blocker ? [report.blocker.kind, report.blocker.reason] : null]);
    const requestDigest = hash(JSON.stringify(request));
    if (meta.assignmentReport) {
        const accepted = readAssignmentReport(meta);
        if (accepted.requestDigest !== requestDigest)
            throw new Error("Conflicting assignment report refused.");
        return { reportId: meta.assignmentReport.digest, status: accepted.status, note: "Report retained. Assignment terminalization after exit and exact parent disposition remain separate." };
    }
    const snapshots = report.evidence.map((e) => captureEvidence(root, e));
    const retained = { version: 1, assignmentId: meta.assignment.assignmentId, attemptId: id, requestDigest,
        status: report.status, reason: report.reason,
        ...(report.remaining_work ? { remainingWork: report.remaining_work } : {}), ...(report.blocker ? { blocker: report.blocker } : {}),
        evidence: snapshots.map(({ digest, source, explanation, range }) => ({ path: join(directory, digest), digest, source, explanation, ...(range ? { range } : {}) })) };
    const text = JSON.stringify(retained);
    if (Buffer.byteLength(text) > 65536)
        throw new Error("Assignment report exceeds its retained metadata bound.");
    const digest = hash(text);
    const latest = assertAuthority();
    if (latest.assignmentReport) {
        if (latest.assignmentReport.digest !== digest)
            throw new Error("Conflicting assignment report refused.");
        readAssignmentReport(latest);
    }
    else {
        mkdirSync(directory, { recursive: true });
        for (const snapshot of snapshots)
            writeFileSync(join(directory, snapshot.digest), snapshot.bytes, { mode: 0o600 });
        const path = join(directory, `${digest}.json`);
        writeFileSync(path, text, { mode: 0o600 });
        const updated = { ...latest, assignmentReport: { version: 1, assignmentId: retained.assignmentId, attemptId: id, digest, path } };
        delete updated.assignmentReportRejection;
        writeMeta(updated);
    }
    return { reportId: digest, status: report.status, note: "Report retained. Assignment terminalization after exit and exact parent disposition remain separate." };
}
function captureEvidence(root, e) {
    try {
        if (!e.path || !e.explanation?.trim() || e.explanation.length > 1024)
            throw new Error("Evidence needs a bounded explanation.");
        const source = realpathSync(resolve(root, e.path));
        if (credentialFilePaths(homedir()).some((p) => inside(p, source)))
            throw new Error("Foreign or credential assignment evidence refused.");
        if (!inside(root, source))
            throw new Error(`Foreign assignment evidence refused: the source must resolve inside the assigned workspace ${JSON.stringify(root)}. A sibling directory is outside this boundary. Use an existing workspace file or place the reportable artifact inside the workspace, then retry.`);
        const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile())
                throw new Error(`Assignment evidence ${JSON.stringify(e.path)} must be a regular file.`);
            const offset = e.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size || (offset === stat.size && offset !== 0)
                || (e.offset !== undefined && e.max_bytes === undefined)
                || (e.max_bytes !== undefined && (!Number.isSafeInteger(e.max_bytes) || e.max_bytes < 1 || e.max_bytes > 65536))) {
                throw new Error(`Invalid assignment evidence range for ${JSON.stringify(e.path)} (${stat.size} bytes). Use offset within the file and max_bytes from 1 through 65536.`);
            }
            if (e.max_bytes === undefined && stat.size > 65536) {
                throw new Error(`Assignment evidence ${JSON.stringify(e.path)} is ${stat.size} bytes; the retained limit is 65536 bytes. Retry with offset and max_bytes (at most 65536) for the relevant excerpt.`);
            }
            const bytes = Buffer.alloc(Math.min(stat.size - offset, e.max_bytes ?? stat.size));
            if (readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length)
                throw new Error("Assignment evidence changed during capture.");
            const after = fstatSync(fd);
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
                throw new Error("Assignment evidence changed during capture.");
            return { bytes, digest: hash(bytes), source, explanation: e.explanation,
                ...(e.max_bytes === undefined ? {} : { range: { offset, bytes: bytes.length, sourceBytes: stat.size } }) };
        }
        finally {
            closeSync(fd);
        }
    }
    catch (error) {
        throw new OperationBridgeError("tool-error", error instanceof Error ? error.message : String(error), true);
    }
}
export function readAssignmentReport(meta) {
    const ref = meta.assignmentReport;
    if (!ref)
        return null;
    if (ref.version !== 1 || !/^[a-f0-9]{64}$/.test(ref.digest) || ref.assignmentId !== meta.assignment?.assignmentId || ref.attemptId !== meta.id
        || ref.path !== join(runDir(meta.id), "assignment-report-v1", `${ref.digest}.json`))
        throw new Error("Foreign assignment report reference.");
    const text = retainedBytes(ref.path, 65536).toString("utf8");
    if (hash(text) !== ref.digest)
        throw new Error("Retained assignment report changed.");
    const report = JSON.parse(text);
    if (report.version !== 1 || report.assignmentId !== ref.assignmentId || report.attemptId !== meta.id)
        throw new Error("Foreign assignment report.");
    for (const e of report.evidence) {
        if (!/^[a-f0-9]{64}$/.test(e.digest) || e.path !== join(runDir(meta.id), "assignment-report-v1", e.digest))
            throw new Error("Retained assignment evidence changed.");
        const bytes = retainedBytes(e.path, 65536);
        if (hash(bytes) !== e.digest || (e.range && (!Number.isSafeInteger(e.range.offset) || e.range.offset < 0
            || !Number.isSafeInteger(e.range.sourceBytes) || e.range.sourceBytes < 0 || e.range.bytes !== bytes.length
            || e.range.offset + e.range.bytes > e.range.sourceBytes)))
            throw new Error("Retained assignment evidence changed.");
    }
    return report;
}
