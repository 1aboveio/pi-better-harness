import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { failedResult, FakeRemoteRunner, successfulResult } from "../../ssh-core/test-support/index.js";
import { executeRemoteBash } from "./remote-bash.js";

// @covers pi-better-ssh.remote-bash
// @level integration
describe("executeRemoteBash", () => {
  it("runs a safely wrapped command through an ensured mux and returns non-zero as data", async () => {
    const fixtureRoot = mkdtempSync("/tmp/pi-better-ssh-service-");
    try {
      const runner = new FakeRemoteRunner([
        failedResult(255, "missing control socket"),
        successfulResult(""),
        successfulResult("Master running (pid=42)\n"),
        failedResult(7, "release failed\n"),
      ]);

      const result = await executeRemoteBash({
        command: "./release --check",
        host: "deploy@build-alias",
        workdir: "/srv/app's releases",
        env: { RELEASE_LABEL: "candidate A" },
        port: 2222,
        identity_file: "/keys/release key",
        jump: "jump@bastion",
        options: {
          BatchMode: "no",
          ConnectTimeout: "120",
          RequestTTY: "force",
          ControlMaster: "auto",
          ServerAliveInterval: "15",
        },
      }, {
        runner,
        sessionScope: "session-216",
        controlPathRoot: join(fixtureRoot, "control"),
      });

      expect(result).toMatchObject({
        output: "release failed\n",
        exitCode: 7,
        cancelled: false,
        truncated: false,
        target: "deploy@build-alias",
        workdir: "/srv/app's releases",
        mux: { state: "up", reused: false },
      });
      const exec = runner.runCalls[3]!;
      expect(exec.shell).toBe(false);
      expect(exec.argv).toEqual([
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-T",
        "-p", "2222",
        "-i", "/keys/release key",
        "-J", "jump@bastion",
        "-o", "ServerAliveInterval=15",
        "-o", "ControlMaster=no",
        "-o", expect.stringMatching(/^ControlPath=/),
        "--", "deploy@build-alias",
        expect.stringMatching(/^bash -c /),
      ]);
      expect(exec.command).toContain("bash -c");
      expect(exec.command).toContain("RELEASE_LABEL");
      expect(runner.runTimeouts[3]).toBeUndefined();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("reuses the scoped mux across commands", async () => {
    const fixtureRoot = mkdtempSync("/tmp/pi-better-ssh-reuse-");
    try {
      const runner = new FakeRemoteRunner([
        failedResult(255, "missing"),
        successfulResult(""),
        successfulResult("Master running\n"),
        successfulResult("first\n"),
        successfulResult("Master running\n"),
        successfulResult("second\n"),
      ]);
      const dependencies = {
        runner,
        sessionScope: "session-reuse",
        controlPathRoot: join(fixtureRoot, "control"),
      };

      const first = await executeRemoteBash({ command: "hostname", host: "build-alias" }, dependencies);
      const second = await executeRemoteBash({ command: "pwd", host: "build-alias" }, dependencies);

      expect(first.mux.reused).toBe(false);
      expect(second.mux.reused).toBe(true);
      expect(runner.runCalls.filter((call) => call.argv?.includes("ControlMaster=yes"))).toHaveLength(1);
      expect(runner.runCalls[3]?.argv?.at(-1)).toBe("bash -c 'hostname'");
      expect(runner.runCalls[5]?.argv?.at(-1)).toBe("bash -c 'pwd'");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("returns timeout cancellation without stopping the mux", async () => {
    const fixtureRoot = mkdtempSync("/tmp/pi-better-ssh-timeout-");
    try {
      const now = Date.now();
      const runner = new FakeRemoteRunner([
        successfulResult("Master running\n"),
        {
          exitCode: null,
          signal: "SIGTERM",
          stdout: "partial output\n",
          stderr: "",
          startedAt: now,
          endedAt: now + 1250,
          timedOut: true,
        },
      ]);
      const signal = new AbortController().signal;

      const result = await executeRemoteBash({
        command: "sleep 30",
        host: "ops@cluster-alias",
        timeout: 1.25,
      }, {
        runner,
        sessionScope: "session-timeout",
        controlPathRoot: join(fixtureRoot, "control"),
      }, signal);

      expect(result).toMatchObject({
        output: "partial output\n",
        exitCode: undefined,
        cancelled: true,
        timedOut: true,
        mux: { state: "up", reused: true },
      });
      expect(runner.runTimeouts).toEqual([undefined, 1250]);
      expect(runner.runSignals).toEqual([undefined, signal]);
      expect(runner.runCalls.some((call) => call.argv?.includes("exit"))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("truncates from the tail at Pi bash limits and persists the complete output", async () => {
    const fixtureRoot = mkdtempSync("/tmp/pi-better-ssh-truncate-");
    const fullOutput = Array.from({ length: 2_100 }, (_, index) => `line-${index + 1}`).join("\n");
    const runner = new FakeRemoteRunner([
      successfulResult("Master running\n"),
      successfulResult(fullOutput),
    ]);
    let fullOutputPath: string | undefined;
    try {
      const result = await executeRemoteBash({ command: "print-many-lines", host: "logs-alias" }, {
        runner,
        sessionScope: "session-truncate",
        controlPathRoot: join(fixtureRoot, "control"),
      });
      fullOutputPath = result.fullOutputPath;

      expect(result.truncated).toBe(true);
      expect(result.truncation).toMatchObject({
        truncated: true,
        truncatedBy: "lines",
        totalLines: 2_100,
        outputLines: 2_000,
        maxLines: 2_000,
        maxBytes: 50 * 1024,
      });
      expect(result.output).not.toContain("line-1\n");
      expect(result.output).toContain("line-2100");
      expect(fullOutputPath && existsSync(fullOutputPath)).toBe(true);
      expect(readFileSync(fullOutputPath!, "utf8")).toBe(fullOutput);
    } finally {
      if (fullOutputPath) rmSync(dirname(fullOutputPath), { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects missing and conflicting host identity before runner activity", async () => {
    const runner = new FakeRemoteRunner();
    await expect(executeRemoteBash({ command: "true" }, {
      runner,
      sessionScope: "session-missing-host",
      controlPathRoot: "/tmp/pi-better-ssh-unused",
    })).rejects.toThrow(/requires host.*Host alias or user@host/i);
    await expect(executeRemoteBash({ command: "true", host: "alice@host", user: "bob" }, {
      runner,
      sessionScope: "session-conflict",
      controlPathRoot: "/tmp/pi-better-ssh-unused",
    })).rejects.toThrow(/conflicts with host user/);
    expect(runner.runCalls).toHaveLength(0);
  });
});
