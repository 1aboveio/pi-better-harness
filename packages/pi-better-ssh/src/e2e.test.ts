import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { failedResult, FakeRemoteRunner, successfulResult } from "../../ssh-core/test-support/index.js";
import sshExtension, { registerRemoteBashTool, registerSshExtension } from "./index.js";

type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

type SessionEntry = {
  type: "custom";
  customType: string;
  data: unknown;
};

type RegisteredTool = {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: JsonSchema;
  execute: (...args: any[]) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
};

// @covers pi-better-ssh.tool-contract
// @level integration
describe("pi-better-ssh extension", () => {
  it("registers explicit SSH tools without overriding local bash", () => {
    const harness = createHarness();
    sshExtension(harness.pi);

    expect([...harness.tools.keys()]).toEqual(["remote_bash", "ssh_profile", "ssh_mux"]);
    expect(harness.tools.has("bash")).toBe(false);
    const tool = harness.tools.get("remote_bash")!;
    expect(tool.parameters?.required?.sort()).toEqual(["command"]);
    expect(Object.keys(tool.parameters?.properties ?? {}).sort()).toEqual([
      "command",
      "env",
      "host",
      "identity_file",
      "jump",
      "options",
      "port",
      "timeout",
      "user",
      "workdir",
    ]);
    expect(tool.description).toContain("short remote");
    expect(tool.description).toContain("bg_task_spawn");
    expect(tool.description).toContain("structured ssh");
    expect(tool.description).toContain("last 2000 lines or 50KB");
    expect(tool.promptSnippet).toContain("short synchronous remote");
    expect(tool.promptGuidelines?.join(" ")).toContain("Use remote_bash");
    expect(tool.promptGuidelines?.join(" ")).toContain("bg_task_spawn");
    expect(tool.parameters?.properties?.host?.description).toContain("Host alias or user@host");
    expect(tool.parameters?.properties?.options?.description).toContain("cannot disable");
  });

  it("lists SSH config aliases and persists profile use/status/clear across reload", async () => {
    const fixtureRoot = mkdtempSync("/tmp/pi-better-ssh-profile-");
    const configPath = join(fixtureRoot, ".ssh", "config");
    mkdirSync(join(fixtureRoot, ".ssh"), { recursive: true });
    writeFileSync(configPath, [
      "Host deploy analytics",
      "  HostName 10.0.0.10",
      "Host *.internal !blocked",
      "Host deploy",
      "HostName should-not-be-an-alias",
    ].join("\n"));

    try {
      const entries: SessionEntry[] = [];
      const runner = new FakeRemoteRunner([
        failedResult(255, "Control socket missing"),
        failedResult(255, "Control socket missing"),
        failedResult(255, "Control socket missing"),
        successfulResult(""),
        successfulResult("Master running\n"),
        successfulResult("profile command\n"),
        successfulResult("Exit request sent\n"),
      ]);
      const harness = createHarness("profile-session-217", entries);
      registerSshExtension(harness.pi, {
        runner,
        sshConfigPath: configPath,
        controlPathRoot: join(fixtureRoot, "control"),
        muxEntries: new Map(),
      });

      const listed = await harness.execute("ssh_profile", { action: "list" });
      expect(listed.details).toMatchObject({
        action: "list",
        aliases: ["analytics", "deploy"],
        active: null,
      });

      const used = await harness.execute("ssh_profile", {
        action: "use",
        host: "deploy",
        workdir: "/srv/app",
        env: { APP_ENV: "staging" },
      });
      expect(used.details).toMatchObject({
        action: "use",
        active: { host: "deploy", workdir: "/srv/app", env: { APP_ENV: "staging" } },
        mux: { state: "down" },
      });
      expect(entries.at(-1)).toMatchObject({
        type: "custom",
        customType: "pi-better-ssh-profile",
        data: { version: 1, active: { host: "deploy", workdir: "/srv/app", env: { APP_ENV: "staging" } } },
      });
      expect(harness.statuses.at(-1)).toEqual(["pi-better-ssh", "SSH: deploy:/srv/app (mux down)"]);

      const status = await harness.execute("ssh_profile", { action: "status" });
      expect(status.details).toMatchObject({
        action: "status",
        active: { host: "deploy", workdir: "/srv/app", env: { APP_ENV: "staging" } },
        mux: { state: "down" },
      });

      const hostless = await harness.execute("remote_bash", {
        command: "printf '%s' \"$APP_ENV\"",
      });
      expect(hostless.details).toMatchObject({
        output: "profile command\n",
        target: "deploy",
        workdir: "/srv/app",
        mux: { state: "up", reused: false },
      });
      expect(runner.runCalls[5]?.command).toContain("APP_ENV");
      expect(runner.runCalls[5]?.command).toContain("staging");
      expect(harness.statuses.at(-1)).toEqual(["pi-better-ssh", "SSH: deploy:/srv/app (mux up)"]);

      const stopped = await harness.execute("ssh_mux", { action: "stop" });
      expect(stopped.details).toMatchObject({
        scope: "target",
        masters: [{ target: "deploy", state: "stopped" }],
      });
      expect(harness.statuses.at(-1)).toEqual(["pi-better-ssh", "SSH: deploy:/srv/app (mux down)"]);

      const reloadRunner = new FakeRemoteRunner([
        failedResult(255, "Control socket missing"),
        failedResult(255, "Control socket missing"),
      ]);
      const reloaded = createHarness("profile-session-217", entries);
      registerSshExtension(reloaded.pi, {
        runner: reloadRunner,
        sshConfigPath: configPath,
        controlPathRoot: join(fixtureRoot, "control"),
        muxEntries: new Map(),
      });
      await reloaded.startSession("reload");
      const restored = await reloaded.execute("ssh_profile", { action: "status" });
      expect(restored.details).toMatchObject({
        active: { host: "deploy", workdir: "/srv/app", env: { APP_ENV: "staging" } },
      });
      expect(reloaded.statuses.at(-1)).toEqual(["pi-better-ssh", "SSH: deploy:/srv/app (mux down)"]);
      await reloaded.shutdown();
      expect(reloaded.statuses.at(-1)).toEqual(["pi-better-ssh", undefined]);

      const cleared = await reloaded.execute("ssh_profile", { action: "clear" });
      expect(cleared.details).toEqual({ action: "clear", active: null });
      expect(entries.at(-1)?.data).toEqual({ version: 1, active: null });
      expect(reloaded.statuses.at(-1)).toEqual(["pi-better-ssh", undefined]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous mux scope before runner activity", async () => {
    const runner = new FakeRemoteRunner();
    const harness = createHarness("mux-invalid-session-217");
    registerSshExtension(harness.pi, { runner, muxEntries: new Map() });

    await expect(harness.execute("ssh_mux", { action: "status" }))
      .rejects.toThrow(/ssh_mux requires host.*active SSH profile/i);
    await expect(harness.execute("ssh_mux", { action: "stop", all: true, host: "alpha" }))
      .rejects.toThrow(/all cannot be combined with target identity/i);
    expect(runner.runCalls).toHaveLength(0);
  });

  it("reports and stops a target or all current-session mux masters known from remote_bash", async () => {
    const fixtureRoot = mkdtempSync("/tmp/pi-better-ssh-mux-tool-");
    try {
      const runner = new FakeRemoteRunner([
        failedResult(255, "missing alpha"),
        successfulResult(""),
        successfulResult("Master alpha\n"),
        successfulResult("alpha command\n"),
        failedResult(255, "missing beta"),
        successfulResult(""),
        successfulResult("Master beta\n"),
        successfulResult("beta command\n"),
        successfulResult("Master alpha\n"),
        failedResult(255, "missing beta"),
        successfulResult("Exit request sent\n"),
        successfulResult("Exit request sent\n"),
      ]);
      const muxEntries = new Map();
      const foreignRunner = new FakeRemoteRunner([
        successfulResult("Master foreign\n"), successfulResult("foreign command\n"),
      ]);
      const foreign = createHarness("other-mux-session");
      registerSshExtension(foreign.pi, {
        runner: foreignRunner,
        controlPathRoot: join(fixtureRoot, "control"),
        muxEntries,
      });
      await foreign.execute("remote_bash", { command: "hostname", host: "foreign" });
      const harness = createHarness("mux-session-217");
      registerSshExtension(harness.pi, {
        runner,
        controlPathRoot: join(fixtureRoot, "control"),
        muxEntries,
      });

      await harness.execute("remote_bash", { command: "hostname", host: "alpha" });
      await harness.execute("remote_bash", { command: "hostname", host: "ops@beta" });

      const allStatus = await harness.execute("ssh_mux", { action: "status", all: true });
      expect(allStatus.details).toMatchObject({
        action: "status",
        scope: "all",
        masters: [
          { target: "alpha", state: "up" },
          { target: "ops@beta", state: "down" },
        ],
      });

      const targetStop = await harness.execute("ssh_mux", { action: "stop", host: "alpha" });
      expect(targetStop.details).toMatchObject({
        action: "stop",
        scope: "target",
        masters: [{ target: "alpha", state: "stopped" }],
      });

      const allStop = await harness.execute("ssh_mux", { action: "stop", all: true });
      expect(allStop.details).toMatchObject({
        action: "stop",
        scope: "all",
        masters: [{ target: "ops@beta", state: "stopped" }],
      });
      expect([...muxEntries.values()].map((entry) => entry.sessionScope)).toEqual(["other-mux-session"]);
      expect(foreignRunner.runCalls).toHaveLength(2);
      expect(runner.runCalls.slice(8).map((call) => call.argv?.slice(-4))).toEqual([
        ["-O", "check", "--", "alpha"],
        ["-O", "check", "--", "ops@beta"],
        ["-O", "exit", "--", "alpha"],
        ["-O", "exit", "--", "ops@beta"],
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("executes through an injected fake and returns a non-zero exit as a normal tool result", async () => {
    const fixtureRoot = mkdtempSync("/tmp/pi-better-ssh-tool-");
    try {
      const runner = new FakeRemoteRunner([
        failedResult(255, "missing"),
        successfulResult(""),
        successfulResult("Master running\n"),
        failedResult(23, "remote check failed\n"),
      ]);
      const harness = createHarness("tool-session-216");
      registerRemoteBashTool(harness.pi, { runner, controlPathRoot: join(fixtureRoot, "control") });

      const result = await harness.execute("remote_bash", {
        command: "check-release",
        host: "release-alias",
      });

      expect(result.content[0]?.text).toContain("remote check failed");
      expect(result.content[0]?.text).toContain("Command exited with code 23");
      expect(result.details).toMatchObject({
        output: "remote check failed\n",
        exitCode: 23,
        cancelled: false,
        truncated: false,
        target: "release-alias",
        mux: { state: "up", reused: false },
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // @covers pi-better-ssh.release-contract
  // @level integration
  it("loads the independently packed extension registered in the root bundle", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-ssh-pack-"));
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    try {
      const packOutput = JSON.parse(execFileSync("npm", [
        "pack", "--ignore-scripts", "--json", "--pack-destination", directory,
        "--cache", join(directory, "npm-cache"),
      ], { cwd: packageRoot, encoding: "utf8" }));
      const packed = Array.isArray(packOutput) ? packOutput[0]
        : packOutput.filename ? packOutput
        : Object.values(packOutput).find((value: any) => value?.filename);
      expect(packed?.filename).toBeTypeOf("string");
      execFileSync("tar", ["-xzf", join(directory, packed.filename), "-C", directory]);
      const manifest = JSON.parse(readFileSync(join(directory, "package/package.json"), "utf8"));
      const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
      expect(manifest.pi.extensions).toHaveLength(1);
      expect(rootManifest.pi.extensions.map((entry: string) => resolve(repoRoot, entry)))
        .toContain(resolve(packageRoot, manifest.pi.extensions[0]));
      symlinkSync(join(repoRoot, "node_modules"), join(directory, "node_modules"), "dir");
      const output = execFileSync(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e",
        `import extension from ${JSON.stringify(join(directory, "package", manifest.pi.extensions[0]))};
         const tools = [];
         extension({ registerTool(tool) { tools.push(tool.name); }, on() {} });
         console.log(JSON.stringify(tools));`,
      ], { cwd: directory, encoding: "utf8" });
      expect(JSON.parse(output)).toEqual(["remote_bash", "ssh_profile", "ssh_mux"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

function createHarness(sessionId = "session-216", entries: SessionEntry[] = []) {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const statuses: Array<[string, string | undefined]> = [];
  const context = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
    ui: {
      setStatus(key: string, value: string | undefined) {
        statuses.push([key, value]);
      },
    },
  };
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(eventName: string, handler: (event: any, ctx: any) => unknown) {
      const current = handlers.get(eventName) ?? [];
      current.push(handler);
      handlers.set(eventName, current);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    tools,
    entries,
    statuses,
    async execute(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`missing tool ${name}`);
      return tool.execute("call-217", params, undefined, undefined, context);
    },
    async startSession(reason = "startup") {
      for (const handler of handlers.get("session_start") ?? []) await handler({ reason }, context);
    },
    async shutdown(reason = "quit") {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason }, context);
    },
  };
}
