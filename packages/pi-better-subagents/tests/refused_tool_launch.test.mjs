/**
 * #669: a tool the sandbox plan refuses must never reach the child loadout.
 *
 * The recorded bug: the launcher computed `taskTools.refused` but left the
 * rejected names in `selectedTools`, so a default (implicit) tool such as
 * `tool_search` was written into the task policy, the child preflight and the
 * frozen launch recipe. The child then exited in preflight with
 * "Child requested tool tool_search is unavailable" after the parent had
 * already announced the tool as merely disabled.
 *
 * These tests drive the REAL `subagent_spawn` execute path (real plan, real
 * `prepareTaskRuntime`, real policy/preflight/recipe writers) with a stubbed Pi
 * SDK package and a `pi` binary that is only used for path identity. The child
 * process itself is not under test: every assertion reads what the parent
 * committed before or while spawning.
 *
 * Contract:
 * - implicit/default unavailable tools are removed from the effective child
 *   tools (policy, preflight, recipe) with an actionable warning;
 * - an explicit `tools` request for an unavailable tool fails in the parent
 *   before any child, authority, or committed run record exists;
 * - exclusions still win over a request;
 * - a continuation whose frozen loadout can no longer be satisfied refuses
 *   before spawning instead of silently changing the saved conversation.
 *
 * @covers subagent.refused-tools
 * @level integration
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME = mkdtempSync(join(tmpdir(), "refused-tool-launch-"));
process.env.TMPDIR = RUNTIME;
process.env.PI_CODING_AGENT_DIR = join(RUNTIME, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
// The sandbox policy is read-only outside the workspace, so no recovery
// snapshot is taken; keep the flag explicit so the intent survives policy edits.
process.env.PI_SANDBOX_RECOVERY_SNAPSHOT = "off";

// ---- stubbed Pi SDK packages (temp root only; checkout node_modules untouched) ----
const STUBS_DIR = join(RUNTIME, "stubs");

function writeStubPackage(name, files) {
    const pkgDir = join(STUBS_DIR, ...name.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name, type: "module", main: "index.js", exports: { ".": "./index.js" } }),
    );
    for (const [file, content] of Object.entries(files)) {
        mkdirSync(dirname(join(pkgDir, file)), { recursive: true });
        writeFileSync(join(pkgDir, file), content);
    }
    return pkgDir;
}

/**
 * The SDK package the parent treats as the active Pi install. `getPackageDir()`
 * must point at it because `prepareTaskRuntime` proves the launched CLI is the
 * active SDK CLI, and `task-runtime.mjs` (the spawned entry) resolves
 * `<package>/dist/index.js` and `<package>/package.json` from it.
 */
function setupStubs() {
    writeStubPackage("@earendil-works/pi-ai", {
        "index.js": `
const scalar = (type, opts = {}) => ({ type, ...opts });
export const Type = {
    String: (opts) => scalar("string", opts),
    Number: (opts) => scalar("number", opts),
    Boolean: (opts) => scalar("boolean", opts),
    Optional: (schema) => schema,
    Array: (schema, opts = {}) => ({ type: "array", items: schema, ...opts }),
    Object: (props, opts = {}) => ({ type: "object", properties: props, ...opts }),
    Union: (variants, opts = {}) => ({ type: "union", anyOf: variants, ...opts }),
};
export function getSupportedThinkingLevels(model) {
    if (!model || model.reasoning === false) return ["off"];
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
}
`,
    });
    writeStubPackage("@earendil-works/pi-coding-agent", {
        "index.js": `
export function getAgentDir() { return process.env.PI_CODING_AGENT_DIR; }
export function getPackageDir() { return process.env.PI_TEST_SDK_PACKAGE_DIR; }
export class CustomEditor {}
export class SettingsManager {}
`,
        // The trusted native launcher validates this version floor itself.
        "package.json": JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.99.0", type: "module" }),
        // Only path identity matters: the spawned entry is task-runtime.mjs.
        "dist/cli.js": "#!/bin/sh\nexit 0\n",
        "dist/index.js": "\n",
    });
    writeStubPackage("@earendil-works/pi-tui", {
        "index.js": `
export const Key = { left: "left" };
export class Input {}
export class SelectList {}
export function wrapTextWithAnsi(text) { return [text]; }
export function matchesKey() { return false; }
export function visibleWidth(s) { return String(s ?? "").length; }
export function truncateToWidth(s) { return s; }
`,
    });

    const loaderPath = join(RUNTIME, "stub-loader.mjs");
    writeFileSync(loaderPath, `import { pathToFileURL } from "node:url";
const stubs = {
  "@earendil-works/pi-ai": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-ai/index.js"))},
  "@earendil-works/pi-coding-agent": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-coding-agent/index.js"))},
  "@earendil-works/pi-tui": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-tui/index.js"))},
};
export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(stubs, specifier)) {
    return { shortCircuit: true, url: pathToFileURL(stubs[specifier]).href };
  }
  return nextResolve(specifier, context);
}
`);
    register(pathToFileURL(loaderPath).href);
    const sdkRoot = join(STUBS_DIR, "@earendil-works/pi-coding-agent");
    // `which` skips a non-executable entry, so the stubbed CLI must be runnable.
    chmodSync(join(sdkRoot, "dist", "cli.js"), 0o755);
    process.env.PI_TEST_SDK_PACKAGE_DIR = sdkRoot;
    return sdkRoot;
}

/** `pi` on PATH is a symlink to the stubbed SDK CLI, so path identity holds. */
function pinPiBinaryOnPath(sdkRoot) {
    const binDir = join(RUNTIME, "bin");
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, "pi");
    if (!existsSync(link)) symlinkSync(join(sdkRoot, "dist", "cli.js"), link);
    const original = process.env.PATH;
    process.env.PATH = `${binDir}:${original ?? ""}`;
    return () => {
        if (original === undefined) delete process.env.PATH;
        else process.env.PATH = original;
    };
}

const SANDBOX_MAIN = {
    enabled: false, projectFiles: "read-write", outsideProject: "read",
    storedCredentials: "read", commands: true, network: true,
};
/** Read-only project files, no outside writes, no network. */
const SANDBOX_CHILD = {
    enabled: true, projectFiles: "read", outsideProject: "off",
    storedCredentials: "off", commands: true, network: true, processAccess: "off",
};

/**
 * The published profile ticks the default web tools, whose package is not
 * installed for this run. `tool_search` is the implicitly loaded default from
 * the recorded session (#669) and is not a guarded or ticked tool at all.
 */
const POLICY = Object.freeze({
    state: "enabled",
    permissions: SANDBOX_MAIN,
    subagentPermissions: SANDBOX_CHILD,
    subagentTools: { applyPatch: true, trusted: [{ name: "web_fetch", package: "npm:@juicesharp/rpiv-web-tools" }] },
});

const { SANDBOX_POLICY_CHANNEL, SANDBOX_POLICY_REQUEST_CHANNEL } = await import("../permission-policy.ts");
const { setConfigForTests } = await import("../config.ts");
const registry = await import("../registry.ts");
const { describeSandboxSupport } = await import("../shared-sandbox-core.ts");
const support = describeSandboxSupport();

// Only the default (implicit) loadout is under test. A default launch must be
// able to reach the plan, so the recorded default tools are what a real session
// carried: `tool_search` cannot be provided by any task adapter here.
const DEFAULT_TOOLS = "read, edit, tool_search, web_fetch";
setConfigForTests({ defaultTools: DEFAULT_TOOLS, maxConcurrent: 6, defaultModel: null, tierPolicy: null });

function loadExtension(policy) {
    const events = new EventEmitter();
    events.on(SANDBOX_POLICY_REQUEST_CHANNEL, () => events.emit(SANDBOX_POLICY_CHANNEL, policy));
    events.emit(SANDBOX_POLICY_CHANNEL, policy);
    const tools = {};
    const pi = {
        events,
        // No third-party tool is registered in this parent, so every ticked
        // trusted tool is genuinely unavailable.
        getAllTools: () => [],
        registerTool: (definition) => {
            tools[definition.name] = definition;
        },
        registerCommand: () => {},
        appendEntry: () => {},
        on: () => {},
        sendMessage: () => {},
    };
    mod.default(pi);
    return { tools, pi };
}

function makeCtx(cwd) {
    return {
        cwd,
        model: { provider: "test", id: "model" },
        hasUI: false,
        isIdle: () => true,
        ui: { notify() {}, setWidget() {} },
        sessionManager: { getSessionId: () => "owner-session", getBranch: () => [] },
    };
}

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

function runPath(id) {
    return join(RUNTIME, "pi-better-subagents", "runs", id);
}

function runIds() {
    const dir = join(RUNTIME, "pi-better-subagents", "runs");
    return existsSync(dir) ? registry.listMetas().map((meta) => meta.id).sort() : [];
}

function runDirectories() {
    const dir = join(RUNTIME, "pi-better-subagents", "runs");
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("sa_")).sort() : [];
}

async function waitForTerminal(id, { attempts = 200, delayMs = 25 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const meta = registry.readMeta(id);
        if (meta && meta.status !== "running" && meta.status !== "orphaned") return meta;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return undefined;
}

let mod;
let workspace;
let restorePath;

before(async () => {
    const sdkRoot = setupStubs();
    restorePath = pinPiBinaryOnPath(sdkRoot);
    mod = await import("../index.ts");
    workspace = join(RUNTIME, "workspace");
    mkdirSync(workspace, { recursive: true });
});

beforeEach(() => {
    setConfigForTests({ defaultTools: DEFAULT_TOOLS, maxConcurrent: 6, defaultModel: null, tierPolicy: null });
});

after(() => {
    restorePath?.();
    setConfigForTests(undefined);
    rmSync(RUNTIME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function requireSandbox(t) {
    if (!support.supported) {
        t.skip(`task sandbox backend unavailable: ${support.reason}`);
        return false;
    }
    return true;
}

function newSandboxDir(label) {
    const dir = join(RUNTIME, `sandbox-${label}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${label}\n`);
    return dir;
}

describe("refused task tools never reach the child loadout (#669)", () => {
    it("drops an implicitly loaded unavailable tool from policy, preflight and recipe", { timeout: 30000 }, async (t) => {
        if (!requireSandbox(t)) return;
        const { tools } = loadExtension(POLICY);
        const ctx = makeCtx(workspace);
        const sandboxDir = newSandboxDir("implicit");

        const result = await tools.subagent_spawn.execute("tc-implicit", {
            prompt: "implicit refusal", sandbox_dir: sandboxDir, callback: false,
        }, undefined, undefined, ctx);
        const text = result.content[0].text;
        const id = text.match(/id=(sa_[a-z0-9_]+)/)?.[1];
        assert.ok(id, `no run id in launch output: ${text}`);
        await waitForTerminal(id);

        // The recorded bug: the refused default tool stayed in every authority.
        const preflight = readJson(join(runPath(id), "child-preflight.json"));
        const policy = readJson(join(runPath(id), "control", "task-policy.json"));
        const meta = registry.readMeta(id);
        assert.deepEqual(preflight.tools, ["read", "edit", "report_assignment_result", "apply_patch"],
            "the child preflight must list only tools the task boundary can provide");
        assert.deepEqual(policy.tools, preflight.tools,
            "the immutable task policy must admit exactly the preflight loadout");
        assert.equal(meta.recipe.tools, "read,edit,apply_patch",
            "the frozen caller loadout excludes the supervisor's reporting capability");
        for (const loadout of [preflight.tools, policy.tools, meta.recipe.tools.split(",")]) {
            assert.ok(!loadout.includes("tool_search"));
            assert.ok(!loadout.includes("web_fetch"));
        }

        // The drop is reported, with the reason, where the operator can act.
        assert.match(text, /Task sandbox: /);
        assert.match(text, /tool_search disabled \(not a guarded tool and not ticked as trusted in \/sandbox \(Subagents · Tools\)\)/);
        assert.match(text, /web_fetch disabled \(its package @juicesharp\/rpiv-web-tools can't be found/);
        assert.doesNotMatch(text, /trusted web_fetch/);
    });

    it("fails an explicit request for an unavailable tool before any attempt is committed", { timeout: 30000 }, async (t) => {
        if (!requireSandbox(t)) return;
        const { tools } = loadExtension(POLICY);
        const ctx = makeCtx(workspace);
        const sandboxDir = newSandboxDir("explicit");
        const before = runIds();
        const beforeDirectories = runDirectories();

        await assert.rejects(
            tools.subagent_spawn.execute("tc-explicit", {
                prompt: "explicit refusal", sandbox_dir: sandboxDir, tools: "read,tool_search", callback: false,
            }, undefined, undefined, ctx),
            (error) => {
                assert.match(error.message, /tool_search/);
                assert.match(error.message, /not a guarded tool and not ticked as trusted/);
                // The refusal is the parent's, not the child launcher's fallback.
                assert.doesNotMatch(error.message, /Task sandbox requires a supported active Pi SDK/);
                return true;
            },
        );
        assert.deepEqual(runIds(), before, "a refused explicit request leaves no run record");
        assert.deepEqual(runDirectories(), beforeDirectories,
            "a refused explicit request leaves no attempt directory containing preflight or task policy");
    });

    it("keeps exclusions ahead of a requested tool", { timeout: 30000 }, async (t) => {
        if (!requireSandbox(t)) return;
        const { tools } = loadExtension(POLICY);
        const ctx = makeCtx(workspace);
        const sandboxDir = newSandboxDir("excluded");

        const result = await tools.subagent_spawn.execute("tc-excluded", {
            prompt: "excluded request", sandbox_dir: sandboxDir, tools: "read,tool_search",
            exclude_tools: "tool_search", callback: false,
        }, undefined, undefined, ctx);
        const text = result.content[0].text;
        const id = text.match(/id=(sa_[a-z0-9_]+)/)?.[1];
        assert.ok(id, `no run id in launch output: ${text}`);
        await waitForTerminal(id);

        const preflight = readJson(join(runPath(id), "child-preflight.json"));
        assert.deepEqual(preflight.tools, ["read", "report_assignment_result"], "only the caller's read tool and internal reporter are admitted");
        const policy = readJson(join(runPath(id), "control", "task-policy.json"));
        const meta = registry.readMeta(id);
        assert.deepEqual(policy.tools, preflight.tools);
        assert.equal(meta.recipe.tools, "read,tool_search", "the caller's original selection stays frozen");
        assert.equal(meta.recipe.excludeTools, "tool_search", "the frozen denylist still overrides that selection");
        for (const loadout of [preflight.tools, policy.tools]) {
            assert.ok(!loadout.includes("tool_search"), "excluded user tool stays absent from runtime authority");
        }
        assert.doesNotMatch(text, /tool_search/, "an excluded tool is not reported as disabled");
    });

    it("refuses a continuation whose frozen loadout can no longer be satisfied", { timeout: 30000 }, async (t) => {
        if (!requireSandbox(t)) return;
        const { tools } = loadExtension(POLICY);
        const ctx = makeCtx(workspace);
        const sandboxDir = newSandboxDir("frozen");
        const sessionId = registry.nextRunId();
        const sessionDir = join(RUNTIME, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(
            join(sessionDir, `2024-01-01T00-00-00-000Z_${sessionId}.jsonl`),
            `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: sandboxDir })}\n`
            + `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "prior" }] } })}\n`,
        );
        // A saved conversation frozen with a tool this parent can no longer
        // provide: the first attempt ran where web_fetch resolved.
        registry.writeMeta({
            id: sessionId,
            status: "completed",
            pid: 0,
            spawnPid: process.pid,
            cwd: sandboxDir,
            promptPreview: "prior",
            startedAt: Date.now() - 1000,
            endedAt: Date.now(),
            exitCode: 0,
            logPath: registry.logPathFor(sessionId),
            sessionId,
            rootRunId: sessionId,
            sandbox: sandboxDir,
            taskRuntime: true,
            callback: false,
            recipe: {
                version: 1, attemptId: sessionId, sessionId, sessionDir, cwd: sandboxDir,
                model: "test/model", tools: "read,edit,web_fetch",
                clean: false, allowNested: false, approve: false,
                sandbox: true, sandboxDir, gitCloneWorkspace: false, callback: false,
            },
        });
        const before = runIds();

        await assert.rejects(
            tools.subagent_spawn.execute("tc-frozen", {
                prompt: "frozen continuation", session_id: sessionId,
            }, undefined, undefined, ctx),
            (error) => {
                assert.match(error.message, new RegExp(`Cannot continue ${sessionId}`));
                assert.match(error.message, /frozen launch requires/);
                assert.match(error.message, /web_fetch \(its package @juicesharp\/rpiv-web-tools can't be found/);
                assert.match(error.message, /Launch a new run/);
                assert.doesNotMatch(error.message, /Task sandbox requires a supported active Pi SDK/);
                return true;
            },
        );
        assert.deepEqual(runIds(), before, "a refused continuation leaves no new attempt record");
        const prior = registry.readMeta(sessionId);
        assert.equal(prior.recipe.tools, "read,edit,web_fetch", "the saved loadout is never silently rewritten");
    });
});
