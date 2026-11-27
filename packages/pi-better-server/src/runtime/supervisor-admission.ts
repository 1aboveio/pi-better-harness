import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ReviewScenario = "stall-diagnosis" | "scope-review" | "commitment-followup";
export function reviewRevision(agentDir: string, scenario: string) {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).piBetterHarness?.supervisorMode;
    if (raw?.enabled === true && Array.isArray(raw.scenarios) && raw.scenarios.includes(scenario))
      return typeof raw.revision === "string" ? raw.revision : "initial";
  } catch { /* Unreadable settings cannot authorize a review. */ }
}

/** One model analysis per daemon. Leases are short and disappear on daemon replacement. */
export class SupervisorAdmission {
  private lease?: { token: string; owner: string; scenario: ReviewScenario; revision: string; expires: number };
  private readonly revision: (scenario: ReviewScenario) => string | undefined;
  private readonly now: () => number;
  constructor(revision: (scenario: ReviewScenario) => string | undefined, now = Date.now) {
    this.revision = revision;
    this.now = now;
  }
  request(owner: string, command: Record<string, unknown>) {
    const scenario = command.scenario;
    if (scenario !== "stall-diagnosis" && scenario !== "scope-review" && scenario !== "commitment-followup") throw new Error("Unsupported Supervisor scenario");
    const lease = this.lease;
    const revision = this.revision(scenario);
    if (lease && (lease.expires <= this.now() || lease.revision !== (lease.scenario === scenario ? revision : this.revision(lease.scenario)))) this.lease = undefined;
    if (!revision) return { status: "disabled" };
    if (command.action === "begin") {
      if (this.lease) return { status: "busy" };
      const token = randomUUID();
      this.lease = { owner, scenario, token, revision, expires: this.now() + 45_000 };
      return { status: "admitted", token };
    }
    if (command.action !== "finish" && command.action !== "release") throw new Error("Unsupported Supervisor action");
    if (!this.lease || this.lease.owner !== owner || this.lease.scenario !== scenario || this.lease.token !== command.token)
      return { status: "stale" };
    this.lease = undefined;
    return { status: command.action === "finish" ? "admitted" : "released" };
  }
}
