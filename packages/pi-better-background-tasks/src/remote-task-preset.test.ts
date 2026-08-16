import { describe, expect, it } from "vitest";
import { expandSshRemoteTaskPreset } from "./remote-task-preset.js";
import type { CommandResult, CommandSpec } from "./types.js";

class FakeRemoteRunner {
  readonly runCalls: CommandSpec[] = [];

  spawn(): never {
    throw new Error("spawn was not expected");
  }

  async runOnce(spec: CommandSpec): Promise<CommandResult> {
    this.runCalls.push(spec);
    return {
      exitCode: 0,
      signal: null,
      stdout: "ok\n",
      stderr: "",
      startedAt: 1,
      endedAt: 2,
    };
  }
}

describe("SSH remote-task preset", () => {
  // @covers background-task.ssh-preset
  // @level unit
  it("expands structured SSH intent into safe argv and delegates through the injected runner", async () => {
    const runner = new FakeRemoteRunner();

    const resolved = expandSshRemoteTaskPreset({
      operation: "watch",
      command: "printf '%s\\n' 'remote value'",
      cwd: "/local/worktree",
      env: { RELEASE_ENV: "staging" },
      ssh: {
        host: "example.com",
        user: "deploy",
        port: 2222,
        identity_file: "/tmp/key with spaces",
        jump: "jump-user@bastion.example.com",
        options: { ServerAliveInterval: "15" },
      },
      remote: {
        session: "direct",
        install_tmux: false,
        workdir: "/srv/app with spaces",
      },
    }, runner);

    expect(resolved.commandSpec).toEqual({
      command: "printf '%s\\n' 'remote value'",
      argv: [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-T",
        "-p", "2222",
        "-i", "/tmp/key with spaces",
        "-J", "jump-user@bastion.example.com",
        "-o", "ServerAliveInterval=15",
        "--",
        "deploy@example.com",
        "printf '%s\\n' 'remote value'",
      ],
      shell: false,
      cwd: "/local/worktree",
      env: { RELEASE_ENV: "staging" },
    });
    expect(resolved.metadata).toEqual({
      ssh: {
        host: "example.com",
        user: "deploy",
        port: 2222,
        identityFile: "/tmp/key with spaces",
        jump: "jump-user@bastion.example.com",
        options: { ServerAliveInterval: "15" },
        target: "deploy@example.com",
      },
      remote: {
        command: "printf '%s\\n' 'remote value'",
        session: "direct",
        installTmux: false,
        workdir: "/srv/app with spaces",
      },
    });

    await resolved.runOnce();
    expect(runner.runCalls).toEqual([resolved.commandSpec]);
  });
});
