import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLog, retainLogTail } from "./logs.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function logPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-bg-log-"));
  directories.push(directory);
  return join(directory, "output.log");
}

describe("background task log display", () => {
  it("collapses carriage-return progress and retains terminal errors", () => {
    const path = logPath();
    writeFileSync(path, "10%\r20%\r99%\rRead from remote host: Operation timed out\nclient_loop: Broken pipe\n");

    const log = readLog(path, 10);

    expect(log.text).toBe("Read from remote host: Operation timed out\nclient_loop: Broken pipe");
  });

  it("tails a huge log without returning the discarded head", () => {
    const path = logPath();
    writeFileSync(path, `${"progress\r".repeat(100_000)}final failure\n`);

    const log = readLog(path, 10);

    expect(log.text).toBe("final failure");
    expect(log.truncated).toBe(true);
  });
});

describe("background task log retention", () => {
  it("compacts in place and marks discarded output", () => {
    const path = logPath();
    writeFileSync(path, `${"discarded\n".repeat(12_000)}final diagnostic\n`);

    const result = retainLogTail(path, 64 * 1024);

    expect(result?.discardedBytes).toBeGreaterThan(0);
    expect(statSync(path).size).toBeLessThan(64 * 1024);
    const log = readLog(path, 10);
    expect(log.text).toContain("log retention discarded");
    expect(log.text).toContain("final diagnostic");
  });
});