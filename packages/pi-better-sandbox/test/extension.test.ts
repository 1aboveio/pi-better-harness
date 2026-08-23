import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
    createEditToolDefinition,
    createWriteToolDefinition,
    discoverAndLoadExtensions,
} from "@earendil-works/pi-coding-agent";
import type {
    EventBus,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    RegisteredCommand,
    SessionStartEvent,
    ToolDefinition,
    UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

import piBetterSandbox from "../index.ts";
import {
    FOREGROUND_SANDBOX_POLICY_CHANNEL,
    FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
    type ForegroundSandboxPolicyEvent,
} from "../events.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-sandbox-extension-")));
after(() => rmSync(fixtures, { recursive: true, force: true }));

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
    published: ForegroundSandboxPolicyEvent[];
    events: EventBus;
};

/** A recorder shaped like Pi's ExtensionAPI, driving the real extension factory. */
function record(): Recorded {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
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

    const pi = {
        events,
        registerTool(tool: ToolDefinition) {
            tools.set(tool.name, tool);
        },
        registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
            commands.set(name, command);
        },
        on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
            handlers.set(event, handler);
        },
    } as unknown as ExtensionAPI;

    return { pi, tools, commands, handlers, published, events };
}

type UiCall = { kind: string; text: string };

function context(cwd: string, options: { hasUI?: boolean; confirm?: boolean } = {}) {
    const notifications: UiCall[] = [];
    const statuses: Array<string | undefined> = [];
    const confirmations: string[] = [];
    const ctx = {
        cwd,
        hasUI: options.hasUI ?? true,
        mode: "tui",
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
        },
    } as unknown as ExtensionCommandContext;
    return { ctx, notifications, statuses, confirmations };
}

async function startSession(
    recorded: Recorded,
    cwd: string,
    reason: SessionStartEvent["reason"] = "startup",
) {
    const started = context(cwd);
    const handler = recorded.handlers.get("session_start");
    assert.ok(handler, "the extension must handle session_start");
    await handler({ type: "session_start", reason }, started.ctx);
    return started;
}

test("the extension registers the built-in overrides, user_bash routing, and the sandbox command", () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);

    assert.deepEqual([...recorded.tools.keys()], ["bash", "write", "edit"]);
    assert.ok(recorded.handlers.has("user_bash"));
    assert.ok(recorded.handlers.has("session_start"));
    assert.deepEqual([...recorded.commands.keys()], ["sandbox"]);
});

test("no tool can read or change sandbox state, so the model cannot disable its own sandbox", () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);

    // Every registered tool is an override of a pi built-in the model already
    // had; sandbox control lives in a slash command, which the model cannot call.
    assert.deepEqual([...recorded.tools.keys()].sort(), ["bash", "edit", "write"]);
});

test("the write and edit overrides keep pi's own schemas, prompt guidance and renderers", () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);

    const builtIn = {
        write: createWriteToolDefinition(process.cwd()),
        edit: createEditToolDefinition(process.cwd()),
    };
    for (const name of ["write", "edit"] as const) {
        const override = recorded.tools.get(name);
        assert.ok(override, `${name} must be overridden`);
        assert.equal(override.description, builtIn[name].description);
        assert.equal(override.promptSnippet, builtIn[name].promptSnippet);
        assert.deepEqual(override.promptGuidelines, builtIn[name].promptGuidelines);
        assert.deepEqual(override.parameters, builtIn[name].parameters);
        assert.equal(typeof override.renderCall, "function");
        assert.equal(typeof override.renderResult, "function");
    }
});

test("a session with a different cwd re-registers the file tools against that cwd", async () => {
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

test("the bash override keeps pi's own schema, description and renderers", () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const bash = recorded.tools.get("bash");

    assert.ok(bash);
    assert.equal(bash.name, "bash");
    assert.ok("command" in (bash.parameters as { properties: Record<string, unknown> }).properties);
    assert.equal(typeof bash.renderCall, "function");
    assert.equal(typeof bash.renderResult, "function");
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

test("every session start publishes an enabled policy and paints the footer", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("lifecycle");

    for (const reason of ["startup", "new", "resume", "fork", "reload"] as const) {
        const started = await startSession(recorded, root, reason);
        const policy = recorded.published.at(-1);
        assert.equal(policy?.state, "enabled", `state after ${reason}`);
        assert.equal(policy?.projectRoot, root);
        assert.equal(started.statuses.at(-1), `sandbox · on · ${"lifecycle"}`);
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
    });
    assert.throws(() => {
        (policy.denyWrite as string[]).push("/etc/passwd");
    });
});

test("/sandbox reports the effective status without changing it", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("report");
    await startSession(recorded, root);
    const publishedBefore = recorded.published.length;

    const shown = context(root);
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

test("an off state never survives the next session start", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("no-persist");
    await startSession(recorded, root);
    await recorded.commands.get("sandbox")?.handler("off", context(root, { confirm: true }).ctx);
    assert.equal(recorded.published.at(-1)?.state, "disabled");

    await startSession(recorded, root, "resume");

    assert.equal(recorded.published.at(-1)?.state, "enabled");
});

test("an unknown /sandbox subcommand explains the usage instead of changing state", async () => {
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("bad-subcommand");
    await startSession(recorded, root);

    const shown = context(root);
    await recorded.commands.get("sandbox")?.handler("deny add /etc", shown.ctx);

    assert.equal(shown.notifications.at(-1)?.kind, "error");
    assert.match(shown.notifications.at(-1)?.text ?? "", /Unknown \/sandbox subcommand/);
    assert.equal(recorded.published.at(-1)?.state, "enabled");
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
    assert.deepEqual([...extension.tools.keys()], ["bash", "write", "edit"]);
    assert.deepEqual([...extension.commands.keys()], ["sandbox"]);
    assert.ok(extension.handlers.has("session_start"));
    assert.ok(extension.handlers.has("user_bash"));
});

test("the package ships an extension entry point and no launcher executable", () => {
    const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;

    assert.deepEqual(manifest.pi, { extensions: ["./index.ts"] });
    assert.equal("bin" in manifest, false, "users invoke ordinary pi; this package ships no binary");
    assert.equal(existsSync(join(packageRoot, "index.ts")), true);
});
