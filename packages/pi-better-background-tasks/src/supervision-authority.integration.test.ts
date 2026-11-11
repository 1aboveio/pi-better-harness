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

function startProbe(root: string, session: string, stay: boolean): Probe {
  const child = spawn(process.execPath, [
    "--import", "tsx", probePath,
    JSON.stringify({ root, session, passes: PASSES, stay }),
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
      expect(ownerReport.steady.queries, "one running-set read and one pending-outbox read per pass").toBe(PASSES * 2);

      // An unrelated live process sees every running operation but must not
      // inspect, write, or take over any of them.
      db.exec("DELETE FROM probe_updates");
      const unrelated = startProbe(root, "unrelated-b", false);
      const unrelatedReport = await unrelated.report;
      expect(unrelatedReport.warmWrites).toBe(0);
      expect(unrelatedReport.steady.inspections).toBe(0);
      expect(unrelatedReport.steady.writes).toBe(0);
      expect(unrelatedReport.steady.queries).toBe(ownerReport.steady.queries);
      expect(countUpdates(), "no operations row changed while both hosts stayed healthy").toBe(0);
      expect(
        ownerReport.steady.inspections + unrelatedReport.steady.inspections,
        "two live hosts do not double the inspection work",
      ).toBe(TASK_COUNT * PASSES);

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
      expect(countUpdates(), "takeover happens once, not on every reconciliation pass").toBe(0);
      failover.child.kill("SIGKILL");
      await once(failover.child, "exit");
    } finally {
      db.close();
    }
  }, 60_000);
});
