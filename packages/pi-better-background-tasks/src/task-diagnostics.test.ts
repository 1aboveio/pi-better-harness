import { describe, expect, it, vi } from "vitest";
import { inspectTaskProcess } from "./task-diagnostics.js";
import type { BackgroundTaskMeta } from "./types.js";
import { currentProcessStartToken } from "./process-identity.js";

const meta = { pid: 123, pidStartTime: "Sun Oct 25 10:00:00 2026", kind: "process", status: "running" } as BackgroundTaskMeta;

describe.skipIf(typeof process.getuid !== "function")("permission-respecting Unix task diagnostics", () => {
  it("does not use an unconfined ps workaround for a confined Main agent", () => {
    const probe = vi.fn();
    expect(inspectTaskProcess(meta, "confined", probe)).toMatchObject({ availability: "unavailable" });
    expect(probe).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")("reads the real current process without exposing its arguments", () => {
    const result = inspectTaskProcess({ ...meta, pid: process.pid, pidStartTime: currentProcessStartToken() }, "read");
    expect(result).toMatchObject({ availability: "available", identity: "matches" });
    expect(result.cpuTime).toMatch(/\d/);
    expect(result).not.toHaveProperty("argv");
  });
  it.each(["off", "unknown"] as const)("does not probe when process access is %s", (access) => {
    const probe = vi.fn(() => { throw new Error("must not inspect the OS"); });
    expect(inspectTaskProcess(meta, access, probe)).toMatchObject({ availability: "blocked" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports sampled wait evidence without claiming a sleeping process is hung", () => {
    const result = inspectTaskProcess(meta, "read", () => ({ uid: process.getuid!(), startTime: "Sun Oct 25 10:00:00 2026", state: "S", cpuTime: "0:00.01", waitChannel: "pipe_read" }));
    expect(result).toMatchObject({ availability: "available", identity: "matches", state: "S", waitChannel: "pipe_read" });
    expect(result.limit).toContain("cannot prove useful work or a hang");
  });

  it("does not attribute activity to a recycled PID or another user", () => {
    for (const row of [
      { uid: process.getuid!(), startTime: "Sun Oct 25 11:00:00 2026" },
      { uid: process.getuid!() + 1, startTime: meta.pidStartTime! },
    ]) {
      const result = inspectTaskProcess(meta, "read", () => ({ ...row, state: "R", cpuTime: "1:00", waitChannel: "-" }));
      expect(result).toMatchObject({ availability: "unavailable" });
      expect(result).not.toHaveProperty("cpuTime");
    }
  });

  it("distinguishes an absent process, unavailable start identity and remote execution", () => {
    expect(inspectTaskProcess(meta, "read", () => undefined)).toMatchObject({ identity: "absent", availability: "available" });
    expect(inspectTaskProcess({ ...meta, pidStartTime: undefined }, "read", () => ({ uid: process.getuid!(), startTime: "now", state: "R", cpuTime: "0:00", waitChannel: "-" })))
      .toMatchObject({ identity: "unverified", availability: "unavailable" });
    const probe = vi.fn();
    expect(inspectTaskProcess({ ...meta, ssh: { target: "example" } as BackgroundTaskMeta["ssh"] }, "read", probe)).toMatchObject({ availability: "unavailable" });
    expect(probe).not.toHaveBeenCalled();
  });
});