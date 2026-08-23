import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { commandExecution } from "./process.js";
import { readMeta } from "./registry.js";
import { startWatchTask } from "./runtime.js";
import {
  confineCommandSpec,
  currentForegroundSandboxPolicy,
  ForegroundSandboxBlockedError,
  FOREGROUND_SANDBOX_POLICY_CHANNEL,
  FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
  observeForegroundSandboxPolicy,
  resolveForegroundSandboxPlan,
} from "./sandbox.js";
import { describeSandboxSupport } from "./shared-sandbox-core.js";
import { FakeRemoteRunner } from "./test-support/fake-remote-runner.js";
import type { CommandSpec } from "./types.js";

// Disposable fixtures live under the canonical /var/tmp rather than
// os.tmpdir(): the macOS profile always allows writes under /private/var/folders
// (which is what os.tmpdir() returns there), so an "outside the project" probe
// placed there would pass without the sandbox proving anything. realpath keeps
// the same directory addressable on both platforms — /private/var/tmp on macOS,
// /var/tmp on Linux.
const varTmp = realpathSync("/var/tmp");
const fixtureRoot = mkdtempSync(join(varTmp, "bg-sandbox-contract-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const support = describeSandboxSupport();

/**
 * A stand-in for the publishing half of the wire contract: the exact channels
 * and payload shape `pi-better-sandbox` puts on `pi.events`, including its
 * answer to a late consumer's request. Nothing inside this package is faked.
 */
function createSandboxPublisher(events: EventEmitter) {
  let status: Record<string, unknown> | undefined;
  const publish = () => {
    if (status) events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, status);
  };
  events.on(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, publish);
  return {
    announce(next: Record<string, unknown>) {
      status = Object.freeze({
        projectRoot: next.writableRoot,
        denyWrite: Object.freeze([]),
        platform: process.platform,
        readPolicy: "unrestricted",
        networkPolicy: "unrestricted",
        reason: "test policy",
        ...next,
      });
      publish();
    },
  };
}

function createPi(): { pi: ExtensionAPI; events: EventEmitter } {
  const events = new EventEmitter();
  return { pi: { events } as unknown as ExtensionAPI, events };
}

function enabledPolicy(writableRoot: string, denyWrite: string[] = []) {
  return {
    state: "enabled",
    writableRoot,
    denyWrite,
    reason: `Writes are confined to ${writableRoot}.`,
  };
}

describe("foreground sandbox policy contract", () => {
  // @covers background-task.sandbox-policy-contract
  // @level integration
  it("captures a policy published after background tasks subscribed", () => {
    const { pi, events } = createPi();
    observeForegroundSandboxPolicy(pi);
    const publisher = createSandboxPublisher(events);

    publisher.announce(enabledPolicy(varTmp));

    expect(currentForegroundSandboxPolicy(pi)).toMatchObject({
      state: "enabled",
      writableRoot: varTmp,
    });
  });

  // @covers background-task.sandbox-policy-contract
  // @level integration
  it("recovers a policy published before background tasks subscribed", () => {
    const { pi, events } = createPi();
    // The sandbox extension loaded and published first. The bus has no replay,
    // so that publication is already gone by the time this extension exists.
    const publisher = createSandboxPublisher(events);
    publisher.announce(enabledPolicy(varTmp));

    observeForegroundSandboxPolicy(pi);

    expect(currentForegroundSandboxPolicy(pi)).toMatchObject({
      state: "enabled",
      writableRoot: varTmp,
    });
  });

  // @covers background-task.sandbox-policy-contract
  // @level integration
  it("sees the newest policy, so a toggle reaches launches made after it", () => {
    const { pi, events } = createPi();
    observeForegroundSandboxPolicy(pi);
    const publisher = createSandboxPublisher(events);

    publisher.announce(enabledPolicy(varTmp));
    publisher.announce({ state: "disabled", reason: "a human turned it off" });

    expect(currentForegroundSandboxPolicy(pi)?.state).toBe("disabled");
    expect(resolveForegroundSandboxPlan(pi)).toEqual({ confined: false });
  });

  // @covers background-task.sandbox-policy-contract
  // @level unit
  it("ignores payloads that are not an effective-policy snapshot", () => {
    const { pi, events } = createPi();
    observeForegroundSandboxPolicy(pi);
    const publisher = createSandboxPublisher(events);
    publisher.announce(enabledPolicy(varTmp));

    events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, { state: "whatever" });
    events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, "off");

    expect(currentForegroundSandboxPolicy(pi)).toMatchObject({ state: "enabled" });
  });

  // @covers background-task.sandbox-policy-contract
  // @level unit
  it("runs unsandboxed when no sandbox extension publishes a policy", () => {
    const { pi } = createPi();

    expect(currentForegroundSandboxPolicy(pi)).toBeUndefined();
    expect(resolveForegroundSandboxPlan(pi)).toEqual({ confined: false });
  });
});

describe("foreground sandbox launch planning", () => {
  // @covers background-task.sandbox-fail-closed
  // @level unit
  it("blocks a launch when no backend is available on this platform", () => {
    const { pi, events } = createPi();
    observeForegroundSandboxPolicy(pi);
    createSandboxPublisher(events).announce({
      state: "unavailable",
      reason: "Linux sandbox requires executable bubblewrap (bwrap) on PATH.",
    });

    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(ForegroundSandboxBlockedError);
    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(/bubblewrap/);
  });

  // @covers background-task.sandbox-fail-closed
  // @level unit
  it("blocks a launch when the foreground sandbox failed to apply", () => {
    const { pi, events } = createPi();
    observeForegroundSandboxPolicy(pi);
    createSandboxPublisher(events).announce({
      state: "failed",
      reason: "Pi was launched from an unsafe broad root.",
    });

    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(/unsafe broad root/);
  });

  // @covers background-task.sandbox-launch-capture
  // @level unit
  it("leaves the command untouched when a human disabled the sandbox", () => {
    const spec: CommandSpec = { command: "echo hi", cwd: fixtureRoot, shell: true };

    expect(confineCommandSpec(spec, { confined: false }, join(fixtureRoot, "unused.sb"))).toBe(spec);
  });

  // @covers background-task.sandbox-launch-capture
  // @level integration
  it("wraps the exact executable and argv the unconfined launch would have run", () => {
    if (!support.supported) return expect(support.reason).toBeTypeOf("string");

    const project = join(fixtureRoot, "wrap-project");
    mkdirSync(project, { recursive: true });
    const spec: CommandSpec = {
      command: "echo hi",
      cwd: project,
      env: { PROBE: "1" },
      shell: true,
    };
    const profilePath = join(fixtureRoot, "wrap.sb");

    const confined = confineCommandSpec(
      spec,
      { confined: true, writableRoot: project, denyWrite: [join(project, ".env")] },
      profilePath,
    );

    const { execPath, execArgs } = commandExecution(spec);
    expect(confined.shell).toBe(false);
    expect(confined.cwd).toBe(project);
    expect(confined.env).toEqual({ PROBE: "1" });
    expect(confined.command).toBe("echo hi");
    expect(confined.argv![0]).toBe(support.executable);
    expect(confined.argv!.slice(-1 - execArgs.length)).toEqual([execPath, ...execArgs]);

    if (support.backend === "macos-seatbelt") {
      const profile = readFileSync(profilePath, "utf8");
      expect(profile).toContain(`(allow file-write* (subpath "${project}"))`);
      expect(profile).toContain(`(deny file-write* (subpath "${join(project, ".env")}"))`);
      expect(profile).toContain(`(allow file-write* (subpath "${homedir()}/.pi"))`);
    }
  });
});

async function waitForStatus(id: string, status: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readMeta(id)?.status === status) return readMeta(id);
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`task ${id} never reached ${status}: ${JSON.stringify(readMeta(id))}`);
}

describe("structured remote SSH tasks ignore the foreground sandbox", () => {
  // @covers background-task.sandbox-remote-unchanged
  // @level integration
  it("launches a remote watch even while local launches are blocked", async () => {
    const { pi, events } = createPi();
    observeForegroundSandboxPolicy(pi);
    createSandboxPublisher(events).announce({
      state: "unavailable",
      reason: "no backend on this platform",
    });
    const runner = new FakeRemoteRunner();

    const meta = startWatchTask(pi, {
      command: "printf 'done\\n'",
      interval_seconds: 60,
      timeout_seconds: 5,
      callback: false,
      ssh: { host: "watch.example" },
      remote: { session: "direct", install_tmux: false },
      success_when: { type: "stdout_contains", value: "done" },
    }, fixtureRoot, undefined, undefined, { remoteRunner: runner });

    await waitForStatus(meta.id, "succeeded");
    expect(meta.ssh?.target).toBe("watch.example");
    expect(meta.launchArgv).toBeUndefined();
    expect(runner.runCalls[0]).toMatchObject({
      argv: [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-T",
        "--",
        "watch.example",
        "printf 'done\\n'",
      ],
      shell: false,
    });
    expect(existsSync(join(fixtureRoot, "unused.sb"))).toBe(false);
  });
});
