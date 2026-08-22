import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { failedResult, FakeRemoteRunner, successfulResult } from "../../ssh-core/test-support/index.js";
import sshExtension, { registerRemoteBashTool } from "./index.js";

type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
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
  it("registers only remote_bash with the short-versus-long operator contract", () => {
    const harness = createHarness();
    sshExtension(harness.pi);

    expect([...harness.tools.keys()]).toEqual(["remote_bash"]);
    const tool = harness.tools.get("remote_bash")!;
    expect(tool.parameters?.required?.sort()).toEqual(["command", "host"]);
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

  it("is independently publishable but absent from the root extension bundle", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const rootPackageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

    expect(packageJson).toMatchObject({
      name: "pi-better-ssh",
      publishConfig: { access: "public" },
      pi: { extensions: ["./src/index.ts"] },
    });
    expect(packageJson.keywords).toContain("pi-package");
    expect(rootPackageJson.pi.extensions.join(" ")).not.toContain("pi-better-ssh");
  });
});

function createHarness(sessionId = "session-216") {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    tools,
    async execute(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`missing tool ${name}`);
      return tool.execute("call-216", params, undefined, undefined, {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => sessionId },
      });
    },
  };
}
