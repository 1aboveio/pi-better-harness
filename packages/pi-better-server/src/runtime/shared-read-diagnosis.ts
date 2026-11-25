import { randomUUID } from "node:crypto";

export type ReadHealth = "ready" | "rebuilding" | "degraded";

/** Group only facts about this daemon's read plane. Never return a scope, operation or owner. */
export class SharedReadDiagnosis {
  private incident?: { id: string; state: ReadHealth; generation: number; recommendation: string };
  private readonly owners = new Map<string, boolean>();
  verified(owner: string, incident: unknown) {
    if (!this.incident || this.incident.id !== incident || !this.owners.has(owner)) return false;
    this.owners.set(owner, true);
    return true;
  }
  inspect(state: ReadHealth, generation: number, owner: string) {
    if (state === "ready") { this.incident = undefined; this.owners.clear(); return; }
    if (this.incident?.state === state && this.incident.generation === generation) {
      if (!this.owners.has(owner) && this.owners.size < 512) this.owners.set(owner, false);
      return [...this.owners.values()].includes(true)
        ? { ...this.incident, recommendation: "An affected read has recovered. Retry your original observation by ID to verify recovery in this session." }
        : this.incident;
    }
    this.owners.clear();
    this.owners.set(owner, false);
    const recommendation = state === "rebuilding"
      ? "The daemon is rebuilding its shared read inventory. Keep the original operation running. Retry its observation by the original ID once inventory is ready."
      : "The daemon read worker is degraded. Check worker recovery, then read the original operation by ID to verify its state.";
    return this.incident = { id: randomUUID(), state, generation, recommendation };
  }
}
