import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openStore } from "./shared-operation-coordinator/index.js";

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

interface Probe {
  child: ChildProcess;
  report: Promise<ProbeReport>;
}

const PASSES = 5;
const TASK_COUNT = 14;
const probePath = fileURLToPath(new URL("./test-support/supervision-authority-probe.ts", import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function workspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `observed-waits-${name}-`));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function startProbe(root: string, session: string, stay: boolean, options: { identityless?: boolean } = {}): Probe {
  const child = spawn(process.execPath, [
    "--import", "tsx", probePath,
    JSON.stringify({ root, session, passes: PASSES, stay, identityless: options.identityless === true }),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const report = new Promise<ProbeReport>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`independent probe timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("PROBE_REPORT ")) continue;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(JSON.parse(line.slice("PROBE_REPORT ".length)) as ProbeReport);
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`independent probe exited before reporting (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
  });
  return { child, report };
}

function seedOperations(root: string): void {
  const store = openStore({ path: join(root, "operations.sqlite") });
  try {
    for (let index = 0; index < TASK_COUNT; index += 1) {
      store.registerOperation({
        operationId: `op_multi_${index}`,
        taskId: `bgs_${(index + 1).toString(16).padStart(20, "0")}`,
        launchToken: `launch_multi_${index}`,
        owner: {
          kind: "parent-session",
          sessionId: "owner-a",
          workspace: root,
          branchId: null,
          goalId: null,
        },
        observer: { kind: "background-tasks", version: "1" },
      });
    }
  } finally {
    store.close();
  }
}

describe("supervision authority across independent processes", () => {
  it("keeps identityless followers behind the discovery holder", async () => {
    const root = workspace("multi-process-identityless");
    seedOperations(root);
    const db = new DatabaseSync(join(root, "operations.sqlite"));
    db.exec("CREATE TABLE probe_updates (host TEXT)");
    db.exec(`CREATE TRIGGER probe_update AFTER UPDATE ON operations BEGIN
      INSERT INTO probe_updates VALUES (json_extract(NEW.supervision_json, '$.hostId'));
    END`);
    const countUpdates = (): number => {
      const row = db.prepare("SELECT count(*) AS count FROM probe_updates").get() as { count?: number } | undefined;
      return Number(row?.count ?? 0);
    };

    try {
      const owner = startProbe(root, "owner-a", true);
      const ownerReport = await owner.report;
      expect(ownerReport.steady.globalScans).toBe(PASSES);
      expect(ownerReport.steady.inspections).toBe(TASK_COUNT * PASSES);

      db.exec("DELETE FROM probe_updates");
      const identityless = startProbe(root, "unrelated-identityless", false, { identityless: true });
      const identitylessReport = await identityless.report;
      expect(identitylessReport.warmWrites).toBe(0);
      expect(identitylessReport.steady.globalScans, "no global enumeration without the discovery claim").toBe(0);
      expect(identitylessReport.steady.inspections, "no foreign inspection without operation authority").toBe(0);
      expect(identitylessReport.steady.writes).toBe(0);
      expect(identitylessReport.steady.localScans).toBe(PASSES);
      expect(identitylessReport.steady.processProbes, "one discovery-holder identity check per pass").toBe(PASSES);
      expect(identitylessReport.steady.directoryReads).toBe(0);
      expect(identitylessReport.steady.queries).toBe(PASSES * 3);
      expect(countUpdates(), "identityless follower made no operation writes").toBe(0);
      expect(
        ownerReport.steady.globalScans + identitylessReport.steady.globalScans,
        "identityless follower does not add global scans",
      ).toBe(PASSES);
      expect(
        ownerReport.steady.inspections + identitylessReport.steady.inspections,
        "identityless follower does not add foreign inspections",
      ).toBe(TASK_COUNT * PASSES);

      owner.child.kill("SIGKILL");
      await once(owner.child, "exit");
    } finally {
      db.close();
    }
  }, 60_000);

  it("serializes simultaneous contenders so no operation is claimed twice", async () => {
    const root = workspace("multi-process-contenders");
    seedOperations(root);
    const db = new DatabaseSync(join(root, "operations.sqlite"));
    db.exec("CREATE TABLE probe_updates (host TEXT)");
    db.exec("CREATE TABLE probe_claims (host TEXT, operation_id TEXT, health TEXT)");
    db.exec(`CREATE TRIGGER probe_update AFTER UPDATE ON operations BEGIN
      INSERT INTO probe_updates VALUES (json_extract(NEW.supervision_json, '$.hostId'));
      INSERT INTO probe_claims VALUES (json_extract(NEW.supervision_json, '$.hostId'), NEW.operation_id, NEW.health);
    END`);
    const countClaims = (): number => {
      const row = db.prepare("SELECT count(*) AS count FROM probe_claims").get() as { count?: number } | undefined;
      return Number(row?.count ?? 0);
    };

    try {
      const first = startProbe(root, "owner-a", true);
      const second = startProbe(root, "unrelated-b", true);
      const [firstReport, secondReport] = await Promise.all([first.report, second.report]);

      // Each operation belongs to exactly one winner. A lost stale contender
      // writes nothing, and neither steady host rewrites the claimed rows.
      expect(firstReport.warmWrites + secondReport.warmWrites).toBe(TASK_COUNT);
      expect(firstReport.steady.writes + secondReport.steady.writes).toBe(0);
      expect(firstReport.steady.inspections + secondReport.steady.inspections).toBe(TASK_COUNT * PASSES);
      expect(firstReport.steady.globalScans + secondReport.steady.globalScans).toBe(PASSES);
      expect(firstReport.steady.localScans + secondReport.steady.localScans).toBe(PASSES);
      expect(
        firstReport.steady.processProbes + secondReport.steady.processProbes,
        "at most one foreign-holder probe by the holder and one discovery-holder probe by the follower per pass",
      ).toBeLessThanOrEqual(PASSES * 2);
      expect(firstReport.steady.directoryReads + secondReport.steady.directoryReads).toBe(PASSES);
      // A concurrent warm-up can advance the change revision during the first
      // measured pass, adding at most one exact-owner refresh per client.
      expect(firstReport.steady.queries).toBeLessThanOrEqual(PASSES * 5);
      expect(secondReport.steady.queries).toBeLessThanOrEqual(PASSES * 5);
      expect(countClaims(), "one authority write per operation across both contenders").toBe(TASK_COUNT);

      first.child.kill("SIGKILL");
      second.child.kill("SIGKILL");
      await Promise.all([once(first.child, "exit"), once(second.child, "exit")]);
    } finally {
      db.close();
    }
  }, 60_000);

  it("keeps idle unrelated sessions observation-free and recovers a killed authority", async () => {
    const root = workspace("multi-process-authority");
    seedOperations(root);
    const db = new DatabaseSync(join(root, "operations.sqlite"));
    db.exec("CREATE TABLE probe_updates (host TEXT)");
    db.exec(`CREATE TRIGGER probe_update AFTER UPDATE ON operations BEGIN
      INSERT INTO probe_updates VALUES (json_extract(NEW.supervision_json, '$.hostId'));
    END`);
    const countUpdates = (): number => {
      const row = db.prepare("SELECT count(*) AS count FROM probe_updates").get() as { count?: number } | undefined;
      return Number(row?.count ?? 0);
    };

    try {
      // The owner process claims authority once, then performs only the
      // inspections that its own operations need.
      const owner = startProbe(root, "owner-a", true);
      const ownerReport = await owner.report;
      expect(ownerReport.warmWrites).toBe(TASK_COUNT);
      expect(ownerReport.steady.writes).toBe(0);
      expect(ownerReport.steady.inspections).toBe(TASK_COUNT * PASSES);
      expect(ownerReport.steady.globalScans, "the discovery holder scans the running set once per pass").toBe(PASSES);
      expect(ownerReport.steady.localScans).toBe(0);
      expect(ownerReport.steady.processProbes).toBe(0);
      expect(ownerReport.steady.directoryReads).toBe(PASSES);
      expect(ownerReport.steady.queries).toBe(PASSES * 3);

      // An unrelated live process sees every running operation but must not
      // inspect, write, or take over any of them.
      db.exec("DELETE FROM probe_updates");
      const unrelated = startProbe(root, "unrelated-b", false);
      const unrelatedReport = await unrelated.report;
      expect(unrelatedReport.warmWrites).toBe(0);
      expect(unrelatedReport.steady.inspections).toBe(0);
      expect(unrelatedReport.steady.writes).toBe(0);
      expect(unrelatedReport.steady.globalScans, "a follower never performs the global running scan").toBe(0);
      expect(unrelatedReport.steady.localScans, "a follower reads only its indexed assigned operations").toBe(PASSES);
      expect(unrelatedReport.steady.ownerScans).toBe(0);
      expect(unrelatedReport.steady.processProbes, "one discovery-holder identity check per follower pass").toBe(PASSES);
      expect(unrelatedReport.steady.directoryReads).toBe(0);
      expect(unrelatedReport.steady.queries).toBe(PASSES * 4);

      const secondUnrelated = startProbe(root, "unrelated-c", false);
      const secondUnrelatedReport = await secondUnrelated.report;
      expect(secondUnrelatedReport.warmWrites).toBe(0);
      expect(secondUnrelatedReport.steady.inspections).toBe(0);
      expect(secondUnrelatedReport.steady.writes).toBe(0);
      expect(secondUnrelatedReport.steady.globalScans).toBe(0);
      expect(secondUnrelatedReport.steady.localScans).toBe(PASSES);
      expect(secondUnrelatedReport.steady.processProbes).toBe(PASSES);
      expect(secondUnrelatedReport.steady.directoryReads).toBe(0);
      expect(secondUnrelatedReport.steady.queries).toBe(PASSES * 4);
      expect(countUpdates(), "no operations row changed while all three hosts stayed healthy").toBe(0);
      expect(
        ownerReport.steady.inspections + unrelatedReport.steady.inspections + secondUnrelatedReport.steady.inspections,
        "three live hosts do not multiply the inspection work",
      ).toBe(TASK_COUNT * PASSES);
      expect(
        ownerReport.steady.globalScans + unrelatedReport.steady.globalScans + secondUnrelatedReport.steady.globalScans,
        "client count does not multiply the global running scan",
      ).toBe(PASSES);

      // Kill the authority without a graceful release. The unrelated process
      // must prove the old pid is gone, take over once, and then stay stable.
      owner.child.kill("SIGKILL");
      await once(owner.child, "exit");
      db.exec("DELETE FROM probe_updates");
      const failover = startProbe(root, "unrelated-b", true);
      const failoverReport = await failover.report;
      expect(failoverReport.warmWrites).toBe(TASK_COUNT);
      expect(failoverReport.steady.writes).toBe(0);
      expect(failoverReport.steady.inspections).toBe(TASK_COUNT * PASSES);
      expect(failoverReport.steady.globalScans).toBe(PASSES);
      expect(failoverReport.steady.processProbes).toBe(0);
      expect(failoverReport.steady.directoryReads).toBe(PASSES);
      expect(failoverReport.steady.queries).toBe(PASSES * 3);
      expect(countUpdates(), "takeover happens once, not on every reconciliation pass").toBe(0);
      failover.child.kill("SIGKILL");
      await once(failover.child, "exit");
    } finally {
      db.close();
    }
  }, 60_000);
});
