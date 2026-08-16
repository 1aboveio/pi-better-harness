import { describe, expect, it } from "vitest";
import { expandSshRemoteTaskPreset } from "./remote-task-preset.js";
import { failedResult, FakeRemoteRunner, successfulResult } from "./test-support/fake-remote-runner.js";

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
        argv: expect.arrayContaining([
          "-o", "BatchMode=yes",
          "-T",
          "deploy@build.example",
          expect.stringContaining("command -v tmux"),
        ]),
        shell: false,
      }),
    ]);
  });

  // @covers background-task.ssh-tmux-bootstrap
  // @level unit
  it.each([
    ["apt-get", "apt-get update && apt-get install -y tmux", "root", "0", "root"],
    ["dnf", "dnf install -y tmux", "root", "0", "root"],
    ["yum", "yum install -y tmux", "root", "0", "root"],
    ["apk", "apk add --no-cache tmux", "root", "0", "root"],
    ["pacman", "pacman -Sy --noconfirm tmux", "root", "0", "root"],
    ["zypper", "zypper --non-interactive install tmux", "root", "0", "root"],
    ["brew", "brew install tmux", "builder", "501", "direct"],
  ])("installs tmux with %s under its approved privilege mode and records the host mutation", async (packageManager, installCommand, user, uid, privilege) => {
    const target = `${user}@${packageManager}.example`;
    const runner = new FakeRemoteRunner([
      failedResult(127),
      successfulResult(`user=${user}\nuid=${uid}\npm=${packageManager}\nprivilege=${privilege}\n`),
      successfulResult("installed\n"),
      successfulResult("/opt/bin/tmux\ntmux 3.5a\n"),
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: { host: `${packageManager}.example`, user },
    }, runner);

    await expect(resolved.bootstrapTmux()).resolves.toEqual({
      status: "installed",
      target,
      packageManager,
      tmuxPath: "/opt/bin/tmux",
      tmuxVersion: "tmux 3.5a",
      mutated: true,
      installCommand: `ssh '${target}' '${installCommand}'`,
      verifyCommand: `ssh '${target}' 'command -v tmux && tmux -V'`,
      message: `Installed tmux with ${packageManager} on ${target}; tmux 3.5a is available at /opt/bin/tmux.`,
    });
    expect(runner.runCalls.map((call) => call.command)).toEqual([
      expect.stringContaining("command -v tmux"),
      expect.stringMatching(/apt-get.*dnf.*yum.*apk.*pacman.*zypper.*brew/s),
      installCommand,
      expect.stringContaining("command -v tmux"),
    ]);
  });

  // @covers background-task.ssh-tmux-bootstrap
  // @level unit
  it("prefers dnf to yum and uses only sudo -n for non-root installation", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127),
      successfulResult("user=deploy\nuid=1000\npm=dnf\nprivilege=sudo\n"),
      successfulResult("installed\n"),
      successfulResult("/usr/bin/tmux\ntmux 3.4\n"),
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: { host: "packages.example", user: "deploy" },
    }, runner);

    const result = await resolved.bootstrapTmux();

    expect(result).toMatchObject({
      status: "installed",
      packageManager: "dnf",
      installCommand: "ssh -t 'deploy@packages.example' 'sudo dnf install -y tmux'",
      mutated: true,
    });
    expect(runner.runCalls[1]?.command?.indexOf("dnf")).toBeLessThan(runner.runCalls[1]?.command?.indexOf("yum") ?? -1);
    expect(runner.runCalls[2]?.command).toBe("sudo -n dnf install -y tmux");
    expect(runner.runCalls[2]?.command).not.toMatch(/sudo(?! -n)/);
  });

  // @covers background-task.ssh-tmux-bootstrap
  // @level integration
  it("fails fast on noninteractive SSH probe failure without attempting package detection", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(255, "Permission denied (publickey).\n"),
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: { host: "auth.example", user: "deploy" },
    }, runner);

    await expect(resolved.bootstrapTmux()).resolves.toEqual({
      status: "install_failed",
      target: "deploy@auth.example",
      exitCode: 255,
      mutated: false,
      verifyCommand: "ssh 'deploy@auth.example' 'command -v tmux && tmux -V'",
      message: "tmux bootstrap could not probe deploy@auth.example (exit 255): Permission denied (publickey). Install tmux manually if needed, then verify: ssh 'deploy@auth.example' 'command -v tmux && tmux -V'",
    });
    expect(runner.runCalls).toHaveLength(1);
    expect(runner.runCalls[0]?.argv).toContain("BatchMode=yes");
  });

  // @covers background-task.ssh-tmux-bootstrap
  // @level unit
  it("fails closed without passwordless sudo and gives exact one-host remediation", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127),
      successfulResult("user=deploy\nuid=1000\npm=apt-get\nprivilege=needs_user\n"),
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: {
        host: "locked.example",
        user: "deploy",
        port: 2222,
        identity_file: "/tmp/deploy key",
        jump: "jump@bastion.example",
        options: { ServerAliveInterval: "15" },
      },
    }, runner);

    await expect(resolved.bootstrapTmux()).resolves.toEqual({
      status: "needs_user",
      reason: "passwordless_sudo_unavailable",
      target: "deploy@locked.example",
      packageManager: "apt-get",
      mutated: false,
      installCommand: "ssh -t -p '2222' -i '/tmp/deploy key' -J 'jump@bastion.example' -o 'ServerAliveInterval=15' 'deploy@locked.example' 'sudo apt-get update && sudo apt-get install -y tmux'",
      verifyCommand: "ssh -p '2222' -i '/tmp/deploy key' -J 'jump@bastion.example' -o 'ServerAliveInterval=15' 'deploy@locked.example' 'command -v tmux && tmux -V'",
      message: "tmux is missing on deploy@locked.example and automatic installation cannot use passwordless sudo. Run: ssh -t -p '2222' -i '/tmp/deploy key' -J 'jump@bastion.example' -o 'ServerAliveInterval=15' 'deploy@locked.example' 'sudo apt-get update && sudo apt-get install -y tmux' Then verify: ssh -p '2222' -i '/tmp/deploy key' -J 'jump@bastion.example' -o 'ServerAliveInterval=15' 'deploy@locked.example' 'command -v tmux && tmux -V'",
    });
    expect(runner.runCalls).toHaveLength(2);
  });

  // @covers background-task.ssh-tmux-bootstrap
  // @level unit
  it("supports probe-only mode with the same actionable needs-user guidance", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127),
      successfulResult("user=root\nuid=0\npm=apk\nprivilege=root\n"),
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: { host: "immutable.example", user: "root" },
      remote: { install_tmux: false },
    }, runner);

    const result = await resolved.bootstrapTmux();

    expect(result).toMatchObject({
      status: "needs_user",
      reason: "install_disabled",
      target: "root@immutable.example",
      packageManager: "apk",
      installCommand: "ssh 'root@immutable.example' 'apk add --no-cache tmux'",
      verifyCommand: "ssh 'root@immutable.example' 'command -v tmux && tmux -V'",
      mutated: false,
    });
    expect(result.message).toContain("Automatic tmux installation is disabled for root@immutable.example.");
    expect(runner.runCalls).toHaveLength(2);
  });

  // @covers background-task.ssh-tmux-bootstrap
  // @level unit
  it("fails closed with generic guidance when no supported package manager exists", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127),
      successfulResult("user=operator\nuid=1000\npm=\nprivilege=needs_user\n"),
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: { host: "custom-os.example", user: "operator" },
    }, runner);

    await expect(resolved.bootstrapTmux()).resolves.toEqual({
      status: "unknown_package_manager",
      target: "operator@custom-os.example",
      mutated: false,
      verifyCommand: "ssh 'operator@custom-os.example' 'command -v tmux && tmux -V'",
      message: "tmux is missing on operator@custom-os.example, but none of apt-get, dnf, yum, apk, pacman, zypper, or brew was found. Install tmux manually, then verify: ssh 'operator@custom-os.example' 'command -v tmux && tmux -V'",
    });
    expect(runner.runCalls).toHaveLength(2);
  });

  // @covers background-task.ssh-tmux-bootstrap
  // @level unit
  it("reports package installation failure with retry commands and no prompt-capable sudo", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127),
      successfulResult("user=deploy\nuid=1000\npm=dnf\nprivilege=sudo\n"),
      failedResult(100, "repository unavailable\n"),
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: { host: "broken-repo.example", user: "deploy" },
    }, runner);

    const result = await resolved.bootstrapTmux();

    expect(result).toMatchObject({
      status: "install_failed",
      target: "deploy@broken-repo.example",
      packageManager: "dnf",
      exitCode: 100,
      mutated: false,
      installCommand: "ssh -t 'deploy@broken-repo.example' 'sudo dnf install -y tmux'",
      verifyCommand: "ssh 'deploy@broken-repo.example' 'command -v tmux && tmux -V'",
    });
    expect(result.status).toBe("install_failed");
    if (result.status !== "install_failed") throw new Error(`expected install_failed, received ${result.status}`);
    expect(result.message).toContain("repository unavailable");
    expect(result.message).toContain(result.installCommand ?? "missing install command");
    expect(result.message).toContain(result.verifyCommand);
    expect(runner.runCalls[2]?.command).toBe("sudo -n dnf install -y tmux");
  });

  // @covers background-task.ssh-tmux-bootstrap
  // @level unit
  it("reports an unusable post-install probe while preserving mutation disclosure", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127),
      successfulResult("user=root\nuid=0\npm=yum\nprivilege=root\n"),
      successfulResult("installed\n"),
      failedResult(126, "tmux: permission denied\n"),
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: { host: "bad-binary.example", user: "root" },
    }, runner);

    const result = await resolved.bootstrapTmux();

    expect(result).toMatchObject({
      status: "install_failed",
      target: "root@bad-binary.example",
      packageManager: "yum",
      mutated: true,
      installCommand: "ssh 'root@bad-binary.example' 'yum install -y tmux'",
      verifyCommand: "ssh 'root@bad-binary.example' 'command -v tmux && tmux -V'",
    });
    expect(result.message).toContain("install command completed but tmux did not pass verification");
  });

  // @covers background-task.ssh-tmux-bootstrap
  // @level integration
  it("bounds bootstrap and returns known install guidance when the package command times out", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127),
      successfulResult("user=deploy\nuid=1000\npm=pacman\nprivilege=sudo\n"),
      { ...failedResult(143, "install timed out"), timedOut: true },
    ]);
    const resolved = expandSshRemoteTaskPreset({
      operation: "spawn",
      command: "make release",
      ssh: { host: "slow-mirror.example", user: "deploy" },
    }, runner);

    await expect(resolved.bootstrapTmux({ timeoutMs: 250 })).resolves.toEqual({
      status: "timed_out",
      target: "deploy@slow-mirror.example",
      packageManager: "pacman",
      mutated: false,
      installCommand: "ssh -t 'deploy@slow-mirror.example' 'sudo pacman -Sy --noconfirm tmux'",
      verifyCommand: "ssh 'deploy@slow-mirror.example' 'command -v tmux && tmux -V'",
      message: "tmux bootstrap timed out on deploy@slow-mirror.example while running the pacman install. Run: ssh -t 'deploy@slow-mirror.example' 'sudo pacman -Sy --noconfirm tmux' Then verify: ssh 'deploy@slow-mirror.example' 'command -v tmux && tmux -V'",
    });
    expect(runner.runTimeouts).toHaveLength(3);
    expect(runner.runTimeouts.every((timeout) => timeout !== undefined && timeout > 0 && timeout <= 250)).toBe(true);
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

  // @covers background-task.ssh-watch
  // @level unit
  // @fails-without-fix background-task.ssh-watch
  it("normalizes every SSH watch to direct mode without tmux installation", () => {
    const omitted = expandSshRemoteTaskPreset({
      operation: "watch",
      command: "echo ready",
      ssh: { host: "watch.example" },
    });
    const requestedTmux = expandSshRemoteTaskPreset({
      operation: "watch",
      command: "echo ready",
      ssh: { host: "watch.example" },
      remote: { session: "tmux", install_tmux: true },
    });

    expect(omitted.metadata.remote).toMatchObject({ session: "direct", installTmux: false });
    expect(requestedTmux.metadata.remote).toMatchObject({ session: "direct", installTmux: false });
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
