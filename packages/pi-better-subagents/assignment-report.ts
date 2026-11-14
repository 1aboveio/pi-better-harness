import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { runDir, writeMeta, type RunMeta } from "./registry.ts";
import { credentialFilePaths } from "./shared-sandbox-core.ts";
import type { PermissionSnapshot, PermissionProfile } from "./permission-policy.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
function retainedBytes(path: string, limit: number): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > limit) throw new Error("Retained assignment evidence exceeds its bound.");
        const bytes = Buffer.alloc(stat.size);
        if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("Retained assignment evidence changed.");
        return bytes;
    } finally { closeSync(fd); }
}
export interface AssignmentReport {
    version: 1; assignmentId: string; attemptId: string; requestDigest: string; status: "complete" | "incomplete"; reason: string;
    evidence: Array<{ path: string; digest: string; source: string; explanation: string }>;
}

/** Runs synchronously under the authenticated handler: no yield between authority and persistence. */
export function recordAssignmentReport(id: string, input: unknown, assertAuthority: () => RunMeta, current?: PermissionSnapshot) {
    const meta = assertAuthority();
    const report = input as { status: string; reason: string; evidence: Array<{ path: string; explanation: string }> };
    if (!["complete", "incomplete"].includes(report.status) || !report.reason?.trim() || report.reason.length > 2048
        || !Array.isArray(report.evidence) || report.evidence.length < 1 || report.evidence.length > 4) throw new Error("Invalid assignment report.");
    const root = realpathSync(meta.cwd);
    const directory = join(runDir(id), "assignment-report-v1");
    const captured = (meta.operations?.policy.sandbox as { permissions?: Partial<PermissionProfile> } | null)?.permissions;
    if (captured && captured.projectFiles !== "read" && captured.projectFiles !== "read-write") throw new Error("Captured assignment evidence read permission refused.");
    for (const policy of [current?.permissions, current?.subagentPermissions]) {
        if (policy?.enabled && policy.projectFiles !== "read" && policy.projectFiles !== "read-write") throw new Error("Current assignment evidence read permission refused.");
    }
    if (meta.operations?.policy.sandbox && !current?.permissions) throw new Error("Current assignment evidence read authority unavailable.");
    const requestDigest = hash(JSON.stringify([report.status, report.reason, report.evidence.map((e) => [e.path, e.explanation])]));
    if (meta.assignmentReport) {
        const accepted = readAssignmentReport(meta)!;
        if (accepted.requestDigest !== requestDigest) throw new Error("Conflicting assignment report refused.");
        return { reportId: meta.assignmentReport.digest, status: accepted.status, note: "Report retained. Assignment terminalization after exit and exact parent disposition remain separate." };
    }
    const snapshots = report.evidence.map((e) => {
        if (!e.path || !e.explanation?.trim() || e.explanation.length > 1024) throw new Error("Evidence needs a bounded explanation.");
        const source = realpathSync(resolve(root, e.path));
        if (!inside(root, source) || credentialFilePaths(homedir()).some((p) => inside(p, source))) throw new Error("Foreign or credential assignment evidence refused.");
        const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > 65536) throw new Error("Assignment evidence must be a file of at most 65536 bytes.");
            const bytes = Buffer.alloc(stat.size);
            if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("Assignment evidence changed during capture.");
            return { bytes, digest: hash(bytes), source, explanation: e.explanation };
        } finally { closeSync(fd); }
    });
    const retained: AssignmentReport = { version: 1, assignmentId: meta.assignment!.assignmentId, attemptId: id, requestDigest,
        status: report.status as AssignmentReport["status"], reason: report.reason,
        evidence: snapshots.map(({ digest, source, explanation }) => ({ path: join(directory, digest), digest, source, explanation })) };
    const text = JSON.stringify(retained);
    if (Buffer.byteLength(text) > 65536) throw new Error("Assignment report exceeds its retained metadata bound.");
    const digest = hash(text);
    const latest = assertAuthority();
    if (latest.assignmentReport) {
        if (latest.assignmentReport.digest !== digest) throw new Error("Conflicting assignment report refused.");
        readAssignmentReport(latest);
    } else {
        mkdirSync(directory, { recursive: true });
        for (const snapshot of snapshots) writeFileSync(join(directory, snapshot.digest), snapshot.bytes, { mode: 0o600 });
        const path = join(directory, `${digest}.json`);
        writeFileSync(path, text, { mode: 0o600 });
        writeMeta({ ...latest, assignmentReport: { version: 1, assignmentId: retained.assignmentId, attemptId: id, digest, path } });
    }
    return { reportId: digest, status: report.status, note: "Report retained. Assignment terminalization after exit and exact parent disposition remain separate." };
}

export function readAssignmentReport(meta: RunMeta): AssignmentReport | null {
    const ref = meta.assignmentReport;
    if (!ref) return null;
    if (ref.version !== 1 || !/^[a-f0-9]{64}$/.test(ref.digest) || ref.assignmentId !== meta.assignment?.assignmentId || ref.attemptId !== meta.id
        || ref.path !== join(runDir(meta.id), "assignment-report-v1", `${ref.digest}.json`)) throw new Error("Foreign assignment report reference.");
    const text = retainedBytes(ref.path, 65536).toString("utf8");
    if (hash(text) !== ref.digest) throw new Error("Retained assignment report changed.");
    const report = JSON.parse(text) as AssignmentReport;
    if (report.version !== 1 || report.assignmentId !== ref.assignmentId || report.attemptId !== meta.id) throw new Error("Foreign assignment report.");
    for (const e of report.evidence) {
        if (!/^[a-f0-9]{64}$/.test(e.digest) || e.path !== join(runDir(meta.id), "assignment-report-v1", e.digest) || hash(retainedBytes(e.path, 65536)) !== e.digest) throw new Error("Retained assignment evidence changed.");
    }
    return report;
}
