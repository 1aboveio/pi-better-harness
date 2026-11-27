import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readMeta, processStartToken } from "./registry.ts";
import { processExists } from "./spawn.ts";
import { readConversationLease } from "./continuation.ts";
import type { WorkerOperationRegistration } from "./worker-waits.ts";

/** Bearer capabilities are private runtime records, never metadata or transcript fields. */
export function managedWorkerBridge(root: string) {
    const directory = join(root, "worker-bridge-admission");
    const socketDirectory = `/tmp/pi-wb-${process.getuid?.() ?? "user"}-${createHash("sha256").update(root).digest("hex").slice(0, 20)}`;
    const check = (path: string, directory: boolean) => {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Worker bridge admission storage is not private");
        return stat;
    };
    for (const path of [directory, socketDirectory]) { mkdirSync(path, { recursive: true, mode: 0o700 }); check(path, true); }
    const pathFor = (id: string) => {
        if (!/^sa_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid bridge attempt identity");
        return join(directory, `${id}.json`);
    };
    return {
        socketPath: join(socketDirectory, "operations.sock"),
        save(registration: WorkerOperationRegistration, token: string) {
            const path = pathFor(registration.runId), pending = `${path}.${process.pid}.tmp`;
            writeFileSync(pending, JSON.stringify({ registration, token }), { mode: 0o600, flag: "wx" });
            renameSync(pending, path);
        },
        remove(id: string) { try { unlinkSync(pathFor(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } },
        restore(): Array<WorkerOperationRegistration & { token: string }> {
            const records = [];
            for (const name of readdirSync(directory)) {
                if (!name.endsWith(".json")) continue;
                const path = join(directory, name);
                if (check(path, false).size > 1024 * 1024) throw new Error("Worker bridge admission record is too large");
                const { registration, token } = JSON.parse(readFileSync(path, "utf8"));
                const meta = readMeta(registration.runId);
                if (!meta || meta.management?.root !== root || !["running", "orphaned"].includes(meta.status) || !processExists(meta.pid)) continue;
                if (!meta.pidStartTime || processStartToken(meta.pid) !== meta.pidStartTime) throw new Error("Worker bridge writer identity is unverified");
                const lease = readConversationLease(meta.sessionId);
                if (!lease || lease.token !== registration.writerLeaseId || lease.attemptId !== meta.id || registration.conversationId !== meta.sessionId) throw new Error("Worker bridge writer lease changed");
                records.push({ ...registration, token });
            }
            return records;
        },
    };
}
