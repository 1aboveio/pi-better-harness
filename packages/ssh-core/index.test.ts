import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createSshMuxController,
  createTmuxSessionController,
  DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_SSH_CONTROL_PERSIST_SECONDS,
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

  // @covers ssh-core.control-master
  // @level integration
  it("ensures and reuses one restrictively stored master with safe mux exec argv", async () => {
    const fixtureRoot = mkdtempSync("/tmp/ssh-core-mux-");
    const controlPathRoot = join(fixtureRoot, "control");
    try {
      const runner = new FakeRemoteRunner([
        failedResult(255, "Control socket connect: No such file or directory"),
        successfulResult(""),
        successfulResult("Master running (pid=42)\n"),
        successfulResult("Master running (pid=42)\n"),
      ]);
      const resolved = resolveSshCommand({
        command: "printf ready",
        ssh: {
          host: "build.example",
          user: "deploy",
          port: 2222,
          identity_file: "/keys/release key",
          jump: "jump@bastion.example",
          options: {
            ServerAliveInterval: "15",
            BatchMode: "no",
            ControlMaster: "auto",
            ControlPath: "/tmp/caller-controlled-socket",
            ControlPersist: "9999",
          },
        },
      });
      const mux = createSshMuxController({
        ...resolved,
        runner,
        sessionScope: "pi-session-42",
        controlPathRoot,
      });
      const sameIdentity = createSshMuxController({
        ...resolveSshCommand({
          command: "printf different-command",
          ssh: {
            host: "build.example",
            user: "deploy",
            port: 2222,
            identity_file: "/keys/release key",
            jump: "jump@bastion.example",
            options: {
              batchmode: "yes",
              ServerAliveInterval: "15",
            },
          },
        }),
        runner,
        sessionScope: "pi-session-42",
        controlPathRoot,
      });
      const differentScope = createSshMuxController({
        ...resolved,
        runner,
        sessionScope: "pi-session-other",
        controlPathRoot,
      });

      assert.equal(DEFAULT_SSH_CONTROL_PERSIST_SECONDS, 600);
      assert.equal(mux.controlPath, sameIdentity.controlPath);
      assert.notEqual(mux.controlPath, differentScope.controlPath);
      assert.match(mux.controlPath, new RegExp(`^${controlPathRoot.replaceAll("/", "\\/")}\\/cm-[a-f0-9]{32}$`));

      const opened = await mux.ensure();
      const reused = await mux.ensure();
      assert.equal(opened.state, "up");
      assert.equal(opened.reused, false);
      assert.equal(reused.state, "up");
      assert.equal(reused.reused, true);
      assert.equal(statSync(controlPathRoot).mode & 0o777, 0o700);

      assert.deepEqual(runner.runCalls[0]?.argv, [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-T",
        "-p", "2222",
        "-i", "/keys/release key",
        "-J", "jump@bastion.example",
        "-o", "ServerAliveInterval=15",
        "-o", "ControlMaster=no",
        "-o", `ControlPath=${mux.controlPath}`,
        "-O", "check",
        "--", "deploy@build.example",
      ]);
      assert.deepEqual(runner.runCalls[1]?.argv, [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-T",
        "-p", "2222",
        "-i", "/keys/release key",
        "-J", "jump@bastion.example",
        "-o", "ServerAliveInterval=15",
        "-o", "ControlMaster=yes",
        "-o", "ControlPersist=600",
        "-o", `ControlPath=${mux.controlPath}`,
        "-N", "-f",
        "--", "deploy@build.example",
      ]);
      assert.equal(runner.runCalls.filter((call) => call.argv?.includes("ControlMaster=yes")).length, 1);
      assert.ok(runner.runCalls.every((call) => call.shell === false));

      assert.deepEqual(mux.withMux(resolved.commandSpec).argv, [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-T",
        "-p", "2222",
        "-i", "/keys/release key",
        "-J", "jump@bastion.example",
        "-o", "ServerAliveInterval=15",
        "-o", "ControlMaster=no",
        "-o", `ControlPath=${mux.controlPath}`,
        "--", "deploy@build.example", "printf ready",
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // @covers ssh-core.control-master
  // @level integration
  it("reopens a stale master exactly once and surfaces a failed post-open check", async () => {
    const fixtureRoot = mkdtempSync("/tmp/ssh-core-mux-stale-");
    try {
      const runner = new FakeRemoteRunner([
        failedResult(255, "stale control socket"),
        successfulResult(""),
        failedResult(255, "master still unavailable"),
      ]);
      const mux = createSshMuxController({
        ...resolveSshCommand({ command: "true", ssh: { host: "stale.example" } }),
        runner,
        sessionScope: "session-stale",
        controlPathRoot: join(fixtureRoot, "control"),
      });

      await assert.rejects(() => mux.ensure(), /failed to establish.*after one reopen attempt.*master still unavailable/i);
      assert.equal(runner.runCalls.length, 3);
      assert.equal(runner.runCalls.filter((call) => call.argv?.includes("ControlMaster=yes")).length, 1);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // @covers ssh-core.control-master
  // @level integration
  it("reports and cleans up the resolved target master and stale local path", async () => {
    const fixtureRoot = mkdtempSync("/tmp/ssh-core-mux-status-");
    try {
      const runner = new FakeRemoteRunner([
        successfulResult("Master running (pid=42)\n"),
        successfulResult("Exit request sent.\n"),
        failedResult(255, "Control socket connect: No such file or directory"),
      ]);
      const mux = createSshMuxController({
        ...resolveSshCommand({ command: "true", ssh: { host: "status.example", user: "ops" } }),
        runner,
        sessionScope: "session-status",
        controlPathRoot: join(fixtureRoot, "control"),
      });

      const status = await mux.status();
      assert.equal(status.state, "up");
      assert.equal(status.target, "ops@status.example");
      writeFileSync(mux.controlPath, "stale socket placeholder");

      const cleanup = await mux.cleanup();
      assert.equal(cleanup.state, "stopped");
      assert.equal(existsSync(mux.controlPath), false);
      assert.deepEqual(runner.runCalls[1]?.argv?.slice(-4), ["-O", "exit", "--", "ops@status.example"]);

      const down = await mux.status();
      assert.equal(down.state, "down");
      assert.match(down.detail, /No such file or directory/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // @covers ssh-core.control-master
  // @level unit
  it("rejects invalid mux scope and overlong ControlPath roots", () => {
    const resolved = resolveSshCommand({ command: "true", ssh: { host: "limits.example" } });
    const runner = new FakeRemoteRunner();

    assert.throws(
      () => createSshMuxController({ ...resolved, runner, sessionScope: "  ", controlPathRoot: "/tmp/pi-ssh" }),
      /sessionScope is required/,
    );
    assert.throws(
      () => createSshMuxController({
        ...resolved,
        runner,
        sessionScope: "session-limits",
        controlPathRoot: `/tmp/${"x".repeat(100)}`,
      }),
      /ControlPath exceeds 100 bytes/,
    );
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
