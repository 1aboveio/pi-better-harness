/**
 * Exclusive ownership of each logical session, kept in one small JSON file per
 * daemon. A session is writable here only while this daemon holds it ("owned").
 * `epoch` rises every time ownership changes hands, so a stale holder can be told
 * apart from the current one.
 *
 *   owned --fence--> fenced --retire--> moved
 *     ^                |
 *     +----unfence-----+        (a later import back here: acquire -> owned, epoch + 1)
 *
 * A fenced or moved session refuses every command and is not resumed on boot, so a
 * crash mid-move can never leave two live writers; only an explicit unfence or
 * acquire changes that. A session with no record is owned at epoch 0.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type OwnershipState = "owned" | "fenced" | "moved";

export interface OwnershipRecord {
  sessionId: string;
  state: OwnershipState;
  epoch: number;
  /** Move that fenced or retired the session. */
  moveId?: string;
  /** Daemon that took the session over (state "moved"). */
  movedTo?: string;
  updatedAt: string;
}

interface OwnershipFile {
  version: 1;
  /** Stable identity of this daemon's state directory. */
  daemonId: string;
  sessions: Record<string, OwnershipRecord>;
}

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipError";
  }
}

export class OwnershipStore {
  readonly daemonId: string;
  private readonly path: string;
  private readonly records = new Map<string, OwnershipRecord>();

  constructor(path: string) {
    this.path = path;
    let daemonId: string = randomUUID();
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as OwnershipFile;
      daemonId = parsed.daemonId;
      for (const record of Object.values(parsed.sessions)) this.records.set(record.sessionId, record);
    }
    this.daemonId = daemonId;
    this.save();
  }

  get(sessionId: string): OwnershipRecord {
    return this.records.get(sessionId) ?? { sessionId, state: "owned", epoch: 0, updatedAt: new Date(0).toISOString() };
  }

  /** Every session this daemon has a record for (owned, fenced or moved). */
  list(): OwnershipRecord[] {
    return [...this.records.values()];
  }

  /** Why the session cannot take commands here, or undefined when this daemon owns it. */
  blockedReason(sessionId: string): string | undefined {
    const record = this.get(sessionId);
    if (record.state === "fenced") return `Session ${sessionId} is fenced for a move${record.moveId ? ` (${record.moveId})` : ""}`;
    if (record.state === "moved") return `Session ${sessionId} moved to another daemon${record.movedTo ? ` (${record.movedTo})` : ""}`;
    return undefined;
  }

  fence(sessionId: string, moveId: string): OwnershipRecord {
    const current = this.get(sessionId);
    if (current.state !== "owned") throw new OwnershipError(this.blockedReason(sessionId) ?? `Session ${sessionId} is not owned here`);
    return this.set({ ...current, state: "fenced", moveId });
  }

  /** Give the session back to this daemon after a failed move. Only the fencing move may do it. */
  unfence(sessionId: string, moveId?: string): OwnershipRecord {
    const current = this.get(sessionId);
    if (current.state !== "fenced") throw new OwnershipError(`Session ${sessionId} is not fenced`);
    if (moveId && current.moveId !== moveId) throw new OwnershipError(`Session ${sessionId} is fenced by move ${current.moveId}, not ${moveId}`);
    const { moveId: _done, ...rest } = current;
    return this.set({ ...rest, state: "owned" });
  }

  /** The target acknowledged: this daemon no longer owns the session. */
  retire(sessionId: string, moveId: string, movedTo: string): OwnershipRecord {
    const current = this.get(sessionId);
    if (current.state === "moved" && current.moveId === moveId) return current; // retry after a lost reply
    if (current.state !== "fenced" || current.moveId !== moveId) throw new OwnershipError(`Session ${sessionId} is not fenced by move ${moveId}`);
    return this.set({ ...current, state: "moved", movedTo });
  }

  /** This daemon takes the session at `epoch`; used by the import side. */
  acquire(sessionId: string, epoch: number, moveId: string): OwnershipRecord {
    const current = this.get(sessionId);
    if (current.state === "owned" && this.records.has(sessionId)) throw new OwnershipError(`Session ${sessionId} is already owned by this daemon`);
    if (current.state === "fenced") throw new OwnershipError(`Session ${sessionId} is fenced here; unfence it before importing`);
    return this.set({ sessionId, state: "owned", epoch: Math.max(epoch, current.epoch + 1), moveId, updatedAt: "" });
  }

  /** Forget an acquisition that was rolled back. */
  release(sessionId: string, previous: OwnershipRecord | undefined): void {
    if (previous) this.records.set(sessionId, previous);
    else this.records.delete(sessionId);
    this.save();
  }

  /** Raw record or undefined (for rollback). */
  peek(sessionId: string): OwnershipRecord | undefined {
    return this.records.get(sessionId);
  }

  private set(record: OwnershipRecord): OwnershipRecord {
    const next = { ...record, updatedAt: new Date().toISOString() };
    this.records.set(record.sessionId, next);
    this.save();
    return next;
  }

  private save(): void {
    const file: OwnershipFile = { version: 1, daemonId: this.daemonId, sessions: Object.fromEntries(this.records) };
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
