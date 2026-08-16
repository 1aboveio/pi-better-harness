import { describe, expect, it } from "vitest";
import { expandSshRemoteTaskPreset } from "./remote-task-preset.js";
import { FakeRemoteRunner, successfulResult } from "./test-support/fake-remote-runner.js";

describe("SSH remote-task preset", () => {
  // @covers background-task.ssh-tmux-bootstrap
  // @level unit
  it("reports a present remote tmux with a usable path and version", async () => {
    const runner = new FakeRemoteRunner([
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: { host: "build.example", user: "deploy" },
    }, runner);

    await expect(resolved.bootstrapTmux()).resolves.toEqual({
      status: "present",
      target: "deploy@build.example",
      tmuxPath: "/usr/bin/tmux",
      tmuxVersion: "tmux 3.4",
      mutated: false,
      message: "tmux 3.4 is available at /usr/bin/tmux on deploy@build.example.",
    });
    expect(runner.runCalls).toEqual([
      expect.objectContaining({
        argv: expect.arrayContaining(["deploy@build.example", expect.stringContaining("command -v tmux")]),
        shell: false,
      }),
    ]);
  });

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

  // @covers background-task.ssh-preset
  // @level unit
  it("keeps required safety options when extra options try to override them", () => {
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "uname -a",
      ssh: {
        host: "safe.example",
        options: {
          BatchMode: "no",
          connecttimeout: "120",
          RequestTTY: "force",
          Compression: "yes",
        },
      },
    });

    expect(resolved.commandSpec.argv).toEqual([
      "ssh",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-T",
      "-o", "Compression=yes",
      "--",
      "safe.example",
      "uname -a",
    ]);
  });

  // @covers background-task.ssh-preset
  // @level unit
  it("requires valid structured fields and a remote command for SSH intent", () => {
    const expand = (ssh: Parameters<typeof expandSshRemoteTaskPreset>[0]["ssh"], command: string | undefined = "echo ready") => (
      expandSshRemoteTaskPreset({ operation: "watch", command, ssh })
    );

    expect(() => expand({ host: "  " })).toThrow("ssh.host is required");
    expect(() => expandSshRemoteTaskPreset({ operation: "watch", ssh: { host: "ready.example" } })).toThrow("command is required when ssh is set");
    expect(() => expand({ host: "ready.example", port: 0 })).toThrow("ssh.port must be an integer between 1 and 65535");
    expect(() => expand({ host: "ready.example", port: 65_536 })).toThrow("ssh.port must be an integer between 1 and 65535");
    expect(() => expand({ host: "ready.example", user: "bad user" })).toThrow("ssh.user must not be empty or contain whitespace");
    expect(() => expand({ host: "ready.example", identity_file: "" })).toThrow("ssh.identity_file must not be empty");
    expect(() => expand({ host: "ready.example", jump: "" })).toThrow("ssh.jump must not be empty");
    expect(() => expand({ host: "ready.example", options: { "Bad Key": "value" } })).toThrow("ssh option names must not be empty or contain whitespace");
  });
});
