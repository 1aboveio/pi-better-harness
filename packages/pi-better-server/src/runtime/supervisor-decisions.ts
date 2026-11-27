import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

const fields = ["reference", "operation", "host", "resource", "effect"] as const;
type Scope = Record<typeof fields[number], string>;
const questionMs = 120_000;
export const decisionDurationMs = 60 * 60_000;

function exactScope(raw: unknown): Scope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Missing decision scope");
  const scope = {} as Scope;
  for (const key of fields) {
    const text = (raw as Scope)[key];
    if (typeof text !== "string" || !text.trim() || text !== text.trim() || text.length > 200 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(text)) throw new Error("Invalid decision scope");
    scope[key] = text;
  }
  if (Object.keys(raw).length !== fields.length) throw new Error("Unsupported decision scope field");
  return scope;
}

/** One local user's answer to a specific proposal in a trusted workspace; execution still uses normal tool authorization. */
export function supervisorDecision(agentDir: string, owner: { cwd: string; sessionId: string; projectTrusted: boolean },
  command: Record<string, unknown>, now = Date.now()) {
  if (!owner.projectTrusted) throw new Error("Supervisor decisions require a trusted workspace");
  const scope = exactScope(command.scope);
  const key = createHash("sha256").update(JSON.stringify([owner.cwd, scope])).digest("hex");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(join(agentDir, "supervisor-decisions.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL, owner TEXT NOT NULL, token TEXT NOT NULL)");
    db.exec("CREATE INDEX IF NOT EXISTS decisions_expiry ON decisions(expires)");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM decisions WHERE expires <= ?").run(now);
    const row = db.prepare("SELECT * FROM decisions WHERE id=?").get(key);
    const lookup = () => ({ status: row?.state ?? "missing", expires: row?.expires });
    let result;
    if (command.action === "decision-query") result = lookup();
    else if (command.action === "decision-request") {
      if (row) result = lookup();
      else {
        const token = randomUUID();
        db.prepare("INSERT INTO decisions VALUES(?, 'pending', ?, ?, ?)").run(key, now + questionMs, owner.sessionId, token);
        result = { status: "ask", token, scope, workspace: owner.cwd, timeoutMs: questionMs, durationMinutes: decisionDurationMs / 60_000 };
      }
    } else if (command.action === "decision-answer") {
      if (row?.state !== "pending" || row.owner !== owner.sessionId || row.token !== command.token) result = { status: "stale" };
      else if (command.answer === "cancelled") {
        db.prepare("DELETE FROM decisions WHERE id=?").run(key);
        result = { status: "cancelled" };
      } else {
        if (command.answer !== "approved" && command.answer !== "denied") throw new Error("Invalid decision answer");
        db.prepare("UPDATE decisions SET state=?, expires=?, token='' WHERE id=?").run(command.answer, now + decisionDurationMs, key);
        result = { status: command.answer, expires: now + decisionDurationMs };
      }
    } else throw new Error("Unsupported decision action");
    db.exec("COMMIT");
    return result;
  } finally { db.close(); }
}
