/**
 * Opt-in real Pi acceptance for catalog instruction delegation.
 *
 * PI_CATALOG_REAL_PI=1 starts the Pi CLI against this checkout. The
 * coordinating model must choose tool arguments. A scripted provider that
 * returns a prefilled tool call is not used and would not count.
 *
 * Default npm test skips this file. A skip is not T13/T14/T26 evidence.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const extension = join(repoRoot, "packages/pi-better-subagents/index.ts");
const configPath = join(repoRoot, "packages/pi-better-subagents/config.json");
const fixtures = join(here, "fixtures/acceptance");
const enabled = process.env.PI_CATALOG_REAL_PI === "1";
const reportPath = join(repoRoot, ".rush-results/acceptance.json");

const QUOTED = "openai/gpt-6-astra";
const SKILL_MODEL = "xai/grok-4.5";
const SKILL_EFFORT = "low";
const USER_MODEL = "xai/grok-4.6";
const USER_EFFORT = "high";
const LEGACY_MODEL = "xai/grok-4.3";
const LEGACY_EFFORT = "low";
const FOREGROUND_MODEL = "xai/grok-4.7";
const FOREGROUND_EFFORT = "high";

describe("catalog real Pi acceptance", { concurrency: false }, () => {
    (enabled ? it : it.skip)("proves instruction to child launch with a real coordinator", { timeout: 780_000 }, async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const sandbox = join(repoRoot, ".acceptance-sandbox", stamp);
        const agentDir = join(sandbox, "pi-agent");
        const work = join(sandbox, "work");
        const sessions = join(sandbox, "sessions");
        const tmp = join(sandbox, "tmp");
        const report = {
            unit: "acceptance",
            modelReadback: {
                provider: process.env.PI_PROVIDER ?? null,
                model: process.env.PI_MODEL ?? null,
                reasoning: process.env.PI_REASONING_LEVEL ?? null,
            },
            reasoningProof: "pi-cli extension plus live xai coordinator; no scripted tool response",
            sha: gitSha(),
            sandbox,
            commands: [],
            phases: {},
            runs: [],
            dialogs: [],
            unproven: staticUnproven(),
            blockers: [],
        };
        const originalConfig = readFileSync(configPath, "utf8");
        let child;
        let watcher;
        try {
            mkdirSync(join(agentDir, "agents/roles"), { recursive: true });
            mkdirSync(work, { recursive: true });
            mkdirSync(sessions, { recursive: true });
            mkdirSync(tmp, { recursive: true });
            mkdirSync(dirname(reportPath), { recursive: true });
            for (const name of readdirSync(join(fixtures, "roles"))) {
                copyFileSync(join(fixtures, "roles", name), join(agentDir, "agents/roles", name));
            }
            // Symlink the existing Pi model files. models.json carries the working
            // xAI route; copying it would duplicate credentials. Neither file is
            // written into the repository.
            for (const name of ["models.json", "models-store.json"]) {
                const source = join(homedir(), ".pi/agent", name);
                if (!existsSync(source)) throw new Error(`Missing ${source}; cannot reach the configured xAI model without copying secrets.`);
                symlinkSync(source, join(agentDir, name));
            }
            const binDir = join(sandbox, "bin");
            mkdirSync(binDir, { recursive: true });
            const realPi = execFileSync("/usr/bin/which", ["pi"], { encoding: "utf8" }).trim();
            const argvLog = join(sandbox, "argv.jsonl");
            writeFileSync(join(binDir, "pi"), [
                "#!/bin/sh",
                "set -e",
                "python3 -c 'import json,os,sys; f=open(os.environ[\"PI_ACCEPTANCE_ARGV_LOG\"],\"a\"); f.write(json.dumps(sys.argv[1:])+chr(10)); f.flush()' \"$@\"",
                "exec \"$PI_ACCEPTANCE_REAL_PI\" \"$@\"",
                "",
            ].join("\n"));
            chmodSync(join(binDir, "pi"), 0o755);
            writeFileSync(configPath, patchedConfig(originalConfig));
            const listed = execFileSync("pi", ["--list-models", "grok"], {
                env: isolatedEnv(agentDir, tmp),
                encoding: "utf8",
            });
            report.phases.listModels = listed.split("\n").filter((line) => line.includes("grok")).map((line) => line.trim());
            if (!listed.includes("grok-4.7")) {
                throw new Error("Isolated PI_CODING_AGENT_DIR cannot see xai/grok-4.7.");
            }

            child = spawn("pi", [
                "--mode", "rpc",
                "--no-session",
                "--session-dir", sessions,
                "--no-extensions",
                "-e", extension,
                "--no-skills",
                "--skill", join(fixtures, "implementer-model"),
                "--no-prompt-templates",
                "--no-context-files",
                "--no-approve",
                "--model", FOREGROUND_MODEL,
                "--thinking", FOREGROUND_EFFORT,
                "--tools", "subagent_spawn,subagent_spawn_batch,agents_catalog",
                "--append-system-prompt", "You coordinate subagents. Obey the expanded skill and the user. Put a chosen model and effort in the tool model and thinking arguments before launch. Quoted comparisons are not selections. Do not do the delegated work yourself and do not poll for results.",
            ], {
                cwd: work,
                env: {
                    ...isolatedEnv(agentDir, tmp),
                    PATH: `${binDir}:${process.env.PATH ?? ""}`,
                    PI_ACCEPTANCE_ARGV_LOG: argvLog,
                    PI_ACCEPTANCE_REAL_PI: realPi,
                },
                stdio: ["pipe", "pipe", "pipe"],
            });
            const rpc = new Rpc(child);
            watcher = watchRuns(join(tmp, "pi-better-subagents/runs"));
            const state = await rpc.request({ type: "get_state" }, 60_000);
            report.phases.coordinator = {
                provider: state.data?.model?.provider ?? null,
                model: state.data?.model?.id ?? null,
                thinkingLevel: state.data?.thinkingLevel ?? null,
                sessionFile: state.data?.sessionFile ?? null,
            };
            assert.equal(report.phases.coordinator.provider, "xai");
            assert.equal(report.phases.coordinator.model, "grok-4.7");
            assert.equal(report.phases.coordinator.thinkingLevel, "high");
            const levels = await rpc.request({ type: "get_available_thinking_levels" }, 30_000);
            report.phases.thinkingLevels = levels.data ?? levels;
            writeReport(report);

            const list = await rpc.command("/agents list");
            const created = await rpc.command('/agents create --role role.developer --name "Acceptance Dev" --id agent.acceptance-dev --mode add --instructions "Reply with the single word DONE." --scope user');
            const shown = await rpc.command("/agents show agent.acceptance-dev");
            const imported = await rpc.command(`/agents import-codex ${join(fixtures, "codex-acceptance.toml")} --role role.developer`);
            const shownImport = await rpc.command("/agents show agent.acceptance-import");
            report.dialogs = rpc.dialogs.map((dialog) => ({
                method: dialog.method,
                title: dialog.title ?? null,
                confirmed: dialog.confirmed ?? null,
                value: dialog.value ?? null,
                cancelled: dialog.cancelled ?? null,
            }));
            report.phases.commands = {
                list: notifications(list),
                create: notifications(created),
                show: notifications(shown),
                import: notifications(imported),
                showImport: notifications(shownImport),
            };
            writeReport(report);
            const listText = report.phases.commands.list.join("\n");
            for (const id of ["role.researcher", "role.explorer", "role.product-manager", "role.developer", "role.reviewer", "role.architect"]) {
                assert.match(listText, new RegExp(id));
            }
            assert.match(report.phases.commands.create.join("\n"), /Created agent\.acceptance-dev/);
            assert.match(report.phases.commands.show.join("\n"), /Acceptance Dev/);
            assert.match(report.phases.commands.show.join("\n"), /winning source/);
            assert.equal(report.dialogs.some((dialog) => dialog.method === "confirm" && dialog.confirmed === true), true);
            assert.match(report.phases.commands.import.join("\n"), /Imported agent\.acceptance-import/);

            const promptA = await rpc.turn(`/skill:implementer-model ${taskA()}`, 180_000, ["TOKEN_NAMED", "TOKEN_ROLE_NUMERIC", "TOKEN_BATCH_IMPLEMENTER", "TOKEN_BATCH_USER"]);
            report.phases.promptA = summarizeTurn(promptA);
            writeReport(report);
            if (report.phases.promptA.tools.length === 0 && report.phases.promptA.errors.length > 0) {
                throw new Error(`coordinator prompt A failed before a tool call: ${report.phases.promptA.errors[0]}`);
            }
            const batchResult = (report.phases.promptA.results ?? []).find((item) => item.toolName === "subagent_spawn_batch");
            if (!batchResult || !/sa_[a-z0-9_]+/.test(batchResult.text ?? "")) {
                throw new Error(`batch did not launch: ${batchResult?.text ?? "no batch result"}`);
            }
            const promptB = await rpc.turn(`/skill:implementer-model ${taskB()}`, 180_000, ["TOKEN_QUOTE", "TOKEN_LEGACY", "TOKEN_TIER", "TOKEN_FOREGROUND"]);
            report.phases.promptB = summarizeTurn(promptB);
            writeReport(report);

            const runs = await collectRuns(join(tmp, "pi-better-subagents/runs"), argvLog);
            report.toolCalls = [...promptA, ...promptB].filter((event) => event.type === "tool_execution_start").map(summarizeTool);
            attachToolArgs(runs, report.toolCalls);
            report.runs = runs.map(publicRun);
            writeReport(report);

            const named = requireRun(runs, "TOKEN_NAMED");
            assertLaunch(named, {
                model: SKILL_MODEL,
                effort: SKILL_EFFORT,
                name: "Acceptance Dev",
                agent: "agent.acceptance-dev",
                source: "invocation",
            });
            const numeric = requireRun(runs, "TOKEN_ROLE_NUMERIC");
            assertLaunch(numeric, {
                model: SKILL_MODEL,
                effort: SKILL_EFFORT,
                name: /^developer-\d+$/,
                role: "role.developer",
                source: "invocation",
            });
            const batchImpl = requireRun(runs, "TOKEN_BATCH_IMPLEMENTER");
            const batchUser = requireRun(runs, "TOKEN_BATCH_USER");
            assertLaunch(batchImpl, {
                model: SKILL_MODEL,
                effort: SKILL_EFFORT,
                name: "developer-checkout",
                role: "role.developer",
                source: "invocation",
            });
            assertLaunch(batchUser, {
                model: USER_MODEL,
                effort: USER_EFFORT,
                role: "role.explorer",
                source: "invocation",
            });
            assert.equal(batchImpl.meta.catalog.snapshotDigest, batchUser.meta.catalog.snapshotDigest);
            assert.notEqual(batchImpl.meta.model, batchUser.meta.model);
            assert.equal(batchImpl.sharedModel ?? null, null);
            assert.equal(batchUser.sharedModel ?? null, null);
            const quote = requireRun(runs, "TOKEN_QUOTE");
            assertOmittedModel(quote);
            assert.equal(quote.meta.model, LEGACY_MODEL);
            assert.equal(quote.meta.effort, LEGACY_EFFORT);
            assert.equal(flagValue(quote.argv, "model"), LEGACY_MODEL);
            const legacy = requireRun(runs, "TOKEN_LEGACY");
            assert.equal(legacy.meta.catalog, undefined);
            assert.equal(legacy.meta.name, "legacy-check");
            assertToolChoice(legacy, LEGACY_MODEL, LEGACY_EFFORT);
            assert.equal(legacy.meta.model, LEGACY_MODEL);
            assert.equal(legacy.meta.effort, LEGACY_EFFORT);
            assert.match(legacy.argv, /--model xai\/grok-4\.3/);
            assert.match(legacy.argv, /--thinking low/);
            const tier = requireRun(runs, "TOKEN_TIER");
            assertOmittedModel(tier);
            assert.equal(tier.meta.model, SKILL_MODEL);
            assert.equal(tier.meta.effort, "low");
            assert.equal(tier.meta.catalog.modelSelection.source, "tier-candidate");
            assert.match(tier.argv, /--model xai\/grok-4\.5/);
            const foreground = requireRun(runs, "TOKEN_FOREGROUND");
            assertOmittedModel(foreground);
            assert.equal(foreground.meta.model, FOREGROUND_MODEL);
            assert.equal(foreground.meta.effort, "low");
            assert.equal(foreground.meta.catalog.modelSelection.source, "foreground");
            assert.equal(foreground.meta.catalog.effortSelection.source, "role-default");
            assert.match(foreground.argv, /--model xai\/grok-4\.7/);
            assert.match(foreground.argv, /--thinking low/);
            for (const run of runs) {
                assert.doesNotMatch(flagValue(run.argv, "model") ?? "", new RegExp(QUOTED));
                assert.doesNotMatch(String(run.tool?.model ?? ""), new RegExp(QUOTED));
                assert.notEqual(run.tool?.thinking, "xhigh");
            }
            const finished = await waitStatus(named.metaPath, 180_000);
            named.meta = finished;
            const output = existsSync(join(dirname(named.metaPath), "output.log"))
                ? readFileSync(join(dirname(named.metaPath), "output.log"), "utf8")
                : "";
            report.phases.namedCompletion = {
                id: finished.id,
                status: finished.status,
                exitCode: finished.exitCode ?? null,
                outputHasDone: output.includes("DONE"),
                outputTail: redact(output).slice(-1500),
            };
            report.runs = runs.map(publicRun);
            report.passed = finished.status === "completed" && output.includes("DONE");
            writeReport(report);
            assert.equal(finished.status, "completed", `named agent status ${finished.status}`);
            assert.match(output, /DONE/);
            report.blockers = [];
            writeReport(report);
        } catch (error) {
            report.passed = false;
            report.blockers.push(redact(error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4000));
            writeReport(report);
            throw error;
        } finally {
            watcher?.stop();
            if (child && child.exitCode === null && !child.killed) {
                child.kill("SIGTERM");
            }
            killRuns(join(tmp, "pi-better-subagents/runs"));
            writeFileSync(configPath, originalConfig);
        }
    });
});

function taskA() {
    return [
        "Delegate these launches now, then stop. Do not poll.",
        "The skill rule is the implementer model and effort. The quoted comparison in the skill is not a selection.",
        "1. subagent_spawn agent agent.acceptance-dev and no role. Prompt must start TOKEN_NAMED Reply with the single word DONE. Include the comparison quote in the prompt only. clean true, tools read,bash, sandbox false, callback false.",
        "2. subagent_spawn role role.developer and no alias. Prompt must start TOKEN_ROLE_NUMERIC Reply with the single word DONE. Skill model and thinking. clean true, tools read,bash, sandbox false, callback false.",
        "3. One subagent_spawn_batch. Do not set a shared model or shared thinking.",
        "Job A role role.developer alias checkout. Prompt must start TOKEN_BATCH_IMPLEMENTER Reply with the single word DONE. Skill model and thinking.",
        `Job B role role.explorer and no alias. The user explicitly requires model ${USER_MODEL} and thinking ${USER_EFFORT} for this job only, which outranks the skill. Prompt must start TOKEN_BATCH_USER Reply with the single word DONE.`,
        "Both batch prompts must contain the comparison quote as text, not as the model argument. clean true, tools read,bash, sandbox false, callback false on every job.",
    ].join("\n");
}

function taskB() {
    return [
        "Delegate these launches now, then stop. Do not poll.",
        "The skill's xai/grok-4.5 rule does not apply to any launch in this message. Do not pass that model unless the user explicitly names it below.",
        "The comparison quote openai/gpt-6-astra@xhigh is not a selection.",
        "1. subagent_spawn role role.acceptance-quote. Omit model and omit thinking. Prompt must start TOKEN_QUOTE Reply with the single word DONE. Put the comparison quote in the prompt text only. clean true, tools read,bash, sandbox false, callback false.",
        `2. subagent_spawn with no agent and no role. name legacy-check. The user explicitly requires model ${LEGACY_MODEL} and thinking ${LEGACY_EFFORT}. Prompt must start TOKEN_LEGACY Reply with the single word DONE. clean true, tools read,bash, sandbox false, callback false.`,
        "3. subagent_spawn role role.acceptance-same-tier. Omit model and omit thinking so catalog fallback can run. Prompt must start TOKEN_TIER Reply with the single word DONE. clean true, tools read,bash, sandbox false, callback false.",
        "4. subagent_spawn role role.acceptance-foreground. Omit model and omit thinking so catalog fallback can run. Prompt must start TOKEN_FOREGROUND Reply with the single word DONE. clean true, tools read,bash, sandbox false, callback false.",
    ].join("\n");
}

function patchedConfig(original) {
    const config = JSON.parse(original);
    config.maxConcurrent = 8;
    config.tierPolicy = {
        balanced: {
            members: ["openai/gpt-6-sol", "openai/gpt-6-missing", "xai/grok-4.5"],
            candidates: [{ model: "xai/grok-4.5", crossProvider: true }],
        },
    };
    return `${JSON.stringify(config, null, 2)}\n`;
}

function isolatedEnv(agentDir, tmp) {
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: tmp, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    delete env.PI_SESSION_FILE;
    delete env.PI_SESSION_ID;
    return env;
}

function gitSha() {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
        return null;
    }
}

function writeReport(report) {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function staticUnproven() {
    return [
        "T02 second independent agent",
        "T04 second-process numeric collision",
        "T05 alias collision suffix",
        "T06 rename does not relabel an old run",
        "T07 six preferred gpt-6 launches",
        "T08 model-only override matrix",
        "T11 no usable foreground",
        "T15 unavailable explicit model error",
        "T16 T33 unsupported effort and no retry",
        "T18 project shadow and same-scope duplicates",
        "T20 malformed sibling recovery",
        "T22 callback and stop parity",
        "T23 live role edit after a completed run",
        "T24 side-by-side capability grant",
        "T25 session reload of an old snapshot",
        "T27 empty replacement",
        "T28 role id repair",
        "T29 invalid project shadow",
        "T30 manual edit visible on the next launch",
        "T32 re-import preview",
        "T34 ambiguous two-role clarification",
        "T35 cross-process label race",
        "T36 unsupported execution restriction",
        "interactive navigator overlay pixels",
    ];
}

class Rpc {
    constructor(child) {
        this.child = child;
        this.buffer = "";
        this.queue = [];
        this.waiters = [];
        this.dialogs = [];
        this.stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => this.push(chunk));
        child.stderr.on("data", (chunk) => {
            this.stderr = `${this.stderr}${chunk}`.slice(-100_000);
        });
        child.on("error", (error) => this.fail(error));
        child.on("exit", (code) => {
            if (code !== 0 && code !== null) this.fail(new Error(`pi exited ${code}: ${redact(this.stderr).slice(-1000)}`));
        });
    }

    fail(error) {
        const waiter = this.waiters.shift();
        if (waiter) waiter.reject(error);
    }

    push(chunk) {
        this.buffer += chunk;
        let index = this.buffer.indexOf("\n");
        while (index >= 0) {
            let line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            index = this.buffer.indexOf("\n");
            if (!line.trim()) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            this.onMessage(message);
        }
    }

    onMessage(message) {
        if (message.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(message.method)) {
            const response = dialogResponse(message);
            this.dialogs.push({ ...summarizeDialog(message), ...response.record });
            this.send({ type: "extension_ui_response", id: message.id, ...response.body });
        }
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.queue.push(message);
    }

    send(message) {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    next(timeout) {
        if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
                reject(new Error("timed out waiting for pi rpc"));
            }, timeout);
            this.waiters.push({
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
        });
    }

    async request(message, timeout) {
        const id = message.id ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this.send({ ...message, id });
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const event = await this.next(deadline - Date.now());
            if (event.type === "response" && event.id === id) return event;
        }
        throw new Error(`no response for ${message.type}`);
    }

    async command(text) {
        const id = `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this.send({ id, type: "prompt", message: text });
        const events = [];
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            const event = await this.next(deadline - Date.now());
            events.push(event);
            if (event.type === "response" && event.id === id) return events;
        }
        throw new Error(`command did not finish: ${text.slice(0, 80)}`);
    }

    async turn(text, timeout, tokens = []) {
        const id = `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this.send({ id, type: "prompt", message: text });
        const events = [];
        const deadline = Date.now() + timeout;
        let accepted = false;
        let stateId = null;
        while (Date.now() < deadline) {
            let event;
            try {
                event = await this.next(Math.min(15_000, deadline - Date.now()));
            } catch {
                if (!accepted) continue;
                stateId = `state-${Date.now()}`;
                this.send({ id: stateId, type: "get_state" });
                continue;
            }
            events.push(event);
            if (event.type === "tool_execution_end" && event.isError === true) {
                throw new Error(`tool ${event.toolName} failed: ${redact(JSON.stringify(event.result)).slice(0, 2000)}`);
            }
            if (event.type === "response" && event.id === id) {
                accepted = true;
                if (event.success === false) throw new Error(`prompt rejected: ${event.error ?? "unknown"}`);
            }
            if (tokens.length > 0 && toolCallsFinished(events, tokens)) {
                this.send({ type: "abort" });
                const abortDeadline = Date.now() + 20_000;
                while (Date.now() < abortDeadline) {
                    const extra = await this.next(abortDeadline - Date.now());
                    events.push(extra);
                    if (extra.type === "response" && extra.command === "abort") break;
                }
                return events;
            }
            if (accepted && event.type === "agent_end" && !stateId) {
                stateId = `state-${Date.now()}`;
                this.send({ id: stateId, type: "get_state" });
            }
            if (stateId && event.type === "response" && event.id === stateId) {
                if (event.data?.isStreaming || event.data?.pendingMessageCount) stateId = null;
                else return events;
            }
        }
        throw new Error(`coordinator turn timed out after ${timeout}ms`);
    }
}

function dialogResponse(message) {
    if (message.method === "confirm") {
        const expected = String(message.title ?? "").startsWith("Import instructions");
        return { body: { confirmed: expected }, record: { confirmed: expected } };
    }
    if (message.method === "select") {
        const options = Array.isArray(message.options) ? message.options.map(String) : [];
        const inherit = options.find((option) => option.startsWith("Inherit "));
        if (!inherit) return { body: { cancelled: true }, record: { cancelled: true } };
        return { body: { value: inherit }, record: { value: inherit } };
    }
    return { body: { cancelled: true }, record: { cancelled: true } };
}

function summarizeDialog(message) {
    return {
        method: message.method,
        title: message.title ?? null,
        options: message.options ?? null,
    };
}

function notifications(events) {
    return events
        .filter((event) => event.type === "extension_ui_request" && (event.method === "notify" || event.method === "setWidget"))
        .map((event) => event.message ?? (event.widgetLines ?? []).join("\n"));
}

function summarizeTurn(events) {
    return {
        tools: events.filter((event) => event.type === "tool_execution_start").map(summarizeTool),
        results: events.filter((event) => event.type === "tool_execution_end").map((event) => ({
            toolName: event.toolName,
            isError: event.isError === true,
            text: redact(toolText(event.result)).slice(0, 2000),
        })),
        errors: events.filter((event) => event.isError === true || event.type === "message_end" && event.message?.errorMessage).map((event) => redact(JSON.stringify(event)).slice(0, 500)),
    };
}

function toolText(result) {
    const content = result?.content;
    if (!Array.isArray(content)) return JSON.stringify(result ?? "");
    return content.map((item) => item?.text ?? "").join("\n");
}

function summarizeTool(event) {
    return { toolName: event.toolName, args: event.args ?? null };
}

function toolCallsFinished(events, tokens) {
    const starts = [];
    const ended = new Set();
    for (const event of events) {
        if (event.type === "tool_execution_start") starts.push(event);
        if (event.type === "tool_execution_end") ended.add(event.toolCallId);
    }
    return tokens.every((token) => starts.some((event) => ended.has(event.toolCallId) && JSON.stringify(event.args ?? {}).includes(token)));
}

function watchRuns(runsDir) {
    const argvById = new Map();
    const timer = setInterval(() => {
        if (!existsSync(runsDir)) return;
        for (const id of readdirSync(runsDir)) {
            if (argvById.has(id)) continue;
            const metaPath = join(runsDir, id, "meta.json");
            if (!existsSync(metaPath)) continue;
            let meta;
            try {
                meta = JSON.parse(readFileSync(metaPath, "utf8"));
            } catch {
                continue;
            }
            const argv = processArgs(meta.pid);
            if (argv) argvById.set(id, argv);
        }
    }, 50);
    return {
        argvById,
        stop() {
            clearInterval(timer);
        },
    };
}

function processArgs(pid) {
    if (!pid) return "";
    try {
        return execFileSync("ps", ["-p", String(pid), "-ww", "-o", "command="], { encoding: "utf8" }).trim();
    } catch {
        return "";
    }
}

async function collectRuns(runsDir, argvLog) {
    const deadline = Date.now() + 5_000;
    let runs = readRuns(runsDir, argvLog);
    while (Date.now() < deadline && runs.some((run) => run.argv === "")) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        runs = readRuns(runsDir, argvLog);
    }
    return runs;
}

function readRuns(runsDir, argvLog) {
    const recorded = loadArgv(argvLog);
    if (!existsSync(runsDir)) return [];
    const runs = [];
    for (const id of readdirSync(runsDir)) {
        const dir = join(runsDir, id);
        const metaPath = join(dir, "meta.json");
        if (!existsSync(metaPath)) continue;
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        const prompt = existsSync(join(dir, "prompt.md")) ? readFileSync(join(dir, "prompt.md"), "utf8") : meta.promptPreview ?? "";
        runs.push({
            id,
            metaPath,
            meta,
            prompt,
            argv: argvFor(id, recorded),
        });
    }
    return runs;
}

function loadArgv(argvLog) {
    if (!existsSync(argvLog)) return [];
    return readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function argvFor(id, recorded) {
    const found = recorded.find((args) => {
        const index = args.indexOf("--session-id");
        return index >= 0 && args[index + 1] === id;
    });
    return found ? found.join(" ") : "";
}

function requireRun(runs, token) {
    const found = runs.find((run) => run.prompt.includes(token));
    assert.ok(found, `no child prompt contained ${token}; saw ${runs.map((run) => run.prompt.slice(0, 40)).join(" | ")}`);
    return found;
}

const TOKENS = [
    "TOKEN_NAMED",
    "TOKEN_ROLE_NUMERIC",
    "TOKEN_BATCH_IMPLEMENTER",
    "TOKEN_BATCH_USER",
    "TOKEN_QUOTE",
    "TOKEN_LEGACY",
    "TOKEN_TIER",
    "TOKEN_FOREGROUND",
];

function attachToolArgs(runs, toolCalls) {
    for (const run of runs) {
        const token = TOKENS.find((item) => run.prompt.includes(item));
        if (!token) continue;
        for (const call of toolCalls) {
            const args = call.args ?? {};
            if (Array.isArray(args.jobs)) {
                const job = args.jobs.find((item) => JSON.stringify(item).includes(token));
                if (!job) continue;
                run.tool = job;
                run.toolName = call.toolName;
                run.sharedModel = args.shared?.model;
                break;
            }
            if (JSON.stringify(args).includes(token)) {
                run.tool = args;
                run.toolName = call.toolName;
                break;
            }
        }
    }
}

function splitModel(value) {
    if (typeof value !== "string" || value.trim() === "") return { model: undefined, effort: undefined };
    const at = value.lastIndexOf("@");
    if (at <= 0) return { model: value, effort: undefined };
    return { model: value.slice(0, at), effort: value.slice(at + 1) };
}

function assertToolChoice(run, model, effort) {
    assert.ok(run.tool, `${run.id} has no coordinator tool arguments`);
    const parsed = splitModel(run.tool.model);
    assert.equal(parsed.model, model, `${run.id} tool model`);
    assert.equal(run.tool.thinking ?? parsed.effort, effort, `${run.id} tool effort`);
    assert.doesNotMatch(parsed.model ?? "", new RegExp(QUOTED));
}

function assertOmittedModel(run) {
    assert.ok(run.tool, `${run.id} has no coordinator tool arguments`);
    assert.equal(run.tool.model, undefined, `${run.id} tool model should be omitted`);
    assert.equal(run.tool.thinking, undefined, `${run.id} tool thinking should be omitted`);
}

function flagValue(argv, name) {
    const match = argv.match(new RegExp(`(?:^|\\s)--${name}\\s+(\\S+)`));
    return match?.[1];
}

function assertLaunch(run, expected) {
    assertToolChoice(run, expected.model, expected.effort);
    assert.equal(run.meta.model, expected.model, `${run.id} model`);
    assert.equal(run.meta.effort, expected.effort, `${run.id} effort`);
    if (expected.name instanceof RegExp) assert.match(run.meta.name ?? "", expected.name);
    else if (expected.name) assert.equal(run.meta.name, expected.name);
    if (expected.agent) assert.equal(run.meta.catalog?.id, expected.agent);
    if (expected.role) assert.equal(run.meta.catalog?.roleId ?? run.meta.catalog?.id, expected.role);
    if (expected.source) assert.equal(run.meta.catalog?.modelSelection?.source, expected.source);
    assert.equal(flagValue(run.argv, "model"), expected.model, `${run.id} argv model`);
    assert.equal(flagValue(run.argv, "thinking"), expected.effort, `${run.id} argv effort`);
}

function publicRun(run) {
    return {
        id: run.id,
        metaPath: run.metaPath,
        name: run.meta.name ?? null,
        model: run.meta.model ?? null,
        effort: run.meta.effort ?? null,
        status: run.meta.status ?? null,
        argv: redact(run.argv).slice(0, 1500),
        toolName: run.toolName ?? null,
        toolModel: run.tool?.model ?? null,
        toolThinking: run.tool?.thinking ?? null,
        catalog: run.meta.catalog
            ? {
                id: run.meta.catalog.id,
                roleId: run.meta.catalog.roleId ?? null,
                displayName: run.meta.catalog.displayName,
                snapshotDigest: run.meta.catalog.snapshotDigest,
                modelSource: run.meta.catalog.modelSelection?.source ?? null,
                modelReason: run.meta.catalog.modelSelection?.reason ?? null,
                effortSource: run.meta.catalog.effortSelection?.source ?? null,
                effortActual: run.meta.catalog.effortSelection?.actual ?? null,
            }
            : null,
        promptStart: run.prompt.slice(0, 80),
    };
}

async function waitStatus(metaPath, timeout) {
    const deadline = Date.now() + timeout;
    let meta = JSON.parse(readFileSync(metaPath, "utf8"));
    while (Date.now() < deadline && meta.status === "running") {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
    }
    return meta;
}

function killRuns(runsDir) {
    if (!existsSync(runsDir)) return;
    for (const id of readdirSync(runsDir)) {
        try {
            const meta = JSON.parse(readFileSync(join(runsDir, id, "meta.json"), "utf8"));
            if (meta.pid) {
                try {
                    process.kill(-meta.pid, "SIGTERM");
                } catch {
                    try {
                        process.kill(meta.pid, "SIGTERM");
                    } catch { /* already gone */ }
                }
            }
        } catch { /* ignore */ }
    }
}

function redact(value) {
    return String(value)
        .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(/xai-[A-Za-z0-9_-]{8,}/g, "[redacted]")
        .replace(/(api[_-]?key|authorization|bearer)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}
