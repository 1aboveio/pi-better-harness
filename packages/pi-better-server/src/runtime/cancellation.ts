import { join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
// @ts-expect-error Generated fixed-version domain implementation.
import { openStore } from "./domain/coordinator/index.mjs";
// @ts-expect-error Generated canonical supervisor; only stop is invoked here.
import { createLocalSupervisor } from "./domain/background/supervisor/supervisor.mjs";
// @ts-expect-error Generated canonical durable stop records.
import { readStopRequest, writeStopRequest } from "./domain/background/supervisor/store.mjs";
// @ts-expect-error Generated canonical host publication contract.
import { supervisorTerminalPublication } from "./domain/background/terminal-publication.mjs";

export type CancellationStage = "accepted" | "before-stop-file" | "after-stop-file" | "after-process-action";

/** Startup reads only durable intents, without activating mutation ownership for query clients. */
export function hasPendingCancellation(root: string): boolean {
  const path = join(root, "operation-coordinator.sqlite");
  if (!existsSync(path)) return false;
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = db.prepare("PRAGMA table_info(task_cancellation_requests)").all();
    if (!columns.some((column: any) => column.name === "result_json")) return false;
    return !!db.prepare("SELECT 1 FROM task_cancellation_requests WHERE result_json IS NULL LIMIT 1").get();
  } finally { db.close(); }
}

/** Cancellation only: no arbitrary method, module, launch or wait dispatch. */
export class RuntimeCancellation {
  private store: any;
  private pending = new Map<string, Promise<unknown>>();
  readonly epoch: number;
  private fault?: (stage: CancellationStage) => void;
  get busy() { return this.pending.size > 0; }
  constructor(root: string, instanceId: string, fault?: (stage: CancellationStage) => void) {
    this.fault = fault;
    this.store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    this.epoch = this.store.cancellationRuntimeEpoch(instanceId);
    for (const admission of this.store.pendingTaskCancellations()) void this.execute(admission);
  }
  async handle(command: Record<string, unknown>) {
    if (Object.keys(command).some(key => !["id", "type", "credential"].includes(key))) throw new Error("not_accepted: unsupported cancellation field");
    if (command.type === "runtime_cancellation_status") return { runtimeEpoch: this.epoch };
    if (typeof command.credential !== "string") throw new Error("not_accepted: permission-unavailable: cancellation credential required");
    let admission;
    try { admission = this.store.authorizedTaskCancellation(command.credential); }
    catch (error) { throw new Error(`not_accepted: ${String(error)}`); }
    const previous = this.store.getTaskCancellation(admission.request);
    if (command.type === "runtime_query_cancellation") return previous?.result?.status === "outcome_unknown" ? { ...previous, state: "outcome_unknown" } : previous ?? { state: "not_accepted" };
    if (command.type !== "runtime_cancel_task") throw new Error("not_accepted: unsupported cancellation operation");
    if (previous?.result) return previous.result.status === "outcome_unknown" ? { ...previous, state: "outcome_unknown" } : previous;
    try { this.store.acceptAuthorizedTaskCancellation({ credential: command.credential, runtimeEpoch: this.epoch }); }
    catch (error) { throw new Error(`not_accepted: ${String(error)}`); }
    this.fault?.("accepted");
    return this.execute(admission);
  }
  private execute(admission: any): Promise<any> {
    const key = JSON.stringify([admission.request.owner, admission.request.idempotencyKey]);
    const running = this.pending.get(key);
    if (running) return running;
    const intent = this.store.getTaskCancellation(admission.request);
    const execution = Promise.resolve().then(async () => {
      try {
        const supervisor = createLocalSupervisor({ directory: admission.directory });
        const stop = readStopRequest(admission.directory, intent.taskId);
        if (stop && stop.token !== intent.expectedLaunchToken) throw new Error("Exact stop token mismatch; refusing recovery");
        let result;
        if (stop) {
          // A durable stop may already have caused a signal before the crash.
          // Observe that exact execution; never repeat an ambiguous process action.
          result = supervisor.inspect(intent.taskId);
          if (result?.token !== intent.expectedLaunchToken) throw new Error("Exact launch token mismatch; refusing recovery");
        } else {
          const inspection = supervisor.snapshot(intent.taskId);
          if (inspection?.token !== intent.expectedLaunchToken) throw new Error("Exact launch token mismatch; refusing action");
          this.fault?.("before-stop-file");
          writeStopRequest(admission.directory, { version: 1, taskId: intent.taskId, token: intent.expectedLaunchToken, requestedAt: Date.now(), reason: intent.reason });
          this.fault?.("after-stop-file");
          result = await supervisor.stop(intent.taskId, { token: intent.expectedLaunchToken, reason: intent.reason });
          this.fault?.("after-process-action");
        }
        if (!result) throw new Error("Exact launch record unavailable; no replacement execution is permitted");
        const inspection = result.inspection ?? result;
        const operation = this.store.getOperation(intent.operationId);
        return this.store.finishTaskCancellationIntent({ request: admission.request, status: result.status, terminal: result.terminal,
          ...(result.terminal ? { publication: supervisorTerminalPublication(operation, inspection) } : {}) });
      } catch {
        return { ...this.store.unknownTaskCancellation(admission.request), state: "outcome_unknown" };
      } finally { this.pending.delete(key); }
    });
    this.pending.set(key, execution);
    return execution;
  }
  async close() { await Promise.all(this.pending.values()); this.store.close(); }
}
