import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRemoteRunner } from "./process-runner.js";

// @covers pi-better-ssh.process-runner
// @level integration
describe("process remote runner", () => {
  it("captures a complete large output while retaining a bounded tail", async () => {
    const runner = createProcessRemoteRunner();
    const fullOutput = Array.from({ length: 2100 }, (_, i) => `line-${i + 1}:${"x".repeat(100)}\n`).join("");
    const result = await runner.runOnce({
      argv: [process.execPath, "-e", "for(let i=1;i<=2100;i++) console.log(`line-${i}:${'x'.repeat(100)}`)"],
      shell: false,
    }, 100 * 1024);

    try {
      expect(result.exitCode).toBe(0);
      expect(result.outputCapture).toMatchObject({ totalLines: 2101, totalBytes: Buffer.byteLength(fullOutput) });
      expect(result.outputCapture?.fullOutputPath && existsSync(result.outputCapture.fullOutputPath)).toBe(true);
      expect(readFileSync(result.outputCapture!.fullOutputPath!, "utf8")).toBe(fullOutput);
      for (const tail of [result.stdout, result.outputCapture!.output]) {
        expect(tail).toContain(`line-2100:${"x".repeat(100)}\n`);
        expect(fullOutput.endsWith(tail)).toBe(true);
        expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(100 * 1024);
      }
    } finally {
      if (result.outputCapture?.fullOutputPath) {
        rmSync(dirname(result.outputCapture.fullOutputPath), { recursive: true, force: true });
      }
    }
  });

  it("terminates its child on timeout and abort", async () => {
    const runner = createProcessRemoteRunner();
    const timedOut = await runner.runOnce({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      shell: false,
    }, undefined, 20);
    expect(timedOut).toMatchObject({ exitCode: null, timedOut: true, signal: "SIGTERM" });

    const controller = new AbortController();
    const abortedPromise = runner.runOnce({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      shell: false,
    }, undefined, undefined, controller.signal);
    controller.abort();
    const aborted = await abortedPromise;
    expect(aborted).toMatchObject({ exitCode: null, signal: "SIGTERM" });
    expect(aborted.timedOut).toBeUndefined();
  });
});
