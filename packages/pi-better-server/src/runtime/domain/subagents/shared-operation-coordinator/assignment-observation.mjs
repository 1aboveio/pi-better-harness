// Generated fixed launch domain from packages/pi-better-subagents/shared-operation-coordinator/assignment-observation.mjs. Do not edit directly.
// Generated from packages/operation-coordinator/assignment-observation.mjs. Do not edit directly.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { AssignmentInbox } from "./assignment-inbox.mjs";
/** Read-only, bounded projection input. Never creates/migrates a database. */
export function readAssignmentWaits(path, owner, connection) {
    let db;
    try {
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
        db = connection ?? new DatabaseSync(path, { readOnly: true });
        // v4 adds repair accounting; the observed wait/outcome fields are unchanged.
        if (!["1", "2", "3", "4"].includes(db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value)) {
            return { verified: false, waits: [], reason: "Unsupported coordinator schema; assignment state is unverified." };
        }
        const rows = db.prepare(`SELECT wait_id, generation, phase, phase_reason,
            acknowledgement_json, cancel_epoch FROM waits
            WHERE owner_kind = 'worker-conversation' AND owner_session_id = ? AND owner_workspace = ?
            ${owner.assignmentId ? "AND json_extract(origin_json, '$.assignmentRef') = ?" : `AND (
                EXISTS (SELECT 1 FROM json_each(?) AS attempt
                    WHERE attempt.value = json_extract(waits.origin_json, '$.attemptId')
                       OR attempt.value = json_extract(waits.park_json, '$.attemptId'))
                OR EXISTS (SELECT 1 FROM resume_claims AS claim, json_each(?) AS attempt
                    WHERE claim.wait_id = waits.wait_id AND claim.generation = waits.generation
                      AND claim.attempt_id = attempt.value)
                OR EXISTS (SELECT 1 FROM json_each(?) AS ref
                    WHERE json_extract(ref.value, '$.waitId') = waits.wait_id
                      AND json_extract(ref.value, '$.generation') = waits.generation)
            )`}
            ORDER BY created_at DESC, generation DESC LIMIT 100`).all(owner.sessionId, owner.workspace, ...(owner.assignmentId ? [owner.assignmentId] : [JSON.stringify(owner.attemptIds ?? []), JSON.stringify(owner.attemptIds ?? []), JSON.stringify(owner.waitRefs ?? [])]));
        const record = owner.assignmentId ? db.prepare("SELECT record_json FROM assignment_outcomes WHERE assignment_id = ?").get(owner.assignmentId) : null;
        const outcome = record ? JSON.parse(record.record_json) : null;
        if (outcome && (outcome.owner.sessionId !== owner.sessionId || outcome.owner.workspace !== owner.workspace))
            throw new Error("Foreign assignment outcome");
        return { verified: true, outcome, waits: rows.map((row) => ({
                waitId: row.wait_id, generation: row.generation, phase: row.phase,
                reason: row.phase_reason, cancelEpoch: row.cancel_epoch,
                acknowledgement: row.acknowledgement_json ? JSON.parse(row.acknowledgement_json) : null,
            })) };
    }
    catch {
        return { verified: false, waits: [], reason: "Coordinator state is unverified; compatible supervision is unavailable." };
    }
    finally {
        if (!connection)
            db?.close();
    }
}
/** A root read model owns this connection; ordinary observers remain one-shot. */
export function createAssignmentReader(path, inboxPath = ":memory:") {
    const inbox = new AssignmentInbox(inboxPath);
    let db;
    let identity;
    let snapshot = false;
    const statements = new Map();
    return {
        revision() {
            const { statSync } = createRequire(import.meta.url)("node:fs");
            const stat = statSync(path, { bigint: true });
            const next = `${stat.dev}:${stat.ino}`;
            if (identity !== next) {
                if (snapshot)
                    throw new Error("Coordinator identity changed during observation");
                db?.close();
                db = undefined;
                statements.clear();
                identity = next;
            }
            const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
            db ??= new DatabaseSync(path, { readOnly: true });
            return `${identity}:${db.prepare("PRAGMA data_version").get().data_version}`;
        },
        connection(refresh = true) { if (refresh)
            this.revision(); return db; },
        changes() { this.revision(); return inbox.receive(db, identity); },
        acknowledgeChanges(batch, complete) { inbox.acknowledge(batch, complete); },
        get changeMetrics() { return inbox.metrics; },
        beginSnapshot() {
            this.revision();
            if (snapshot)
                throw new Error("Coordinator snapshot already open");
            db.exec("BEGIN");
            snapshot = true;
            const release = () => {
                if (!snapshot)
                    return;
                try {
                    db.exec("ROLLBACK");
                }
                finally {
                    snapshot = false;
                }
            };
            try {
                // Pin the WAL read view before recording its revision; other writers keep advancing.
                db.prepare("SELECT count(*) FROM sqlite_schema").get();
                return { revision: this.revision(), release };
            }
            catch (error) {
                release();
                throw error;
            }
        },
        read(owner) {
            try {
                this.revision();
                return readAssignmentWaits(path, owner, { prepare(sql) {
                        if (!statements.has(sql))
                            statements.set(sql, db.prepare(sql));
                        return statements.get(sql);
                    } });
            }
            catch {
                return { verified: false, waits: [], reason: "Coordinator state is unverified; compatible supervision is unavailable." };
            }
        },
        conversationRevisions() {
            try {
                this.revision();
                if (!["1", "2", "3", "4"].includes(db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value))
                    return undefined;
                const hashes = new Map();
                const add = (sessionId, workspace, value) => {
                    const key = JSON.stringify([sessionId, workspace]);
                    if (!hashes.has(key))
                        hashes.set(key, createHash("sha256"));
                    hashes.get(key).update(JSON.stringify(value));
                };
                // One source pass per changed database revision, instead of one
                // projection/query/log parse for every historical attempt.
                for (const row of db.prepare(`SELECT w.*, (SELECT json_group_array(attempt_id)
                    FROM resume_claims c WHERE c.wait_id = w.wait_id AND c.generation = w.generation) AS claimed_attempts
                    FROM waits w WHERE owner_kind = 'worker-conversation' ORDER BY wait_id, generation`).all()) {
                    add(row.owner_session_id, row.owner_workspace, row);
                }
                for (const row of db.prepare("SELECT record_json FROM assignment_outcomes ORDER BY assignment_id").all()) {
                    const record = JSON.parse(row.record_json);
                    add(record.owner.sessionId, record.owner.workspace, record);
                }
                return new Map([...hashes].map(([key, hash]) => [key, hash.digest("hex")]));
            }
            catch {
                return undefined;
            }
        },
        upgradeObligations() {
            try {
                this.revision();
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return [];
                throw error;
            }
            const version = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value;
            if (!["1", "2", "3", "4"].includes(version))
                throw new Error("Unsupported coordinator schema during upgrade");
            const obligations = db.prepare("SELECT operation_id, task_id, observer_kind FROM operations WHERE phase='running' AND terminal_revision=0").all()
                .map(row => ({ kind: "unsettled-operation", id: row.task_id, operationId: row.operation_id, observer: row.observer_kind }));
            const reasons = db.prepare("SELECT claim_id AS id, state FROM resume_claims WHERE state IN ('claimed', 'published')").all()
                .map(row => ({ kind: "resume-claim", id: row.id, state: row.state }));
            for (const row of db.prepare("SELECT wait_id, generation, phase FROM waits WHERE owner_kind='worker-conversation' AND phase NOT IN ('consumed', 'cancelled') AND dispatch_disarmed=0").all()) {
                reasons.push({ kind: "worker-wait", id: row.wait_id, generation: row.generation, phase: row.phase });
            }
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subagent_launch_intents'").get()) {
                for (const row of db.prepare("SELECT owner, request_key, attempts FROM subagent_launch_intents WHERE state='accepted'").all()) {
                    reasons.push({ kind: "launch-intent", id: row.request_key, owner: row.owner, attempts: JSON.parse(row.attempts).map(attempt => attempt.id) });
                }
            }
            for (const row of db.prepare("SELECT value FROM coordinator_state WHERE key LIKE 'background-request-v1:%'").all()) {
                const request = JSON.parse(row.value);
                if (request.state !== 'returned')
                    reasons.push({ kind: 'background-request', id: request.key, owner: request.owner });
            }
            return [...obligations, ...reasons];
        },
        close() { if (snapshot) {
            db.exec("ROLLBACK");
            snapshot = false;
        } db?.close(); db = undefined; statements.clear(); identity = undefined; inbox.close(); },
    };
}
