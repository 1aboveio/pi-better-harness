import type { EventEmitter } from "node:events";

/** Await pushed verified inventory, without admitting a read or warming its cache. */
export function querySourceReady(worker: Pick<EventEmitter, "on" | "once" | "off">, observation: () => {
  status: string; reason?: string; observedAt: number | null;
}) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`query fixture source inventory did not become ready within 5000 ms; ${JSON.stringify(observation())}`));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", changed); worker.off("exit", exited); worker.off("error", failed);
    };
    const changed = () => {
      const value = observation();
      if (value.status !== "ready" || value.observedAt === null) return;
      cleanup(); resolve();
    };
    const exited = (code: number) => { cleanup(); reject(new Error(`query fixture worker exited before source inventory readiness (code ${code})`)); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    worker.on("message", changed); worker.once("exit", exited); worker.once("error", failed);
    changed();
  });
}

/** Retain the executor's first failure when an early exit prevents the receipt. */
export function queryBootstrap(worker: Pick<EventEmitter, "on" | "once" | "off">, diagnostic: () => {
  observation: { status: string; reason?: string };
  executor: { worker?: string; restarts?: number; timeouts?: number; status?: string };
}, now = () => performance.now()) {
  let online = false, heartbeats = 0;
  const began = now();
  const phases: Array<{ phase: string; elapsedMs: number; heartbeats: number }> = [];
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      worker.off("online", started); worker.off("message", message);
      worker.off("exit", exited); worker.off("error", failed);
    };
    const started = () => { online = true; };
    const message = (value: any) => {
      if (value.type === "heartbeat") heartbeats++;
      if (value.type === "fixture-bootstrap-phase" && typeof value.phase === "string") {
        phases.push({ phase: value.phase.slice(0, 80), elapsedMs: Math.round(now() - began), heartbeats });
        if (phases.length > 16) phases.shift();
      }
      if (value.type === "fixture-ready") { cleanup(); resolve(); }
    };
    const exited = (code: number) => {
      cleanup();
      let state: unknown;
      try { state = diagnostic(); }
      catch (error) { state = { diagnosticError: String(error) }; }
      reject(new Error(`query fixture worker exited before bootstrap (code ${code}); ${JSON.stringify({ online, heartbeats, phases, state })}`));
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    worker.on("online", started); worker.on("message", message);
    worker.once("exit", exited); worker.once("error", failed);
  });
}
