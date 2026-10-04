import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTaskBashOperations } from "./index.ts";

function fixture(t: test.TestContext) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "task-bash-")));
    const root = join(base, "project"), home = join(base, "home"), control = join(base, "control");
    for (const path of [root, home, control]) mkdirSync(path);
    const plan = { confined: true as const, profilePath: join(control, "task.sb"), policy: {
        writableRoot: root, home, denyWrite: [control, join(root, ".env")],
        permissions: { projectFiles: "read-write" as const, outsideProject: "write" as const,
            storedCredentials: "read" as const, commands: true, network: true },
    } };
    t.after(() => rmSync(base, { recursive: true, force: true }));
    return { root, control, plan, ops: createTaskBashOperations({ requireLaunchPlan: () => plan }) };
}

function mockSpawn(t: test.TestContext, implementation: (...args: any[]) => any) {
    t.mock.method(childProcess, "spawn", implementation);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

const options = { onData: (_chunk: Buffer) => {} };
const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const kernel = mac && childProcess.spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
if (process.env.PI_SANDBOX_REQUIRE_BACKEND === "macos-seatbelt" && !kernel) {
    throw new Error("Real macOS Seatbelt kernel required but sandbox-exec cannot apply a profile");
}

// Delay the external reader at the spawn boundary, keeping the real policy builder.
test("overlapping shell launches retain independent complete profiles until each child settles", { skip: !mac }, async (t) => {
    const f = fixture(t);
    const launches: { profile: string; bytes: Buffer; child: EventEmitter }[] = [];
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    mockSpawn(t, (file, argv) => {
        assert.equal(file, "/usr/bin/sandbox-exec");
        assert.equal(argv[0], "-f");
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
        launches.push({ profile: argv[1], bytes: readFileSync(argv[1]), child });
        if (launches.length === 2) bothStarted();
        return child;
    });
    const first = f.ops.exec("/usr/bin/true", f.root, options);
    const second = f.ops.exec("/usr/bin/true", f.root, options);
    await started;
    try {
        assert.notEqual(launches[0].profile, launches[1].profile, "a sibling must not rewrite the reader's profile");
        assert.deepEqual(readFileSync(launches[0].profile), launches[0].bytes);
        assert.deepEqual(launches[0].bytes, launches[1].bytes, "per-operation allocation must preserve the full policy");
        launches[0].child.emit("close", 0);
        assert.deepEqual(await first, { exitCode: 0 });
        assert.equal(existsSync(launches[0].profile), false);
        assert.deepEqual(readFileSync(launches[1].profile), launches[1].bytes, "first cleanup must not affect its sibling");
        launches[1].child.emit("close", 65);
        assert.deepEqual(await second, { exitCode: 65 });
        assert.deepEqual(readdirSync(f.control), []);
    } finally {
        for (const launch of launches) launch.child.emit("close", 0);
        await Promise.allSettled([first, second]);
    }
});

test("shell profiles are retired on synchronous and asynchronous spawn failure", { skip: !mac }, async (t) => {
    for (const failure of ["throw", "error"] as const) {
        await t.test(failure, async (t) => {
            const f = fixture(t);
            mockSpawn(t, () => {
                if (failure === "throw") throw new Error("fixture spawn failure");
                const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
                queueMicrotask(() => child.emit("error", new Error("fixture spawn failure")));
                return child;
            });
            await assert.rejects(f.ops.exec("/usr/bin/true", f.root, options), /fixture spawn failure/);
            assert.deepEqual(readdirSync(f.control), []);
        });
    }
});

test("invalid or already aborted shell calls do not leave profiles", { skip: !mac }, async (t) => {
    const f = fixture(t);
    mockSpawn(t, () => { throw new Error("must not spawn"); });
    await assert.rejects(f.ops.exec("/usr/bin/true", f.root, { ...options, timeout: 0 }), /Invalid timeout/);
    await assert.rejects(f.ops.exec("/usr/bin/true", f.root, { ...options, signal: AbortSignal.abort() }), /aborted/);
    assert.deepEqual(readdirSync(f.control), []);
});

test("real overlapping sandboxed shells retain project writes and protected-file denials", { skip: !kernel }, async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.root, ".env"), "fixture-only\n");
    writeFileSync(join(f.control, "protected.txt"), "controller\n");
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        f.ops.exec(`printf ok > allowed-${i}.txt`, f.root, options)));
    for (let i = 0; i < results.length; i++) {
        assert.equal(results[i].exitCode, 0);
        assert.equal(readFileSync(join(f.root, `allowed-${i}.txt`), "utf8"), "ok");
    }
    const denied = await Promise.all([
        f.ops.exec("printf changed > .env", f.root, options),
        f.ops.exec("printf changed > ../control/protected.txt", f.root, options),
    ]);
    for (const result of denied) assert.notEqual(result.exitCode, 0);
    assert.equal(readFileSync(join(f.root, ".env"), "utf8"), "fixture-only\n");
    assert.equal(readFileSync(join(f.control, "protected.txt"), "utf8"), "controller\n");
    assert.deepEqual(readdirSync(f.control), ["protected.txt"]);
});

test("real shell timeout and cancellation retire profiles after stopping children", { skip: !kernel }, async (t) => {
    const f = fixture(t);
    await assert.rejects(f.ops.exec("/bin/sleep 60", f.root, { ...options, timeout: 0.05 }), /timeout:0.05/);
    assert.deepEqual(readdirSync(f.control), []);
    const controller = new AbortController();
    await assert.rejects(f.ops.exec("printf ready; /bin/sleep 60", f.root, {
        signal: controller.signal, timeout: 5,
        onData: () => controller.abort(),
    }), /aborted/);
    assert.deepEqual(readdirSync(f.control), []);
});

test("confined Git inventory avoids optional locks in linked-worktree metadata (#419)", { skip: !kernel }, async (t) => {
    // Temp and hidden home entries permit removal; neither reproduces a normal repository's gitdir.
    const base = realpathSync(mkdtempSync(join(import.meta.dirname, ".git-lock-fixture-")));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const home = join(base, "home"), repo = join(home, "projects", "repo");
    const root = join(repo, ".worktrees", "task"), control = join(base, "control");
    mkdirSync(repo, { recursive: true });
    mkdirSync(control);
    const env = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (cwd: string, args: string[]) => {
        const result = childProcess.spawnSync("/usr/bin/git", args, { cwd, env, encoding: "utf8" });
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        return result.stdout.trim();
    };
    git(repo, ["init", "-q", "--template="]);
    git(repo, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test",
        "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture"]);
    git(repo, ["worktree", "add", "-q", "-b", "task", root]);
    const gitdir = git(root, ["rev-parse", "--absolute-git-dir"]);
    const lock = join(gitdir, "index.lock");
    const plan = { confined: true as const, profilePath: join(control, "task.sb"), policy: {
        writableRoot: root, home, denyWrite: [control], permissions: {
            projectFiles: "read-write" as const, outsideProject: "write" as const,
            storedCredentials: "read" as const, commands: true, network: true,
        },
    } };
    const ops = createTaskBashOperations({ requireLaunchPlan: () => plan });
    const previous = process.env.GIT_OPTIONAL_LOCKS;
    delete process.env.GIT_OPTIONAL_LOCKS;
    t.after(() => {
        if (previous === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
        else process.env.GIT_OPTIONAL_LOCKS = previous;
    });
    const run = async (command: string, overrides: Record<string, string> = {}) => {
        let output = "";
        const result = await ops.exec(command, root, { env: { ...env, ...overrides }, onData: (chunk) => { output += chunk.toString(); } });
        return { ...result, output };
    };
    const inventory = await run("git status --short --branch");
    assert.equal(inventory.exitCode, 0, inventory.output);
    assert.match(inventory.output, /## task/);
    assert.doesNotMatch(inventory.output, /unable to unlink|Operation not permitted/);
    assert.equal(existsSync(lock), false, "read-only inventory must not strand an optional metadata lock");

    const explicit = await run("git status --short --branch", { GIT_OPTIONAL_LOCKS: "1" });
    assert.equal(explicit.exitCode, 0, explicit.output);
    assert.match(explicit.output, /unable to unlink .*index\.lock.*Operation not permitted/);
    assert.equal(readFileSync(lock).length, 0, "Git created an empty lock but the kernel refused its cleanup");
    const probe = `try { require("node:fs").unlinkSync(${JSON.stringify(lock)}); } catch (e) { console.log(JSON.stringify({code:e.code,syscall:e.syscall,path:e.path})); process.exitCode=1; }`;
    const denied = await run(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(probe)}`);
    assert.equal(denied.exitCode, 1, denied.output);
    assert.deepEqual(JSON.parse(denied.output), { code: "EPERM", syscall: "unlink", path: lock });
    assert.equal(existsSync(lock), true);
    rmSync(lock);

    assert.equal(git(root, ["status", "--short"]), "", "unconfined positive control still cleans up normally");
    assert.equal(existsSync(lock), false);
    const mutation = await run("mkdir writable && cd writable && git init -q --template= && printf fixture > added.txt && git add added.txt && git diff --cached --name-only");
    assert.equal(mutation.exitCode, 0, mutation.output);
    assert.equal(mutation.output.trim(), "added.txt", "the default must not disable required Git index writes");
});
