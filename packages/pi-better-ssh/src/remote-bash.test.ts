import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
});
