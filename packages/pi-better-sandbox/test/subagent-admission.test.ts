import assert from "node:assert/strict";
import { createEventBus, type ExtensionAPI, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSubagentExecutionAdmission, requestsSubagentSandbox } from "../subagent-admission.ts";

const channel = "pi-better-subagents:execution-adapter-request";
const source = fileURLToPath(new URL("../../pi-better-subagents/index.ts", import.meta.url));

test("subagent execution admission requires compatible source and current schema, including reload", () => {
    const events = createEventBus();
    const parameters = { type: "object", properties: {} };
    let currentParameters: object = parameters;
    let currentSource: string | undefined = source;
    const pi = { events, getAllTools: () => [{ name: "subagent_spawn", parameters: currentParameters,
        sourceInfo: currentSource ? { path: currentSource } : undefined }] as ToolInfo[] } as unknown as ExtensionAPI;
    const admit = createSubagentExecutionAdmission(pi);
    assert.equal(admit("subagent_spawn"), false, "old consumers cannot ignore restrictions");
    const unsubscribe = events.on(channel, (input) => {
        const request = input as { version: number; reply(value: unknown): void };
        request.reply({ version: request.version, parameters });
    });
    assert.equal(admit("subagent_spawn"), true);
    for (const path of [undefined, "<inline:spoof>", "relative.ts", fileURLToPath(new URL("../index.ts", import.meta.url))]) {
        currentSource = path;
        assert.equal(admit("subagent_spawn"), false);
    }
    currentSource = source;
    currentParameters = { ...parameters };
    assert.equal(admit("subagent_spawn"), false, "a replaced definition cannot reuse an old reply");
    currentParameters = parameters;
    const replace = events.on(channel, () => { currentParameters = {}; });
    assert.equal(admit("subagent_spawn"), false, "replacement during admission fails closed");
    replace();
    currentParameters = parameters;
    unsubscribe();
    assert.equal(admit("subagent_spawn"), false, "shutdown removes compatibility proof");
    for (const version of [0, 2, undefined]) {
        const stop = events.on(channel, (input) => (input as { reply(value: unknown): void }).reply({ version, parameters }));
        assert.equal(admit("subagent_spawn"), false);
        stop();
    }
    events.clear();
});

test("explicit sandbox opt-in follows per-job overrides rather than unrelated batch jobs", () => {
    assert.equal(requestsSubagentSandbox("subagent_spawn", { sandbox: true }), true);
    assert.equal(requestsSubagentSandbox("subagent_spawn", {}), false);
    assert.equal(requestsSubagentSandbox("subagent_spawn_batch", { shared: { sandbox: true }, jobs: [{ sandbox: false }] }), false);
    assert.equal(requestsSubagentSandbox("subagent_spawn_batch", { shared: { sandbox: true }, jobs: [{}] }), true);
    assert.equal(requestsSubagentSandbox("subagent_spawn_batch", { jobs: [{ sandbox: false }, { sandbox: true }] }), true);
    assert.equal(requestsSubagentSandbox("subagent_spawn_batch", { shared: { sandbox: true }, jobs: [] }), false);
});