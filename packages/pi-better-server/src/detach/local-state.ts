import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MoveRecovery } from "../move/orchestrate.ts";

/** What this machine knows about a session that has been (or is being) detached to a daemon. */
export interface LocalRecord {
  sessionId: string;
  /** owned: usable here (also after a return). fenced: a detach is in flight. moved: a daemon owns it. */
  state: "owned" | "fenced" | "moved";
  epoch: number;
  /** The canonical writer after a return; older retained snapshots stay read-only. */
  sessionFile?: string;
  moveId?: string;
  /** Where the workspace lived before the session left; `return` rebuilds it there by default. */
  cwd?: string;
  /** Destination of the last detach, as the user named it. */
  host?: string;
  movedTo?: string;
  updatedAt: string;
}

export function localDaemonId(): string {
  return `local-${hostname()}`;
}

export function localStateDir(): string {
  return join(process.env.PI_REMOTE_STATE_DIR || join(getAgentDir(), "remote"), "local-sessions");
}

export function movesDir(stateDir: string): string {
  return join(stateDir, "moves");
}

export function readLocalRecord(stateDir: string, sessionId: string): LocalRecord | undefined {
  const file = join(stateDir, `${sessionId}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as LocalRecord;
}

export function writeLocalRecord(stateDir: string, record: Omit<LocalRecord, "updatedAt">): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, `${record.sessionId}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export function removeMoveDir(stateDir: string, moveId: string): void {
  rmSync(join(movesDir(stateDir), moveId), { recursive: true, force: true });
}

/** The recovery commands for a local source left fenced; they act on the local record, not on a daemon. */
export function localRecovery(host: string | undefined): MoveRecovery {
  const hostFlag = ` --host ${host ?? "<ssh-alias>"}`;
  return {
    abort: (sessionId) => `pi-remote recover ${sessionId} --abort${hostFlag}`,
    retire: (sessionId, moveId, movedTo) => `pi-remote recover ${sessionId} --retire --move-id ${moveId}${movedTo ? ` --moved-to ${movedTo}` : ""}${hostFlag}`,
  };
}

/** The reason this machine must not write to the session, or undefined when it may. */
export function localBlockedReason(stateDir: string, sessionId: string, sessionFile?: string): string | undefined {
  const record = readLocalRecord(stateDir, sessionId);
  if (record?.state === "owned" && record.sessionFile && sessionFile && resolve(record.sessionFile) !== resolve(sessionFile)) {
    const path = `'${record.sessionFile.replaceAll("'", `'\\''`)}'`;
    return `This retained session snapshot is read-only. Resume the returned conversation with \`pi --session ${path}\`.`;
  }
  const hostFlag = record?.host ? ` --host ${record.host}` : "";
  if (record?.state === "moved") {
    return `This session moved to ${record.host ?? record.movedTo ?? "a daemon"}. Bring it back with \`pi-remote return ${sessionId}${hostFlag}\`, or follow it with \`pi-remote tail\` / \`steer\`.`;
  }
  if (record?.state === "fenced") {
    return `A detach of this session is in flight (move ${record.moveId}). If it is stuck, check the daemon with \`pi-remote ls${hostFlag}\`: if it lacks the session run \`${localRecovery(record.host).abort(sessionId)}\`; if it holds it, run \`${localRecovery(record.host).retire(sessionId, record.moveId ?? "<move-id>")}\`.`;
  }
  return undefined;
}

/** Find the local record for a full session id or a unique prefix. */
export function findLocalRecord(stateDir: string, ref: string): LocalRecord {
  const ids = existsSync(stateDir) ? readdirSync(stateDir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)) : [];
  const matches = ids.includes(ref) ? [ref] : ids.filter((id) => id.startsWith(ref));
  if (matches.length === 0) throw new Error(`No local session record matches "${ref}"`);
  if (matches.length > 1) throw new Error(`"${ref}" is ambiguous; use more of the id`);
  return readLocalRecord(stateDir, matches[0]!)!;
}
