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
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
    createEditToolDefinition,
    createWriteToolDefinition,
    discoverAndLoadExtensions,
    getAgentDir,
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
import { sandboxArgumentCompletions } from "../commands.ts";
import { denyRuleOverridePath } from "../deny-rules.ts";
import { PACKAGED_DENY_WRITE_TEMPLATES } from "../policy.ts";
import { RULES_PAGE_NO_UI_REJECTION } from "../rules-page.ts";
import {
    FOREGROUND_SANDBOX_POLICY_CHANNEL,
    FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
    type ForegroundSandboxPolicyEvent,
} from "../events.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-sandbox-extension-")));
after(() => rmSync(fixtures, { recursive: true, force: true }));

// The extension reads its write-deny override out of the pi agent directory.
// Redirecting that directory into a disposable fixture is what keeps every test
// below off the developer's real ~/.pi state, including the ones that drive pi's
// own extension loader.
const agentDir = realpathSync(mkdtempSync(join(realpathSync("/var/tmp"), "pi-better-sandbox-agent-")));
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

type ContextOptions = {
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
    assert.deepEqual(
        [...(recorded.published.at(-1)?.denyWrite ?? [])],
        [join(root, ".env"), join(root, ".env.local"), join(root, ".git/hooks")],
    );
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

test("a new deny rule reaches the write and edit tools pi already holds", async () => {
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
        /is a write-denied path/,
    );
    assert.equal(existsSync(join(root, "build", "second.txt")), false);
    await assert.rejects(
        () => editThrough(edit, "build/first.txt", "one", "two"),
        /is a write-denied path/,
    );
    assert.equal(readFileSync(join(root, "build", "first.txt"), "utf8"), "one\n");

    // The published policy — what background tasks and subagents read — agrees.
    assert.ok(recorded.published.at(-1)?.denyWrite.includes(join(root, "build")));

    // And removing the rule lets the next mutation through, same tool object.
    await runSandbox(recorded, "deny remove build", shown.ctx);
    await writeThrough(write, "build/third.txt", "three\n");
    assert.equal(readFileSync(join(root, "build", "third.txt"), "utf8"), "three\n");
});

test("a deny rule denies a whole subtree, and a file rule only that file", async () => {
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

test("a rule change applies to the next mutation, not to the one pi is already running", async () => {
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
    assert.deepEqual(
        [...(recorded.published.at(-1)?.denyWrite ?? [])],
        [join(root, ".env"), join(root, ".env.local"), join(root, ".git/hooks")],
    );
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
    assert.deepEqual(
        [...(recorded.published.at(-1)?.denyWrite ?? [])],
        [join(root, ".env"), join(root, ".env.local"), join(root, ".git/hooks")],
    );
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
    assert.deepEqual([...recorded.tools.keys()].sort(), ["bash", "edit", "write"]);
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

test("every session start re-reads the rules, while the off state never survives", async () => {
    forgetDenyOverride();
    const recorded = record();
    piBetterSandbox(recorded.pi);
    const root = project("rules-across-sessions");
    await startSession(recorded, root);
    await runSandbox(recorded, "deny add build", context(root).ctx);

    for (const reason of ["new", "resume", "fork", "reload"] as const) {
        await runSandbox(recorded, "off", context(root, { confirm: true }).ctx);
        assert.equal(recorded.published.at(-1)?.state, "disabled");

        await startSession(recorded, root, reason);

        const policy = recorded.published.at(-1);
        assert.equal(policy?.state, "enabled", `protection is re-armed after ${reason}`);
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
    assert.deepEqual([...(recorded.published.at(-1)?.denyWrite ?? [])], [join(root, ".env")]);
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

test("completions cover the subcommands and the deny actions", () => {
    assert.deepEqual(
        sandboxArgumentCompletions("").map((entry) => entry.value),
        ["on", "off", "deny", "rules"],
    );
    assert.deepEqual(
        sandboxArgumentCompletions("de").map((entry) => entry.value),
        ["deny"],
    );
    assert.deepEqual(
        sandboxArgumentCompletions("deny ").map((entry) => entry.value),
        ["deny list", "deny add", "deny remove", "deny reset"],
    );
    assert.deepEqual(
        sandboxArgumentCompletions("deny re").map((entry) => entry.value),
        ["deny remove", "deny reset"],
    );
});
