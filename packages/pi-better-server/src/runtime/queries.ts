import type { Socket } from "node:net";
import { WorkReadModel, type WorkScope } from "./read-model.ts";

export function workScope(input: unknown): WorkScope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A runtime scope object is required");
  const value = input as Record<string, unknown>;
  for (const key of ["cwd", "sessionId", "id", "cursor"]) if (value[key] !== undefined && (typeof value[key] !== "string" || String(value[key]).length > 4096)) throw new Error(`Invalid scope ${key}`);
  if (value.sessionId && !value.cwd) throw new Error("Session scope requires cwd");
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 200)) throw new Error("Runtime limit must be from 1 to 200");
  if (value.active !== undefined && typeof value.active !== "boolean") throw new Error("Invalid active scope");
  if (value.detail !== undefined && (typeof value.detail !== "boolean" || (value.detail && !value.id))) throw new Error("Detail requires an exact run ID");
  if (value.statuses !== undefined && (!Array.isArray(value.statuses) || value.statuses.length > 9 || value.statuses.some(s => !["running", "waiting", "completed", "failed", "cancelled", "killed", "exited", "orphaned", "lost"].includes(String(s))))) throw new Error("Invalid assignment status filter");
  if (value.background !== undefined && typeof value.background !== "boolean") throw new Error("Invalid background scope");
  if (value.backgroundHistory !== undefined && typeof value.backgroundHistory !== "boolean") throw new Error("Invalid background history scope");
  if (value.backgroundAll !== undefined && (typeof value.backgroundAll !== "boolean" || value.backgroundAll && !value.backgroundHistory)) throw new Error("All backgrounds requires an explicit history query");
  return { backgroundAll: value.backgroundAll as boolean | undefined, backgroundHistory: value.backgroundHistory as boolean | undefined, background: value.background as boolean | undefined, cwd: value.cwd as string | undefined, sessionId: value.sessionId as string | undefined, id: value.id as string | undefined,
    cursor: value.cursor as string | undefined, limit: value.limit as number | undefined, active: value.active as boolean | undefined, detail: value.detail as boolean | undefined, statuses: value.statuses as string[] | undefined };
}

/** Snapshot capture and observer installation execute at one synchronous serial point. */
export class WorkQueries {
  private dispose?: () => void;
  private paused = false;
  private model: WorkReadModel;
  private socket: Socket;
  private maxQueuedBytes: number;
  constructor(model: WorkReadModel, socket: Socket, maxQueuedBytes = 4 * 1024 * 1024) {
    this.model = model; this.socket = socket; this.maxQueuedBytes = maxQueuedBytes;
    // A failed peer owns no usable subscription; terminate its queued writes too.
    socket.on("error", () => { this.close(); socket.destroy(); });
    socket.once("close", () => this.close());
    socket.on("drain", () => {
      if (!this.paused) return;
      this.paused = false;
      this.event({ type: "resync_required", reason: "slow-reader", instanceId: this.model.instanceId });
    });
  }
  private event(event: unknown) {
    if (this.socket.destroyed || this.paused) return;
    if (this.socket.writableLength > this.maxQueuedBytes) { this.paused = true; return; }
    const line = JSON.stringify({ type: "event", event }) + "\n";
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
      this.close();
      this.socket.write(JSON.stringify({ type: "event", event: { type: "resync_required", reason: "snapshot-too-large: narrow the scope or limit" } }) + "\n");
      return;
    }
    this.socket.write(line);
  }
  handle(command: Record<string, unknown>) {
    if (command.type === "runtime_unsubscribe") { this.close(); return { unsubscribed: true }; }
    if (command.type === "runtime_get_metrics") return { ...this.model.metrics };
    const scope = workScope(command.scope);
    const snapshot = this.model.snapshot(scope);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024) throw new Error("state-degraded: snapshot exceeds 4 MiB; narrow the scope or limit");
    if (command.type === "runtime_subscribe") {
      this.close();
      this.dispose = this.model.onChange(() => this.event({ type: "runtime_snapshot", snapshot: this.model.snapshot({ ...scope, cursor: undefined }) }));
      if (command.sinceSeq !== undefined && (command.instanceId !== snapshot.instanceId || command.sinceSeq !== snapshot.seq)) {
        return { ...snapshot, resyncRequired: true, resyncReason: command.instanceId !== snapshot.instanceId ? "instance-changed" : "replay-truncated" };
      }
    }
    return snapshot;
  }
  close() { this.dispose?.(); this.dispose = undefined; }
}
