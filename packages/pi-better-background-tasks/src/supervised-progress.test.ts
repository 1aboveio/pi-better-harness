import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { supervisedProgress } from "./supervised-progress.ts";

describe("supervised task progress", () => {
  it("becomes quiet, stalls, and alerts on inclusive deadlines even without a new log event", ({ onTestFinished }) => {
    const dir = mkdtempSync(join(tmpdir(), "bg-progress-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const inspection = { status: "running", kind: "watch", claim: { claimedAt: 1 }, logs: { stdout: join(dir, "stdout.log") } };
    writeFileSync(join(dir, "progress.json"), JSON.stringify({ observedAt: 1000 }));
    for (const [now, state, alertDue] of [[60999, "healthy", false], [61000, "quiet", false], [301000, "stalled", false], [361000, "stalled", true]] as const) {
      expect(supervisedProgress(inspection, now)).toMatchObject({ observedAt: 1000, state, alertDue });
    }
    writeFileSync(inspection.logs.stdout, "same poll result");
    expect(supervisedProgress(inspection, 361000)?.observedAt).toBe(1000);
    writeFileSync(join(dir, "progress.json"), JSON.stringify({ observedAt: 361001 }));
    expect(supervisedProgress(inspection, 361002)?.state).toBe("healthy");
    expect(supervisedProgress({ ...inspection, status: "succeeded" }, 800000)).toBeUndefined();
  });
  it("recovers old process output and leaves old watches with unverifiable progress alone", ({ onTestFinished }) => {
    const dir = mkdtempSync(join(tmpdir(), "bg-old-progress-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const stdout = join(dir, "stdout.log"), stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "");
    writeFileSync(stderr, "last line");
    utimesSync(stderr, new Date(2000), new Date(2000));
    const source = { kind: "process", status: "running", claim: { claimedAt: 1 }, logs: { stdout, stderr } };
    expect(supervisedProgress(source, 362000)).toMatchObject({ observedAt: 2000, state: "stalled", alertDue: true });
    expect(supervisedProgress({ ...source, kind: "watch" }, 362000)).toBeUndefined();
    writeFileSync(join(dir, "progress.json"), "damaged");
    expect(supervisedProgress(source, 362000)).toBeUndefined();
  });
});
