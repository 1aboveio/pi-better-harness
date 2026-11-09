import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  assertBackgroundExecutionAllowed,
  backgroundExecutionLimits,
  confineCommandSpec,
  ForegroundSandboxBlockedError,
  FOREGROUND_SANDBOX_POLICY_CHANNEL,
  FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
  InvalidWorkerSandboxPolicyError,
  MAX_COMMAND_TIMEOUT_SECONDS,
  resolveWorkerSandboxPlan,
  sandboxProvenance,
  type WorkerSandboxPermissions,
  type WorkerSandboxPolicy,
} from "./sandbox.js";
import { compileWritePolicy, type SandboxSeams } from "./shared-sandbox-core.js";
import type { CommandSpec } from "./types.js";

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "bg-worker-policy-")));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

/** A backend that resolves on any host, so the argv is proved without a kernel. */
const MACOS: SandboxSeams = { platform: () => "darwin" };

function projectDir(name: string): string {
  const project = join(fixtureRoot, name);
  mkdirSync(project, { recursive: true });
  return project;
}

function createPi(): { pi: ExtensionAPI; events: EventEmitter } {
  const events = new EventEmitter();
  return { pi: { events } as unknown as ExtensionAPI, events };
}

/**
 * A stand-in for `pi-better-sandbox`'s publisher: the exact channels and payload
 * shape, including the sibling Main profile and the Background column, and the
 * answer to a late consumer's request. Nothing in this package is faked.
 */
function createPublisher(events: EventEmitter) {
  let payload: Record<string, unknown> | undefined;
  const publish = () => { if (payload) events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, payload); };
  events.on(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, publish);
  const base = (denyWrite: readonly string[]) => ({
    denyWrite: Object.freeze([...denyWrite]),
    platform: process.platform,
    readPolicy: "unrestricted",
    networkPolicy: "unrestricted",
    reason: "test policy",
  });
  return {
    announce(options: { main?: Record<string, unknown>; background?: Record<string, unknown> }) {
      const main = options.main ?? {};
      payload = Object.freeze({
        ...base((main.denyWrite as string[] | undefined) ?? []),
        ...main,
        ...(options.background === undefined ? {} : {
          background: Object.freeze({
            ...base((options.background.denyWrite as string[] | undefined) ?? []),
            ...options.background,
          }),
        }),
      });
      publish();
    },
  };
}

function enabled(root: string, denyWrite: string[] = []): Record<string, unknown> {
  return { state: "enabled", writableRoot: root, denyWrite, reason: `Writes are confined to ${root}.` };
}

function off(reason = "a human turned it off"): Record<string, unknown> {
  return { state: "disabled", denyWrite: [], reason };
}

/** A Background-column profile (publisher shape: it carries `enabled`). */
function backgroundPermissions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true, projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
    commands: true, network: true, ...overrides,
  };
}

/** A worker-captured TaskPolicy-shaped profile (no `enabled` is required). */
function workerPermissions(overrides: Record<string, unknown> = {}): WorkerSandboxPermissions {
  return {
    projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
    commands: true, network: true, ...overrides,
  } as WorkerSandboxPermissions;
}

function workerPolicy(root: string, overrides: Partial<WorkerSandboxPolicy> = {}): WorkerSandboxPolicy {
  return Object.freeze({
    root,
    denyWrite: [],
    permissions: workerPermissions(),
    ...overrides,
  });
}

const ACCESS_RANK = { off: 0, read: 1, write: 2, "read-write": 3 } as const;

describe("worker → background sandbox authority", () => {
  // @covers background-task.worker-sandbox-intersection
  // @level integration
  it("applies the current Background profile when the worker captured no authority", () => {
    const { pi, events } = createPi();
    const project = projectDir("worker-unconfined");
    createPublisher(events).announce({
      main: enabled(project),
      background: {
        ...enabled(project),
        permissions: backgroundPermissions({ shell: false, commandTimeoutSeconds: 30 }),
      },
    });

    const plan = resolveWorkerSandboxPlan(pi, undefined);

    expect(plan.confined).toBe(true);
    expect(plan.confined && plan.writableRoot).toBe(project);
    expect(backgroundExecutionLimits(plan)).toEqual({ shell: false, commandTimeoutSeconds: 30 });
    expect(() => assertBackgroundExecutionAllowed({ command: "echo hi", shell: true }, plan))
      .toThrow(/disables shell commands/);
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("stays unconfined when the worker is unconfined and Background is off", () => {
    const { pi, events } = createPi();
    createPublisher(events).announce({ main: enabled(fixtureRoot), background: off() });

    const plan = resolveWorkerSandboxPlan(pi, undefined);

    expect(plan).toEqual({ confined: false });
    expect(backgroundExecutionLimits(plan)).toEqual({ shell: true });
    expect(sandboxProvenance(plan)).toMatchObject({ confinement: "unconfined", policySource: "background" });
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("preserves worker confinement and settings when Background is off", () => {
    const { pi, events } = createPi();
    const project = projectDir("worker-only");
    createPublisher(events).announce({ main: enabled(fixtureRoot), background: off() });
    const permissions = workerPermissions({
      projectFiles: "read", outsideProject: "off", storedCredentials: "read",
      network: false, shell: false, commandTimeoutSeconds: 10,
    });

    const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
      denyWrite: [join(project, ".env")],
      permissions,
    }));

    expect(plan).toMatchObject({
      confined: true,
      writableRoot: project,
      denyWrite: [join(project, ".env")],
      permissions: {
        projectFiles: "read", outsideProject: "off", storedCredentials: "read",
        commands: true, network: false, shell: false, commandTimeoutSeconds: 10,
      },
    });
    expect(backgroundExecutionLimits(plan)).toEqual({ shell: false, commandTimeoutSeconds: 10 });
    expect(sandboxProvenance(plan)).toMatchObject({ confinement: "confined", policySource: "background" });
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("intersects file levels, ANDs switches, takes the smaller cap, and unions deny paths", () => {
    const { pi, events } = createPi();
    const project = projectDir("worker-intersect");
    const backgroundDeny = [join(project, ".git"), join(project, ".env")];
    createPublisher(events).announce({
      main: enabled(project),
      background: {
        ...enabled(project, backgroundDeny),
        permissions: backgroundPermissions({ commandTimeoutSeconds: 60 }),
      },
    });

    const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
      denyWrite: [join(project, "secrets")],
      permissions: workerPermissions({
        projectFiles: "write", outsideProject: "read-write", storedCredentials: "read-write",
        network: true, shell: false, commandTimeoutSeconds: 15,
      }),
    }));

    expect(plan).toMatchObject({
      confined: true,
      writableRoot: project,
      permissions: {
        projectFiles: "write",
        outsideProject: "read",
        storedCredentials: "read",
        commands: true,
        network: true,
        shell: false,
        commandTimeoutSeconds: 15,
      },
    });
    expect(plan.confined && [...plan.denyWrite].sort()).toEqual(
      [...backgroundDeny, join(project, "secrets")].sort(),
    );
    expect(backgroundExecutionLimits(plan)).toEqual({ shell: false, commandTimeoutSeconds: 15 });
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("ANDs network access so a worker cannot regain a network the parent denied", () => {
    const { pi, events } = createPi();
    const project = projectDir("worker-network");
    createPublisher(events).announce({
      main: enabled(project),
      background: { ...enabled(project), permissions: backgroundPermissions({ network: true }) },
    });

    const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
      permissions: workerPermissions({ network: false }),
    }));

    expect(plan.confined && plan.permissions?.network).toBe(false);
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("ANDs the shell switch in both directions", () => {
    const project = projectDir("worker-shell-and");

    {
      const { pi, events } = createPi();
      createPublisher(events).announce({
        main: enabled(project),
        background: { ...enabled(project), permissions: backgroundPermissions({ shell: false }) },
      });
      const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
        permissions: workerPermissions({ shell: true }),
      }));
      expect(backgroundExecutionLimits(plan)).toEqual({ shell: false });
    }

    {
      const { pi, events } = createPi();
      createPublisher(events).announce({
        main: enabled(project),
        background: { ...enabled(project), permissions: backgroundPermissions({ shell: true }) },
      });
      const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
        permissions: workerPermissions({ shell: false }),
      }));
      expect(backgroundExecutionLimits(plan)).toEqual({ shell: false });
    }
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("reads the Background column, never the parent's broader sibling Main profile", () => {
    const { pi, events } = createPi();
    const project = projectDir("worker-main-isolation");
    createPublisher(events).announce({
      main: {
        ...enabled(project),
        permissions: backgroundPermissions({
          projectFiles: "read-write", outsideProject: "write", storedCredentials: "read-write", network: true,
        }),
      },
      background: {
        ...enabled(project),
        permissions: backgroundPermissions({
          projectFiles: "read", outsideProject: "off", storedCredentials: "off", network: false,
        }),
      },
    });

    const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
      permissions: workerPermissions({
        projectFiles: "read-write", outsideProject: "write", storedCredentials: "read-write", network: true,
      }),
    }));

    expect(plan).toMatchObject({
      confined: true,
      writableRoot: project,
      permissions: {
        projectFiles: "read", outsideProject: "off", storedCredentials: "off", network: false,
      },
    });
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("treats their canonical roots as the same root when one is a symlink", () => {
    const { pi, events } = createPi();
    const project = projectDir("worker-root-link");
    const link = join(fixtureRoot, "worker-root-link-alias");
    symlinkSync(project, link);
    createPublisher(events).announce({
      main: enabled(project),
      background: { ...enabled(project), permissions: backgroundPermissions() },
    });

    const plan = resolveWorkerSandboxPlan(pi, workerPolicy(link));

    expect(plan.confined && plan.writableRoot).toBe(project);
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("refuses differing canonical roots instead of dropping either side's rules", () => {
    const { pi, events } = createPi();
    const parentRoot = projectDir("worker-root-parent");
    const workerRoot = projectDir("worker-root-child");
    createPublisher(events).announce({
      main: enabled(parentRoot),
      background: { ...enabled(parentRoot), permissions: backgroundPermissions() },
    });

    let thrown: unknown;
    try {
      resolveWorkerSandboxPlan(pi, workerPolicy(workerRoot));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForegroundSandboxBlockedError);
    expect((thrown as Error).message).toMatch(/different directories/);
    expect((thrown as Error).message).toContain(parentRoot);
    expect((thrown as Error).message).toContain(workerRoot);
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("refuses an intersection when either confined side publishes no permission levels", () => {
    const project = projectDir("worker-no-levels");

    {
      const { pi, events } = createPi();
      createPublisher(events).announce({
        main: enabled(project),
        background: { ...enabled(project), permissions: backgroundPermissions() },
      });
      expect(() => resolveWorkerSandboxPlan(pi, { root: project, denyWrite: [] }))
        .toThrow(/no permission levels/);
    }

    {
      const { pi, events } = createPi();
      // A legacy Background profile: write confinement, no capability levels.
      createPublisher(events).announce({ main: enabled(project), background: enabled(project) });
      expect(() => resolveWorkerSandboxPlan(pi, workerPolicy(project)))
        .toThrow(/no permission levels/);
    }
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("refuses a worker whose captured command capability is Off", () => {
    for (const background of [off(), { ...enabled(fixtureRoot), permissions: backgroundPermissions() }]) {
      const { pi, events } = createPi();
      const project = projectDir("worker-commands-off");
      createPublisher(events).announce({ main: enabled(project), background });

      expect(() => resolveWorkerSandboxPlan(pi, workerPolicy(project, {
        permissions: workerPermissions({ commands: false }),
      }))).toThrow(/worker task authority disables commands/);
    }
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["above the timer maximum", MAX_COMMAND_TIMEOUT_SECONDS + 1],
    ["not finite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["a string", "30"],
    ["a boolean", true],
  ])("rejects an invalid worker command cap: %s", (_label, value) => {
    const { pi } = createPi();
    const project = projectDir(`worker-cap-${String(_label).replace(/[^a-z]+/gi, "-")}`);

    expect(() => resolveWorkerSandboxPlan(pi, workerPolicy(project, {
      permissions: workerPermissions({ commandTimeoutSeconds: value as number }),
    }))).toThrow(InvalidWorkerSandboxPolicyError);
    expect(() => resolveWorkerSandboxPlan(pi, workerPolicy(project, {
      permissions: workerPermissions({ commandTimeoutSeconds: value as number }),
    }))).toThrow(/commandTimeoutSeconds/);
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it.each([
    ["a non-object policy", 42, /must be an object/],
    ["a relative root", { root: "relative/project" }, /root must be an absolute path/],
    ["the filesystem root", { root: "/" }, /project directory/],
    ["a non-object permissions profile", { root: fixtureRoot, permissions: "read" }, /permissions must be an object/],
    ["an unknown project level", { root: fixtureRoot, permissions: { ...workerPermissions(), projectFiles: "everything" } }, /projectFiles must be/],
    ["an unknown outside level", { root: fixtureRoot, permissions: { ...workerPermissions(), outsideProject: "write-only" } }, /outsideProject must be/],
    ["a write credential level", { root: fixtureRoot, permissions: { ...workerPermissions(), storedCredentials: "write" } }, /storedCredentials must be/],
    ["a non-boolean commands switch", { root: fixtureRoot, permissions: { ...workerPermissions(), commands: "yes" } }, /commands must be a boolean/],
    ["a non-boolean network switch", { root: fixtureRoot, permissions: { ...workerPermissions(), network: 1 } }, /network must be a boolean/],
    ["a non-boolean shell switch", { root: fixtureRoot, permissions: { ...workerPermissions(), shell: "no" } }, /shell must be a boolean/],
    ["a relative deny entry", { root: fixtureRoot, denyWrite: ["secrets"] }, /denyWrite must be a list of absolute paths/],
  ])("rejects %s before any launch", (_label, value, message) => {
    const { pi } = createPi();
    expect(() => resolveWorkerSandboxPlan(pi, value as unknown as WorkerSandboxPolicy))
      .toThrow(InvalidWorkerSandboxPolicyError);
    expect(() => resolveWorkerSandboxPlan(pi, value as unknown as WorkerSandboxPolicy))
      .toThrow(message as RegExp);
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("refuses when the Background profile itself cannot be applied", () => {
    const { pi, events } = createPi();
    const project = projectDir("worker-background-failed");
    createPublisher(events).announce({
      main: { state: "failed", denyWrite: [], reason: "no backend on this platform" },
      background: { state: "failed", denyWrite: [], reason: "no backend on this platform" },
    });

    // The worker's own confinement is not a substitute for a Background profile
    // that failed closed: a protected launch is still blocked.
    expect(() => resolveWorkerSandboxPlan(pi, workerPolicy(project)))
      .toThrow(ForegroundSandboxBlockedError);
  });

  // @covers background-task.worker-sandbox-intersection
  // @level integration
  it("keeps the launch snapshot after the parent mutates the source object", () => {
    const { pi, events } = createPi();
    const project = projectDir("worker-snapshot");
    createPublisher(events).announce({ main: enabled(project), background: off() });
    const source = {
      root: project,
      denyWrite: [] as string[],
      permissions: { ...workerPermissions({ shell: false, commandTimeoutSeconds: 5 }) },
    };

    const plan = resolveWorkerSandboxPlan(pi, source);
    source.permissions.projectFiles = "off";
    source.permissions.shell = true;
    source.permissions.network = false;
    source.denyWrite.push(join(project, "later"));

    expect(plan.confined && plan.permissions).toMatchObject({
      projectFiles: "read-write", shell: false, commandTimeoutSeconds: 5,
    });
    expect(plan.confined && plan.denyWrite).toEqual([]);
    expect(backgroundExecutionLimits(plan)).toEqual({ shell: false, commandTimeoutSeconds: 5 });
    expect(() => assertBackgroundExecutionAllowed({ command: "echo hi", shell: true }, plan))
      .toThrow(/disables shell commands/);
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("keeps the intersected cap after the live Background profile loosens", () => {
    const { pi, events } = createPi();
    const project = projectDir("worker-live-snapshot");
    const publisher = createPublisher(events);
    publisher.announce({
      main: enabled(project),
      background: {
        ...enabled(project),
        permissions: backgroundPermissions({ shell: false, commandTimeoutSeconds: 5 }),
      },
    });

    const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
      permissions: workerPermissions({ shell: true, commandTimeoutSeconds: 300 }),
    }));

    publisher.announce({
      main: enabled(project),
      background: { ...enabled(project), permissions: backgroundPermissions({ shell: true }) },
    });

    expect(backgroundExecutionLimits(plan)).toEqual({ shell: false, commandTimeoutSeconds: 5 });
    expect(() => assertBackgroundExecutionAllowed({ command: "echo hi", shell: true }, plan))
      .toThrow(/disables shell commands/);
  });
});

describe("worker authority and command checks", () => {
  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("never yields a weaker command profile whether Background is on or off", () => {
    const project = projectDir("worker-no-weaker");
    const worker = workerPermissions({
      projectFiles: "read", outsideProject: "off", storedCredentials: "read",
      commands: true, network: false, shell: false, commandTimeoutSeconds: 5,
    });

    for (const background of [
      off(),
      { ...enabled(project), permissions: backgroundPermissions({
        projectFiles: "read-write", outsideProject: "write", storedCredentials: "read-write",
        commands: true, network: true, shell: true, commandTimeoutSeconds: 60,
      }) },
    ]) {
      const { pi, events } = createPi();
      createPublisher(events).announce({ main: enabled(project), background });

      const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, { permissions: worker }));
      expect(plan.confined).toBe(true);
      const effective = plan.confined ? plan.permissions : undefined;
      expect(effective).toBeDefined();
      expect(ACCESS_RANK[effective!.projectFiles]).toBeLessThanOrEqual(ACCESS_RANK[worker.projectFiles]);
      expect(ACCESS_RANK[effective!.outsideProject]).toBeLessThanOrEqual(ACCESS_RANK[worker.outsideProject]);
      expect(effective!.storedCredentials).toBe("read");
      expect(effective!.commands).toBe(true);
      expect(effective!.network).toBe(false);
      expect(effective!.shell).toBe(false);
      expect(backgroundExecutionLimits(plan)).toEqual({ shell: false, commandTimeoutSeconds: 5 });
      expect(() => assertBackgroundExecutionAllowed({ command: "echo hi", shell: true }, plan))
        .toThrow(/disables shell commands/);
    }
  });

  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it("refuses every shell bypass alias while Background is on and off", () => {
    const project = projectDir("worker-shell-aliases");
    symlinkSync(realpathSync("/bin/sh"), join(project, "alias"));
    const env = { PATH: "." };

    for (const background of [
      off(),
      { ...enabled(project), permissions: backgroundPermissions({ shell: true }) },
    ]) {
      const { pi, events } = createPi();
      createPublisher(events).announce({ main: enabled(project), background });
      const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
        permissions: workerPermissions({ shell: false }),
      }));

      expect(() => assertBackgroundExecutionAllowed({ command: "echo hi", shell: true }, plan))
        .toThrow(/disables shell commands/);
      expect(() => assertBackgroundExecutionAllowed({ command: "echo hi" }, plan))
        .toThrow(/disables shell commands/);
      expect(() => assertBackgroundExecutionAllowed(
        { argv: ["/bin/bash", "-c", "echo hi"], shell: false }, plan,
      )).toThrow(/direct shell executable/);
      expect(() => assertBackgroundExecutionAllowed(
        { argv: ["bash", "-c", "echo hi"], shell: false }, plan,
      )).toThrow(/direct shell executable/);
      expect(() => assertBackgroundExecutionAllowed(
        { argv: ["alias", "-c", "echo hi"], shell: false, cwd: project, env }, plan,
        { cwd: project },
      )).toThrow(/direct shell executable/);
      expect(() => assertBackgroundExecutionAllowed(
        { argv: [process.execPath, "-e", "process.exit(0)"], shell: false, cwd: project, env }, plan,
        { cwd: project },
      )).not.toThrow();
    }
  });

  // @covers background-task.worker-sandbox-intersection
  // @level integration
  it("confines a real command with the intersected levels, cap, and deny union", () => {
    const project = projectDir("worker-confine");
    const profilePath = join(fixtureRoot, "worker-confine.sb");
    const backgroundDeny = join(project, ".env");
    const workerDeny = join(project, "secrets");

    const { pi, events } = createPi();
    createPublisher(events).announce({
      main: enabled(project),
      background: {
        ...enabled(project, [backgroundDeny]),
        permissions: backgroundPermissions({ network: true, shell: true, commandTimeoutSeconds: 60 }),
      },
    });
    const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
      denyWrite: [workerDeny],
      permissions: workerPermissions({ network: false, shell: false, commandTimeoutSeconds: 20 }),
    }));

    // Prove the plan is usable by the real confinement path, not just readable.
    const permissions = plan.confined ? plan.permissions : undefined;
    if (!("permissions" in compileWritePolicy({
      writableRoot: project, home: homedir(), ...(permissions ? { permissions } : {}),
    }))) {
      throw new Error("permission-aware sandbox core is unavailable; update the sandbox packages before this test.");
    }

    const spec: CommandSpec = {
      argv: [process.execPath, "-e", "process.exit(0)"],
      shell: false,
      cwd: project,
    };
    const confined = confineCommandSpec(spec, plan, profilePath, MACOS);

    expect(confined.shell).toBe(false);
    expect(confined.argv?.[0]).toBe("/usr/bin/sandbox-exec");
    expect(confined.argv).toContain("--eval");
    const profile = readFileSync(profilePath, "utf8");
    expect(profile).toContain(`(allow file-write* (subpath "${project}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${backgroundDeny}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${workerDeny}"))`);
    expect(profile).toContain("(deny network*)");
    expect(backgroundExecutionLimits(plan)).toEqual({ shell: false, commandTimeoutSeconds: 20 });
  });
});

describe("worker command cap intersection", () => {
  // @covers background-task.worker-sandbox-intersection
  // @level unit
  it.each([
    ["takes the smaller finite cap", 60, 15, 15],
    ["keeps the only finite cap when the worker has none", 30, null, 30],
    ["has no cap when neither side caps", null, null, undefined],
    ["keeps the worker cap when the parent has none", null, 12, 12],
  ])("%s", (_label, backgroundCap, workerCap, expected) => {
    const { pi, events } = createPi();
    const project = projectDir(`worker-cap-intersection-${String(_label).replace(/[^a-z]+/gi, "-")}`);
    createPublisher(events).announce({
      main: enabled(project),
      background: {
        ...enabled(project),
        permissions: backgroundPermissions({ commandTimeoutSeconds: backgroundCap }),
      },
    });

    const plan = resolveWorkerSandboxPlan(pi, workerPolicy(project, {
      permissions: workerPermissions({ commandTimeoutSeconds: workerCap }),
    }));

    expect(backgroundExecutionLimits(plan)).toEqual(
      expected === undefined ? { shell: true } : { shell: true, commandTimeoutSeconds: expected },
    );
  });
});
