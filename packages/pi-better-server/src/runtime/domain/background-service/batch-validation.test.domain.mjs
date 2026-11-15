// Generated fixed launch domain from packages/pi-better-background-tasks/src/batch-validation.test.ts. Do not edit directly.
import { rmSync } from "node:fs";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { spawnTaskBatch } from "./batch.domain.mjs";
import { listMetasForOrigin, taskDir } from "./registry.domain.mjs";
import { stopTask } from "./runtime.domain.mjs";
import { registerTools } from "./tools.domain.mjs";
const pi = { sendMessage() { } };
const origin = { cwd: process.cwd(), sessionId: "batch-validation-tests" };
afterEach(async () => {
    for (const meta of listMetasForOrigin(origin)) {
        await stopTask(pi, meta.id);
        rmSync(taskDir(meta.id), { recursive: true, force: true });
    }
});
const invalidLaunches = [
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
        expect(() => spawnTaskBatch(pi, { shared, jobs: [{ command: "true" }, {}] }, origin.cwd, origin)).toThrow(new RegExp(`Invalid batch shared field ${field}`));
        expect(listMetasForOrigin(origin)).toEqual([]);
    });
    it("Pi argument validation refuses a shared command rather than silently applying it to empty jobs", () => {
        let batchTool;
        registerTools({ on() { }, registerTool(tool) { if (tool.name === "bg_task_spawn_batch")
                batchTool = tool; } });
        expect(() => validateToolArguments(batchTool, {
            type: "toolCall", id: "invalid-shared-command", name: "bg_task_spawn_batch",
            arguments: { shared: { command: "true" }, jobs: [{}, {}] },
        })).toThrow(/shared|command/);
    });
});
