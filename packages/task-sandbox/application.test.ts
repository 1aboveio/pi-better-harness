// @covers task-sandbox.run-application
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRunApplicationToolDefinition, validateRunApplicationParams, RUN_APPLICATION_TOOL } from "./application.ts";
import { createTaskExecutor, directShellInterpreter, effectiveCommandTimeout, SHELL_SCRIPTS_OFF, validateTimeout } from "./exec.ts";
import { createTaskBashOperations, installTaskTools, TASK_BUILTINS } from "./index.ts";
import { RESERVED_TOOL_NAMES } from "./tools.ts";

const options = { onData: (_chunk: Buffer) => {} };
const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const kernel = mac && childProcess.spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
if (process.env.PI_SANDBOX_REQUIRE_BACKEND === "macos-seatbelt" && !kernel) {
    throw new Error("Real macOS Seatbelt kernel required but sandbox-exec cannot apply a profile");
}

const pwd = existsSync("/bin/pwd") ? "/bin/pwd" : "/usr/bin/pwd";
// The shell entry point every POSIX lane ships, plus the canonical file it
// resolves to. The expectation comes from the fixture input, not a distro
// layout: /bin/sh is a real "sh" on macOS and a link to /usr/bin/dash on
// Debian/Ubuntu, so a literal "/bin/sh" expectation only holds on macOS.
function posixShell() {
    const entry = "/bin/sh";
    return { entry, canonical: realpathSync.native(entry) };
}

function permissions(overrides: Record<string, unknown> = {}): any {
    return { projectFiles: "read-write" as const, outsideProject: "read" as const,
        storedCredentials: "read" as const, commands: true, network: true, ...overrides };
}

function fixture(t: test.TestContext, overrides: Record<string, unknown> = {}, confined = true) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "task-app-")));
    const root = join(base, "project"), home = join(base, "home"), control = join(base, "control");
    for (const path of [root, home, control]) mkdirSync(path);
    const policy = { writableRoot: root, home, denyWrite: [control], permissions: permissions(overrides) };
    const plan: any = confined ? { confined: true as const, profilePath: join(control, "task.sb"), policy }
        : { confined: false as const };
    const observations: any[] = [];
    const controller = { requireLaunchPlan: () => plan };
    const run = createTaskExecutor(controller, undefined, { observe: (observation) => { observations.push(observation); } });
    const tool = createRunApplicationToolDefinition(root, run);
    t.after(() => rmSync(base, { recursive: true, force: true }));
    return { base, root, home, control, policy, plan, tool, observations, controller,
        bashOps: createTaskBashOperations(controller, undefined, {
            observe: (observation) => { observations.push(observation); },
        }),
    };
}

async function runTool(tool: ReturnType<typeof createRunApplicationToolDefinition>, params: unknown) {
    return await tool.execute("call", params);
}

test("run_application passes literal argv without shell parsing", async (t) => {
    const f = fixture(t, {}, false);
    const result = await runTool(f.tool, { executable: "/usr/bin/printf", args: ["%s|%s", "$HOME", "a b"] });
    assert.equal(result.content[0].text, "$HOME|a b");
    assert.equal((result.details as any).exitCode, 0);
});

test("run_application runs in the tool factory working directory", async (t) => {
    const f = fixture(t, {}, false);
    const result = await runTool(f.tool, { executable: pwd });
    assert.equal(result.content[0].text.trim(), f.root);
});

test("run_application reports a non-zero exit through the SDK error contract", async (t) => {
    const f = fixture(t, {}, false);
    await assert.rejects(runTool(f.tool, { executable: process.execPath, args: ["-e", "process.exit(3)"] }),
        /Command exited with code 3/);
});

test("run_application rejects malformed parameters before any launch", async (t) => {
    const f = fixture(t, {}, false);
    assert.deepEqual(validateRunApplicationParams({ executable: "ls", args: null, timeout: null }),
        { executable: "ls", args: [], timeout: undefined });
    for (const params of [
        { executable: "" },
        { executable: "  " },
        { executable: "node", args: "not-an-array" },
        { executable: "node", args: ["ok", 3] },
        { executable: "node", args: ["ok", "bad\u0000arg"] },
        { executable: "node", extra: true },
        { executable: "node", timeout: 0 },
        { executable: "node", timeout: -1 },
        { executable: "node", timeout: Number.POSITIVE_INFINITY },
        { executable: "node", timeout: 2_147_484 },
    ]) {
        assert.throws(() => validateRunApplicationParams(params), /run_application|Invalid timeout/, JSON.stringify(params));
    }
});

test("run_application truncates output and spills the full text to a temp file", async (t) => {
    const f = fixture(t, {}, false);
    const result = await runTool(f.tool, { executable: process.execPath,
        args: ["-e", "for (let i = 0; i < 3000; i++) console.log(`line ${i}`)"] });
    const details = result.details as { truncation?: { truncated: boolean; totalLines: number }; fullOutputPath?: string };
    assert.equal(details.truncation?.truncated, true);
    assert.equal(details.truncation?.totalLines, 3000);
    assert.ok(details.fullOutputPath);
    assert.match(result.content[0].text, /Showing lines \d+-3000 of 3000\. Full output: /);
    const spilled = readFileSync(details.fullOutputPath!, "utf8");
    assert.match(spilled, /line 0\n/);
    assert.match(spilled, /line 2999\n/);
    rmSync(details.fullOutputPath!, { force: true });
});

test("direct shell interpreters are refused by requested and resolved identity while Shell scripts is Off", async (t) => {
    const f = fixture(t, { shell: false });
    const marker = join(f.root, "shell-marker.txt");
    const alias = join(f.root, "shell-alias");
    const shell = posixShell();
    symlinkSync(shell.entry, alias);
    // Requested identity: bare names and absolute paths whose name is a shell.
    // Resolved identity: links whose own name says nothing about the target.
    const attempts = ["sh", "bash", "/bin/bash", shell.entry, alias, "./shell-alias"];
    for (const executable of attempts) {
        await assert.rejects(runTool(f.tool, { executable, args: ["-c", `printf ran > ${marker}`] }),
            /Shell scripts are Off/, executable);
        assert.equal(existsSync(marker), false, `${executable} must not run`);
    }
    // The fixture link really reaches a shell, through whatever link chain this
    // platform installs, so the resolved-identity cases above are not vacuous.
    assert.equal(realpathSync.native(alias), shell.canonical);
    assert.equal(f.observations.filter((observation) => observation.outcome === "denied").length, attempts.length);
    assert.ok(f.observations.some((observation) => observation.tool === RUN_APPLICATION_TOOL &&
        observation.outcome === "denied" && observation.resource === "command-execution"));
    // Only shells are refused; any other executable still runs while commands is On.
    const allowed = await runTool(f.tool, { executable: "/usr/bin/printf", args: ["%s", "direct-ok"] });
    assert.equal(allowed.content[0].text, "direct-ok");
});

test("resolved identity catches a PATH-only symlink to a shell", (t) => {
    const f = fixture(t);
    const bin = join(f.base, "bin");
    mkdirSync(bin);
    const shell = posixShell();
    symlinkSync(shell.entry, join(bin, "runner"));
    assert.equal(directShellInterpreter("runner", { PATH: bin }, f.root), shell.canonical);
    assert.equal(directShellInterpreter("runner", { PATH: f.base }, f.root), undefined);
    assert.equal(directShellInterpreter("./runner", { PATH: bin }, f.root), undefined);
});

test("Shell scripts Off refuses bash and user_bash operations", async (t) => {
    const f = fixture(t, { shell: false });
    const marker = join(f.root, "bash-marker.txt");
    await assert.rejects(f.bashOps.exec(`printf ran > ${marker}`, f.root, options), /Shell scripts are Off/);
    assert.equal(existsSync(marker), false);
});

test("Shell scripts Off still permits an application to start a shell of its own", async (t) => {
    // Interface restriction, not an OS exec deny: the profile hides the shell
    // entry point from the model, it does not forbid descendants.
    const f = fixture(t, { shell: false });
    const marker = join(f.root, "child-marker.txt");
    const script = `require("node:child_process").execFileSync("/bin/sh", ["-c", ${JSON.stringify(`printf child > ${marker}`)}])`;
    const result = await runTool(f.tool, { executable: process.execPath, args: ["-e", script] });
    assert.equal(result.content[0].text, "(no output)");
    assert.equal(readFileSync(marker, "utf8"), "child");
});

test("Run applications Off refuses both bash and run_application", async (t) => {
    const f = fixture(t, { commands: false });
    await assert.rejects(f.bashOps.exec("printf denied", f.root, options), /Run commands & applications is Off/);
    await assert.rejects(runTool(f.tool, { executable: "/usr/bin/printf", args: ["denied"] }), /Run commands & applications is Off/);
});

test("the profile time limit bounds every command path, including an omitted timeout", () => {
    const capped = permissions({ commandTimeoutSeconds: 60 });
    assert.equal(effectiveCommandTimeout(undefined, capped), 60);
    assert.equal(effectiveCommandTimeout(300, capped), 60);
    assert.equal(effectiveCommandTimeout(5, capped), 5);
    assert.equal(effectiveCommandTimeout(undefined, permissions({ commandTimeoutSeconds: null })), undefined);
    assert.equal(effectiveCommandTimeout(undefined, permissions()), undefined);
    assert.equal(effectiveCommandTimeout(30, permissions()), 30);
    assert.equal(effectiveCommandTimeout(2_147_483, permissions({ commandTimeoutSeconds: 2_147_483 })), 2_147_483);
    assert.throws(() => effectiveCommandTimeout(undefined, permissions({ commandTimeoutSeconds: 0 })), /time limit is invalid/);
    assert.throws(() => effectiveCommandTimeout(undefined, permissions({ commandTimeoutSeconds: 2_147_484 })), /time limit is invalid/);
    assert.throws(() => validateTimeout(0), /Invalid timeout/);
    assert.throws(() => validateTimeout(2_147_484), /Invalid timeout/);
});

test("kernel: the omitted timeout is capped and keeps the SDK timeout error text", { skip: !kernel }, async (t) => {
    const f = fixture(t, { commandTimeoutSeconds: 0.05 });
    const bash = createBashToolDefinition(f.root, { operations: f.bashOps });
    const ctx = { sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined } } as any;
    await assert.rejects(bash.execute("call", { command: "/bin/sleep 5" }, undefined, undefined, ctx),
        /Command timed out after 0\.05 seconds/);
    await assert.rejects(runTool(f.tool, { executable: "/bin/sleep", args: ["5"] }),
        /Command timed out after 0\.05 seconds/);
    assert.deepEqual(readdirSync(f.control), []);
});

test("kernel: a requested timeout below a raised cap still wins", { skip: !kernel }, async (t) => {
    const f = fixture(t, { commandTimeoutSeconds: 600 });
    await assert.rejects(runTool(f.tool, { executable: "/bin/sleep", args: ["5"], timeout: 0.05 }),
        /Command timed out after 0\.05 seconds/);
    assert.deepEqual(readdirSync(f.control), []);
});

test("kernel: abort stops the application group and retires its profile", { skip: !kernel }, async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    t.after(() => clearTimeout(timer));
    await assert.rejects(f.tool.execute("call", { executable: "/bin/sleep", args: ["60"] }, controller.signal),
        /Command aborted/);
    assert.deepEqual(readdirSync(f.control), []);
});

test("kernel: direct applications run inside the same kernel write policy", { skip: !kernel }, async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.root, ".env"), "fixture-only\n");
    const created = await runTool(f.tool, { executable: "/usr/bin/touch", args: [join(f.root, "made.txt")] });
    assert.equal((created.details as any).exitCode, 0);
    assert.equal(existsSync(join(f.root, "made.txt")), true);
    await assert.rejects(runTool(f.tool, { executable: "/usr/bin/touch", args: [join(f.control, "nope.txt")] }),
        /Command exited with code 1/);
    assert.equal(existsSync(join(f.control, "nope.txt")), false);
    assert.equal(readFileSync(join(f.root, ".env"), "utf8"), "fixture-only\n");
});

function fakePi() {
    const tools = new Map<string, any>();
    const handlers = new Map<string, any>();
    const source = fileURLToPath(import.meta.url);
    return {
        tools, handlers, source,
        pi: {
            registerTool(tool: any) { tools.set(tool.name, tool); },
            getAllTools() {
                return [...tools.values()].map((tool) => ({ name: tool.name, parameters: tool.parameters, sourceInfo: { path: source } }));
            },
            on(event: string, handler: any) { handlers.set(event, handler); },
        } as any,
    };
}

test("installTaskTools registers run_application as a guarded builtin and reserves its name", (t) => {
    const f = fixture(t);
    const fake = fakePi();
    const boundary = installTaskTools(fake.pi, { controller: { requireLaunchPlan: () => f.plan },
        cwd: f.root, trustedSources: [fake.source] });
    assert.ok(TASK_BUILTINS.includes(RUN_APPLICATION_TOOL));
    assert.ok(RESERVED_TOOL_NAMES.includes(RUN_APPLICATION_TOOL));
    assert.equal(fake.tools.get(RUN_APPLICATION_TOOL)?.name, RUN_APPLICATION_TOOL);
    assert.doesNotThrow(() => boundary.assertInstalled([RUN_APPLICATION_TOOL]));
});

test("the task gate refuses run_application shells and every command when the profile says Off", (t) => {
    const f = fixture(t);
    const fake = fakePi();
    installTaskTools(fake.pi, { controller: { requireLaunchPlan: () => f.plan }, cwd: f.root, trustedSources: [fake.source] });
    const gate = fake.handlers.get("tool_call");
    const call = (toolName: string, input: unknown) => gate({ toolName, input }, { cwd: f.root });

    assert.equal(call(RUN_APPLICATION_TOOL, { executable: "/usr/bin/printf" }), undefined);
    assert.equal(call("bash", { command: "printf ok" }), undefined);

    f.policy.permissions.shell = false;
    const bashBlocked = call("bash", { command: "printf ok" }) as { block: boolean; reason: string };
    assert.equal(bashBlocked.block, true);
    assert.equal(bashBlocked.reason, SHELL_SCRIPTS_OFF);
    for (const executable of ["sh", "/bin/bash", "/usr/local/bin/zsh"]) {
        const refusal = call(RUN_APPLICATION_TOOL, { executable }) as { block: boolean; reason: string };
        assert.equal(refusal.block, true, executable);
        assert.match(refusal.reason, /Shell scripts are Off; run_application cannot launch the shell interpreter/);
    }
    assert.equal(call(RUN_APPLICATION_TOOL, { executable: "/usr/bin/printf" }), undefined);

    f.policy.permissions.commands = false;
    for (const toolName of ["bash", RUN_APPLICATION_TOOL]) {
        const refusal = call(toolName, { command: "printf ok", executable: "/usr/bin/printf" }) as { block: boolean; reason: string };
        assert.equal(refusal.block, true);
        assert.match(refusal.reason, /Run commands & applications is Off/);
    }
});

test("user_bash keeps the confined executor and refuses a shell while Shell scripts is Off", async (t) => {
    const f = fixture(t, { shell: false });
    const fake = fakePi();
    installTaskTools(fake.pi, { controller: { requireLaunchPlan: () => f.plan }, cwd: f.root, trustedSources: [fake.source] });
    const handler = fake.handlers.get("user_bash");
    const first = handler({ type: "user_bash", command: "printf ok", excludeFromContext: false, cwd: f.root });
    const second = handler({ type: "user_bash", command: "printf ok", excludeFromContext: true, cwd: f.root });
    assert.equal(first.operations, second.operations);
    await assert.rejects(first.operations.exec("printf ok", f.root, options), /Shell scripts are Off/);
});
