import { fork } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startWorkRuntimeFixture } from "./work-runtime-fixture.mjs";
import { startContinuationModel, continuationModels } from "../../pi-better-server/test/support/subagent-offline-model.ts";
import { WorkClient } from "../../pi-better-server/src/runtime/work-client.mjs";

/** Real SDK foregrounds share a real daemon. Only the remote model is substituted. */
export async function continuationFixture({ root, artifacts, workspace }) {
    const agent = join(root, "agent"); mkdirSync(agent, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_SUBAGENT_DURABLE_DIR = join(agent, "subagents");
    const model = await startContinuationModel(artifacts);
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { defaultTools: "read,bash" } } }));
    writeFileSync(join(agent, "models.json"), JSON.stringify(continuationModels(model.baseUrl)));
    const observer = new URL("./fixtures/continuation-worker-observer.mjs", import.meta.url).href;
    const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${observer}`.trim(),
        PI_CONTINUATION_ARTIFACTS: artifacts };
    const stopDaemon = await startWorkRuntimeFixture(env);
    const observation = new WorkClient(stopDaemon.socketPath, agent);
    const actors = new Set();
    let nextActor = 0;
    function makeHarness(options = {}) {
        const actorId = ++nextActor, requests = new Map();
        let sequence = 0, entries = [], actualSessionId, stopped, errors = "", policy = options.policy;
        const cwd = options.cwd ?? workspace, sessionId = options.sessionId ?? "owner-session";
        const child = fork(new URL("../../pi-better-server/test/support/subagent-launch-sdk.mjs", import.meta.url), [], {
            execPath: env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath, execArgv: ["--import", "tsx"],
            env: { ...env, LAUNCH_WORKSPACE: cwd, CONTINUATION_CONTEXT: JSON.stringify({ sessionId, sessionDir: join(root, "parents"), policy }) },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        actors.add(child); child.stderr.on("data", bytes => { errors += bytes; });
        const tools = new Map(), sent = [];
        const update = state => {
            if (!state) return;
            entries = state.entries;
            actualSessionId = state.sessionId;
            sent.splice(0, sent.length, ...entries.filter(entry => entry.type === "custom_message").map(entry => ({ message: entry })));
        };
        const ready = new Promise((resolve, reject) => {
            child.on("message", message => {
                update(message.state ?? (message.ready ? message : undefined));
                if (message.ready) {
                    tools.clear();
                    for (const name of message.tools) tools.set(name, { execute: (key, params) => execute(name, key, params) });
                    resolve(message); return;
                }
                const pending = requests.get(message.id);
                if (!pending) return;
                requests.delete(message.id);
                if (message.error) { const error = new Error(message.error); error.stack = message.stack; pending.reject(error); }
                else pending.resolve(message.result);
            });
            child.once("exit", (code, signal) => {
                actors.delete(child);
                const error = new Error(`SDK foreground exited (${code ?? signal}): ${errors}`);
                reject(error); for (const pending of requests.values()) pending.reject(error); requests.clear();
            });
        });
        const control = params => {
            const jobs = Array.isArray(params.jobs) ? params.jobs : [params];
            for (const job of jobs) {
                if (typeof job.prompt !== "string") continue;
                const key = createHash("sha256").update(job.prompt).digest("hex");
                writeFileSync(join(artifacts, `control-${key}.json`), JSON.stringify({
                    sleepMs: Number(process.env.PI_CONTINUATION_SLEEP_MS ?? 0), holdAfterWriteMs: Number(process.env.PI_CONTINUATION_HOLD_AFTER_WRITE_MS ?? 0),
                }));
            }
        };
        const execute = async (tool, key, params) => {
            await ready; control(params);
            const id = ++sequence;
            return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); child.send({ id, tool, key: `${key}-${actorId}-${id}`, params, policy }); });
        };
        for (const tool of ["subagent_spawn", "subagent_spawn_batch", "subagent_result", "subagent_stop", "subagent_settings"]) {
            tools.set(tool, { execute: (key, params) => execute(tool, key, params) });
        }
        // Read-only SDK snapshots support the existing assertions, never tool execution.
        return { tools, sent, ready, ctx: { cwd, sessionManager: { getSessionId: () => actualSessionId, getBranch: () => entries } },
            publishPolicy(next) { policy = next; },
            shutdown() { return stopped ??= (async () => { await ready; if (child.exitCode === null) { const exited = once(child, "exit"); child.send({ stop: true }); await exited; } })(); },
        };
    }
    return { makeHarness, async observedTerminal(id) {
        const value = await observation.get({ id, limit: 1 });
        const row = value.rows[0];
        return row && !["running", "orphaned"].includes(row.meta.status);
    }, async close() {
        for (const child of actors) { const exited = once(child, "exit"); child.send({ stop: true }); await exited; }
        observation.close(); await stopDaemon(); await model.close();
        if (process.env.PI_CONTINUATION_EVIDENCE_DIR) {
            mkdirSync(process.env.PI_CONTINUATION_EVIDENCE_DIR, { recursive: true });
            cpSync(root, mkdtempSync(join(process.env.PI_CONTINUATION_EVIDENCE_DIR, "continuation-")), { recursive: true });
        }
    } };
}
