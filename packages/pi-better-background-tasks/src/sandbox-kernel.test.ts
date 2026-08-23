/**
 * Real-kernel proof that locally launched background tasks honor the foreground
 * sandbox policy.
 *
 * Every case here drives the actual extension through its registered tools,
 * spawns real processes, and checks the real filesystem. Nothing about the
 * sandbox mechanism, the task runtime, or the process layer is stubbed; the only
 * stand-in is the publishing half of the `pi.events` policy contract, which
 * belongs to `pi-better-sandbox`.
 *
 * Fixtures live under the canonical `/var/tmp` on purpose — `/private/var/tmp`
 * on macOS, `/var/tmp` on Linux. The macOS profile always allows writes under
 * `/private/var/folders`, which is what `os.tmpdir()` returns, so an "outside
 * the project" probe placed there would be created even with the sandbox
 * working — a false pass. The Linux backend read-only-binds `/` and rebinds
 * only `/tmp` and the writable root, so `/var/tmp` is outside there too. Every denial assertion below is
 * paired with a negative control that performs the identical write with the
 * sandbox disabled and requires the file to appear, so a broken fixture cannot
 * masquerade as enforcement.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import backgroundTasksExtension from "./index.js";
import { baseDir, metaPathFor, readMeta, sandboxProfilePathFor, writeMeta } from "./registry.js";
import { resumeRunningTask, stopTask } from "./runtime.js";
import {
  FOREGROUND_SANDBOX_POLICY_CHANNEL,
  FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
} from "./sandbox.js";
import { describeSandboxSupport } from "./shared-sandbox-core.js";

const support = describeSandboxSupport();

// A platform CI lane sets PI_SANDBOX_REQUIRE_BACKEND to the backend it exists to
// prove. Without it a runner that lost `bwrap` (or `sandbox-exec`) would report
// every case below as skipped — green, and proving nothing. With it, a missing
// or unexpected backend throws here, at the exact point the skip would
// otherwise have been taken.
const requiredBackend = process.env.PI_SANDBOX_REQUIRE_BACKEND;
if (requiredBackend !== undefined && requiredBackend !== "") {
  if (!support.supported) {
    throw new Error(
      `PI_SANDBOX_REQUIRE_BACKEND=${requiredBackend} but no sandbox backend is available: ${support.reason}`,
    );
  }
  if (support.backend !== requiredBackend) {
    throw new Error(
      `PI_SANDBOX_REQUIRE_BACKEND=${requiredBackend} but this runner selected ${support.backend}.`,
    );
  }
}
// realpath so macOS resolves /var/tmp to /private/var/tmp and Linux keeps /var/tmp.
const fixtureRoot = mkdtempSync(join(realpathSync("/var/tmp"), "bg-sandbox-kernel-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

let caseIndex = 0;
let project: string;
let outside: string;
let outsideProbe: string;
let deniedProbe: string;
let absentDeniedProbe: string;
let readable: string;

beforeEach(() => {
  caseIndex += 1;
  const base = join(fixtureRoot, `case-${caseIndex}`);
  project = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(join(project, "secrets"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  outsideProbe = join(outside, "escaped.txt");
  deniedProbe = join(project, "secrets", "leaked.txt");
  // Denied and deliberately never created: the state `.env.local` is in for most
  // projects, and the one a mount of a non-existent source silently skips.
  absentDeniedProbe = join(project, ".env.local");
  readable = join(outside, "readable.txt");
  writeFileSync(readable, "readable-outside-content\n");
});

/** The four things a confined task must and must not be able to do. */
function probeCommand(): string {
  return [
    `printf 'inside\\n' > "${join(project, "allowed.txt")}"`,
    `cat "${readable}"`,
    `printf 'escaped\\n' > "${outsideProbe}" 2>&1 || true`,
    `printf 'leaked\\n' > "${deniedProbe}" 2>&1 || true`,
    `printf 'created\\n' > "${absentDeniedProbe}" 2>&1 || true`,
    `printf 'PROBE-COMPLETE\\n'`,
  ].join("; ");
}

/**
 * Both shapes of denial the probe exercises.
 *
 * The existing denied file must simply not appear. The absent one may exist
 * afterwards — the Linux backend needs a mount point and puts an empty
 * placeholder there — so what is asserted is that none of the probe's bytes
 * reached it.
 */
function expectDenialsHeld() {
  expect(existsSync(deniedProbe)).toBe(false);
  if (existsSync(absentDeniedProbe)) {
    expect(readFileSync(absentDeniedProbe, "utf8")).toBe("");
  }
}

function enabledPolicy() {
  return {
    state: "enabled",
    projectRoot: project,
    writableRoot: project,
    denyWrite: [join(project, "secrets"), join(project, ".env.local")],
    platform: process.platform,
    backend: support.supported ? support.backend : undefined,
    executable: support.supported ? support.executable : undefined,
    readPolicy: "unrestricted",
    networkPolicy: "unrestricted",
    reason: `Writes are confined to ${project}.`,
  };
}

function disabledPolicy() {
  return {
    state: "disabled",
    projectRoot: project,
    writableRoot: undefined,
    denyWrite: [],
    platform: process.platform,
    readPolicy: "unrestricted",
    networkPolicy: "unrestricted",
    reason: "A human turned the foreground sandbox off for this session.",
  };
}

type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

/**
 * Load the real extension against an event bus, optionally with a sandbox
 * policy already published before the extension exists — the load order where a
 * consumer must ask for the current policy rather than wait for the next change.
 */
function createHarness(options: { announceBeforeLoad?: Record<string, unknown> } = {}) {
  const tools = new Map<string, RegisteredTool>();
  const events = new EventEmitter();
  let status: Record<string, unknown> | undefined = options.announceBeforeLoad;

  // The publishing half of the contract, exactly as pi-better-sandbox
  // implements it: publish on change, and re-publish on request.
  const publish = () => {
    if (status) events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, Object.freeze({ ...status }));
  };
  events.on(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, publish);
  if (status) publish();

  const context = {
    cwd: project,
    mode: "print",
    hasUI: false,
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      setWidget() {},
      getEditorComponent() { return undefined; },
      setEditorComponent() {},
      custom() { return Promise.resolve(null); },
    },
    sessionManager: { getSessionId: () => `sandbox-kernel-${caseIndex}` },
  };
  const pi = {
    events,
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    on() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;

  backgroundTasksExtension(pi);

  return {
    pi,
    announce(next: Record<string, unknown>) {
      status = next;
      publish();
    },
    async execute(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      const result = await tool.execute("kernel-call", params, new AbortController().signal, undefined, context);
      return result.content.map((part) => part.text).join("\n");
    },
  };
}

function taskIdIn(launchText: string): string {
  const match = launchText.match(/bg_[a-z0-9_]+/);
  if (!match) throw new Error(`no task id in: ${launchText}`);
  return match[0];
}

async function waitForMeta(
  id: string,
  done: (meta: ReturnType<typeof readMeta>) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readMeta(id);
    if (done(meta)) return meta!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`task ${id} never reached the expected state: ${JSON.stringify(readMeta(id))}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition(done: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !done()) await sleep(25);
}

describe.skipIf(!support.supported)(
  `local background tasks under a real ${support.backend ?? "no"} sandbox`,
  () => {
    // @covers background-task.sandbox-local-spawn
    // @level integration
    it("confines a spawned task's writes while leaving reads alone", async () => {
      const harness = createHarness({ announceBeforeLoad: enabledPolicy() });

      const id = taskIdIn(await harness.execute("bg_task_spawn", {
        command: probeCommand(),
        callback: false,
      }));
      const meta = await waitForMeta(id, (current) => current?.status === "succeeded");
      const log = readFileSync(meta.logPath, "utf8");

      expect(log).toContain("PROBE-COMPLETE");
      expect(log).toContain("readable-outside-content");
      expect(readFileSync(join(project, "allowed.txt"), "utf8")).toBe("inside\n");
      expect(existsSync(outsideProbe)).toBe(false);
      expectDenialsHeld();
      expect(meta.launchArgv?.[0]).toBe(support.executable);
    });

    // @covers background-task.sandbox-local-spawn
    // @level integration
    it("negative control: the same writes all land when the sandbox is disabled", async () => {
      const harness = createHarness({ announceBeforeLoad: disabledPolicy() });

      const id = taskIdIn(await harness.execute("bg_task_spawn", {
        command: probeCommand(),
        callback: false,
      }));
      const meta = await waitForMeta(id, (current) => current?.status === "succeeded");

      expect(readFileSync(meta.logPath, "utf8")).toContain("PROBE-COMPLETE");
      expect(readFileSync(outsideProbe, "utf8")).toBe("escaped\n");
      expect(readFileSync(deniedProbe, "utf8")).toBe("leaked\n");
      expect(readFileSync(absentDeniedProbe, "utf8")).toBe("created\n");
      expect(meta.launchArgv).toBeUndefined();
    });

    // @covers background-task.sandbox-local-watch
    // @level integration
    it("confines a watch poll's writes on every interval", async () => {
      const harness = createHarness();
      // Published after the extension loaded: the other load order.
      harness.announce(enabledPolicy());

      const id = taskIdIn(await harness.execute("bg_task_watch", {
        command: probeCommand(),
        interval_seconds: 1,
        timeout_seconds: 10,
        callback: false,
        success_when: { type: "stdout_contains", value: "PROBE-COMPLETE" },
      }));
      const meta = await waitForMeta(id, (current) => current?.status === "succeeded");

      expect(readFileSync(join(project, "allowed.txt"), "utf8")).toBe("inside\n");
      expect(existsSync(outsideProbe)).toBe(false);
      expectDenialsHeld();
      expect(meta.launchArgv?.[0]).toBe(support.executable);
      // The operator's own command stays the recorded one; only the launch
      // vector carries the wrapper.
      expect(meta.command).toBe(probeCommand());
      expect(meta.shell).toBe(true);
    });

    // @covers background-task.sandbox-launch-capture
    // @level integration
    it("keeps a running watch on its launch policy after the sandbox is turned off", async () => {
      const harness = createHarness({ announceBeforeLoad: enabledPolicy() });

      const runningId = taskIdIn(await harness.execute("bg_task_watch", {
        command: `printf 'escaped\\n' >> "${outsideProbe}" 2>&1 || true; printf 'tick\\n'`,
        interval_seconds: 1,
        timeout_seconds: 0,
        callback: false,
        success_when: { type: "stdout_contains", value: "never-matches" },
      }));
      const launched = await waitForMeta(runningId, (current) => current?.lastCheckedAt !== undefined);
      const launchArgv = launched.launchArgv;
      expect(launchArgv?.[0]).toBe(support.executable);

      harness.announce(disabledPolicy());
      // Long enough for several more polls under the new policy.
      await sleep(2_500);

      try {
        expect(readMeta(runningId)?.lastCheckedAt).toBeGreaterThan(launched.lastCheckedAt!);
        expect(readMeta(runningId)?.launchArgv).toEqual(launchArgv);
        expect(existsSync(outsideProbe)).toBe(false);

        // ...while a task launched after the toggle picks the new policy up.
        const afterId = taskIdIn(await harness.execute("bg_task_spawn", {
          command: `printf 'escaped\\n' > "${outsideProbe}"`,
          callback: false,
        }));
        await waitForMeta(afterId, (current) => current?.status === "succeeded");
        expect(readFileSync(outsideProbe, "utf8")).toBe("escaped\n");
        expect(readMeta(afterId)?.launchArgv).toBeUndefined();
      } finally {
        await harness.execute("bg_task_stop", { id: runningId });
      }
    });

    // @covers background-task.sandbox-lifecycle-compat
    // @level integration
    it("still terminates a sandboxed process tree on stop", async () => {
      const harness = createHarness({ announceBeforeLoad: enabledPolicy() });
      const marker = join(project, "child.pid");

      const id = taskIdIn(await harness.execute("bg_task_spawn", {
        // A child of the shell, so stopping must reach past the wrapper and the
        // shell into the whole process group.
        command: `(sleep 60 & printf '%s\\n' "$!" > "${marker}"; wait)`,
        callback: false,
      }));
      await waitForMeta(id, () => existsSync(marker));
      const childPid = Number(readFileSync(marker, "utf8").trim());
      expect(processAlive(childPid)).toBe(true);

      expect(await harness.execute("bg_task_stop", { id })).toContain(id);
      await waitForMeta(id, (current) => current?.status === "cancelled");
      await waitForCondition(() => !processAlive(childPid));

      expect(processAlive(childPid)).toBe(false);
    }, 20_000);

    // @covers background-task.sandbox-lifecycle-compat
    // @level integration
    it("still times a sandboxed watch poll out", async () => {
      const harness = createHarness({ announceBeforeLoad: enabledPolicy() });

      const id = taskIdIn(await harness.execute("bg_task_watch", {
        command: "sleep 60",
        interval_seconds: 1,
        timeout_seconds: 2,
        callback: false,
        success_when: { type: "stdout_contains", value: "never-matches" },
      }));
      const meta = await waitForMeta(id, (current) => current?.status === "timed_out");

      expect(meta.launchArgv?.[0]).toBe(support.executable);
      expect(meta.result).toMatchObject({ reason: "timeout" });
    }, 20_000);

    // @covers background-task.sandbox-launch-capture
    // @level integration
    it("re-runs a resumed watch under the policy it launched with", async () => {
      const harness = createHarness({ announceBeforeLoad: enabledPolicy() });

      const id = taskIdIn(await harness.execute("bg_task_watch", {
        command: `printf 'escaped\\n' >> "${outsideProbe}" 2>&1 || true; printf 'tick\\n'`,
        interval_seconds: 1,
        timeout_seconds: 0,
        callback: false,
        success_when: { type: "stdout_contains", value: "never-matches" },
      }));
      const launched = await waitForMeta(id, (current) => current?.lastCheckedAt !== undefined);
      await harness.execute("bg_task_stop", { id });

      // A later Pi session picks the durable task back up. Its own foreground
      // policy is irrelevant: the launch vector and the generated profile both
      // live in the task's own directory.
      expect(existsSync(sandboxProfilePathFor(id))).toBe(support.backend === "macos-seatbelt");
      const resumed = readMeta(id)!;
      resumed.status = "running";
      delete resumed.endedAt;
      delete resumed.stopRequestedAt;
      delete resumed.result;
      writeMeta(resumed);

      // The later session's own foreground policy says the sandbox is off. It
      // must not reach this task: the launch vector and the generated profile
      // both live in the task's own directory.
      const laterSession = createHarness({ announceBeforeLoad: disabledPolicy() });
      resumeRunningTask(laterSession.pi, resumed);

      try {
        await waitForMeta(id, (current) => (current?.lastCheckedAt ?? 0) > launched.lastCheckedAt!);
        expect(existsSync(outsideProbe)).toBe(false);
        expect(readMeta(id)?.launchArgv).toEqual(launched.launchArgv);
      } finally {
        await stopTask(laterSession.pi, id);
      }
    }, 15_000);

    // @covers background-task.sandbox-launch-capture
    // @level integration
    it("cannot be resumed under a launch vector or profile a confined task rewrote", async () => {
      const harness = createHarness({ announceBeforeLoad: enabledPolicy() });

      // The victim: a durable watch whose `meta.json` holds the argv a later
      // session re-runs verbatim and whose `sandbox.sb` is the profile that argv
      // names. Both live under the system temp directory, which both backends
      // leave writable on purpose.
      const victim = taskIdIn(await harness.execute("bg_task_watch", {
        command: `printf 'escaped\\n' >> "${outsideProbe}" 2>&1 || true; printf 'tick\\n'`,
        interval_seconds: 1,
        timeout_seconds: 0,
        callback: false,
        success_when: { type: "stdout_contains", value: "never-matches" },
      }));
      const launched = await waitForMeta(victim, (current) => current?.lastCheckedAt !== undefined);
      const launchArgv = launched.launchArgv;
      expect(launchArgv?.[0]).toBe(support.executable);

      const metaPath = metaPathFor(victim);
      const profilePath = sandboxProfilePathFor(victim);
      const profileBefore = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : undefined;
      const plantedProbe = join(baseDir(), "planted.txt");
      // JSON carries no single quotes, so it travels through the shell whole.
      const forgedMeta = JSON.stringify({
        ...launched,
        launchArgv: ["/bin/sh", "-c", `printf 'escaped\\n' > "${outsideProbe}"`],
      });

      // A second confined task attacks that control plane. No race is involved:
      // if any of these landed, the tampering would simply sit there until the
      // victim's next poll or its resume in a later session picked it up.
      const attacker = taskIdIn(await harness.execute("bg_task_spawn", {
        command: [
          `printf '%s' '${forgedMeta}' > "${metaPath}" 2>&1 || true`,
          `printf '(version 1)\\n(allow default)\\n' > "${profilePath}" 2>&1 || true`,
          `rm -f "${profilePath}" 2>&1 || true`,
          `printf 'planted\\n' > "${plantedProbe}" 2>&1 || true`,
          `printf 'ATTACK-COMPLETE\\n'`,
        ].join("; "),
        callback: false,
      }));
      const attackerMeta = await waitForMeta(attacker, (current) => current?.status === "succeeded");
      expect(readFileSync(attackerMeta.logPath, "utf8")).toContain("ATTACK-COMPLETE");

      try {
        // Nothing the attacker aimed at the control plane landed.
        expect(existsSync(plantedProbe)).toBe(false);
        expect(existsSync(profilePath)).toBe(support.backend === "macos-seatbelt");
        if (profileBefore !== undefined) {
          expect(readFileSync(profilePath, "utf8")).toBe(profileBefore);
        }
        expect(readMeta(victim)?.launchArgv).toEqual(launchArgv);
        // ...and the victim is still polling under its own confinement.
        await waitForMeta(victim, (current) => (current?.lastCheckedAt ?? 0) > launched.lastCheckedAt!);
        expect(existsSync(outsideProbe)).toBe(false);
      } finally {
        await harness.execute("bg_task_stop", { id: victim });
      }

      // The resume the attack was aiming at: a later session, whose own
      // foreground policy says the sandbox is off, re-runs the captured vector.
      const resumed = readMeta(victim)!;
      resumed.status = "running";
      delete resumed.endedAt;
      delete resumed.stopRequestedAt;
      delete resumed.result;
      writeMeta(resumed);
      const stoppedAt = resumed.lastCheckedAt!;

      const laterSession = createHarness({ announceBeforeLoad: disabledPolicy() });
      resumeRunningTask(laterSession.pi, resumed);
      try {
        await waitForMeta(victim, (current) => (current?.lastCheckedAt ?? 0) > stoppedAt);
        expect(readMeta(victim)?.launchArgv).toEqual(launchArgv);
        expect(existsSync(outsideProbe)).toBe(false);
      } finally {
        await stopTask(laterSession.pi, victim);
      }
    }, 30_000);
  },
);

describe("local background tasks with no usable sandbox backend", () => {
  // @covers background-task.sandbox-fail-closed
  // @level integration
  it("blocks the launch instead of running the command unconfined", async () => {
    const harness = createHarness({
      announceBeforeLoad: {
        state: "unavailable",
        projectRoot: project,
        writableRoot: undefined,
        denyWrite: [],
        platform: process.platform,
        readPolicy: "unrestricted",
        networkPolicy: "unrestricted",
        reason: "Linux sandbox requires executable bubblewrap (bwrap) on PATH.",
      },
    });
    const before = await harness.execute("bg_task_list", {});

    const spawned = await harness.execute("bg_task_spawn", {
      command: `printf 'escaped\\n' > "${outsideProbe}"`,
      callback: false,
    });
    const watched = await harness.execute("bg_task_watch", {
      command: `printf 'escaped\\n' > "${outsideProbe}"`,
      callback: false,
      success_when: { type: "exit_code", equals: 0 },
    });

    // The action wrapper is a second entry point into the same launches.
    const actionSpawned = await harness.execute("bg_task", {
      action: "spawn",
      command: `printf 'escaped\\n' > "${outsideProbe}"`,
      callback: false,
    });
    const actionWatched = await harness.execute("bg_task", {
      action: "watch",
      command: `printf 'escaped\\n' > "${outsideProbe}"`,
      callback: false,
      success_when: { type: "exit_code", equals: 0 },
    });

    for (const result of [spawned, watched, actionSpawned, actionWatched]) {
      expect(result).toContain("Foreground sandbox is unavailable");
      expect(result).toContain("bubblewrap");
      expect(result).not.toContain("Started background");
    }
    // Nothing ran, and no half-built task was left in the registry.
    await sleep(200);
    expect(existsSync(outsideProbe)).toBe(false);
    expect(await harness.execute("bg_task_list", {})).toBe(before);
  });
});
