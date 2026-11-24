import { randomUUID } from "node:crypto";

export type ReadHealth = "ready" | "rebuilding" | "degraded";

/** Group only facts about this daemon's read plane. Never return a scope, operation or owner. */
export class SharedReadDiagnosis {
  private incident?: { id: string; state: ReadHealth; generation: number; recommendation: string };
  inspect(state: ReadHealth, generation: number) {
    if (state === "ready") { this.incident = undefined; return; }
    if (this.incident?.state === state && this.incident.generation === generation) return this.incident;
    const recommendation = state === "rebuilding"
      ? "The daemon is rebuilding its shared read inventory. Keep the original operation running. Retry its observation by the original ID once inventory is ready."
      : "The daemon read worker is degraded. Check worker recovery, then read the original operation by ID to verify its state.";
    return this.incident = { id: randomUUID(), state, generation, recommendation };
  }
}
