import { rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { spawnTaskBatch, type SpawnBatchParams } from "./batch.js";
import { listMetasForOrigin, taskDir } from "./registry.js";
import { stopTask, type SpawnTaskParams } from "./runtime.js";
import { registerTools } from "./tools.js";

const pi = { sendMessage() {} } as unknown as ExtensionAPI;
const origin = { cwd: process.cwd(), sessionId: "batch-validation-tests" };

afterEach(async () => {
  for (const meta of listMetasForOrigin(origin)) {
    await stopTask(pi, meta.id);
    rmSync(taskDir(meta.id), { recursive: true, force: true });
  }
});

const invalidLaunches: SpawnTaskParams[] = [
  { command: "echo \0" },
  { shell: false, argv: [process.execPath, "\0"] },
  { command: "true", cwd: "/tmp/\0" },
  { command: "true", env: { VALUE: "\0" } },
  { command: "true", env: { ["KEY\0"]: "value" } },
  { command: "true", ssh: { host: "server\0" } },
  { command: "true", ssh: { host: "server" }, remote: { workdir: "/srv/\0" } },
];

describe("batch preflight regressions", () => {
  it.each(invalidLaunches)("rejects launch-invalid strings before starting earlier valid jobs: %j", (invalid) => {
    expect(() => spawnTaskBatch(pi, {
      shared: { callback: false },
      jobs: [{ command: "true" }, invalid, { command: "true" }],
    }, origin.cwd, origin)).toThrow(/Invalid batch job 2: .*NUL bytes/);
    expect(listMetasForOrigin(origin)).toEqual([]);
  });

  it.each(["command", "argv", "name", "batchId", "batchName"])("rejects excluded shared field %s before any launch", (field) => {
    const shared = { callback: false, [field]: field === "argv" ? [process.execPath] : "true" };
    expect(() => spawnTaskBatch(pi, { shared, jobs: [{ command: "true" }, {}] } as SpawnBatchParams,
      origin.cwd, origin)).toThrow(new RegExp(`Invalid batch shared field ${field}`));
    expect(listMetasForOrigin(origin)).toEqual([]);
  });

  it("Pi argument validation refuses a shared command rather than silently applying it to empty jobs", () => {
    let batchTool: any;
    registerTools({ on() {}, registerTool(tool: any) { if (tool.name === "bg_task_spawn_batch") batchTool = tool; } } as any);
    expect(() => validateToolArguments(batchTool, {
      type: "toolCall", id: "invalid-shared-command", name: "bg_task_spawn_batch",
      arguments: { shared: { command: "true" }, jobs: [{}, {}] },
    } as any)).toThrow(/shared|command/);
  });
});
