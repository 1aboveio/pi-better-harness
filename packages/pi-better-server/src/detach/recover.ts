/**
 * Recovery for a local session a failed /detach left fenced. Acts on the local
 * record (no daemon owns a local session's fence) and first asks the daemon
 * whether it holds the session, so a recovery never leaves two live writers.
 */
import type { DaemonClient } from "../client.ts";
import { listSessions } from "../remote/sessions.ts";
import { findLocalRecord, removeMoveDir, writeLocalRecord } from "./local-state.ts";

export interface RecoverOptions {
  stateDir: string;
  /** Full session id or unique prefix. */
  ref: string;
  action: "abort" | "retire";
  /** Required for retire when the record has no move id (it always does for a fenced record). */
  moveId?: string;
  movedTo?: string;
  /** The daemon the detach targeted. */
  connect: () => Promise<DaemonClient>;
}

export async function recoverLocal(options: RecoverOptions): Promise<{ sessionId: string; state: "owned" | "moved" }> {
  const { stateDir, action } = options;
  const record = findLocalRecord(stateDir, options.ref);
  const { sessionId } = record;
  if (record.state === "moved" && action === "retire") return { sessionId, state: "moved" };
  if (record.state !== "fenced") throw new Error(`Session ${sessionId} is not fenced here (state: ${record.state}); nothing to recover`);
  if (options.moveId && record.moveId !== options.moveId) throw new Error(`Session ${sessionId} is fenced by move ${record.moveId}, not ${options.moveId}`);

  const client = await options.connect();
  let holds: boolean;
  try {
    holds = (await listSessions(client)).some((s) => s.sessionId === sessionId && !s.ownership);
  } finally {
    client.close();
  }
  if (action === "abort" && holds) {
    throw new Error(`The daemon holds session ${sessionId}; reopening it here would make two writers. Run \`pi-remote recover ${sessionId} --retire --move-id ${record.moveId} --host <ssh-alias>\` instead.`);
  }
  if (action === "retire" && !holds) {
    throw new Error(`The daemon does not hold session ${sessionId}; retiring here would lose it. Run \`pi-remote recover ${sessionId} --abort --host <ssh-alias>\` instead.`);
  }

  const { moveId, ...rest } = record;
  if (action === "abort") {
    writeLocalRecord(stateDir, { ...rest, state: "owned" });
    if (moveId) removeMoveDir(stateDir, moveId);
    return { sessionId, state: "owned" };
  }
  writeLocalRecord(stateDir, { ...rest, moveId, state: "moved", movedTo: options.movedTo ?? "unknown" });
  if (moveId) removeMoveDir(stateDir, moveId);
  return { sessionId, state: "moved" };
}
