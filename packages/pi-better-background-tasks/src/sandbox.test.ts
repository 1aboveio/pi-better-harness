import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { commandExecution } from "./process.js";
import { baseDir, readMeta, taskDir, writeMeta } from "./registry.js";
import { resumeRunningTask, spawnTask, startWatchTask, stopTask } from "./runtime.js";
import {
  assertBackgroundExecutionAllowed,
  backgroundExecutionLimits,
  confineCommandSpec,
  currentForegroundSandboxPolicy,
  ForegroundSandboxBlockedError,
  FOREGROUND_SANDBOX_POLICY_CHANNEL,
  FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
  isCommandTimeoutSeconds,
  isShellExecutable,
  MAX_COMMAND_TIMEOUT_SECONDS,
  observeForegroundSandboxPolicy,
  resolveForegroundSandboxPlan,
} from "./sandbox.js";
import { compileWritePolicy, describeSandboxSupport, type SandboxSeams } from "./shared-sandbox-core.js";
import { FakeRemoteRunner } from "./test-support/fake-remote-runner.js";
import type { BackgroundTaskMeta, CommandSpec } from "./types.js";

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

  it("accepts the Write levels for file rows but not for stored credentials", () => {
    const { pi, events } = createPi();
    const publisher = createSandboxPublisher(events);
    const permissions = { enabled: true, projectFiles: "write", outsideProject: "write",
      storedCredentials: "read", commands: true, network: true };
    publisher.announce({ ...enabledPolicy(varTmp), permissions });
    expect(resolveForegroundSandboxPlan(pi)).toMatchObject({
      confined: true, permissions: { projectFiles: "write", outsideProject: "write" },
    });
    publisher.announce({ ...enabledPolicy(varTmp), permissions: { ...permissions, storedCredentials: "write" } });
    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(/Invalid Main sandbox permission profile/);
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

  it("reports a placeholder the Linux backend leaves in the workspace, for the task log (#350)", () => {
    const { spec, project, profilePath } = wrapFixture("placeholder-notice-linux");
    const fakeHome = join(fixtureRoot, "placeholder-notice-home");
    mkdirSync(fakeHome, { recursive: true });
    symlinkSync(join(project, "rc"), join(fakeHome, ".zlogin"));
    const permissions = { projectFiles: "read-write", outsideProject: "write", storedCredentials: "read",
      commands: true, network: true } as const;
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const notices: string[] = [];
      confineCommandSpec(spec, { ...wrapPlan(project), permissions }, profilePath, {
        ...LINUX, makeDirectory: () => {},
        maskSources: () => ({ directory: join(fixtureRoot, "mask-dir"), file: join(fixtureRoot, "mask-file") }),
      }, (line) => notices.push(line));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(join(project, "rc"));
      expect(notices[0]).toContain("remove it before creating the real target");
      expect(existsSync(join(project, "rc"))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
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

/** Count task directories without failing when no task has been created yet. */
function taskDirCount(): number {
  try { return readdirSync(baseDir()).length; } catch { return 0; }
}

function permissionsFor(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true, projectFiles: "read-write", outsideProject: "read",
    storedCredentials: "read", commands: true, network: true,
    ...overrides,
  };
}

/** The persisted cap, read through the shared metadata type. */
function persistedCap(meta: BackgroundTaskMeta | undefined): number | undefined {
  return meta?.commandTimeoutSeconds;
}

async function waitFor(
  id: string,
  done: (meta: BackgroundTaskMeta | undefined) => boolean,
  timeoutMs = 4000,
): Promise<BackgroundTaskMeta | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readMeta(id);
    if (done(meta)) return meta;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${id} did not reach the expected state: ${JSON.stringify(readMeta(id))}`);
}

describe("background application execution settings", () => {
  it("defaults a missing shell switch and cap to the historical behavior", () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({ ...enabledPolicy(varTmp), permissions: permissionsFor() });

    expect(backgroundExecutionLimits(resolveForegroundSandboxPlan(pi))).toEqual({ shell: true });
  });

  it("captures the shell switch and cap as an immutable launch snapshot", () => {
    const { pi, events } = createPi();
    const publisher = createSandboxPublisher(events);
    const permissions: Record<string, unknown> = permissionsFor({ shell: false, commandTimeoutSeconds: 42 });
    publisher.announce({ ...enabledPolicy(varTmp), permissions });

    const plan = resolveForegroundSandboxPlan(pi);
    expect(backgroundExecutionLimits(plan)).toEqual({ shell: false, commandTimeoutSeconds: 42 });
    permissions.shell = true;
    permissions.commandTimeoutSeconds = 1;
    expect(backgroundExecutionLimits(plan)).toEqual({ shell: false, commandTimeoutSeconds: 42 });
  });

  it("treats a null cap as unlimited and a false profile switch as unrestricted", () => {
    const { pi, events } = createPi();
    const publisher = createSandboxPublisher(events);
    publisher.announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ shell: false, commandTimeoutSeconds: null }),
    });
    expect(backgroundExecutionLimits(resolveForegroundSandboxPlan(pi))).toEqual({ shell: false });

    publisher.announce({
      state: "disabled",
      permissions: permissionsFor({ enabled: false, shell: false, commandTimeoutSeconds: 5 }),
    });
    expect(backgroundExecutionLimits(resolveForegroundSandboxPlan(pi))).toEqual({ shell: true });
  });

  it("reads the Background tasks profile independently of Main", () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor(),
      background: {
        ...enabledPolicy(varTmp),
        permissions: permissionsFor({ shell: false, commandTimeoutSeconds: 5 }),
      },
    });

    expect(backgroundExecutionLimits(resolveForegroundSandboxPlan(pi))).toEqual({ shell: false, commandTimeoutSeconds: 5 });
  });

  it("fails closed on invalid Background tasks application fields", () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      background: {
        ...enabledPolicy(varTmp),
        permissions: permissionsFor({ commandTimeoutSeconds: 0 }),
      },
    });

    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(/Invalid Background tasks sandbox permission profile/);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["above the timer maximum", MAX_COMMAND_TIMEOUT_SECONDS + 1],
    ["not finite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["a string", "30"],
    ["a boolean", true],
  ])("fails closed on a command time limit that is %s", (_label, value) => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ commandTimeoutSeconds: value }),
    });

    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(/Invalid Main sandbox permission profile/);
  });

  it.each([["a string", "no"], ["zero", 0], ["null", null]])("fails closed on a shell switch that is %s", (_label, value) => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ shell: value }),
    });

    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(/Invalid Main sandbox permission profile/);
  });

  it("accepts the contract boundaries for a command time limit", () => {
    expect(isCommandTimeoutSeconds(0.25)).toBe(true);
    expect(isCommandTimeoutSeconds(MAX_COMMAND_TIMEOUT_SECONDS)).toBe(true);
    for (const invalid of [0, -1, MAX_COMMAND_TIMEOUT_SECONDS + 0.5, Infinity, NaN, "30", null, undefined]) {
      expect(isCommandTimeoutSeconds(invalid)).toBe(false);
    }
  });

  it("recognizes a direct shell executable by its basename, PATH lookup, or canonical target", () => {
    for (const shell of ["bash", "/bin/bash", "/bin/sh", "C:\\Program Files\\Git\\bin\\bash.exe", "PowerShell", "pwsh", "cmd.exe", "./dash", "busybox"]) {
      expect(isShellExecutable(shell), shell).toBe(true);
    }
    for (const application of ["node", "/usr/bin/env", "/opt/tools/python3", "bashful", ""]) {
      expect(isShellExecutable(application), application).toBe(false);
    }
    const shellAlias = join(fixtureRoot, `shell-alias-${Date.now()}`);
    symlinkSync("/bin/bash", shellAlias);
    expect(isShellExecutable(shellAlias)).toBe(true);
    const applicationAlias = join(fixtureRoot, `application-alias-${Date.now()}`);
    symlinkSync(process.execPath, applicationAlias);
    expect(isShellExecutable(applicationAlias)).toBe(false);
    const pathDir = join(fixtureRoot, `shell-path-${Date.now()}`);
    mkdirSync(pathDir, { recursive: true });
    symlinkSync("/bin/sh", join(pathDir, "looks-like-an-app"));
    expect(isShellExecutable("looks-like-an-app", { PATH: pathDir })).toBe(true);
  });

  it("resolves a relative executable and a relative PATH entry against the launch cwd", () => {
    const root = mkdtempSync(join(fixtureRoot, "cwd-scope-"));
    const launch = join(root, "launch");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(join(launch, "bin"), { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    // An alias-style name whose canonical target is a shell.
    symlinkSync(realpathSync("/bin/sh"), join(launch, "bin", "runner"));
    const env = { PATH: "./bin" };

    expect(isShellExecutable("runner", env, launch)).toBe(true);
    expect(isShellExecutable("./bin/runner", env, launch)).toBe(true);
    // The same relative executable/PATH seen from another cwd is not this file.
    expect(isShellExecutable("runner", env, elsewhere)).toBe(false);
    expect(isShellExecutable("./bin/runner", env, elsewhere)).toBe(false);
  });

  it("skips a non-executable PATH candidate and refuses a hardlink alias by shell identity", () => {
    const root = mkdtempSync(join(fixtureRoot, "path-xok-"));
    const shadow = join(root, "shadow");
    const real = join(root, "real");
    mkdirSync(shadow);
    mkdirSync(real);
    const shell = realpathSync("/bin/sh");
    // Same bytes and inode shape as the real candidate, but not executable.
    copyFileSync(shell, join(shadow, "runner"));
    chmodSync(join(shadow, "runner"), 0o644);
    copyFileSync(shell, join(real, "runner"));
    chmodSync(join(real, "runner"), 0o755);
    // A known shell name in the same directory gives the inode an identity.
    linkSync(join(real, "runner"), join(real, "bash"));

    // The non-executable shadow is skipped, and PATH order continues to `real`.
    expect(isShellExecutable("runner", { PATH: "./shadow:./real" }, root)).toBe(true);
    // With only the non-executable shadow, no executable resolves at all.
    expect(isShellExecutable("runner", { PATH: "./shadow" }, root)).toBe(false);
  });

  it("accepts an ordinary argv resolved through the launch cwd", () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ shell: false }),
    });
    const plan = resolveForegroundSandboxPlan(pi);
    const project = mkdtempSync(join(fixtureRoot, "ordinary-argv-"));
    symlinkSync(process.execPath, join(project, "app"));
    const env = { PATH: "." };

    expect(isShellExecutable("app", env, project)).toBe(false);
    expect(() => assertBackgroundExecutionAllowed(
      { argv: ["app", "-e", "process.exit(0)"], shell: false, cwd: project, env },
      plan,
      { cwd: project },
    )).not.toThrow();
    // The launch spec's own cwd is the same answer when no explicit cwd is given.
    expect(() => assertBackgroundExecutionAllowed(
      { argv: ["app", "-e", "process.exit(0)"], shell: false, cwd: project, env },
      plan,
    )).not.toThrow();
  });

  it("refuses a launch-cwd shell alias without executing it", () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ shell: false }),
    });
    const project = mkdtempSync(join(fixtureRoot, "alias-never-runs-"));
    symlinkSync(realpathSync("/bin/sh"), join(project, "app"));
    const marker = join(project, "ran.txt");
    const before = taskDirCount();

    expect(() => spawnTask(pi, {
      argv: ["app", "-c", `printf ran > ${JSON.stringify(marker)}`],
      shell: false,
      cwd: project,
      env: { PATH: "." },
      callback: false,
    }, project)).toThrow(/direct shell executable/);
    expect(existsSync(marker)).toBe(false);
    expect(taskDirCount()).toBe(before);
  });

  it("allows only a direct argv launch while Shell scripts is off", () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ shell: false }),
    });
    const plan = resolveForegroundSandboxPlan(pi);

    expect(() => assertBackgroundExecutionAllowed({ command: "echo hi", shell: true }, plan))
      .toThrow(/disables shell commands/);
    expect(() => assertBackgroundExecutionAllowed({ command: "echo hi" }, plan))
      .toThrow(/disables shell commands/);
    expect(() => assertBackgroundExecutionAllowed({ argv: ["/bin/bash", "-c", "echo hi"], shell: false }, plan))
      .toThrow(/direct shell executable/);
    expect(() => assertBackgroundExecutionAllowed({ argv: ["bash", "-c", "echo hi"], shell: false }, plan))
      .toThrow(/direct shell executable/);
    expect(() => assertBackgroundExecutionAllowed({ argv: [process.execPath, "-e", "process.exit(0)"], shell: false }, plan))
      .not.toThrow();
  });

  it("keeps commands as the master switch over the shell switch", () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ commands: false, shell: false }),
    });

    expect(() => resolveForegroundSandboxPlan(pi)).toThrow(/disables commands/);
  });

  it("refuses structured SSH under the shell switch", () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      // A profile-level shell rule with no confinement is reachable only in a
      // synthetic snapshot; the assertion must still protect that branch.
      state: "disabled",
      permissions: permissionsFor({ shell: false }),
    });
    const plan = resolveForegroundSandboxPlan(pi, true);
    expect(plan).toEqual({ confined: false });

    expect(() => assertBackgroundExecutionAllowed({ command: "echo hi" }, plan, { remote: true }))
      .toThrow(/Structured SSH carries a remote shell command/);
  });

  it("refuses a shell launch before any task state exists", () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ shell: false }),
    });
    const before = taskDirCount();

    expect(() => spawnTask(pi, { command: "echo hi", cwd: varTmp, callback: false }, varTmp))
      .toThrow(/disables shell commands/);
    expect(() => startWatchTask(pi, {
      command: "echo hi", interval_seconds: 60, timeout_seconds: 5, callback: false,
      success_when: { type: "exit_code", equals: 0 },
    }, varTmp)).toThrow(/disables shell commands/);
    expect(taskDirCount()).toBe(before);
  });

});

const realBackend = describeSandboxSupport();
const backendDescribe = realBackend.supported ? describe : describe.skip;

backendDescribe("background application settings on a real launch", () => {
  function launchProject(name: string): string {
    const project = join(fixtureRoot, name);
    mkdirSync(project, { recursive: true });
    return project;
  }

  it("runs a shell:false argv when Shell scripts is off, still confined", async () => {
    const project = launchProject("settings-shell-off");
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(project),
      permissions: permissionsFor({ shell: false }),
    });

    const meta = spawnTask(pi, {
      name: "direct application",
      argv: [process.execPath, "-e", "require('node:fs').writeFileSync('ran.txt', 'direct')"],
      shell: false,
      cwd: project,
      callback: false,
    }, project);
    try {
      const terminal = await waitForStatus(meta.id, "succeeded", 10_000);
      expect(terminal?.sandbox?.confinement).toBe("confined");
      expect(readFileSync(join(project, "ran.txt"), "utf8")).toBe("direct");
      expect(persistedCap(terminal)).toBeUndefined();
    } finally {
      rmSync(taskDir(meta.id), { recursive: true, force: true });
    }
  });

  it("never interprets executable text as a shell or executable names as env assignments", async () => {
    const project = launchProject("settings-no-fallback");
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({ ...enabledPolicy(project), permissions: permissionsFor({ shell: false }) });
    const plain = join(project, "plain-program");
    writeFileSync(plain, 'printf "implicit-shell-%s" "$((6 * 7))"', { mode: 0o700 });
    const textTask = spawnTask(pi, { shell: false, argv: [plain], callback: false }, project);
    try {
      await waitForStatus(textTask.id, "failed", 10_000);
      const output = readFileSync(textTask.logPath, "utf8");
      expect(output).toContain("shell fallback is disabled");
      expect(output).not.toContain("implicit-shell-42");
    } finally { rmSync(taskDir(textTask.id), { recursive: true, force: true }); }
    const alias = join(project, "runner=1");
    symlinkSync("/usr/bin/true", alias);
    const marker = join(project, "unexpected-shell");
    const aliasTask = spawnTask(pi, { shell: false, argv: [alias, "/bin/sh", "-c", `touch ${JSON.stringify(marker)}`],
      callback: false }, project);
    try {
      await waitForStatus(aliasTask.id, "succeeded", 10_000);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(taskDir(aliasTask.id), { recursive: true, force: true }); }
  });

  it("caps a spawned command even when the caller's timeout_seconds is 0", async () => {
    const project = launchProject("settings-spawn-cap");
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(project),
      permissions: permissionsFor({ commandTimeoutSeconds: 0.25 }),
    });

    const meta = spawnTask(pi, {
      name: "capped spawn",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      shell: false,
      cwd: project,
      callback: false,
      timeout_seconds: 0,
    }, project);
    try {
      const terminal = await waitForStatus(meta.id, "timed_out", 5_000);
      expect(terminal?.deadlineAt).toBeUndefined();
      expect(persistedCap(terminal)).toBe(0.25);
      expect(terminal?.result).toMatchObject({ reason: expect.stringContaining("command time limit of 0.25s") });
    } finally {
      rmSync(taskDir(meta.id), { recursive: true, force: true });
    }
  });

  it("lets a smaller caller timeout win over a larger policy cap", async () => {
    const project = launchProject("settings-caller-timeout");
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(project),
      permissions: permissionsFor({ commandTimeoutSeconds: 60 }),
    });

    const meta = spawnTask(pi, {
      name: "caller deadline",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      shell: false,
      cwd: project,
      callback: false,
      timeout_seconds: 0.25,
    }, project);
    try {
      const terminal = await waitForStatus(meta.id, "timed_out", 5_000);
      expect(terminal?.deadlineAt).toBeDefined();
      expect(persistedCap(terminal)).toBe(60);
      expect(terminal?.result).toMatchObject({ reason: "timeout" });
    } finally {
      rmSync(taskDir(meta.id), { recursive: true, force: true });
    }
  });

  it("caps each watch check while timeout_seconds:0 keeps the watch lifetime unbounded", async () => {
    const project = launchProject("settings-watch-cap");
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(project),
      permissions: permissionsFor({ commandTimeoutSeconds: 0.25 }),
    });

    const meta = startWatchTask(pi, {
      name: "capped watch",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      shell: false,
      interval_seconds: 60,
      timeout_seconds: 0,
      callback: false,
      success_when: { type: "exit_code", equals: 0 },
    }, project);
    try {
      const terminal = await waitForStatus(meta.id, "timed_out", 5_000);
      expect(terminal?.deadlineAt).toBeUndefined();
      expect(persistedCap(terminal)).toBe(0.25);
      expect(terminal?.result).toMatchObject({ reason: expect.stringContaining("command time limit of 0.25s") });
    } finally {
      rmSync(taskDir(meta.id), { recursive: true, force: true });
    }
  });

  it("does not turn the per-command cap into a whole-watch lifetime", async () => {
    const project = launchProject("settings-watch-lifetime");
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(project),
      permissions: permissionsFor({ commandTimeoutSeconds: 0.5 }),
    });

    const meta = startWatchTask(pi, {
      name: "repeating watch",
      argv: [process.execPath, "-e", "console.log('pending')"],
      shell: false,
      interval_seconds: 0.2,
      timeout_seconds: 0,
      callback: false,
      success_when: { type: "stdout_contains", value: "never" },
    }, project);
    try {
      const first = await waitFor(meta.id, (current) => current?.lastCheckedAt !== undefined, 5_000);
      await waitFor(meta.id, (current) => (current?.lastCheckedAt ?? 0) > (first?.lastCheckedAt ?? 0), 5_000);
      const remaining = 800 - (Date.now() - meta.startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      expect(readMeta(meta.id)?.status).toBe("running");
    } finally {
      await stopTask(pi, meta.id);
      rmSync(taskDir(meta.id), { recursive: true, force: true });
    }
  });
});

describe("persisted command caps survive reload", () => {
  it("enforces the spawn cap from its launch snapshot, not the current policy", async () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ commandTimeoutSeconds: 60 }),
    });
    const id = `bg_cap_spawn_reload_${Date.now()}`;
    const meta: BackgroundTaskMeta = {
      id,
      name: "capped spawn reload",
      kind: "process",
      status: "running",
      startedAt: Date.now() - 5_000,
      lastProgressAt: Date.now() - 5_000,
      logPath: join(taskDir(id), "output.log"),
      callback: false,
      cwd: process.cwd(),
      spawnPid: 999_999,
      commandTimeoutSeconds: 0.25,
    };
    writeMeta(meta);
    try {
      resumeRunningTask(pi, readMeta(id)!);
      const terminal = await waitFor(id, (current) => current?.status === "timed_out", 3_000);
      expect(terminal?.result).toMatchObject({ reason: expect.stringContaining("command time limit of 0.25s") });
    } finally {
      rmSync(taskDir(id), { recursive: true, force: true });
    }
  });

  it("enforces the watch cap from its launch snapshot even when the current policy is looser", async () => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ commandTimeoutSeconds: 60 }),
    });
    const id = `bg_cap_watch_reload_${Date.now()}`;
    const meta: BackgroundTaskMeta = {
      id,
      name: "capped watch reload",
      kind: "command_watch",
      status: "running",
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      intervalMs: 60_000,
      logPath: join(taskDir(id), "output.log"),
      callback: false,
      cwd: process.cwd(),
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      shell: false,
      successWhen: { type: "exit_code", equals: 0 },
      notifyOn: "terminal",
      spawnPid: 999_999,
      commandTimeoutSeconds: 0.25,
    };
    writeMeta(meta);
    try {
      resumeRunningTask(pi, readMeta(id)!);
      const terminal = await waitFor(id, (current) => current?.status === "timed_out", 5_000);
      expect(terminal?.result).toMatchObject({ reason: expect.stringContaining("command time limit of 0.25s") });
    } finally {
      rmSync(taskDir(id), { recursive: true, force: true });
    }
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["above the timer maximum", MAX_COMMAND_TIMEOUT_SECONDS + 1],
    ["not a number", "30"],
  ])("fails closed when a persisted cap is %s instead of resuming unlimited", async (_label, value) => {
    const { pi, events } = createPi();
    createSandboxPublisher(events).announce({
      ...enabledPolicy(varTmp),
      permissions: permissionsFor({ commandTimeoutSeconds: 60 }),
    });
    const id = `bg_cap_invalid_${Date.now()}_${String(value).replace(/\W/g, "_")}`;
    const marker = join(taskDir(id), "should-not-run.txt");
    const meta: BackgroundTaskMeta = {
      id,
      name: "invalid capped watch reload",
      kind: "command_watch",
      status: "running",
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      intervalMs: 60_000,
      logPath: join(taskDir(id), "output.log"),
      callback: false,
      cwd: process.cwd(),
      argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      shell: false,
      successWhen: { type: "exit_code", equals: 0 },
      notifyOn: "terminal",
      spawnPid: 999_999,
      commandTimeoutSeconds: value as number,
    };
    writeMeta(meta);
    try {
      resumeRunningTask(pi, readMeta(id)!);
      const terminal = await waitFor(id, (current) => current?.status === "failed", 3_000);
      expect(terminal?.result).toMatchObject({ reason: expect.stringContaining("invalid") });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(taskDir(id), { recursive: true, force: true });
    }
  });
});
