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
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
    globalScans: number;
    localScans: number;
    ownerScans: number;
    claimReads: number;
    revisionReads: number;
    processProbes: number;
    directoryReads: number;
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
let globalScans = 0;
let localScans = 0;
let ownerScans = 0;
let claimReads = 0;
let revisionReads = 0;
databasePrototype.prepare = function (this: DatabaseSync, sql: string) {
  const normalized = sql.replace(/\s+/g, " ").trim();
  if (/^(select|with)\b/i.test(normalized)) selectQueries += 1;
  if (/FROM operations WHERE phase = 'running' AND supervision_host_id = \?/i.test(normalized)) localScans += 1;
  else if (/FROM operations WHERE phase = \? ORDER BY/i.test(normalized)) globalScans += 1;
  else if (/FROM operations WHERE owner_kind = \?/i.test(normalized)) ownerScans += 1;
  if (/FROM discovery_claims/i.test(normalized)) claimReads += 1;
  if (/FROM coordinator_state/i.test(normalized)) revisionReads += 1;
  return originalPrepare.call(this, sql);
};

let processProbes = 0;
const originalKill = process.kill.bind(process);
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
  if (signal === 0) processProbes += 1;
  return originalKill(pid, signal as NodeJS.Signals);
}) as typeof process.kill;

let directoryReads = 0;
const mutableFs = fs as unknown as { readdirSync: (...args: unknown[]) => unknown };
const originalReaddirSync = mutableFs.readdirSync;
mutableFs.readdirSync = (...args: unknown[]) => {
  directoryReads += 1;
  return originalReaddirSync(...args);
};
syncBuiltinESMExports();

const probeDb = new DatabaseSync(join(request.root, "operations.sqlite"));
probeDb.exec("PRAGMA busy_timeout = 5000");
const ownHostPattern = `${process.pid}:%`;
const clearWrites = (): void => {
  probeDb.prepare("DELETE FROM probe_updates WHERE host LIKE ?").run(ownHostPattern);
};
const countWrites = (): number => {
  const row = probeDb.prepare("SELECT count(*) AS count FROM probe_updates WHERE host LIKE ?").get(ownHostPattern) as { count?: number } | undefined;
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
    globalScans = 0;
    localScans = 0;
    ownerScans = 0;
    claimReads = 0;
    revisionReads = 0;
    processProbes = 0;
    directoryReads = 0;
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
        globalScans,
        localScans,
        ownerScans,
        claimReads,
        revisionReads,
        processProbes,
        directoryReads,
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
