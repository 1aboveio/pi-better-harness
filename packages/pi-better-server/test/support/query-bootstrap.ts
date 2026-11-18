import type { EventEmitter } from "node:events";

/** Retain the executor's first failure when an early exit prevents the receipt. */
export function queryBootstrap(worker: Pick<EventEmitter, "on" | "once" | "off">, diagnostic: () => {
  observation: { status: string; reason?: string };
  executor: { worker?: string; restarts?: number; timeouts?: number; status?: string };
}) {
  let online = false, heartbeats = 0;
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      worker.off("online", started); worker.off("message", message);
      worker.off("exit", exited); worker.off("error", failed);
    };
    const started = () => { online = true; };
    const message = (value: any) => {
      if (value.type === "heartbeat") heartbeats++;
      if (value.type === "fixture-ready") { cleanup(); resolve(); }
    };
    const exited = (code: number) => {
      cleanup();
      let state: unknown;
      try { state = diagnostic(); }
      catch (error) { state = { diagnosticError: String(error) }; }
      reject(new Error(`query fixture worker exited before bootstrap (code ${code}); ${JSON.stringify({ online, heartbeats, state })}`));
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    worker.on("online", started); worker.on("message", message);
    worker.once("exit", exited); worker.once("error", failed);
  });
}
