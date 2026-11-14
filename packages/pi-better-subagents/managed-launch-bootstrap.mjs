import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { launchDigest } from "./managed-launch-journal.mjs";

/** Runs before the Pi CLI or any worker extension can execute task code. */
export function verifyManagedBootstrap(env = process.env) {
    if (!env.PI_MANAGED_SUBAGENT) return;
    const proof = JSON.parse(env.PI_MANAGED_SUBAGENT);
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(proof.path);
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    try {
        const epoch = db.prepare("SELECT epoch FROM subagent_management WHERE singleton=1").get()?.epoch;
        const row = db.prepare("SELECT * FROM subagent_launch_intents WHERE owner=? AND request_key=?").get(proof.owner, proof.key);
        const attempt = row && JSON.parse(row.attempts).find(value => value.id === proof.id);
        if (epoch !== proof.epoch || row?.epoch !== epoch || !attempt || attempt.token !== proof.token
            || !["prepared", "spawned"].includes(attempt.state)) throw new Error("Managed launch epoch/token is no longer admitted");
        const lease = JSON.parse(readFileSync(attempt.leasePath, "utf8"));
        if (lease.token !== attempt.lease || lease.sessionId !== attempt.sessionId || lease.attemptId !== attempt.id) throw new Error("Managed launch writer lease changed");
        if (launchDigest(JSON.parse(readFileSync(attempt.preflightPath, "utf8"))) !== attempt.preflightDigest) throw new Error("Managed launch preflight changed");
        if (attempt.policyPath && launchDigest(JSON.parse(readFileSync(attempt.policyPath, "utf8"))) !== attempt.policyDigest) throw new Error("Managed launch captured permissions changed");
        if (attempt.bootstrapped || (attempt.pid && attempt.pid !== process.pid)) throw new Error("Managed launch token already has a writer");
        attempt.bootstrapped = true;
        attempt.writerPid = process.pid;
        const attempts = JSON.parse(row.attempts).map(value => value.id === attempt.id ? attempt : value);
        db.prepare("UPDATE subagent_launch_intents SET attempts=? WHERE owner=? AND request_key=?").run(JSON.stringify(attempts), proof.owner, proof.key);
        db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }
}
verifyManagedBootstrap();
