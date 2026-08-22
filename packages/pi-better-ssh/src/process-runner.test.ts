import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRemoteRunner } from "./process-runner.js";

// @covers pi-better-ssh.process-runner
// @level integration
describe("process remote runner", () => {
  it("captures a complete large output while retaining a bounded tail", async () => {
    const runner = createProcessRemoteRunner();
    const result = await runner.runOnce({
      argv: [process.execPath, "-e", "for(let i=1;i<=2100;i++) console.log(`line-${i}`)"],
      shell: false,
    }, 100 * 1024);

    try {
      expect(result.exitCode).toBe(0);
      expect(result.outputCapture).toMatchObject({ totalLines: 2101 });
      expect(result.outputCapture?.fullOutputPath && existsSync(result.outputCapture.fullOutputPath)).toBe(true);
      expect(readFileSync(result.outputCapture!.fullOutputPath!, "utf8")).toContain("line-1\n");
      expect(readFileSync(result.outputCapture!.fullOutputPath!, "utf8")).toContain("line-2100\n");
    } finally {
      if (result.outputCapture?.fullOutputPath) {
        rmSync(dirname(result.outputCapture.fullOutputPath), { recursive: true, force: true });
      }
    }
  });

  it("terminates its child on timeout and abort without invoking SSH cleanup", async () => {
    const runner = createProcessRemoteRunner();
    const timedOut = await runner.runOnce({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      shell: false,
    }, undefined, 20);
    expect(timedOut).toMatchObject({ exitCode: null, timedOut: true });

    const controller = new AbortController();
    const abortedPromise = runner.runOnce({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      shell: false,
    }, undefined, undefined, controller.signal);
    controller.abort();
    const aborted = await abortedPromise;
    expect(aborted.exitCode).toBeNull();
    expect(controller.signal.aborted).toBe(true);
  });
});
