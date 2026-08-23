import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { PACKAGED_DENY_WRITE_TEMPLATES } from "../policy.ts";
import {
    buildSandboxedShellCommand,
    createSandboxedBashOperations,
    quoteForPosixShell,
} from "../shell.ts";
import {
    ForegroundSandboxBlockedError,
    ForegroundSandboxController,
    type ForegroundSandboxSeams,
} from "../state.ts";

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-sandbox-shell-")));
after(() => rmSync(fixtures, { recursive: true, force: true }));

function project(name: string): string {
    const root = join(fixtures, name);
    mkdirSync(root, { recursive: true });
    return root;
}

const home = project("home");
const profiles = project("profiles");

function seams(overrides: ForegroundSandboxSeams = {}): ForegroundSandboxSeams {
    return {
        platform: () => "darwin",
        home: () => home,
        createProfileDir: () => profiles,
        ...overrides,
    };
}

/** Records what Pi's local shell backend would have been asked to run. */
function recordingLocal(): BashOperations & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        async exec(command) {
            calls.push(command);
            return { exitCode: 0 };
        },
    };
}

test("single-quote escaping survives a real shell round trip", () => {
    const nasty = [
        "plain",
        "with spaces",
        `it's`,
        `$(touch /tmp/should-never-run)`,
        "back\\slash",
        "new\nline",
        "semi;colon && pipe | glob*",
        `"double"`,
        "`backtick`",
    ];
    const script = nasty.map((value) => `printf '%s\\0' ${quoteForPosixShell(value)}`).join("\n");
    const stdout = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });

    assert.deepEqual(stdout.split("\0").slice(0, -1), nasty);
});

test("the wrapped command execs the backend around pi's own shell with the command intact", () => {
    const controller = new ForegroundSandboxController(seams());
    const root = project("wrapping");
    controller.beginSession(root);
    const plan = controller.requireLaunchPlan();
    assert.equal(plan.confined, true);
    if (!plan.confined) return;

    const wrapped = buildSandboxedShellCommand("echo 'hi there'", plan, seams());
    const shell = getShellConfig();

    assert.ok(wrapped.startsWith("exec '/usr/bin/sandbox-exec' "));
    assert.ok(wrapped.includes(quoteForPosixShell(plan.profilePath)));
    assert.ok(wrapped.includes(quoteForPosixShell(shell.shell)));
    // The user's command travels as one argv element; it is never re-tokenized.
    assert.ok(wrapped.endsWith(quoteForPosixShell("echo 'hi there'")));
});

test("the generated profile confines writes to the canonical root and carves out the deny paths", () => {
    const controller = new ForegroundSandboxController(seams());
    const root = project("profile-contents");
    controller.beginSession(root);
    const plan = controller.requireLaunchPlan();
    assert.equal(plan.confined, true);
    if (!plan.confined) return;

    buildSandboxedShellCommand("true", plan, seams());
    const profile = readFileSync(plan.profilePath, "utf8");

    assert.ok(profile.includes(`(allow file-write* (subpath "${root}"))`));
    assert.ok(profile.includes(`(deny file-write* (subpath "${join(root, ".env")}"))`));
    assert.ok(profile.includes(`(deny file-write* (subpath "${join(root, ".git/hooks")}"))`));
    // Deny rules must come after the allowances they carve out of.
    assert.ok(
        profile.indexOf(`(deny file-write* (subpath "${join(root, ".env")}"))`) >
            profile.indexOf(`(allow file-write* (subpath "${root}"))`),
    );
});

test("an enabled sandbox with no backend blocks the command instead of running it unconfined", async () => {
    const local = recordingLocal();
    const controller = new ForegroundSandboxController(
        seams({ platform: () => "linux", lookupExecutable: () => undefined }),
    );
    controller.beginSession(project("no-backend"));
    const operations = createSandboxedBashOperations(controller, {
        ...seams({ platform: () => "linux", lookupExecutable: () => undefined }),
        localOperations: local,
    });

    await assert.rejects(
        () => operations.exec("touch marker", process.cwd(), { onData: () => {} }),
        ForegroundSandboxBlockedError,
    );
    assert.deepEqual(local.calls, [], "the command must never reach the shell backend");
});

test("an unsafe launch root blocks the command instead of running it unconfined", async () => {
    const local = recordingLocal();
    const controller = new ForegroundSandboxController(seams());
    controller.beginSession(home);
    const operations = createSandboxedBashOperations(controller, {
        ...seams(),
        localOperations: local,
    });

    await assert.rejects(
        () => operations.exec("touch marker", process.cwd(), { onData: () => {} }),
        /Relaunch pi from the directory you are actually working in/,
    );
    assert.deepEqual(local.calls, []);
});

test("a disabled sandbox hands pi's backend the untouched command", async () => {
    const local = recordingLocal();
    const controller = new ForegroundSandboxController(seams());
    controller.beginSession(project("disabled"));
    controller.disable();
    const operations = createSandboxedBashOperations(controller, {
        ...seams(),
        localOperations: local,
    });

    await operations.exec("echo hello", process.cwd(), { onData: () => {} });

    assert.deepEqual(local.calls, ["echo hello"]);
});

test("toggling back on confines the next command without rebuilding the operations", async () => {
    const local = recordingLocal();
    const controller = new ForegroundSandboxController(seams());
    const root = project("retoggle");
    controller.beginSession(root);
    const operations = createSandboxedBashOperations(controller, {
        ...seams(),
        localOperations: local,
    });

    controller.disable();
    await operations.exec("echo one", process.cwd(), { onData: () => {} });
    controller.enable();
    await operations.exec("echo two", process.cwd(), { onData: () => {} });

    assert.equal(local.calls[0], "echo one");
    assert.ok(local.calls[1]?.startsWith("exec '/usr/bin/sandbox-exec' "));
    assert.ok(local.calls[1]?.endsWith(quoteForPosixShell("echo two")));
});

test("streaming, timeout, cancellation and env options reach pi's backend unchanged", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const local: BashOperations = {
        async exec(_command, cwd, options) {
            seen.push({ cwd, ...options });
            return { exitCode: 0 };
        },
    };
    const controller = new ForegroundSandboxController(seams());
    const root = project("passthrough");
    controller.beginSession(root);
    const operations = createSandboxedBashOperations(controller, {
        ...seams(),
        localOperations: local,
    });

    const onData = () => {};
    const signal = new AbortController().signal;
    await operations.exec("echo hi", root, { onData, signal, timeout: 12, env: { A: "1" } });

    assert.deepEqual(seen, [{ cwd: root, onData, signal, timeout: 12, env: { A: "1" } }]);
});

test("a new deny rule reaches the next command's profile, and cannot rewrite a running one", () => {
    const controller = new ForegroundSandboxController(seams());
    const root = project("deny-rule-reaches-shell");
    controller.beginSession(root);

    // A command launches under the rules in force right now.
    const first = controller.requireLaunchPlan();
    assert.equal(first.confined, true);
    if (!first.confined) return;
    buildSandboxedShellCommand("sleep 60", first, seams());
    const launched = readFileSync(first.profilePath, "utf8");

    // A rule changes while that command is still running.
    controller.setDenyWriteTemplates([...PACKAGED_DENY_WRITE_TEMPLATES, "build"]);
    const second = controller.requireLaunchPlan();
    assert.equal(second.confined, true);
    if (!second.confined) return;
    buildSandboxedShellCommand("true", second, seams());

    // The next command is confined by the new rule...
    assert.ok(
        readFileSync(second.profilePath, "utf8").includes(
            `(deny file-write* (subpath "${join(root, "build")}"))`,
        ),
    );
    // ...and the running command's profile is a different file, byte-identical
    // to what it launched with. A rule change can never rewrite the profile a
    // live command is being enforced against.
    assert.notEqual(second.profilePath, first.profilePath);
    assert.equal(readFileSync(first.profilePath, "utf8"), launched);
    assert.equal(launched.includes(join(root, "build")), false);
});

test("the operations pi already holds pick up a rule change on the next command", async () => {
    const local = recordingLocal();
    const controller = new ForegroundSandboxController(seams());
    const root = project("deny-rule-no-reregistration");
    controller.beginSession(root);
    // Built once, exactly as the extension builds them at load time.
    const operations = createSandboxedBashOperations(controller, {
        ...seams(),
        localOperations: local,
    });

    await operations.exec("true", root, { onData: () => {} });
    controller.setDenyWriteTemplates([...PACKAGED_DENY_WRITE_TEMPLATES, "build"]);
    await operations.exec("true", root, { onData: () => {} });

    const profileOf = (command: string): string => {
        const match = /sandbox-exec' '-f' '([^']+)'/.exec(command);
        assert.ok(match, `expected a wrapped command, got ${command}`);
        return readFileSync(match[1] as string, "utf8");
    };
    assert.equal(profileOf(local.calls[0] as string).includes(join(root, "build")), false);
    assert.ok(profileOf(local.calls[1] as string).includes(join(root, "build")));
});
