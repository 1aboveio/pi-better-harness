/**
 * Project context inside a linked git worktree.
 *
 * Pi loads one global context file plus every ancestor file of the working
 * directory, so a worktree nested under, or beside, the main checkout inherits
 * the main checkout's `AGENTS.md`. These tests build real repositories with real
 * `git worktree add`, load context through the host's own loader, run the
 * extension hooks, and render the resulting prompt with the host's own prompt
 * builder. The assertions therefore describe what Pi sends, not what a helper
 * returns.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

import projectContextExtension from "../extensions/project-context/index.ts";
import childOwnership from "../../pi-better-subagents/child-ownership.ts";

// The installed host owns prompt rendering; render with it instead of restating
// the `<project_instructions>` format here.
const sdkDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { buildSystemPrompt } = (await import(pathToFileURL(join(sdkDir, "core/system-prompt.js")).href)) as {
    buildSystemPrompt: (options: Record<string, unknown>) => string;
};

const GLOBAL_RULE = "GLOBAL-AGENT-RULE\n";
const ABOVE_MAIN_RULE = "ABOVE-MAIN-RULE\n";
const MAIN_RULE = "MAIN-CHECKOUT-RULE\n";
const WORKTREE_RULE = "WORKTREE-ROOT-RULE\n";
const SCOPED_RULE = "WORKTREE-SCOPED-RULE\n";

interface Fixture {
    root: string;
    main: string;
    worktree: string;
    agentDir: string;
    /** Working directory the prompt is built for: a subdirectory of the worktree. */
    cwd: string;
}

function git(cwd: string, args: string[]): void {
    execFileSync(
        "git",
        ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.test", "-c", "init.defaultBranch=main", "-c", "gc.auto=0", ...args],
        { cwd, stdio: "ignore" },
    );
}

/** Point the extension's host lookup at this fixture instead of the real agent directory. */
function useAgentDir(t: { after(fn: () => void): void }, agentDir: string): void {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
}

function write(file: string, content: string): string {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
}

/** A committed main checkout, its global agent directory, and one linked worktree. */
function createFixture(t: { after(fn: () => void): void }, layout: "nested" | "sibling"): Fixture {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-worktree-context-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    write(join(agentDir, "AGENTS.md"), GLOBAL_RULE);
    write(join(root, "AGENTS.md"), ABOVE_MAIN_RULE);
    useAgentDir(t, agentDir);

    const main = join(root, "main");
    mkdirSync(main, { recursive: true });
    git(main, ["init", "--quiet"]);
    write(join(main, "README.md"), "main\n");
    git(main, ["add", "."]);
    git(main, ["commit", "--quiet", "-m", "init"]);
    write(join(main, "AGENTS.md"), MAIN_RULE);

    const worktree = layout === "nested" ? join(main, ".worktrees", "feat") : join(root, "feat");
    mkdirSync(dirname(worktree), { recursive: true });
    git(main, ["worktree", "add", "--quiet", worktree, "-b", "feat/context"]);
    write(join(worktree, "AGENTS.md"), WORKTREE_RULE);
    write(join(worktree, "packages", "app", "AGENTS.md"), SCOPED_RULE);
    return { root, main, worktree, agentDir, cwd: join(worktree, "packages", "app") };
}

type BeforeAgentStartHandler = (event: Record<string, unknown>) => unknown;

/** Register the extension exactly as Pi's loader does, then keep its hook. */
function beforeAgentStartHandlers(register: (pi: unknown) => void): BeforeAgentStartHandler[] {
    const handlers: BeforeAgentStartHandler[] = [];
    const pi = {
        on(event: string, handler: BeforeAgentStartHandler) {
            if (event === "before_agent_start") handlers.push(handler);
        },
    };
    register(pi);
    assert.ok(handlers.length > 0, "the extension must register a before_agent_start handler");
    return handlers;
}

function contextOptions(cwd: string, agentDir: string): Record<string, unknown> & { contextFiles: Array<{ path: string; content: string }> } {
    return { cwd, contextFiles: loadProjectContextFiles({ cwd, agentDir }) };
}

/** Run hooks the way the host does: mutable options, and no whole-prompt return. */
async function runHook(handlers: BeforeAgentStartHandler[], options: Record<string, unknown>): Promise<void> {
    for (const handler of handlers) {
        const result = await handler({
            type: "before_agent_start",
            prompt: "fixture",
            systemPrompt: buildSystemPrompt(options),
            systemPromptOptions: options,
        });
        assert.equal(result, undefined, "a whole-prompt return would set forceSystemPrompt and hide every section");
    }
}

function assertPromptHas(prompt: string, paths: string[], rules: string[], absentPaths: string[], absentRules: string[]): void {
    for (const path of paths) assert.ok(prompt.includes(`<project_instructions path="${path}">`), `prompt must carry ${path}`);
    for (const rule of rules) assert.ok(prompt.includes(rule), `prompt must carry ${rule.trim()}`);
    for (const path of absentPaths) assert.ok(!prompt.includes(path), `prompt must not carry ${path}`);
    for (const rule of absentRules) assert.ok(!prompt.includes(rule), `prompt must not carry ${rule.trim()}`);
}

for (const layout of ["nested", "sibling"] as const) {
    test(`a ${layout} linked worktree sends only its own project context`, async (t) => {
        const fixture = createFixture(t, layout);
        const options = contextOptions(fixture.cwd, fixture.agentDir);
        const globalFile = join(fixture.agentDir, "AGENTS.md");
        const aboveMainFile = join(fixture.root, "AGENTS.md");
        const worktreeFile = join(fixture.worktree, "AGENTS.md");
        const scopedFile = join(fixture.worktree, "packages", "app", "AGENTS.md");

        // The host walks every ancestor of cwd, so the directory above the
        // checkout is loaded too. Only the worktree root may bound that walk.
        assert.ok(buildSystemPrompt(options).includes(ABOVE_MAIN_RULE));

        await runHook(beforeAgentStartHandlers(projectContextExtension), options);

        assert.deepEqual(options.contextFiles.map((file) => file.path), [globalFile, worktreeFile, scopedFile]);
        assertPromptHas(buildSystemPrompt(options), [globalFile, worktreeFile, scopedFile],
            [GLOBAL_RULE, WORKTREE_RULE, SCOPED_RULE], [aboveMainFile], [ABOVE_MAIN_RULE]);
    });
}

test("a worktree without its own context file does not fall back to the main checkout", async (t) => {
    const fixture = createFixture(t, "nested");
    rmSync(join(fixture.worktree, "AGENTS.md"));
    // Keep a scoped file below the root, so this also proves "worktree root
    // through cwd" keeps descendants rather than truncating to an empty list.
    const scopedFile = join(fixture.worktree, "packages", "app", "AGENTS.md");
    const globalFile = join(fixture.agentDir, "AGENTS.md");
    const options = contextOptions(fixture.cwd, fixture.agentDir);
    assert.ok(options.contextFiles.some((file) => file.path === join(fixture.main, "AGENTS.md")));

    await runHook(beforeAgentStartHandlers(projectContextExtension), options);

    assert.deepEqual(options.contextFiles.map((file) => file.path), [globalFile, scopedFile]);
    assertPromptHas(buildSystemPrompt(options), [globalFile, scopedFile], [GLOBAL_RULE, SCOPED_RULE],
        [join(fixture.main, "AGENTS.md")], [MAIN_RULE, ABOVE_MAIN_RULE]);
});

test("a symlinked working directory keeps the same worktree boundary", async (t) => {
    const fixture = createFixture(t, "sibling");
    const link = join(fixture.root, "linked-worktree");
    symlinkSync(fixture.worktree, link, "dir");
    const cwd = join(link, "packages", "app");
    const options = contextOptions(cwd, fixture.agentDir);

    await runHook(beforeAgentStartHandlers(projectContextExtension), options);

    assert.equal(options.contextFiles.length, 3);
    assertPromptHas(buildSystemPrompt(options), [join(link, "AGENTS.md"), join(cwd, "AGENTS.md")],
        [WORKTREE_RULE, SCOPED_RULE], [join(fixture.main, "AGENTS.md"), join(fixture.root, "AGENTS.md")],
        [MAIN_RULE, ABOVE_MAIN_RULE]);
});

test("ordinary repositories still inherit every ancestor context file", async (t) => {
    const fixture = createFixture(t, "sibling");
    const cwd = join(fixture.main, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    const options = contextOptions(cwd, fixture.agentDir);

    await runHook(beforeAgentStartHandlers(projectContextExtension), options);

    assert.deepEqual(options.contextFiles.map((file) => file.path), [
        join(fixture.agentDir, "AGENTS.md"),
        join(fixture.root, "AGENTS.md"),
        join(fixture.main, "AGENTS.md"),
    ]);
    assertPromptHas(buildSystemPrompt(options), [], [GLOBAL_RULE, ABOVE_MAIN_RULE, MAIN_RULE], [], []);
});

test("a separate git directory is not mistaken for a linked worktree", async (t) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-separate-git-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    write(join(agentDir, "AGENTS.md"), GLOBAL_RULE);
    write(join(root, "AGENTS.md"), ABOVE_MAIN_RULE);
    useAgentDir(t, agentDir);
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    // `git init --separate-git-dir` writes a `.git` file with no `commondir`,
    // like a submodule. Its checkout keeps ordinary ancestor inheritance.
    git(root, ["init", "--quiet", "--separate-git-dir", join(root, "git-data"), project]);
    write(join(project, "AGENTS.md"), MAIN_RULE);
    const options = contextOptions(project, agentDir);

    await runHook(beforeAgentStartHandlers(projectContextExtension), options);

    assertPromptHas(buildSystemPrompt(options), [join(agentDir, "AGENTS.md"), join(root, "AGENTS.md"), join(project, "AGENTS.md")],
        [GLOBAL_RULE, ABOVE_MAIN_RULE, MAIN_RULE], [], []);
});

test("an empty context list stays empty when context files are disabled", async (t) => {
    const fixture = createFixture(t, "nested");
    const options = { cwd: fixture.cwd, contextFiles: [] as Array<{ path: string; content: string }> };

    await runHook(beforeAgentStartHandlers(projectContextExtension), options);

    assert.deepEqual(options.contextFiles, []);
    assert.ok(!buildSystemPrompt(options).includes("<project_instructions"), "the filter must not inject a context file");
});

test("a subagent child applies the same boundary as its parent", async (t) => {
    const fixture = createFixture(t, "nested");
    const parentOptions = contextOptions(fixture.cwd, fixture.agentDir);
    const childOptions = contextOptions(fixture.cwd, fixture.agentDir);
    // The steer marker is absent here: the boundary is part of every child
    // launch, not part of the worker-handoff control.
    const childHandlers = beforeAgentStartHandlers((pi) => childOwnership(pi as never, {}));

    await runHook(beforeAgentStartHandlers(projectContextExtension), parentOptions);
    await runHook(childHandlers, childOptions);

    assert.deepEqual(childOptions.contextFiles, parentOptions.contextFiles);
    assert.equal(buildSystemPrompt(childOptions), buildSystemPrompt(parentOptions));
    assertPromptHas(buildSystemPrompt(childOptions), [join(fixture.worktree, "AGENTS.md")], [WORKTREE_RULE],
        [join(fixture.main, "AGENTS.md")], [MAIN_RULE]);
});
