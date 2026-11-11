/**
 * Independent-process probe for the supervision-authority regression.
 *
 * The parent test spawns this file with a disposable store directory. The probe
 * opens the real observed-wait host, uses a supervisor that always reports the
 * same healthy running state, and reports actual SQLite SELECT statements,
 * supervisor inspections and operations-table updates for a measured pass
 * sequence. It never launches a command or touches user state.
 */
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LocalSupervisor } from "../supervisor/index.js";

interface ProbeRequest {
  root: string;
  session: string;
  passes: number;
  stay: boolean;
}

interface ProbeReport {
  pid: number;
  session: string;
  warmWrites: number;
  steady: {
    passes: number;
    inspections: number;
    writes: number;
    queries: number;
  };
}

const request = JSON.parse(process.argv[2] ?? "{}") as ProbeRequest;
if (!request.root || !request.session || !Number.isInteger(request.passes)) {
  throw new Error("probe requires root, session and passes");
}

// Count real prepared SELECT statements after the warm-up. Production opens the
// store through this prototype, so the measurement covers the host's own reads.
const databasePrototype = DatabaseSync.prototype as unknown as {
  prepare(this: DatabaseSync, sql: string): unknown;
};
const originalPrepare = databasePrototype.prepare;
let selectQueries = 0;
databasePrototype.prepare = function (this: DatabaseSync, sql: string) {
  if (/^\s*(select|with)\b/i.test(sql)) selectQueries += 1;
  return originalPrepare.call(this, sql);
};

const probeDb = new DatabaseSync(join(request.root, "operations.sqlite"));
const clearWrites = (): void => { probeDb.exec("DELETE FROM probe_updates"); };
const countWrites = (): number => {
  const row = probeDb.prepare("SELECT count(*) AS count FROM probe_updates").get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
};

let inspections = 0;
const supervisor: LocalSupervisor = {
  async start() {
    throw new Error("the supervision-authority probe does not launch");
  },
  inspect(taskId) {
    inspections += 1;
    return healthyRunning(taskId);
  },
  snapshot(taskId) {
    return healthyRunning(taskId);
  },
  async stop() {
    return undefined;
  },
};

function healthyRunning(taskId: string) {
  const now = Date.now();
  return {
    taskId,
    token: "probe-running",
    kind: "process" as const,
    status: "running" as const,
    terminal: false,
    launch: {
      taskId,
      token: "probe-running",
      kind: "process" as const,
      createdAt: now,
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: request.root,
      requestHash: "probe-running",
    },
    taskDir: join(request.root, "probe-task"),
    logs: { stdout: "", stderr: "", events: "" },
    observedAt: now,
  };
}

async function main(): Promise<void> {
  const events = new EventEmitter();
  const pi = {
    events,
    registerTool(definition: unknown) { return definition; },
    on() { return () => {}; },
  } as unknown as ExtensionAPI;
  const { createObservedWaitHost } = await import("../observed-waits.js");
  const host = createObservedWaitHost(pi, {
    storePath: join(request.root, "operations.sqlite"),
    supervisorDirectory: join(request.root, "supervisor"),
    pollMs: 0,
    supervisor,
    notifyParent: () => {},
  });
  const ctx = {
    cwd: request.root,
    sessionManager: {
      getSessionId: () => request.session,
      getBranch: () => [],
    },
    isIdle: () => true,
  } as unknown as ExtensionContext;

  try {
    host.start(ctx);
    await host.reconcileNow();
    const warmWrites = countWrites();
    clearWrites();
    selectQueries = 0;
    inspections = 0;
    for (let pass = 0; pass < request.passes; pass += 1) await host.reconcileNow();
    const queries = selectQueries;
    const report: ProbeReport = {
      pid: process.pid,
      session: request.session,
      warmWrites,
      steady: {
        passes: request.passes,
        inspections,
        writes: countWrites(),
        queries,
      },
    };
    process.stdout.write(`PROBE_REPORT ${JSON.stringify(report)}\n`);
  } finally {
    if (!request.stay) {
      host.close();
      probeDb.close();
    }
  }
  if (request.stay) {
    keepAlive();
  }
}

function keepAlive(): void {
  setInterval(() => {}, 60_000);
}

await main();
