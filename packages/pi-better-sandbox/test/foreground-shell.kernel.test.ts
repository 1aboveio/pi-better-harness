/**
 * Real-kernel proof for the foreground shell path.
 *
 * These drive the extension's own registrations against a real backend and real
 * disposable fixtures. Nothing here asserts on a generated profile or a wrapper
 * argv: every check is a syscall the kernel either allowed or refused.
 *
 * Fixture placement is load-bearing. The macOS profile always allows
 * /private/var/folders and /private/tmp (pi needs them), and `os.tmpdir()` on
 * macOS lives under /private/var/folders — so an "outside" probe there would
 * false-pass. The Linux backend likewise bind-mounts /tmp read-write. Both the
 * project root and the outside probe therefore live under var/tmp, which
 * neither backend's blanket allowances cover.
 *
 * The same scenarios run on both backends. On Linux they need bubblewrap on
 * PATH; without a backend the whole file skips with a reason rather than
 * pretending to have proved anything.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before } from "node:test";

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    RegisteredCommand,
    ToolDefinition,
    UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";

import { describeSandboxSupport } from "../shared-sandbox-core.ts";

import piBetterSandbox from "../index.ts";
import { createSandboxedBashOperations } from "../shell.ts";
import { ForegroundSandboxController } from "../state.ts";

const support = describeSandboxSupport();
const backendAvailable = support.supported;
const skip = backendAvailable ? false : `requires a real sandbox backend: ${support.reason}`;
const macOSOnly = support.backend === "macos-seatbelt" ? false : "macOS Seatbelt profiles only";

// Not under any always-allowed prefix on either backend, so a denied write here
// is a real denial and not an artefact of where the fixture happens to live.
const fixtures = realpathSync(mkdtempSync(join(realpathSync("/var/tmp"), "pi-better-sandbox-kernel-")));
const projectRoot = join(fixtures, "project");
const outside = join(fixtures, "outside");
mkdirSync(projectRoot, { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(join(projectRoot, ".git", "hooks"), { recursive: true });
writeFileSync(join(projectRoot, ".env"), "SECRET=original\n");
writeFileSync(join(projectRoot, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
writeFileSync(join(outside, "readable.txt"), "readable from inside the sandbox\n");
symlinkSync(outside, join(projectRoot, "escape-hatch"));

// The extension reads its write-deny override out of the pi agent directory.
// Redirecting that directory into the fixture tree is what keeps this file off
// the developer's real ~/.pi state. (`PI_CODING_AGENT_DIR` is the name pi's own
// `getAgentDir()` reads.)
const agentDir = join(fixtures, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
assert.equal(getAgentDir(), agentDir, "the pi agent directory must be redirected for these tests");

const originalCwd = process.cwd();
after(() => {
    process.chdir(originalCwd);
    rmSync(fixtures, { recursive: true, force: true });
});

const tools = new Map<string, ToolDefinition>();
const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
const statuses: Array<string | undefined> = [];

const ctx = {
    cwd: projectRoot,
    hasUI: true,
    mode: "tui",
    model: { provider: "test-provider", id: "test-model" },
    thinkingLevel: "off",
    sessionManager: {
        getSessionId: () => "kernel-session",
        getSessionFile: () => join(fixtures, "kernel-session.jsonl"),
    },
    ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: () => undefined,
        setStatus: (_key: string, text: string | undefined) => statuses.push(text),
        confirm: async () => true,
    },
} as unknown as ExtensionCommandContext;

before(async () => {
    if (!backendAvailable) return;
    // The bash tool binds its cwd when the extension factory runs, exactly as it
    // does when pi is launched from a project directory.
    process.chdir(projectRoot);
    const pi = {
        events: { emit: () => undefined, on: () => () => undefined },
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
            commands.set(name, command),
        on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
            handlers.set(event, handler),
    } as unknown as ExtensionAPI;

    piBetterSandbox(pi);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
});

type Outcome = { ok: true; text: string } | { ok: false; message: string };

async function runBash(
    command: string,
    options: { timeout?: number; signal?: AbortSignal; onUpdate?: (update: unknown) => void } = {},
): Promise<Outcome> {
    const bash = tools.get("bash");
    assert.ok(bash, "the extension must register a bash tool");
    const params = options.timeout === undefined ? { command } : { command, timeout: options.timeout };
    try {
        const result = await bash.execute(
            `call-${Math.random()}`,
            params,
            options.signal,
            options.onUpdate as never,
            ctx,
        );
        const first = result.content[0];
        return { ok: true, text: first && first.type === "text" ? first.text : "" };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}

async function setSandbox(state: "on" | "off"): Promise<void> {
    await commands.get("sandbox")?.handler(state, ctx);
}

test("a write inside the project root succeeds", { skip }, async () => {
    const target = join(projectRoot, "allowed.txt");
    const result = await runBash(`printf 'inside\\n' > ${JSON.stringify(target)}`);

    assert.equal(result.ok, true, result.ok ? "" : result.message);
    assert.equal(readFileSync(target, "utf8"), "inside\n");
});

test("a write outside the project root is refused and leaves no host artifact", { skip }, async () => {
    const target = join(outside, "leaked.txt");
    const result = await runBash(`printf 'leak\\n' > ${JSON.stringify(target)}`);

    assert.equal(result.ok, false, "the write must not report success");
    assert.equal(existsSync(target), false, "no file may appear outside the project root");
});

test("a packaged denied file cannot be replaced from inside the project root", { skip }, async () => {
    const target = join(projectRoot, ".env");
    const result = await runBash(`printf 'STOLEN=1\\n' > ${JSON.stringify(target)}`);

    assert.equal(result.ok, false);
    assert.equal(readFileSync(target, "utf8"), "SECRET=original\n");
});

test("a packaged denied subtree cannot be written, renamed into, or deleted", { skip }, async () => {
    const hook = join(projectRoot, ".git", "hooks", "pre-commit");
    const added = join(projectRoot, ".git", "hooks", "post-commit");
    const staged = join(projectRoot, "staged-hook");
    writeFileSync(staged, "#!/bin/sh\necho pwned\n");

    const overwrite = await runBash(`printf 'echo pwned\\n' > ${JSON.stringify(hook)}`);
    const create = await runBash(`printf 'echo pwned\\n' > ${JSON.stringify(added)}`);
    const rename = await runBash(`mv ${JSON.stringify(staged)} ${JSON.stringify(added)}`);
    const remove = await runBash(`rm -f ${JSON.stringify(hook)}`);

    assert.equal(overwrite.ok, false);
    assert.equal(create.ok, false);
    assert.equal(rename.ok, false);
    assert.equal(remove.ok, false);
    assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\nexit 0\n");
    assert.equal(existsSync(added), false);
    assert.equal(existsSync(staged), true);
});

test("a symlink inside the project root cannot be used to write outside it", { skip }, async () => {
    const throughLink = join(projectRoot, "escape-hatch", "via-symlink.txt");
    const result = await runBash(`printf 'escaped\\n' > ${JSON.stringify(throughLink)}`);

    assert.equal(result.ok, false);
    assert.equal(existsSync(join(outside, "via-symlink.txt")), false);
});

test("a symlinked deny target cannot be written through its alias", { skip }, async () => {
    const alias = join(projectRoot, "env-alias");
    if (!existsSync(alias)) symlinkSync(join(projectRoot, ".env"), alias);

    const result = await runBash(`printf 'STOLEN=2\\n' > ${JSON.stringify(alias)}`);

    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(projectRoot, ".env"), "utf8"), "SECRET=original\n");
});

test("reads outside the project root still work", { skip }, async () => {
    const result = await runBash(`cat ${JSON.stringify(join(outside, "readable.txt"))}`);

    assert.equal(result.ok, true, result.ok ? "" : result.message);
    assert.match(result.ok ? result.text : "", /readable from inside the sandbox/);
});

test("the sandboxed shell still sees pi's session environment", { skip }, async () => {
    const result = await runBash('printf "%s|%s|%s\\n" "$PI_SESSION_ID" "$PI_MODEL" "$PI_PROVIDER"');

    assert.equal(result.ok, true, result.ok ? "" : result.message);
    assert.match(result.ok ? result.text : "", /kernel-session\|test-model\|test-provider/);
});

test("the sandboxed shell runs in the project working directory", { skip }, async () => {
    const result = await runBash("pwd -P");

    assert.equal(result.ok, true, result.ok ? "" : result.message);
    assert.equal((result.ok ? result.text : "").trim(), projectRoot);
});

test("output still streams incrementally while the sandboxed command runs", { skip }, async () => {
    const updates: string[] = [];
    const result = await runBash("printf 'first\\n'; sleep 0.4; printf 'second\\n'", {
        onUpdate: (update) => {
            const content = (update as { content: Array<{ type: string; text?: string }> }).content;
            const first = content[0];
            if (first?.type === "text" && first.text) updates.push(first.text);
        },
    });

    assert.equal(result.ok, true, result.ok ? "" : result.message);
    assert.ok(
        updates.some((text) => text.includes("first") && !text.includes("second")),
        `expected a partial update before completion, saw ${JSON.stringify(updates)}`,
    );
});

test("a sandboxed command still times out and its process tree is killed", { skip }, async () => {
    const marker = join(projectRoot, "timeout-marker.txt");
    const result = await runBash(
        `sleep 30 && printf 'survived\\n' > ${JSON.stringify(marker)}`,
        { timeout: 1 },
    );

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /timed out after 1 seconds/);
    assert.equal(existsSync(marker), false);
});

test("a sandboxed command is still cancellable", { skip }, async () => {
    const controller = new AbortController();
    const marker = join(projectRoot, "cancel-marker.txt");
    const pending = runBash(`sleep 30 && printf 'survived\\n' > ${JSON.stringify(marker)}`, {
        signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);

    const result = await pending;

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /aborted/);
    assert.equal(existsSync(marker), false);
});

test("large output is still truncated with pi's own details contract", { skip }, async () => {
    const bash = tools.get("bash");
    assert.ok(bash);
    const result = await bash.execute(
        "call-truncation",
        { command: "seq 1 5000" },
        undefined,
        undefined,
        ctx,
    );

    const details = result.details as { truncation?: { truncated?: boolean }; fullOutputPath?: string };
    assert.equal(details.truncation?.truncated, true);
    assert.ok(details.fullOutputPath);
});

test("user-entered ! commands run under the same confinement", { skip }, async () => {
    const handler = handlers.get("user_bash");
    assert.ok(handler);
    const result = handler(
        { type: "user_bash", command: "true", excludeFromContext: false, cwd: projectRoot },
        ctx,
    ) as UserBashEventResult;
    assert.ok(result.operations);

    const target = join(outside, "user-bash-leak.txt");
    const inside = join(projectRoot, "user-bash-allowed.txt");

    const denied = await result.operations.exec(
        `printf 'leak\\n' > ${JSON.stringify(target)}`,
        projectRoot,
        { onData: () => {} },
    );
    const allowed = await result.operations.exec(
        `printf 'ok\\n' > ${JSON.stringify(inside)}`,
        projectRoot,
        { onData: () => {} },
    );

    assert.notEqual(denied.exitCode, 0);
    assert.equal(existsSync(target), false);
    assert.equal(allowed.exitCode, 0);
    assert.equal(readFileSync(inside, "utf8"), "ok\n");
});

test("a selected backend that cannot initialize blocks the command instead of running it", { skip: skip || macOSOnly }, async () => {
    const marker = join(projectRoot, "failed-backend-marker.txt");
    const controller = new ForegroundSandboxController();
    controller.beginSession(projectRoot);
    const operations = createSandboxedBashOperations(controller, {
        // A profile the backend will reject: sandbox-exec exits before it ever
        // reaches the child, and nothing retries the child directly.
        writeProfile: (path) => writeFileSync(path, "(this is not a valid sbpl profile\n"),
    });

    const result = await operations.exec(
        `printf 'ran unconfined\\n' > ${JSON.stringify(marker)}`,
        projectRoot,
        { onData: () => {} },
    );

    assert.notEqual(result.exitCode, 0);
    assert.equal(existsSync(marker), false, "the child must never run after a backend failure");
});

test("existing network behaviour still works from inside the sandbox", { skip }, async () => {
    const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("network-reachable");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
        const probe = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
            `fetch("http://127.0.0.1:${address.port}/").then(r => r.text()).then(t => process.stdout.write(t))`,
        )}`;
        const result = await runBash(probe);

        assert.equal(result.ok, true, result.ok ? "" : result.message);
        assert.match(result.ok ? result.text : "", /network-reachable/);
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
    }
});

test("a command already running keeps the policy it launched with when the sandbox is switched off", { skip }, async () => {
    const target = join(outside, "mid-flight.txt");
    rmSync(target, { force: true });

    const pending = runBash(`sleep 1; printf 'late\\n' > ${JSON.stringify(target)}`);
    // Switch protection off while that command is still running. It must keep
    // the confinement it launched with, not pick up the new state.
    await new Promise((done) => setTimeout(done, 250));
    await setSandbox("off");

    const result = await pending;

    assert.equal(result.ok, false, "the in-flight command must stay confined");
    assert.equal(existsSync(target), false);
    await setSandbox("on");
});

test("/sandbox off lifts confinement and /sandbox on restores it without a restart", { skip }, async () => {
    const target = join(outside, "after-toggle.txt");
    rmSync(target, { force: true });

    await setSandbox("off");
    const unconfined = await runBash(`printf 'allowed now\\n' > ${JSON.stringify(target)}`);
    assert.equal(unconfined.ok, true, unconfined.ok ? "" : unconfined.message);
    assert.equal(readFileSync(target, "utf8"), "allowed now\n");
    rmSync(target, { force: true });

    await setSandbox("on");
    const confined = await runBash(`printf 'blocked again\\n' > ${JSON.stringify(target)}`);
    assert.equal(confined.ok, false);
    assert.equal(existsSync(target), false);
});

test("an unsafe launch root blocks the shell rather than granting it", { skip }, async () => {
    const unsafe = new ForegroundSandboxController();
    unsafe.beginSession("/");
    const operations = createSandboxedBashOperations(unsafe);
    const marker = join(projectRoot, "unsafe-root-marker.txt");

    await assert.rejects(
        () =>
            operations.exec(`printf 'ran\\n' > ${JSON.stringify(marker)}`, projectRoot, {
                onData: () => {},
            }),
        /Relaunch pi from the directory you are actually working in/,
    );
    assert.equal(existsSync(marker), false);
});

test("the bash tool pi would have registered without this package is unconfined", { skip }, async () => {
    // Control: the same command, the same fixtures, the built-in operations.
    // Without it, a denial above could be a broken fixture rather than the sandbox.
    const builtin = createBashToolDefinition(projectRoot);
    const target = join(outside, "control.txt");
    rmSync(target, { force: true });

    await builtin.execute(
        "call-control",
        { command: `printf 'control\\n' > ${JSON.stringify(target)}` },
        undefined,
        undefined,
        ctx,
    );

    assert.equal(readFileSync(target, "utf8"), "control\n");
    rmSync(target, { force: true });
});

test("a deny rule added at runtime is enforced by the kernel on the next command", { skip }, async () => {
    const denied = join(projectRoot, "runtime-denied");
    const target = join(denied, "secret.txt");

    // Before the rule: an ordinary write inside the project root.
    const before = await runBash(`mkdir -p ${JSON.stringify(denied)} && printf 'first\\n' > ${JSON.stringify(target)}`);
    assert.equal(before.ok, true, before.ok ? "" : before.message);
    assert.equal(readFileSync(target, "utf8"), "first\n");

    await commands.get("sandbox")?.handler("deny add runtime-denied", ctx);

    // The same registered bash tool, no re-registration: the kernel now refuses.
    const overwrite = await runBash(`printf 'second\\n' > ${JSON.stringify(target)}`);
    assert.equal(overwrite.ok, false, "the write must not report success");
    assert.equal(readFileSync(target, "utf8"), "first\n", "the denied file is unchanged");
    const created = await runBash(`printf 'new\\n' > ${JSON.stringify(join(denied, "new.txt"))}`);
    assert.equal(created.ok, false);
    assert.equal(existsSync(join(denied, "new.txt")), false, "nothing may be created in the subtree");
    // User-entered ! commands are held to the same new rule.
    const userBash = handlers.get("user_bash")?.(
        { type: "user_bash", command: "true", excludeFromContext: false, cwd: projectRoot },
        ctx,
    ) as UserBashEventResult;
    assert.ok(userBash.operations);
    await userBash.operations.exec(`printf 'bang\\n' > ${JSON.stringify(target)}`, projectRoot, {
        onData: () => {},
    });
    assert.equal(readFileSync(target, "utf8"), "first\n");

    // Removing the rule lets the next command write there again.
    await commands.get("sandbox")?.handler("deny remove runtime-denied", ctx);
    const restored = await runBash(`printf 'third\\n' > ${JSON.stringify(target)}`);
    assert.equal(restored.ok, true, restored.ok ? "" : restored.message);
    assert.equal(readFileSync(target, "utf8"), "third\n");

    await commands.get("sandbox")?.handler("deny reset", ctx);
});

test("a command already running keeps the deny rules it launched with", { skip }, async () => {
    const denied = join(projectRoot, "late-denied");
    mkdirSync(denied, { recursive: true });
    const target = join(denied, "in-flight.txt");
    rmSync(target, { force: true });

    // Launches while the path is writable, then the rule lands mid-flight.
    const pending = runBash(`sleep 1; printf 'late\\n' > ${JSON.stringify(target)}`);
    await new Promise((done) => setTimeout(done, 250));
    await commands.get("sandbox")?.handler("deny add late-denied", ctx);

    const result = await pending;

    assert.equal(result.ok, true, result.ok ? "" : result.message);
    assert.equal(
        readFileSync(target, "utf8"),
        "late\n",
        "the running command keeps the policy it launched with",
    );
    // A command launched after the change is confined by it.
    const later = await runBash(`printf 'blocked\\n' > ${JSON.stringify(join(denied, "later.txt"))}`);
    assert.equal(later.ok, false);
    assert.equal(existsSync(join(denied, "later.txt")), false);

    await commands.get("sandbox")?.handler("deny reset", ctx);
});
