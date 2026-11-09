// @covers task-sandbox.runtime-control-protection
// @level integration
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { canonicalizePath, compileWritePolicy, evaluateWriteAccess, type SandboxPermissions } from "../sandbox-core/index.ts";
import {
    createTaskBashOperations,
    ensureHarnessRuntimeDirectories,
    harnessRuntimeDirectories,
} from "./index.ts";

const macKernel = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") &&
    childProcess.spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
const linuxKernel = process.platform === "linux" &&
    childProcess.spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"]).status === 0;
const kernel = macKernel || linuxKernel;
if (process.env.PI_SANDBOX_REQUIRE_BACKEND === "macos-seatbelt" && !macKernel) {
    throw new Error("Real macOS Seatbelt kernel required but sandbox-exec cannot apply a profile");
}

/**
 * Independent copy of the canonical naming in
 * pi-better-background-tasks/src/coordinator/paths.ts. The default operation
 * store and supervisor locations are the ones the Background extension uses.
 */
function expectedCoordinatorControls() {
    const user = process.getuid?.() ?? createHash("sha256").update(homedir()).digest("hex").slice(0, 8);
    const stateRoot = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const storePath = join(stateRoot, "operation-coordinator.sqlite");
    const pool = process.env.VITEST_POOL_ID;
    const runtimeName = pool && /^\d+$/.test(pool)
        ? `pi-better-background-tasks-vitest-${pool}`
        : "pi-better-background-tasks";
    const supervisorDirectory = join(tmpdir(), runtimeName, "supervisor");
    const key = createHash("sha256")
        .update(canonicalizePath(storePath))
        .update("\0")
        .update(canonicalizePath(supervisorDirectory))
        .digest("hex")
        .slice(0, 20);
    return {
        socketRoot: canonicalizePath(join("/tmp", `pi-bg-${user}`)),
        electionDirectory: canonicalizePath(join(dirname(canonicalizePath(storePath)), `.pi-bg-${user}-${key}`)),
        stateDirectory: canonicalizePath(join(resolve(stateRoot), "background-tasks-coordinator", key)),
        key,
    };
}

test("runtime protection includes the fixed coordinator socket and default election/state controls", {
    skip: process.platform === "win32",
}, () => {
    const controls = expectedCoordinatorControls();
    const directories = ensureHarnessRuntimeDirectories();
    for (const directory of [
        controls.socketRoot,
        canonicalizePath(join(tmpdir(), "pi-better-subagents")),
        canonicalizePath(join(tmpdir(), "pi-better-background-tasks")),
    ]) {
        assert.ok(directories.includes(directory), `${directory} must be protected`);
        assert.ok(existsSync(directory), `${directory} must exist for kernel-denial planning`);
    }
    for (const directory of [controls.electionDirectory, controls.stateDirectory]) {
        assert.ok(directories.includes(directory), `${directory} must be protected`);
        const agentDir = canonicalizePath(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
        assert.ok(directory.startsWith(`${agentDir}/`),
            `${directory} is already inside the protected agent directory`);
    }
    assert.equal(harnessRuntimeDirectories().includes(controls.socketRoot), true);
});

test("Outside project = Read/write and temp compatibility deny only coordinator control paths", {
    skip: process.platform === "win32",
}, (t) => {
    const base = realpathSync(mkdtempSync(join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "task-runtime-policy-")));
    const project = join(base, "project"), home = join(base, "home");
    mkdirSync(project); mkdirSync(home);
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const controls = expectedCoordinatorControls();
    const permissions: SandboxPermissions = {
        projectFiles: "read-write", outsideProject: "read-write", storedCredentials: "read",
        commands: true, network: true,
    };
    const policy = compileWritePolicy({
        writableRoot: project, home, permissions, runtimeCompatibility: true,
        denyWrite: ensureHarnessRuntimeDirectories(),
    });

    for (const target of [
        controls.socketRoot,
        join(controls.socketRoot, `${controls.key}.sock`),
        join(controls.socketRoot, "other.sock"),
        controls.electionDirectory,
        join(controls.electionDirectory, "leader.sqlite"),
        controls.stateDirectory,
        join(controls.stateDirectory, "leader.lock"),
        join(controls.stateDirectory, "coordinator.log"),
        canonicalizePath(join(tmpdir(), "pi-better-subagents")),
        canonicalizePath(join(tmpdir(), "pi-better-background-tasks")),
    ]) {
        const decision = evaluateWriteAccess(target, policy);
        assert.equal(decision.allowed, false, `${target} must be denied`);
        if (!decision.allowed) assert.equal(decision.reason, "write-denied", target);
    }

    for (const allowed of [
        join(project, "src", "work.txt"),
        join(tmpdir(), `task-runtime-unrelated-${process.pid}`, "work.txt"),
        join("/tmp", `pi-bg-${controls.key}-unrelated`, "work.txt"),
    ]) {
        const decision = evaluateWriteAccess(allowed, policy);
        assert.equal(decision.allowed, true, `${allowed} must remain writable`);
    }
});

test("kernel denies writes and unlinks under the coordinator root without touching a live endpoint", {
    skip: !kernel || process.platform === "win32", timeout: 15_000,
}, async (t) => {
    const controls = expectedCoordinatorControls();
    ensureHarnessRuntimeDirectories();
    // A disposable directory inside the real control root proves the exact
    // protected path without reading, unlinking, or replacing any live socket.
    const fixtureRoot = realpathSync(mkdtempSync(join(controls.socketRoot, "task-runtime-fixture-")));
    const marker = join(fixtureRoot, "control.txt");
    writeFileSync(marker, "original\n");
    const unrelated = realpathSync(mkdtempSync(join(tmpdir(), "task-runtime-unrelated-")));
    const allowed = join(unrelated, "allowed.txt");
    const base = realpathSync(mkdtempSync(join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "task-runtime-kernel-")));
    const project = join(base, "project"), home = join(base, "home");
    mkdirSync(project); mkdirSync(home);
    t.after(() => {
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(unrelated, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
    });

    const plan = { confined: true as const, profilePath: join(base, "task.sb"), policy: {
        writableRoot: project, home, denyWrite: harnessRuntimeDirectories(), runtimeCompatibility: true,
        permissions: {
            projectFiles: "read-write" as const, outsideProject: "read" as const,
            storedCredentials: "read" as const, commands: true, network: true,
        },
    } };
    const ops = createTaskBashOperations({ requireLaunchPlan: () => plan });
    const run = (command: string) => ops.exec(command, project, { onData: () => {} });
    const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

    const allowedWrite = await run(`printf allowed > ${quote(allowed)}`);
    assert.equal(allowedWrite.exitCode, 0);
    assert.equal(readFileSync(allowed, "utf8"), "allowed");
    const allowedRemove = await run(`rm -f ${quote(allowed)}`);
    assert.equal(allowedRemove.exitCode, 0);
    assert.equal(existsSync(allowed), false);

    const deniedWrite = await run(`printf changed > ${quote(marker)}`);
    assert.notEqual(deniedWrite.exitCode, 0);
    assert.equal(readFileSync(marker, "utf8"), "original\n");
    const deniedUnlink = await run(`rm -f ${quote(marker)}`);
    assert.notEqual(deniedUnlink.exitCode, 0);
    assert.equal(existsSync(marker), true);
    const deniedDirectoryUnlink = await run(`rm -rf ${quote(fixtureRoot)}`);
    assert.notEqual(deniedDirectoryUnlink.exitCode, 0);
    assert.equal(existsSync(marker), true);
});
