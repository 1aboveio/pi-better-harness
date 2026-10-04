import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest, { after, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
    createBashToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    discoverAndLoadExtensions,
    getAgentDir,
    initTheme,
} from "@earendil-works/pi-coding-agent";
import type {
    EventBus,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    RegisteredCommand,
    SessionStartEvent,
    ToolDefinition,
    Theme,
    UserBashEventResult,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";

import piBetterSandbox from "../index.ts";
import { permissionSettingsPath, writePermissionSettings } from "../permission-settings.ts";
import { defaultSandboxPermissions } from "../permissions.ts";
import { SESSION_PERMISSION_ENTRY } from "../session-permissions.ts";
import type { Component } from "@earendil-works/pi-tui";
import { sandboxArgumentCompletions } from "../commands.ts";
import { denyRuleOverridePath } from "../deny-rules.ts";
import { sandboxPreferencesPath, writeSandboxDefault } from "../preferences.ts";
import { PACKAGED_DENY_WRITE_TEMPLATES } from "../policy.ts";
import { RULES_PAGE_NO_UI_REJECTION } from "../rules-page.ts";
import {
    FOREGROUND_SANDBOX_POLICY_CHANNEL,
    FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
    type ForegroundSandboxPolicyEvent,
} from "../events.ts";
import { describeSandboxSupport } from "../shared-sandbox-core.ts";
import { realBackendSkip } from "./support/resolvable-backend.ts";

// Policy/registration checks need discovery only; worker execution needs a
// usable kernel. Keep those separate so a restricted host still runs the former.
const backendSkip = realBackendSkip();
const support = describeSandboxSupport();
const test = (name: string, fn: (t: TestContext) => void | Promise<void>) =>
    nodeTest(name, { skip: support.supported ? false : support.reason }, fn);
const kernelTest = (name: string, fn: (t: TestContext) => void | Promise<void>) =>
    nodeTest(name, { skip: backendSkip }, fn);

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-sandbox-extension-")));
after(() => rmSync(fixtures, { recursive: true, force: true }));

// The extension reads its write-deny override out of the pi agent directory.
// Redirecting that directory into a disposable fixture is what keeps every test
// below off the developer's real ~/.pi state, including the ones that drive pi's
// own extension loader.
const agentDir = realpathSync(mkdtempSync(join(realpathSync(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp"), "pi-better-sandbox-agent-")));
// The name pi's own `getAgentDir()` reads (`ENV_AGENT_DIR` in its config module,
// which is not re-exported from the package entry point).
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

// If that env name ever stops being the redirect, this fails loudly instead of
// letting the suite quietly read and write the developer's real pi state.
assert.equal(getAgentDir(), agentDir, "the pi agent directory must be redirected for these tests");
assert.equal(denyRuleOverridePath().startsWith(agentDir), true);

/** Drop any override a previous test left behind, so each starts on defaults. */
function forgetDenyOverride(): void {
    rmSync(denyRuleOverridePath(), { force: true });
}

function forgetSandboxPreference(): void {
    rmSync(sandboxPreferencesPath(), { force: true });
    rmSync(permissionSettingsPath(), { force: true });
}

function project(name: string): string {
    const root = join(fixtures, name);
    mkdirSync(root, { recursive: true });
    return root;
}

type Recorded = {
    pi: ExtensionAPI;
    tools: Map<string, ToolDefinition>;
    commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
    handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
    toolCallHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown>;
    published: ForegroundSandboxPolicyEvent[];
    events: EventBus;
    branch: SessionEntry[];
};

/** A recorder shaped like Pi's ExtensionAPI, driving the real extension factory. */
function record(branch: SessionEntry[] = []): Recorded {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const toolCallHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
    const published: ForegroundSandboxPolicyEvent[] = [];
    const subscribers = new Map<string, Array<(data: unknown) => void>>();

    const events: EventBus = {
        emit(channel, data) {
            for (const handler of subscribers.get(channel) ?? []) handler(data);
        },
        on(channel, handler) {
            const list = subscribers.get(channel) ?? [];
            list.push(handler);
            subscribers.set(channel, list);
            return () => {
                subscribers.set(
                    channel,
                    (subscribers.get(channel) ?? []).filter((entry) => entry !== handler),
                );
            };
        },
    };
    events.on(FOREGROUND_SANDBOX_POLICY_CHANNEL, (data) => {
        published.push(data as ForegroundSandboxPolicyEvent);
    });

    const recorded = { branch };
    const pi = {
        appendEntry: nodeTest.mock.fn((customType: string, data: unknown) => {
            recorded.branch.push({ type: "custom", customType, data: structuredClone(data),
                id: `entry-${recorded.branch.length}`, parentId: recorded.branch.at(-1)?.id ?? null,
                timestamp: "2026-01-01T00:00:00.000Z" });
        }),
        events,
        registerTool(tool: ToolDefinition) {
            tools.set(tool.name, tool);
        },
        registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
            commands.set(name, command);
        },
        on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
            handlers.set(event, handler);
            if (event === "tool_call") toolCallHandlers.push(handler);
        },
        getAllTools() {
            return [...tools.values()].map((tool) => ({
                name: tool.name, description: tool.description, parameters: tool.parameters,
                promptGuidelines: tool.promptGuidelines,
                sourceInfo: { path: join(packageRoot, "index.ts") },
            }));
        },
    } as unknown as ExtensionAPI;

    return Object.assign(recorded, { pi, tools, commands, handlers, toolCallHandlers, published, events });
}

function assertProtectedPolicy(recorded: Recorded, root: string, rules: string[] = [...PACKAGED_DENY_WRITE_TEMPLATES]): void {
    const paths = [...(recorded.published.at(-1)?.denyWrite ?? [])];
    const expected = [
        ...rules.map((rule) => join(root, rule)).sort(),
        getAgentDir(),
        join(realpathSync(tmpdir()), "pi-better-subagents"),
        join(realpathSync(tmpdir()), "pi-better-background-tasks"),
        realpathSync(join(packageRoot, "../../node_modules")),
        packageRoot,
        join(root, ".pi"),
    ];
    assert.deepEqual(paths.slice(0, expected.length), expected);
    // getAllTools can report several registered tools from the same code root.
    for (const path of paths.slice(expected.length)) assert.equal(path, packageRoot);
}

type UiCall = { kind: string; text: string };

type ContextOptions = {
    branch?: () => SessionEntry[];
    hasUI?: boolean;
    confirm?: boolean;
    /** Answers the rules page's selector. Returning undefined is pressing escape. */
    select?: (title: string, options: string[]) => string | undefined;
    /** Answers the rules page's text prompt. */
    input?: (title: string) => string | undefined;
};

function context(cwd: string, options: ContextOptions = {}) {
    const notifications: UiCall[] = [];
    const statuses: Array<string | undefined> = [];
    const confirmations: string[] = [];
    const selections: Array<{ title: string; options: string[] }> = [];
    const prompts: string[] = [];
    const ctx = {
        cwd,
        hasUI: options.hasUI ?? true,
        mode: "tui",
        sessionManager: { getBranch: options.branch ?? (() => []) },
        ui: {
            theme: { fg: (_color: string, text: string) => text },
            notify(message: string, type = "info") {
                notifications.push({ kind: type, text: message });
            },
            setStatus(_key: string, text: string | undefined) {
                statuses.push(text);
            },
            async confirm(title: string) {
                confirmations.push(title);
                return options.confirm ?? false;
            },
            async select(title: string, choices: string[]) {
                selections.push({ title, options: choices });
                return options.select?.(title, choices);
            },
            async input(title: string) {
                prompts.push(title);
                return options.input?.(title);
            },
        },
    } as unknown as ExtensionCommandContext;
    return { ctx, notifications, statuses, confirmations, selections, prompts };
}

async function startSession(
    recorded: Recorded,
    cwd: string,
    reason: SessionStartEvent["reason"] = "startup",
    activate = true,
    resetPreference = true,
) {
    if (resetPreference) forgetSandboxPreference();
    if (reason === "new") recorded.branch = [];
    const started = context(cwd, { branch: () => recorded.branch });
    const handler = recorded.handlers.get("session_start");
    assert.ok(handler, "the extension must handle session_start");
    await handler({ type: "session_start", reason }, started.ctx);
    if (activate) await recorded.commands.get("sandbox")?.handler("on", started.ctx);
    return started;
}

test("the extension registers the built-in overrides, user_bash routing, and the sandbox command", () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);

    assert.deepEqual([...recorded.tools.keys()].sort(), ["bash", "edit", "process_list", "read", "write"]);
    assert.ok(recorded.handlers.has("user_bash"));
    assert.ok(recorded.handlers.has("session_start"));
    assert.deepEqual([...recorded.commands.keys()], ["sandbox"]);
});

test("the task gate rejects unknown and replaced tools while admitting installed definitions", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("task-tool-gate");
    const started = await startSession(recorded, root);
    const gate = recorded.toolCallHandlers[0];
    assert.ok(gate, "the shared task gate must be registered");

    const call = (name: string) => gate({ toolName: name, input: {} }, started.ctx) as
        | { block: boolean; reason: string }
        | undefined;
    assert.equal(call("read"), undefined);
    assert.match(call("unverified_tool")?.reason ?? "", /no verified task execution adapter/);
    assert.equal(call("unverified_tool")?.block, true);

    const installed = recorded.tools.get("write");
    assert.ok(installed);
    recorded.tools.set("write", { ...installed, parameters: { ...installed.parameters } });
    assert.deepEqual(call("write"), {
        block: true,
        reason: "Sandbox: write was replaced by an unverified implementation.",
    });
    recorded.tools.set("write", installed);
    assert.equal(call("write"), undefined);
});

test("registered file and bash overrides preserve SDK contracts and rendered output", () => {
    initTheme("dark", false);
    const recorded = record();
    piBetterSandbox(recorded.pi);

    const builtIn = {
        bash: createBashToolDefinition(process.cwd()),
        write: createWriteToolDefinition(process.cwd()),
        edit: createEditToolDefinition(process.cwd()),
    };
    for (const name of ["write", "edit", "bash"] as const) {
        const override = recorded.tools.get(name);
        assert.ok(override, `${name} must be overridden`);
        assert.equal(override.name, builtIn[name].name);
        assert.equal(override.label, builtIn[name].label);
        assert.equal(override.renderShell, builtIn[name].renderShell);
        assert.equal(override.description, builtIn[name].description);
        assert.equal(override.promptSnippet, builtIn[name].promptSnippet);
        assert.deepEqual(override.promptGuidelines, builtIn[name].promptGuidelines);
        assert.deepEqual(override.parameters, builtIn[name].parameters);
        const theme = { fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
        const renderContext = () => ({ cwd: process.cwd(), state: {}, argsComplete: false,
            expanded: false, isPartial: false, isError: true, args: { path: "example.txt" }, invalidate() {} });
        const input = { command: "printf preview", path: "example.txt", content: "preview", edits: [{ oldText: "old", newText: "new" }] };
        const original = builtIn[name] as ToolDefinition;
        assert.deepEqual(override.renderCall!(input, theme, renderContext() as never).render(80),
            original.renderCall!(input, theme, renderContext() as never).render(80));
        const error = { content: [{ type: "text" as const, text: "synthetic write denied" }], details: undefined };
        const rendered = override.renderResult!(error, { expanded: false, isPartial: false }, theme, renderContext() as never).render(80);
        assert.deepEqual(rendered,
            original.renderResult!(error, { expanded: false, isPartial: false }, theme, renderContext() as never).render(80));
        assert.match(rendered.join("\n"), /synthetic write denied/);
    }
});

kernelTest("a session with a different cwd re-registers the file tools against that cwd", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("file-tool-cwd");
    const before = recorded.tools.get("write");

    await startSession(recorded, root);

    const after = recorded.tools.get("write");
    assert.notEqual(after, before, "the write override must resolve paths against the session cwd");

    // A relative path now resolves under the session root, as pi's own write would.
    await (after as ToolDefinition<never>).execute(
        "call",
        { path: "session-cwd.txt", content: "here\n" } as never,
        undefined,
        undefined,
        {} as ExtensionContext,
    );
    assert.equal(readFileSync(join(root, "session-cwd.txt"), "utf8"), "here\n");
});

test("user_bash routes ! and !! through the same confined operations as the bash tool", () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const handler = recorded.handlers.get("user_bash");
    assert.ok(handler);

    const first = handler(
        { type: "user_bash", command: "ls", excludeFromContext: false, cwd: fixtures },
        context(fixtures).ctx,
    ) as UserBashEventResult;
    const second = handler(
        { type: "user_bash", command: "ls", excludeFromContext: true, cwd: fixtures },
        context(fixtures).ctx,
    ) as UserBashEventResult;

    assert.ok(first.operations);
    assert.equal(first.operations, second.operations);
});

test("every session start publishes an inactive policy and an available footer by default", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("lifecycle");

    for (const reason of ["startup", "new", "resume", "fork", "reload"] as const) {
        const started = await startSession(recorded, root, reason, false);
        const policy = recorded.published.at(-1);
        assert.equal(policy?.state, "disabled", `consumer state after ${reason}`);
        assert.match(policy?.reason ?? "", /inactive by default/);
        assert.equal(policy?.projectRoot, root);
        assert.equal(started.statuses.at(-1), "sandbox · available");
    }
});

test("an unsafe launch directory publishes a failed policy, a loud footer, and a warning", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);

    const started = await startSession(recorded, "/");

    const policy = recorded.published.at(-1);
    assert.equal(policy?.state, "failed");
    assert.equal(started.statuses.at(-1), "sandbox · FAILED");
    assert.match(started.notifications.at(-1)?.text ?? "", /Relaunch pi/);
    assert.equal(started.notifications.at(-1)?.kind, "warning");
});

test("a late consumer can ask for the current policy and receive it", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("late-consumer");
    await startSession(recorded, root);

    const seen: ForegroundSandboxPolicyEvent[] = [];
    recorded.events.on(FOREGROUND_SANDBOX_POLICY_CHANNEL, (data) => {
        seen.push(data as ForegroundSandboxPolicyEvent);
    });
    recorded.events.emit(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, undefined);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.state, "enabled");
    assert.equal(seen[0]?.projectRoot, root);
});

test("the published policy is frozen so one consumer cannot rewrite another's copy", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    await startSession(recorded, project("frozen-policy"));

    const policy = recorded.published.at(-1);
    assert.ok(policy);
    assert.throws(() => {
        (policy as { state: string }).state = "disabled";
    }, TypeError);
    assert.throws(() => {
        (policy.denyWrite as string[]).push("/etc/passwd");
    }, TypeError);
});

test("/sandbox reports the effective status without changing it", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("report");
    await startSession(recorded, root);
    const publishedBefore = recorded.published.length;

    const shown = context(root);
    (shown.ctx as { mode: string }).mode = "rpc";
    await recorded.commands.get("sandbox")?.handler("", shown.ctx);

    const report = shown.notifications.at(-1)?.text ?? "";
    assert.match(report, /Foreground sandbox: ENABLED/);
    assert.match(report, new RegExp(`Writable root: ${root}`));
    assert.match(report, /Reads: +unrestricted/);
    assert.match(report, new RegExp(`${root}/\\.env`));
    assert.match(report, /Not confined: pi's own process/);
    assert.equal(recorded.published.length, publishedBefore);
});

test("/sandbox off is refused without an interactive UI and leaves the sandbox on", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("headless-off");
    await startSession(recorded, root);

    const headless = context(root, { hasUI: false });
    await recorded.commands.get("sandbox")?.handler("off", headless.ctx);

    assert.equal(headless.confirmations.length, 0);
    assert.equal(headless.notifications.at(-1)?.kind, "error");
    assert.match(headless.notifications.at(-1)?.text ?? "", /needs an interactive confirmation/);
    assert.equal(recorded.published.at(-1)?.state, "enabled");
});

test("/sandbox off keeps the sandbox on when the human declines", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("declined-off");
    await startSession(recorded, root);

    const declining = context(root, { confirm: false });
    await recorded.commands.get("sandbox")?.handler("off", declining.ctx);

    assert.equal(declining.confirmations.length, 1);
    assert.equal(recorded.published.at(-1)?.state, "enabled");
});

test("a confirmed /sandbox off disables it, and /sandbox on restores it without a restart", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("confirmed-off");
    const started = await startSession(recorded, root);

    const confirming = context(root, { confirm: true });
    await recorded.commands.get("sandbox")?.handler("off", confirming.ctx);

    assert.equal(confirming.confirmations.length, 1);
    assert.equal(recorded.published.at(-1)?.state, "disabled");
    assert.equal(started.statuses.at(-1), "sandbox · OFF");

    await recorded.commands.get("sandbox")?.handler("on", confirming.ctx);

    assert.equal(recorded.published.at(-1)?.state, "enabled");
    assert.equal(started.statuses.at(-1), `sandbox · on · confirmed-off`);
});

test("/sandbox default on persists opt-in and applies it to future sessions", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("persistent-default-on");
    await startSession(recorded, root, "startup", false);
    assert.equal(recorded.published.at(-1)?.state, "disabled");

    const shown = context(root);
    await recorded.commands.get("sandbox")?.handler("default on", shown.ctx);

    assert.equal(recorded.published.at(-1)?.state, "enabled");
    assert.equal(JSON.parse(readFileSync(sandboxPreferencesPath(), "utf8")).default, "on");

    const next = context(root);
    await recorded.handlers.get("session_start")?.(
        { type: "session_start", reason: "resume" },
        next.ctx,
    );
    assert.equal(recorded.published.at(-1)?.state, "enabled");
});

test("/sandbox default off requires confirmation, persists opt-out, and applies immediately", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("persistent-default-off");
    await startSession(recorded, root);

    const declining = context(root, { confirm: false });
    await recorded.commands.get("sandbox")?.handler("default off", declining.ctx);
    assert.equal(existsSync(sandboxPreferencesPath()), false);
    assert.equal(recorded.published.at(-1)?.state, "enabled");

    const confirming = context(root, { confirm: true });
    await recorded.commands.get("sandbox")?.handler("default off", confirming.ctx);
    assert.equal(JSON.parse(readFileSync(sandboxPreferencesPath(), "utf8")).default, "off");
    assert.equal(recorded.published.at(-1)?.state, "disabled");
});

test("a malformed persisted preference blocks the session instead of broadening access", async () => {
    forgetSandboxPreference();
    mkdirSync(dirname(sandboxPreferencesPath()), { recursive: true });
    writeFileSync(sandboxPreferencesPath(), '{"version":1,"default":"invalid"}\n');
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("malformed-preference");

    const started = context(root);
    await recorded.handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" },
        started.ctx,
    );

    assert.equal(recorded.published.at(-1)?.state, "failed");
    assert.ok(
        started.notifications.some(
            (note) => note.kind === "error" && note.text.includes("could not be loaded"),
        ),
    );
});

test("command activation persists across resume but not into a new session", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("no-persist");
    await startSession(recorded, root, "startup", false);
    assert.equal(recorded.published.at(-1)?.state, "disabled");
    await recorded.commands.get("sandbox")?.handler("on", context(root).ctx);
    assert.equal(recorded.published.at(-1)?.state, "enabled");
    assert.equal(existsSync(permissionSettingsPath()), false);
    assert.equal(existsSync(sandboxPreferencesPath()), false);

    await startSession(recorded, root, "resume", false);

    assert.equal(recorded.published.at(-1)?.state, "enabled");
    await startSession(recorded, root, "new", false);
    assert.equal(recorded.published.at(-1)?.state, "disabled");
});

test("confirmed command off persists its switch and retains permission details across reload", async () => {
    forgetSandboxPreference();
    const settings = defaultSandboxPermissions();
    settings.main.enabled = true;
    settings.main.network = false;
    settings.subagents.outsideProject = "off";
    const recorded = record([sessionEntry({ version: 1, permissions: settings })]);
    piBetterSandbox(recorded.pi);
    const root = project("command-off-reload");
    await startSession(recorded, root, "resume", false);
    await runSandbox(recorded, "off", context(root, { confirm: true }).ctx);
    const restored = record(structuredClone(recorded.branch));
    piBetterSandbox(restored.pi);
    const reloaded = await startSession(restored, root, "reload", false);
    assert.equal(restored.published.at(-1)?.permissions?.enabled, false);
    assert.equal(reloaded.statuses.at(-1), "sandbox · OFF");
    assert.equal(restored.published.at(-1)?.permissions?.network, false);
    assert.equal(restored.published.at(-1)?.subagentPermissions?.outsideProject, "off");
    assert.equal(existsSync(permissionSettingsPath()), false);
    assert.equal(existsSync(sandboxPreferencesPath()), false);
});

/** Run the real page through Pi's custom-UI boundary, awaiting render completion. */
async function permissionsPage(recorded: Recorded, cwd: string,
    interact: (page: Component, press: (key: string) => Promise<void>) => Promise<void>) {
    const shown = context(cwd, { branch: () => recorded.branch });
    shown.ctx.ui.custom = nodeTest.mock.fn(async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        let rendered: (() => void) | undefined;
        const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
            bold: (text: string) => text, inverse: (text: string) => text } as Theme;
        const page = await factory({ requestRender: () => rendered?.() } as never, theme, {} as never, () => {});
        const press = (key: string) => new Promise<void>((resolve) => {
            rendered = resolve;
            page.handleInput?.(key);
        });
        await interact(page, press);
        page.handleInput?.("\x1b");
        return null;
    }) as ExtensionContext["ui"]["custom"];
    await recorded.commands.get("sandbox")!.handler("", shown.ctx);
}

function sessionEntry(data: unknown, id = "policy", parentId: string | null = null): SessionEntry {
    return { type: "custom", customType: SESSION_PERMISSION_ENTRY, data,
        id, parentId, timestamp: "2026-01-01T00:00:00.000Z" };
}

test("UI edits persist both profiles and tools to session only and immediately enforce restrictions", async () => {
    forgetDenyOverride();
    forgetSandboxPreference();
    writePermissionSettings(defaultSandboxPermissions());
    writeSandboxDefault("off");
    const defaults = readFileSync(permissionSettingsPath(), "utf8");
    const activation = readFileSync(sandboxPreferencesPath(), "utf8");
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("session-edit-enforcement");
    const started = await startSession(recorded, root, "startup", false, false);
    await permissionsPage(recorded, root, async (page, press) => {
        await press(" "); // Main on.
        await press("\x1b[B");
        await press(" "); // Project files off.
        for (let i = 0; i < 3; i++) await press("\x1b[B");
        await press(" "); // Main commands off.
        await press("\x1b[B");
        await press(" "); // Main network off.
        await press("\x1b[C");
        await press(" "); // Subagents network off.
        await press("\x1b[B"); // Skip the independent Process access row.
        await press("\x1b[B");
        await press(" "); // Guarded apply_patch off.
        await press("\x1b[B");
        await press(" "); // Default trusted group off.
        assert.doesNotMatch(page.render(120).join("\n"), /Save as defaults/);
        page.handleInput?.("\r"); // Fold, not save.
    });
    const expected = defaultSandboxPermissions();
    Object.assign(expected.main, { enabled: true, projectFiles: "off", commands: false, network: false });
    expected.subagents.network = false;
    expected.subagentTools = { applyPatch: false, trusted: [] };
    assert.equal(recorded.branch.length, 7, "each policy edit creates one custom entry");
    const last = recorded.branch.at(-1)!;
    assert.equal(last.type, "custom");
    assert.deepEqual((last as { data: unknown }).data, { version: 1, permissions: expected });
    assert.deepEqual(recorded.published.at(-1)?.permissions, expected.main);
    assert.deepEqual(recorded.published.at(-1)?.subagentPermissions, expected.subagents);
    assert.deepEqual(recorded.published.at(-1)?.subagentTools, expected.subagentTools);
    assert.equal(readFileSync(permissionSettingsPath(), "utf8"), defaults);
    assert.equal(readFileSync(sandboxPreferencesPath(), "utf8"), activation);
    const file = join(root, "private.txt");
    writeFileSync(file, "unchanged");
    await assert.rejects(() => recorded.tools.get("read")!.execute("read", { path: file }, undefined, undefined, started.ctx), /refused to read/);
    await assert.rejects(() => writeThrough(recorded.tools.get("write")!, file, "changed"), /permission-denied/);
    assert.equal(readFileSync(file, "utf8"), "unchanged");
    assert.equal((recorded.handlers.get("tool_call")!({ toolName: "bash", input: {} }, started.ctx) as { block: boolean }).block, true);
    assert.equal((recorded.handlers.get("tool_call")!({ toolName: "web_fetch", input: {} }, started.ctx) as { block: boolean }).block, true);
});

test("a session append failure is visible, leaves the UI and enforcement unchanged, and permits retry", async (t) => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("session-append-failure");
    await startSession(recorded, root, "startup", false);
    const append = t.mock.method(recorded.pi, "appendEntry", () => { throw new Error("session append failed"); });
    await permissionsPage(recorded, root, async (page, press) => {
        const before = structuredClone(recorded.published.at(-1));
        await press(" ");
        assert.match(page.render(120).join("\n"), /session append failed/);
        assert.match(page.render(120).join("\n"), /Sandbox\s+Off\s+On/);
        assert.deepEqual(recorded.published.at(-1), before);
        assert.deepEqual(recorded.branch, []);
        assert.equal(existsSync(permissionSettingsPath()), false);
        append.mock.restore();
        await press(" ");
        assert.match(page.render(120).join("\n"), /Sandbox\s+On\s+On/);
        assert.equal(recorded.published.at(-1)?.permissions?.enabled, true);
        assert.equal(recorded.branch.length, 1);
    });
});

for (const verb of ["on", "off"] as const) test(`/sandbox ${verb} keeps enforcement unchanged when session persistence fails and retries durably`, async (t) => {
    forgetSandboxPreference();
    const initial = defaultSandboxPermissions();
    initial.main.enabled = verb === "off";
    initial.main.network = false;
    const recorded = record([sessionEntry({ version: 1, permissions: initial })]);
    piBetterSandbox(recorded.pi);
    const root = project(`command-append-failure-${verb}`);
    const started = await startSession(recorded, root, "resume", false, false);
    t.mock.method(started.ctx.ui, "confirm", async () => true);
    const before = structuredClone(recorded.published.at(-1));
    const history = structuredClone(recorded.branch);
    const append = t.mock.method(recorded.pi, "appendEntry", () => { throw new Error("session append failed"); });
    await runSandbox(recorded, verb, started.ctx);
    assert.deepEqual(recorded.published.at(-1), before);
    assert.deepEqual(recorded.branch, history);
    assert.equal(started.notifications.at(-1)?.kind, "error");
    assert.match(started.notifications.at(-1)?.text ?? "", /state unchanged.*session append failed/);
    const blocked = () => (recorded.handlers.get("tool_call")!({ toolName: "web_fetch", input: {} }, started.ctx) as { block: boolean } | undefined)?.block === true;
    assert.equal(blocked(), initial.main.enabled);
    await startSession(recorded, root, "reload", false, false);
    assert.equal(recorded.published.at(-1)?.permissions?.enabled, initial.main.enabled);
    assert.equal(blocked(), initial.main.enabled);
    append.mock.restore();
    await runSandbox(recorded, verb, started.ctx);
    assert.equal(recorded.published.at(-1)?.permissions?.enabled, !initial.main.enabled);
    assert.equal(blocked(), !initial.main.enabled);
    assert.equal(recorded.branch.length, history.length + 1);
    await startSession(recorded, root, "reload", false, false);
    assert.equal(recorded.published.at(-1)?.permissions?.enabled, !initial.main.enabled);
    assert.equal(blocked(), !initial.main.enabled);
    assert.equal(existsSync(permissionSettingsPath()), false);
    assert.equal(existsSync(sandboxPreferencesPath()), false);
});

test("session policy survives fresh extension resume, fork and reload; new sessions inherit saved defaults", async () => {
    forgetSandboxPreference();
    const initial = defaultSandboxPermissions();
    initial.main.enabled = true;
    initial.main.network = false;
    initial.subagents.enabled = false;
    initial.subagentTools = { applyPatch: false, trusted: [{ name: "helper", package: "npm:fixture" }] };
    const branch = [sessionEntry({ version: 1, permissions: initial })];
    const defaults = defaultSandboxPermissions();
    defaults.subagents.outsideProject = "off";
    writePermissionSettings(defaults);
    const root = project("session-reconstruction");
    for (const reason of ["resume", "fork", "reload"] as const) {
        const recorded = record(structuredClone(branch));
        piBetterSandbox(recorded.pi);
        await startSession(recorded, root, reason, false, false);
        assert.deepEqual(recorded.published.at(-1)?.permissions, initial.main, reason);
        assert.deepEqual(recorded.published.at(-1)?.subagentPermissions, initial.subagents, reason);
        assert.deepEqual(recorded.published.at(-1)?.subagentTools, initial.subagentTools, reason);
        assert.deepEqual(recorded.branch, branch, "restoring never appends an entry");
        await startSession(recorded, root, "new", false, false);
        assert.deepEqual(recorded.published.at(-1)?.permissions, defaults.main);
        assert.deepEqual(recorded.published.at(-1)?.subagentPermissions, defaults.subagents);
        assert.equal(recorded.branch.length, 0);
    }
});

test("tree navigation restores only the active branch's latest policy and its enabled switches", async () => {
    forgetSandboxPreference();
    forgetDenyOverride();
    const a = defaultSandboxPermissions();
    a.main.enabled = true;
    a.main.commands = false;
    const b = structuredClone(a);
    b.main.enabled = false;
    b.subagents.enabled = false;
    b.subagentTools.trusted = [];
    const ancestor = sessionEntry({ version: 1, permissions: a }, "ancestor");
    const child = sessionEntry({ version: 1, permissions: b }, "child", "ancestor");
    const recorded = record([ancestor, child]);
    piBetterSandbox(recorded.pi);
    const root = project("tree-session-policy");
    const started = await startSession(recorded, root, "resume", false);
    await runSandbox(recorded, "deny add build", started.ctx);
    const tree = recorded.handlers.get("session_tree")!;
    for (const [branch, expected] of [[[ancestor], a], [[ancestor, child], b], [[], defaultSandboxPermissions()]] as const) {
        recorded.branch = [...branch];
        await tree({ type: "session_tree", newLeafId: branch.at(-1)?.id ?? null, oldLeafId: "child" }, started.ctx);
        assert.deepEqual(recorded.published.at(-1)?.permissions, expected.main);
        assert.deepEqual(recorded.published.at(-1)?.subagentPermissions, expected.subagents);
        assert.deepEqual(recorded.published.at(-1)?.subagentTools, expected.subagentTools);
        assert.ok(recorded.published.at(-1)?.denyWrite.includes(join(root, "build")), "deny rules remain global");
        assert.deepEqual(recorded.branch, branch);
    }
});

test("invalid latest session policies fail closed on start and tree navigation rather than falling back", async () => {
    forgetSandboxPreference();
    const valid = defaultSandboxPermissions();
    const invalids = [undefined, { version: 2, permissions: valid }, { version: 1, permissions: { main: valid.main, subagents: valid.subagents } },
        { version: 1, permissions: { ...valid, main: { ...valid.main, network: "on" } } },
        { version: 1, permissions: { ...valid, subagentTools: { applyPatch: true, trusted: [{ name: "write", package: "npm:evil" }] } } }];
    const root = project("invalid-session-policy");
    for (const data of invalids) {
        const branch = [sessionEntry({ version: 1, permissions: valid }, "valid"), sessionEntry(data, "invalid", "valid")];
        const recorded = record(branch);
        piBetterSandbox(recorded.pi);
        const started = await startSession(recorded, root, "reload", false);
        assert.equal(recorded.published.at(-1)?.state, "failed");
        assert.deepEqual(recorded.published.at(-1)?.subagentTools?.trusted, []);
        assert.equal(recorded.published.at(-1)?.subagentPermissions?.commands, false);
        assert.ok(started.notifications.some((note) => note.kind === "error" && /could not be loaded/.test(note.text)));
        await assert.rejects(() => writeThrough(recorded.tools.get("write")!, "blocked.txt", "no"), /blocked rather than run unconfined/);
        await assert.rejects(() => recorded.tools.get("read")!.execute("read", { path: join(root, "blocked.txt") }, undefined, undefined, started.ctx), /blocked rather than run unconfined/);
        for (const toolName of ["bash", "subagent_spawn", "subagent_spawn_batch"]) {
            assert.equal((recorded.handlers.get("tool_call")!({ toolName, input: {} }, started.ctx) as { block: boolean }).block, true);
        }
        recorded.branch = [];
        await recorded.handlers.get("session_tree")!({}, started.ctx);
        assert.equal(recorded.published.at(-1)?.state, "disabled");
        recorded.branch = branch;
        await recorded.handlers.get("session_tree")!({}, started.ctx);
        assert.equal(recorded.published.at(-1)?.state, "failed");
        assert.equal(existsSync(join(root, "blocked.txt")), false);
    }
});

test("Ctrl+S alone saves global defaults; a failed save retains session edits and reload policy", async () => {
    forgetSandboxPreference();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("save-defaults-session");
    await startSession(recorded, root, "startup", false);
    await permissionsPage(recorded, root, async (page, press) => {
        await press("\x1b[C");
        await press(" "); // Disable Subagents, a loosening.
        assert.equal(existsSync(permissionSettingsPath()), false);
        const branch = structuredClone(recorded.branch);
        mkdirSync(permissionSettingsPath(), { recursive: true }); // Atomic rename cannot replace this directory.
        await press("\x13");
        assert.doesNotMatch(page.render(120).join("\n"), /Defaults saved/);
        assert.match(page.render(120).join("\n"), /EISDIR|ENOTEMPTY/);
        assert.deepEqual(recorded.branch, branch);
        assert.equal(recorded.published.at(-1)?.subagentPermissions?.enabled, false);
        const restored = record(structuredClone(branch));
        piBetterSandbox(restored.pi);
        await startSession(restored, root, "reload", false, false);
        assert.equal(restored.published.at(-1)?.subagentPermissions?.enabled, false, "valid session policy does not read broken global defaults");
        rmSync(permissionSettingsPath(), { recursive: true });
        await press("\x13");
        assert.match(page.render(120).join("\n"), /Defaults saved\. Looser: Subagents: sandbox off/);
        assert.deepEqual(recorded.branch, branch, "saving defaults does not alter session history");
    });
    const next = record();
    piBetterSandbox(next.pi);
    await startSession(next, root, "new", false, false);
    assert.equal(next.published.at(-1)?.subagentPermissions?.enabled, false);
    assert.equal(existsSync(sandboxPreferencesPath()), false, "Ctrl+S does not overwrite the legacy activation preference");
});

test("an unknown /sandbox subcommand explains the usage instead of changing state", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("bad-subcommand");
    await startSession(recorded, root);

    const shown = context(root);
    await recorded.commands.get("sandbox")?.handler("disable", shown.ctx);

    assert.equal(shown.notifications.at(-1)?.kind, "error");
    assert.match(shown.notifications.at(-1)?.text ?? "", /Unknown \/sandbox subcommand/);
    assert.match(shown.notifications.at(-1)?.text ?? "", /\/sandbox deny add <path>/);
    assert.equal(recorded.published.at(-1)?.state, "enabled");

    const badAction = context(root);
    await recorded.commands.get("sandbox")?.handler("deny purge", badAction.ctx);
    assert.equal(badAction.notifications.at(-1)?.kind, "error");
    assert.match(badAction.notifications.at(-1)?.text ?? "", /Unknown \/sandbox deny action/);
});

test("pi loads the published entry point and registers the same surface", async () => {
    // Pi's own loader, pointed at an empty cwd and agent dir so nothing but this
    // package's entry point is discovered.
    const isolated = project("loader-cwd");
    const agentDir = project("loader-agent-dir");
    const result = await discoverAndLoadExtensions(
        [join(packageRoot, "index.ts")],
        isolated,
        agentDir,
    );

    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.ok(extension);
    assert.deepEqual([...extension.tools.keys()].sort(), ["bash", "edit", "process_list", "read", "write"]);
    assert.deepEqual([...extension.commands.keys()], ["sandbox"]);
    assert.ok(extension.handlers.has("session_start"));
    assert.ok(extension.handlers.has("user_bash"));
});

test("the manifest entry points load an extension without a launcher executable", async () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
        pi: { extensions: string[] }; bin?: unknown;
    };
    assert.equal("bin" in manifest, false, "users invoke ordinary pi; this package ships no binary");
    const result = await discoverAndLoadExtensions(
        manifest.pi.extensions.map((entry) => join(packageRoot, entry)),
        project("manifest-cwd"), project("manifest-agent"),
    );
    assert.deepEqual(result.errors, []);
    assert.ok(result.extensions.some((extension) => extension.commands.has("sandbox")),
        "the declared entry points must actually register the sandbox");
});

// --- write-deny rules -------------------------------------------------------
//
// These drive the registrations pi actually loads: the same `/sandbox` command
// object, and the same `write`/`edit` tool objects, before and after a rule
// changes. Nothing is re-registered in between, which is the point.

async function runSandbox(
    recorded: Recorded,
    args: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    await recorded.commands.get("sandbox")?.handler(args, ctx);
}

function writeThrough(tool: ToolDefinition, path: string, content: string): Promise<unknown> {
    return (tool as ToolDefinition<never>).execute(
        `call-${Math.random()}`,
        { path, content } as never,
        undefined,
        undefined,
        {} as ExtensionContext,
    );
}

function editThrough(
    tool: ToolDefinition,
    path: string,
    oldText: string,
    newText: string,
): Promise<unknown> {
    return (tool as ToolDefinition<never>).execute(
        `call-${Math.random()}`,
        { path, edits: [{ oldText, newText }] } as never,
        undefined,
        undefined,
        {} as ExtensionContext,
    );
}

test("installing the extension materializes no settings file", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    await startSession(recorded, project("no-settings-file"));


    assert.equal(
        existsSync(denyRuleOverridePath()),
        false,
        "a fresh install plus a session start must not write a settings file",
    );
    const root = recorded.published.at(-1)?.projectRoot ?? "";
    assertProtectedPolicy(recorded, root);
});

test("/sandbox deny list shows the packaged defaults as canonical absolute paths", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("deny-list");
    await startSession(recorded, root);

    const shown = context(root);
    await runSandbox(recorded, "deny list", shown.ctx);

    const listing = shown.notifications.at(-1)?.text ?? "";
    assert.match(listing, /no override has been created/);
    for (const template of PACKAGED_DENY_WRITE_TEMPLATES) {
        assert.ok(listing.includes(join(root, template)), `${template} must be shown absolutely`);
    }
    assert.equal(existsSync(denyRuleOverridePath()), false, "listing must not create an override");
});

kernelTest("a new deny rule reaches the write and edit tools pi already holds", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("deny-reaches-files");
    await startSession(recorded, root);

    // The exact objects pi is holding. Nothing below re-registers a tool.
    const write = recorded.tools.get("write") as ToolDefinition;
    const edit = recorded.tools.get("edit") as ToolDefinition;

    await writeThrough(write, "build/first.txt", "one\n");
    assert.equal(readFileSync(join(root, "build", "first.txt"), "utf8"), "one\n");

    const shown = context(root);
    await runSandbox(recorded, "deny add build", shown.ctx);
    assert.equal(shown.notifications.at(-1)?.kind, "info");
    assert.ok((shown.notifications.at(-1)?.text ?? "").includes(join(root, "build")));

    assert.equal(recorded.tools.get("write"), write, "no re-registration may have happened");
    assert.equal(recorded.tools.get("edit"), edit, "no re-registration may have happened");

    await assert.rejects(
        () => writeThrough(write, "build/second.txt", "two\n"),
        /write-denied/,
    );
    assert.equal(existsSync(join(root, "build", "second.txt")), false);
    await assert.rejects(
        () => editThrough(edit, "build/first.txt", "one", "two"),
        /write-denied/,
    );
    assert.equal(readFileSync(join(root, "build", "first.txt"), "utf8"), "one\n");

    // The published policy — what background tasks and subagents read — agrees.
    assert.ok(recorded.published.at(-1)?.denyWrite.includes(join(root, "build")));

    // And removing the rule lets the next mutation through, same tool object.
    await runSandbox(recorded, "deny remove build", shown.ctx);
    await writeThrough(write, "build/third.txt", "three\n");
    assert.equal(readFileSync(join(root, "build", "third.txt"), "utf8"), "three\n");
});

kernelTest("a deny rule denies a whole subtree, and a file rule only that file", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("deny-shapes");
    await startSession(recorded, root);
    const write = recorded.tools.get("write") as ToolDefinition;
    const shown = context(root);

    await runSandbox(recorded, "deny add secrets", shown.ctx);
    await runSandbox(recorded, "deny add notes.txt", shown.ctx);

    // A directory rule reaches arbitrarily deep, including paths that do not
    // exist yet.
    await assert.rejects(() => writeThrough(write, "secrets/a/b/c.txt", "x\n"), /write-denied/);
    assert.equal(existsSync(join(root, "secrets")), false);
    // A file rule denies exactly that file and nothing beside it.
    await assert.rejects(() => writeThrough(write, "notes.txt", "x\n"), /write-denied/);
    await writeThrough(write, "notes.txt.bak", "fine\n");
    assert.equal(readFileSync(join(root, "notes.txt.bak"), "utf8"), "fine\n");
});

kernelTest("a new deny rule preserves completed writes and blocks subsequent mutations", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("mid-flight-rule");
    await startSession(recorded, root);
    const write = recorded.tools.get("write") as ToolDefinition;
    const shown = context(root);

    await writeThrough(write, "reports/summary.txt", "done\n");
    await runSandbox(recorded, "deny add reports", shown.ctx);

    // The mutation that had already completed is untouched by the new rule; the
    // next one, launched after the change, is refused.
    assert.equal(readFileSync(join(root, "reports", "summary.txt"), "utf8"), "done\n");
    await assert.rejects(() => writeThrough(write, "reports/next.txt", "no\n"), /write-denied/);
    assert.equal(existsSync(join(root, "reports", "next.txt")), false);
});

test("deny reset drops the override and restores the packaged defaults", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("deny-reset");
    await startSession(recorded, root);
    const confirming = context(root, { confirm: true });

    await runSandbox(recorded, "deny add build", confirming.ctx);
    await runSandbox(recorded, "deny remove .env", confirming.ctx);
    assert.equal(existsSync(denyRuleOverridePath()), true);

    await runSandbox(recorded, "deny reset", confirming.ctx);

    assert.equal(existsSync(denyRuleOverridePath()), false);
    assertProtectedPolicy(recorded, root);
});

test("deny reset is confirmed first, and declining keeps the rules", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("deny-reset-declined");
    await startSession(recorded, root);

    await runSandbox(recorded, "deny add build", context(root, { confirm: true }).ctx);

    const declining = context(root, { confirm: false });
    await runSandbox(recorded, "deny reset", declining.ctx);

    assert.equal(declining.confirmations.length, 1);
    assert.match(declining.notifications.at(-1)?.text ?? "", /left as they are/);
    assert.ok(recorded.published.at(-1)?.denyWrite.includes(join(root, "build")));
});

test("a refused rule change explains itself and leaves the policy alone", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("deny-refusals");
    await startSession(recorded, root);
    const before = [...(recorded.published.at(-1)?.denyWrite ?? [])];
    const shown = context(root);

    const refusals: Array<[string, RegExp]> = [
        ["deny add .env", /already write-denied|already denies/],
        ["deny add .git/hooks/pre-commit", /already inside the write-denied directory/],
        ["deny add .git", /Remove that rule first/],
        ["deny add .", /would make every write in the project fail/],
        ["deny add *.pem", /concrete paths, not patterns/],
        ["deny remove nope", /is not a write-deny rule/],
        ["deny add", /needs a path/],
        ["deny remove", /needs a path/],
    ];
    for (const [args, expected] of refusals) {
        await runSandbox(recorded, args, shown.ctx);
        assert.equal(shown.notifications.at(-1)?.kind, "error", args);
        assert.match(shown.notifications.at(-1)?.text ?? "", expected, args);
    }

    assert.deepEqual([...(recorded.published.at(-1)?.denyWrite ?? [])], before);
    assert.equal(existsSync(denyRuleOverridePath()), false, "a refused change writes nothing");
});

test("a relative rule added in one project applies to the same relative path in the next", async () => {
    forgetDenyOverride();
    const first = record();
    piBetterSandbox(first.pi);
    const firstRoot = project("cross-project-a");
    await startSession(first, firstRoot);
    await runSandbox(first, "deny add config/keys", context(firstRoot).ctx);

    // A different pi session, a different project, the same global rule set.
    const second = record();
    piBetterSandbox(second.pi);
    const secondRoot = project("cross-project-b");
    await startSession(second, secondRoot);

    assert.ok(second.published.at(-1)?.denyWrite.includes(join(secondRoot, "config/keys")));
    await assert.rejects(
        () => writeThrough(second.tools.get("write") as ToolDefinition, "config/keys/id", "x\n"),
        /write-denied/,
    );
});

test("/sandbox rules adds, removes, and restores through the same module", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("rules-page");
    await startSession(recorded, root);

    // Add: pick the add action, type a path, then escape out of the page. The
    // page loops, so the script has to close it on the second pass.
    let addPasses = 0;
    const addingCtx = context(root, {
        select: (_title, options) =>
            (addPasses += 1) === 1 ? options.find((option) => option.startsWith("+")) : undefined,
        input: () => "build/artifacts",
    });
    await runSandbox(recorded, "rules", addingCtx.ctx);

    assert.equal(addingCtx.prompts.length, 1);
    assert.ok(recorded.published.at(-1)?.denyWrite.includes(join(root, "build/artifacts")));
    // The page shows canonical absolute paths.
    assert.ok(
        addingCtx.selections[0]?.options.some((option) => option.startsWith(join(root, ".env"))),
    );
    assert.match(addingCtx.selections[0]?.title ?? "", /write-denied paths · rules-page/);

    // Remove: pick that rule's row, confirm.
    let removePasses = 0;
    const removing = context(root, {
        confirm: true,
        select: (_title, options) =>
            (removePasses += 1) === 1
                ? options.find((option) => option.startsWith(join(root, "build/artifacts")))
                : undefined,
    });
    await runSandbox(recorded, "rules", removing.ctx);

    assert.equal(removing.confirmations.length, 1);
    assert.equal(
        recorded.published.at(-1)?.denyWrite.includes(join(root, "build/artifacts")),
        false,
    );

    // Restore defaults: the override exists (a default was never removed, but a
    // rule was added and removed), so restoring deletes it.
    let restorePasses = 0;
    const restoring = context(root, {
        confirm: true,
        select: (_title, options) =>
            (restorePasses += 1) === 1 ? options.find((option) => option.startsWith("↺")) : undefined,
    });
    await runSandbox(recorded, "rules", restoring.ctx);

    assert.equal(existsSync(denyRuleOverridePath()), false);
    assertProtectedPolicy(recorded, root);
});

test("/sandbox rules keeps the page open and the policy intact when a change is refused", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("rules-page-refusal");
    await startSession(recorded, root);
    const before = [...(recorded.published.at(-1)?.denyWrite ?? [])];

    let passes = 0;
    const shown = context(root, {
        select: (_title, options) => (passes += 1) <= 2 ? options.find((o) => o.startsWith("+")) : undefined,
        input: () => ".env",
    });
    await runSandbox(recorded, "rules", shown.ctx);

    // Two attempts, two refusals, three selector passes: the page stayed open.
    assert.equal(shown.prompts.length, 2);
    assert.equal(shown.selections.length, 3);
    assert.equal(shown.notifications.at(-1)?.kind, "error");
    assert.deepEqual([...(recorded.published.at(-1)?.denyWrite ?? [])], before);
});

test("/sandbox rules is refused without an interactive UI", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("rules-page-headless");
    await startSession(recorded, root);

    const headless = context(root, { hasUI: false });
    await runSandbox(recorded, "rules", headless.ctx);

    assert.equal(headless.selections.length, 0);
    assert.equal(headless.notifications.at(-1)?.kind, "error");
    assert.equal(headless.notifications.at(-1)?.text, RULES_PAGE_NO_UI_REJECTION);
});

test("rule management is reachable only from the slash command, never from a tool", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("human-only-rules");
    await startSession(recorded, root);
    const before = [...(recorded.published.at(-1)?.denyWrite ?? [])];

    // The whole registered tool surface is pi's own built-ins, overridden. There
    // is nothing here the model could call to read or change a rule.
    assert.deepEqual([...recorded.tools.keys()].sort(), ["bash", "edit", "process_list", "read", "write"]);
    assert.deepEqual([...recorded.commands.keys()], ["sandbox"]);

    // Nor can the events contract be used to push a rule set in: publishing a
    // doctored policy changes nothing, and the request channel only re-publishes.
    recorded.events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, {
        state: "enabled",
        denyWrite: [],
        projectRoot: root,
    });
    recorded.events.emit(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, undefined);

    assert.deepEqual([...(recorded.published.at(-1)?.denyWrite ?? [])], before);
    assert.equal(existsSync(denyRuleOverridePath()), false);
});

test("session restore retains activation overrides and re-reads global deny rules", async () => {
    forgetDenyOverride();
    forgetSandboxPreference();
    writeSandboxDefault("on");
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("rules-across-sessions");
    await startSession(recorded, root, "startup", false, false);
    await runSandbox(recorded, "deny add build", context(root).ctx);

    for (const reason of ["new", "resume", "fork", "reload"] as const) {
        await runSandbox(recorded, "off", context(root, { confirm: true }).ctx);
        assert.equal(recorded.published.at(-1)?.state, "disabled");

        await startSession(recorded, root, reason, false, false);

        const policy = recorded.published.at(-1);
        assert.equal(policy?.state, reason === "new" ? "enabled" : "disabled", `activation after ${reason}`);
        assert.ok(
            policy?.denyWrite.includes(join(root, "build")),
            `the rules are re-read after ${reason}`,
        );
    }
});

test("a stored rule that cannot apply here is shown as such, never as protection", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("inert-rule");
    // Legitimately added while a project one level up was open. Here it contains
    // the project root, so applying it would make every write fail.
    mkdirSync(dirname(denyRuleOverridePath()), { recursive: true });
    writeFileSync(
        denyRuleOverridePath(),
        JSON.stringify({ version: 1, denyWrite: [".env", dirname(root)] }),
    );

    const started = await startSession(recorded, root);

    // Held out of the effective policy, and said out loud at session start.
    assertProtectedPolicy(recorded, root, [".env"]);
    assert.ok(
        started.notifications.some(
            (note) => note.kind === "warning" && note.text.includes("is not applied in this project"),
        ),
    );

    // `deny list` says the same thing.
    const shown = context(root);
    await runSandbox(recorded, "deny list", shown.ctx);
    const listing = shown.notifications.at(-1)?.text ?? "";
    assert.match(listing, /Not applied in this project:/);
    assert.ok(listing.includes(dirname(root)));

    // And the page offers it as a row a human can delete, rather than hiding it.
    let passes = 0;
    const page = context(root, {
        confirm: true,
        select: (_title, options) =>
            (passes += 1) === 1
                ? options.find((option) => option.includes("(not applied in this project)"))
                : undefined,
    });
    await runSandbox(recorded, "rules", page.ctx);

    assert.match(page.confirmations.at(-1) ?? "", /Delete this rule from your global rule set/);
    assert.deepEqual(
        JSON.parse(readFileSync(denyRuleOverridePath(), "utf8")).denyWrite,
        [".env"],
    );
});

test("saved permissions reach file tools, command gates, and consumer snapshots", async () => {
    forgetSandboxPreference();
    const settings = defaultSandboxPermissions();
    settings.main.enabled = true;
    settings.main.projectFiles = "off";
    settings.main.commands = false;
    settings.main.network = false;
    settings.subagents.outsideProject = "off";
    writePermissionSettings(settings);
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("permission-gates");
    const file = join(root, "private.txt");
    writeFileSync(file, "must not be read");
    const started = await startSession(recorded, root, "startup", false, false);
    const policy = recorded.published.at(-1);
    assert.equal(policy?.permissions?.projectFiles, "off");
    assert.equal(policy?.subagentPermissions?.outsideProject, "off");
    await assert.rejects(async () => recorded.tools.get("read")!.execute("read", { path: file }, undefined, undefined, started.ctx), /refused to read/);
    await assert.rejects(() => writeThrough(recorded.tools.get("write")!, file, "changed"), /permission-denied/);
    assert.equal(readFileSync(file, "utf8"), "must not be read");
    const call = recorded.handlers.get("tool_call")!;
    assert.deepEqual(call({ toolName: "bash", input: { command: "true" } }, started.ctx), {
        block: true, reason: "Sandbox: Run commands & applications is Off. Change it in /sandbox to launch work.",
    });
    assert.deepEqual(call({ toolName: "web_fetch", input: {} }, started.ctx), { block: true, reason: "Sandbox: Network access is Off." });
    await recorded.commands.get("sandbox")!.handler("off", context(root, { confirm: true }).ctx);
    assert.equal(call({ toolName: "bash", input: { command: "true" } }, started.ctx), undefined);
    forgetSandboxPreference();
});

test("Process access remains Off even when Main confinement is inactive", async () => {
    forgetSandboxPreference();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const started = await startSession(recorded, project("process-off"), "startup", false, false);
    assert.equal(recorded.published.at(-1)?.permissions?.processAccess, "off");
    await assert.rejects(() => recorded.tools.get("process_list")!.execute("process-off", {}, undefined, undefined, started.ctx), /Process access is Off/);
});

test("completions cover activation defaults and deny actions", () => {
    assert.deepEqual(
        sandboxArgumentCompletions("").map((entry) => entry.value),
        ["on", "off", "default", "deny", "rules"],
    );
    assert.deepEqual(
        sandboxArgumentCompletions("de").map((entry) => entry.value),
        ["default", "deny"],
    );
    assert.deepEqual(
        sandboxArgumentCompletions("default ").map((entry) => entry.value),
        ["default on", "default off"],
    );
    assert.deepEqual(
        sandboxArgumentCompletions("deny ").map((entry) => entry.value),
        ["deny list", "deny add", "deny remove", "deny reset"],
    );
    assert.deepEqual(
        sandboxArgumentCompletions("deny re").map((entry) => entry.value),
        ["deny remove", "deny reset"],
    );
    assert.deepEqual(sandboxArgumentCompletions("on"), [
        {
            value: "on",
            label: "on",
            description: "Enable confinement for this session",
        },
    ]);
    assert.equal(
        sandboxArgumentCompletions("deny add")[0]?.description,
        "Add a write-denied path",
    );
});
