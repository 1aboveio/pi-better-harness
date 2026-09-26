import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { commandExecution } from "./process.js";
import { baseDir, readMeta } from "./registry.js";
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
import { compileWritePolicy, type SandboxSeams } from "./shared-sandbox-core.js";
import { FakeRemoteRunner } from "./test-support/fake-remote-runner.js";
import type { CommandSpec } from "./types.js";

// Prefer /var/tmp so outside-project probes are meaningful on macOS. Some
// restricted hosts disallow fixture creation there; policy/argv tests can use
// the process temp directory without changing kernel integration fixtures.
const varTmp = realpathSync("/var/tmp");
let fixtureRoot: string;
try {
  fixtureRoot = realpathSync(mkdtempSync(join(varTmp, "bg-sandbox-contract-")));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "bg-sandbox-contract-")));
}
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

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

/**
 * Backends that resolve on any host, so the argv this package produces is proved
 * for both of them wherever the suite runs. Which backend a runner actually has
 * decides nothing here: real kernel enforcement is what `sandbox-kernel.test.ts`
 * proves, against a real backend, on the platform CI lanes.
 */
const MACOS: SandboxSeams = { platform: () => "darwin" };
const LINUX: SandboxSeams = {
  platform: () => "linux",
  lookupExecutable: (name) => (name === "bwrap" ? "/usr/bin/bwrap" : undefined),
};

/** One project, one shell spec, and a profile path no other test writes to. */
function wrapFixture(name: string) {
  const project = join(fixtureRoot, name);
  mkdirSync(project, { recursive: true });
  const spec: CommandSpec = { command: "echo hi", cwd: project, env: { PROBE: "1" }, shell: true };
  return { spec, project, profilePath: join(fixtureRoot, `${name}.sb`) };
}

/** The launch plan both wrapping tests confine. */
function wrapPlan(project: string) {
  return { confined: true, writableRoot: project, denyWrite: [join(project, ".env")] } as const;
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
  it("inherits the foreground default-off policy as an unconfined launch", () => {
    const { pi, events } = createPi();
    observeForegroundSandboxPolicy(pi);
    createSandboxPublisher(events).announce({
      state: "inactive",
      reason: "the foreground sandbox is available but inactive by default",
    });

    expect(currentForegroundSandboxPolicy(pi)?.state).toBe("inactive");
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

  it("captures permission values as a launch snapshot and rejects disabled Main commands", () => {
    const { pi, events } = createPi();
    const publisher = createSandboxPublisher(events);
    const permissions = { enabled: true, projectFiles: "read-write", outsideProject: "read",
      storedCredentials: "read", commands: true, network: false };
    publisher.announce({ ...enabledPolicy(varTmp), permissions });
    const plan = resolveForegroundSandboxPlan(pi);
    expect(plan).toMatchObject({ confined: true, permissions: { network: false } });
    permissions.network = true;
    expect(plan).toMatchObject({ confined: true, permissions: { network: false } });

    publisher.announce({ ...enabledPolicy(varTmp), permissions: { ...permissions, commands: false } });
    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(/Main profile disables commands/);
  });

  it("checks SSH launch permissions before allowing remote setup", () => {
    const { pi, events } = createPi();
    const publisher = createSandboxPublisher(events);
    publisher.announce(enabledPolicy(varTmp));
    expect(resolveForegroundSandboxPlan(pi, true)).toEqual({ confined: false });
    const permissions = { enabled: true, projectFiles: "read-write", outsideProject: "read",
      storedCredentials: "read", commands: true, network: false };
    publisher.announce({ ...enabledPolicy(varTmp), permissions });
    expect(() => resolveForegroundSandboxPlan(pi, true)).toThrow(/disables network/);
    publisher.announce({ ...enabledPolicy(varTmp), permissions: { ...permissions, commands: false } });
    expect(() => resolveForegroundSandboxPlan(pi, true)).toThrow(/disables commands/);
    publisher.announce({ ...enabledPolicy(varTmp), permissions: { ...permissions, network: true } });
    expect(() => resolveForegroundSandboxPlan(pi, true)).toThrow(/Structured SSH cannot apply/);
    publisher.announce({ state: "disabled", permissions: { ...permissions, enabled: false } });
    expect(resolveForegroundSandboxPlan(pi, true)).toEqual({ confined: false });
  });

  it("fails closed on invalid permission events instead of using an older policy", () => {
    const { pi, events } = createPi();
    const publisher = createSandboxPublisher(events);
    publisher.announce(enabledPolicy(varTmp));
    publisher.announce({
      ...enabledPolicy(varTmp), permissions: { enabled: true, commands: "no" },
    });
    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(/Invalid Main sandbox permission profile/);
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
  it("wraps the exact executable and argv the unconfined launch would have run, under Seatbelt", () => {
    const { spec, project, profilePath } = wrapFixture("wrap-macos");

    const confined = confineCommandSpec(spec, wrapPlan(project), profilePath, MACOS);

    const { execPath, execArgs } = commandExecution(spec);
    expect(confined.shell).toBe(false);
    expect(confined.cwd).toBe(project);
    expect(confined.env).toEqual({ PROBE: "1" });
    expect(confined.command).toBe("echo hi");
    expect(confined.argv![0]).toBe("/usr/bin/sandbox-exec");
    expect(confined.argv!.slice(-1 - execArgs.length)).toEqual([execPath, ...execArgs]);

    const profile = readFileSync(profilePath, "utf8");
    expect(profile).toContain(`(allow file-write* (subpath "${project}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${join(project, ".env")}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${homedir()}/.pi"))`);
    // The deny that protects the mechanism itself: the registry holds the launch
    // vector a resumed watch re-runs and the profile that vector names.
    expect(profile).toContain(`(deny file-write* (subpath "${realpathSync(baseDir())}"))`);
  });

  it("passes the permission snapshot to the backend, including network", () => {
    const { spec, project, profilePath } = wrapFixture("permissions-macos");
    const permissions = { projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
      commands: true, network: false } as const;
    const plan = { ...wrapPlan(project), permissions };
    if (!("permissions" in compileWritePolicy({ writableRoot: project, home: homedir(), ...{ permissions } }))) {
      expect(() => confineCommandSpec(spec, plan, profilePath, MACOS)).toThrow(/permission-aware sandbox core is unavailable/);
    } else {
      confineCommandSpec(spec, plan, profilePath, MACOS);
      expect(readFileSync(profilePath, "utf8")).toContain("(deny network*)");
    }
  });

  // @covers background-task.sandbox-launch-capture
  // @level integration
  it("wraps the exact executable and argv the unconfined launch would have run, under Bubblewrap", () => {
    const { spec, project, profilePath } = wrapFixture("wrap-linux");

    const confined = confineCommandSpec(spec, wrapPlan(project), profilePath, LINUX);

    const { execPath, execArgs } = commandExecution(spec);
    expect(confined.shell).toBe(false);
    expect(confined.cwd).toBe(project);
    expect(confined.env).toEqual({ PROBE: "1" });
    expect(confined.command).toBe("echo hi");
    expect(confined.argv![0]).toBe("/usr/bin/bwrap");
    expect(confined.argv!.slice(-1 - execArgs.length)).toEqual([execPath, ...execArgs]);

    // The writable root is bound read-write, and the denied path is layered back
    // over it read-only so the deny wins wherever the binds overlap. A hard
    // `--ro-bind`, not `--ro-bind-try`: bubblewrap skips a bind whose source is
    // absent, so the denied path is given a mount point first.
    const argv = confined.argv!;
    const denied = join(project, ".env");
    expect(argv.join(" ")).toContain(`--bind ${project} ${project}`);
    expect(argv.join(" ")).toContain(`--ro-bind ${denied} ${denied}`);
    expect(argv.indexOf("--ro-bind", 2)).toBeGreaterThan(argv.indexOf("--bind"));
    // The task registry is denied too: it holds the launch vector a resumed
    // watch re-runs and the profile that vector names, so a confined task must
    // not be able to choose what its own next run executes.
    const registry = realpathSync(baseDir());
    expect(argv.join(" ")).toContain(`${registry} ${registry}`);
    // Bubblewrap carries its policy in argv, so nothing is written to disk.
    expect(existsSync(profilePath)).toBe(false);
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
