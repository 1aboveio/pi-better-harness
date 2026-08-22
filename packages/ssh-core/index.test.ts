import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  createTmuxSessionController,
  DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS,
  resolveSshCommand,
} from "./index.js";
import { FakeRemoteRunner, failedResult, successfulResult } from "./test-support/index.js";

// @covers ssh-core.package
// @level unit
describe("ssh-core package contract", () => {
  it("is private and has no Pi extension or publish configuration", async () => {
    const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));

    assert.equal(packageJson.private, true);
    assert.equal(packageJson.pi, undefined);
    assert.equal(packageJson.publishConfig, undefined);
  });

  // @covers ssh-core.identity-argv
  // @level unit
  it("normalizes identity and enforces noninteractive SSH argv", () => {
    const resolved = resolveSshCommand({
      command: "printf '%s\\n' 'remote value'",
      cwd: "/local/worktree",
      env: { RELEASE_ENV: "staging" },
      ssh: {
        host: "example.com",
        user: "deploy",
        port: 2222,
        identity_file: "/tmp/key with spaces",
        jump: "jump-user@bastion.example.com",
        options: {
          BatchMode: "no",
          connecttimeout: "120",
          RequestTTY: "force",
          ServerAliveInterval: "15",
        },
      },
    });

    assert.equal(DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS, 10);
    assert.deepEqual(resolved.identity, {
      host: "example.com",
      user: "deploy",
      port: 2222,
      identityFile: "/tmp/key with spaces",
      jump: "jump-user@bastion.example.com",
      options: {
        BatchMode: "no",
        connecttimeout: "120",
        RequestTTY: "force",
        ServerAliveInterval: "15",
      },
      target: "deploy@example.com",
    });
    assert.deepEqual(resolved.commandSpec, {
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
  });

  // @covers ssh-core.identity-argv
  // @level unit
  it("rejects invalid structured identity fields", () => {
    assert.throws(() => resolveSshCommand({ command: "true", ssh: { host: "  " } }), /ssh.host is required/);
    assert.throws(() => resolveSshCommand({ command: "true", ssh: { host: "host", user: "bad user" } }), /ssh.user must not be empty or contain whitespace/);
    assert.throws(() => resolveSshCommand({ command: "true", ssh: { host: "host", port: 65_536 } }), /ssh.port must be an integer between 1 and 65535/);
    assert.throws(() => resolveSshCommand({ command: "true", ssh: { host: "host", options: { "Bad Key": "x" } } }), /ssh option names must not be empty or contain whitespace/);
  });

  // @covers ssh-core.tmux-session
  // @level integration
  it("runs tmux bootstrap, start, poll, and kill through the canonical fake runner", async () => {
    const pollCommandResult = successfulResult("__PI_BG_STATUS__=0\n__PI_BG_SIZE__=5\ndone\n");
    const runner = new FakeRemoteRunner([
      successfulResult("__PI_BG_TMUX_PATH__=/usr/bin/tmux\n__PI_BG_TMUX_VERSION__=tmux 3.4\n"),
      successfulResult(""),
      pollCommandResult,
      successfulResult(""),
    ]);
    const resolved = resolveSshCommand({
      command: "make release",
      ssh: { host: "build.example", user: "deploy" },
    });
    const controller = createTmuxSessionController({
      ...resolved,
      runner,
      sessionName: "pi-bg-task-1",
      command: "make release",
      workdir: "/srv/app with spaces",
      installTmux: true,
    });

    assert.deepEqual(await controller.bootstrapTmux(), {
      status: "present",
      target: "deploy@build.example",
      tmuxPath: "/usr/bin/tmux",
      tmuxVersion: "tmux 3.4",
      mutated: false,
      message: "tmux 3.4 is available at /usr/bin/tmux on deploy@build.example.",
    });
    assert.equal((await controller.startTmuxSession("/usr/bin/tmux")).exitCode, 0);
    assert.deepEqual(await controller.pollTmuxSession(0), {
      status: 0,
      logSize: 5,
      output: "done\n",
      commandResult: pollCommandResult,
    });
    assert.equal((await controller.killTmuxSession()).exitCode, 0);

    assert.match(runner.runCalls[1]?.command ?? "", /cd -- .*\/srv\/app with spaces/);
    assert.match(runner.runCalls[1]?.command ?? "", /'\/usr\/bin\/tmux' new-session/);
    assert.match(runner.runCalls[2]?.command ?? "", /tmux has-session -t 'pi-bg-task-1'/);
    assert.equal(runner.runCalls[3]?.command, "tmux kill-session -t 'pi-bg-task-1'");
    assert.ok(runner.runCalls.every((call) => call.shell === false));
  });

  // @covers ssh-core.tmux-bootstrap
  // @level unit
  it("returns needs-user guidance without attempting an interactive install", async () => {
    const runner = new FakeRemoteRunner([
      failedResult(127),
      successfulResult("user=deploy\nuid=1000\npm=apt-get\nprivilege=needs_user\n"),
    ]);
    const resolved = resolveSshCommand({ command: "make release", ssh: { host: "locked.example", user: "deploy" } });
    const controller = createTmuxSessionController({
      ...resolved,
      runner,
      sessionName: "pi-bg-task-2",
      command: "make release",
      installTmux: true,
    });

    const result = await controller.bootstrapTmux();
    assert.equal(result.status, "needs_user");
    assert.match(result.message, /automatic installation cannot use passwordless sudo/);
    assert.equal(runner.runCalls.length, 2);
  });
});
