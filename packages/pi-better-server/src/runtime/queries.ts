import type { Socket } from "node:net";
import type { WorkReadModel, WorkScope, WorkSnapshot } from "./read-model.ts";

const eventEncodings = new WeakMap<object, string>();
const snapshotEncodings = new WeakMap<object, string>();
export function snapshotJSON(snapshot: object): string {
  let json = snapshotEncodings.get(snapshot);
  if (json === undefined) { json = JSON.stringify(snapshot); snapshotEncodings.set(snapshot, json); }
  return json;
}
// The global sequence may advance while a session's Background rows and deadlines stay unchanged.
function backgroundNotificationKey(snapshot: WorkSnapshot) {
  return JSON.stringify([snapshot.scopeRevision, snapshot.status, snapshot.reason, snapshot.nextDeadline]);
}
export const queryEncodingMetrics = { serializations: 0, frames: 0, bytes: 0 };

export function workScope(input: unknown): WorkScope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A runtime scope object is required");
  const value = input as Record<string, unknown>;
  for (const key of ["cwd", "sessionId", "id", "cursor"]) if (value[key] !== undefined && (typeof value[key] !== "string" || String(value[key]).length > 4096)) throw new Error(`Invalid scope ${key}`);
  if (value.sessionId && !value.cwd) throw new Error("Session scope requires cwd");
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 200)) throw new Error("Runtime limit must be from 1 to 200");
  if (value.active !== undefined && typeof value.active !== "boolean") throw new Error("Invalid active scope");
  if (value.endedAfter !== undefined && (typeof value.endedAfter !== "number" || !Number.isFinite(value.endedAfter))) throw new Error("Invalid history deadline");
  if (value.detail !== undefined && (typeof value.detail !== "boolean" || (value.detail && !value.id))) throw new Error("Detail requires an exact run ID");
  const statuses = value.background === true ? ["starting", "running", "succeeded", "failed", "cancelled", "timed_out", "lost"] : ["running", "waiting", "completed", "failed", "cancelled", "killed", "exited", "orphaned", "lost"];
  if (value.statuses !== undefined && (!Array.isArray(value.statuses) || value.statuses.length > statuses.length || value.statuses.some(s => typeof s !== "string" || !statuses.includes(s)))) throw new Error("Invalid assignment status filter");
  if (value.pendingRecipient !== undefined && (typeof value.pendingRecipient !== "boolean" || !value.sessionId || !value.cwd)) throw new Error("Pending recipient query requires an exact conversation");
  if (value.background !== undefined && typeof value.background !== "boolean") throw new Error("Invalid background scope");
  if (value.processId !== undefined && (!Number.isSafeInteger(value.processId) || Number(value.processId) <= 0 || value.background !== true)) throw new Error("Invalid background process identity");
  if (value.backgroundHistory !== undefined && typeof value.backgroundHistory !== "boolean") throw new Error("Invalid background history scope");
  if (value.backgroundAll !== undefined && (typeof value.backgroundAll !== "boolean" || value.backgroundAll && !value.backgroundHistory)) throw new Error("All backgrounds requires an explicit history query");
  return { processId: value.processId as number | undefined, backgroundAll: value.backgroundAll as boolean | undefined, backgroundHistory: value.backgroundHistory as boolean | undefined, background: value.background as boolean | undefined, cwd: value.cwd as string | undefined, sessionId: value.sessionId as string | undefined, id: value.id as string | undefined,
    pendingRecipient: value.pendingRecipient as boolean | undefined, cursor: value.cursor as string | undefined, limit: value.limit as number | undefined, active: value.active as boolean | undefined, endedAfter: value.endedAfter as number | undefined, detail: value.detail as boolean | undefined, statuses: value.statuses as string[] | undefined };
}

/** Snapshot capture and observer installation execute at one synchronous serial point. */
export class WorkQueries {
  private dispose?: () => void;
  private paused = false;
  private lastSnapshotSeq?: number;
  private lastBackgroundKey?: string;
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
    const snapshot = (event as any)?.type === "runtime_snapshot" ? (event as any).snapshot : undefined;
    const key = snapshot && this.lastBackgroundKey !== undefined ? backgroundNotificationKey(snapshot) : undefined;
    if (key !== undefined && key === this.lastBackgroundKey) return;
    if (this.socket.writableLength > this.maxQueuedBytes) { this.paused = true; return; }
    let line: string;
    if (snapshot) {
      let prefix = eventEncodings.get(snapshot);
      if (!prefix) {
        prefix = '{"type":"event","event":{"type":"runtime_snapshot","snapshot":' + snapshotJSON(snapshot);
        eventEncodings.set(snapshot, prefix); queryEncodingMetrics.serializations++;
      }
      // The snapshot is shared; its predecessor belongs to this subscription.
      line = prefix + ',"previousSeq":' + (this.lastSnapshotSeq ?? snapshot.seq) + '}}\n';
    } else line = JSON.stringify({ type: "event", event }) + "\n";
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
      this.close();
      this.socket.write(JSON.stringify({ type: "event", event: { type: "resync_required", reason: "snapshot-too-large: narrow the scope or limit" } }) + "\n");
      return;
    }
    if (snapshot) {
      this.lastSnapshotSeq = snapshot.seq;
      this.lastBackgroundKey = key;
    }
    this.socket.write(line);
    queryEncodingMetrics.frames++; queryEncodingMetrics.bytes += Buffer.byteLength(line);
  }
  handle(command: Record<string, unknown>) {
    if (command.type === "runtime_unsubscribe") { this.close(); return { unsubscribed: true }; }
    if (command.type === "runtime_get_metrics") return { ...this.model.metrics };
    const scope = workScope(command.scope);
    // An explicit read must see new commits. Publication callbacks already observe
    // the reconciled state and must not poll the inbox again for every subscriber.
    if (scope.background && !scope.backgroundHistory) this.model.prepareBackgroundQuery();
    const snapshot = this.model.snapshot(scope);
    if (Buffer.byteLength(snapshotJSON(snapshot)) > 4 * 1024 * 1024 - 1024) throw new Error("state-degraded: snapshot exceeds the 4 MiB frame allowance; narrow the scope or limit");
    if (command.type === "runtime_subscribe") {
      this.close();
      this.lastSnapshotSeq = snapshot.seq;
      this.lastBackgroundKey = scope.background && !scope.backgroundHistory ? backgroundNotificationKey(snapshot) : undefined;
      this.dispose = this.model.onChange(() => {
        try {
          this.event({ type: "runtime_snapshot", snapshot: this.model.snapshot({ ...scope, cursor: undefined }) });
        } catch (error) {
          // A stale detail or oversized scope must not fail shared reconciliation.
          this.close();
          this.event({ type: "resync_required", reason: String(error).slice(0, 512), instanceId: this.model.instanceId });
        }
      }, scope);
      if (command.sinceSeq !== undefined && (command.instanceId !== snapshot.instanceId || command.sinceSeq !== snapshot.seq)) {
        return { ...snapshot, resyncRequired: true, resyncReason: command.instanceId !== snapshot.instanceId ? "instance-changed" : "replay-truncated" };
      }
    }
    return snapshot;
  }
  close() { this.dispose?.(); this.dispose = undefined; }
}
