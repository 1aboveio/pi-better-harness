import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs, { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createProcessListToolDefinition } from "./process-list.ts";
import type { TaskFileController } from "./files.ts";
import type { SandboxWritePolicy } from "../sandbox-core/index.ts";

const supported = process.platform === "darwin" || process.platform === "linux";
const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const linux = process.platform === "linux" && (existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap"));

function fixture(t: test.TestContext) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "process-list-test-")));
    const root = join(base, "project"), home = join(base, "home"), control = join(base, "control");
    for (const path of [root, home, control]) mkdirSync(path);
    const policy: SandboxWritePolicy = {
        writableRoot: root, home, denyWrite: [control, join(root, ".env")],
        permissions: { projectFiles: "read", outsideProject: "read", storedCredentials: "read", commands: false, network: true },
    };
    const plan = { confined: true as const, profilePath: join(control, "task.sb"), policy };
    t.after(() => rmSync(base, { recursive: true, force: true }));
    return { root, home, control, plan };
}

function restoreBuiltins(t: test.TestContext) {
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function helper(t: test.TestContext, write?: (child: ReturnType<typeof fakeChild>) => void,
    inspect?: (file: string, argv: string[], options: SpawnOptions) => void) {
    const launches: { file: string; argv: string[]; options: SpawnOptions; child: ReturnType<typeof fakeChild> }[] = [];
    const kills: { pid: number; signal: unknown }[] = [];
    t.mock.method(childProcess, "spawn", (file: string, argv: string[], options: SpawnOptions) => {
        inspect?.(file, argv, options);
        const child = fakeChild();
        launches.push({ file, argv, options, child });
        if (write) queueMicrotask(() => write(child));
        return child;
    });
    t.mock.method(process, "kill", (pid: number, signal: unknown) => {
        kills.push({ pid, signal });
        const launch = launches.find((entry) => -entry.child.pid === pid);
        assert.ok(launch, "must signal only an owned helper group");
        queueMicrotask(() => launch.child.emit("close", null, "SIGKILL"));
        return true;
    });
    restoreBuiltins(t);
    return { launches, kills };
}

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        pid: 987654321, stdout: new PassThrough(), stderr: new PassThrough(),
        kill: () => { throw new Error("unexpected fallback signal"); },
    });
}

function unconfined(access: () => "off" | "read" = () => "read", controller: TaskFileController = { requireLaunchPlan: () => ({ confined: false }) }) {
    return createProcessListToolDefinition(process.cwd(), controller, access);
}

test("direct calls reject unexpected fields and invalid types before launch", async (t) => {
    const h = helper(t);
    const tool = unconfined();
    for (const params of [null, undefined, [], "node", { command: "ps" }, { argv: [] }, { env: {} }, { [Symbol("extra")]: true }]) {
        await assert.rejects(tool.execute("invalid", params), /only optional name and limit/);
    }
    for (const name of [null, 1, {}, "x".repeat(129)]) {
        await assert.rejects(tool.execute("name", { name }), /name must be a string of at most 128/);
    }
    for (const limit of [null, "1", 0, 201, 1.5, Infinity, NaN]) {
        await assert.rejects(tool.execute("limit", { limit }), /limit must be an integer from 1 to 200/);
    }
    assert.equal(h.launches.length, 0);
});

test("access Off, failed policy, and initial cancellation never spawn even when Main is inactive", async (t) => {
    const h = helper(t);
    let access: "off" | "read" = "off";
    let requests = 0;
    const tool = unconfined(() => access, { requireLaunchPlan: () => { requests++; return { confined: false }; } });
    await assert.rejects(tool.execute("off", {}), /access is Off/);
    assert.equal(requests, 0);
    access = "read";
    await assert.rejects(tool.execute("abort", {}, AbortSignal.abort()), { name: "AbortError" });
    assert.equal(requests, 0);
    const denied = unconfined(() => "read", { requireLaunchPlan: () => { throw new Error("fixture policy unavailable"); } });
    await assert.rejects(denied.execute("plan", {}), /fixture policy unavailable/);
    assert.equal(h.launches.length, 0);
});

test("fixed argv, minimal environment, and literal filtering cannot expose argv or execute a model filter", { skip: !supported }, async (t) => {
    const filter = "$(touch /tmp/injected);.* -- -f";
    const h = helper(t, (child) => {
        child.stdout.end(`12 plain\n34 prefix ${filter.toUpperCase()} suffix\n56 .*\n`);
        child.emit("close", 0);
    });
    const result = await unconfined().execute("filter", { name: filter, limit: 1 });
    assert.deepEqual(result.details, { processes: [{ pid: 34, name: `prefix ${filter.toUpperCase()} suffix` }], truncated: false, scope: "current-user" });
    assert.deepEqual(JSON.parse(result.content[0]!.text), result.details);
    assert.deepEqual(h.launches.map(({ file, argv }) => ({ file, argv })), [
        { file: "/usr/bin/pgrep", argv: ["-l", "-u", String(process.getuid!()), "."] },
    ]);
    assert.deepEqual(h.launches[0]!.options.env, { LC_ALL: "C", HOME: homedir(), PATH: "/usr/bin:/bin" });
    assert.equal(h.launches[0]!.options.shell, false);
    assert.deepEqual(h.launches[0]!.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(h.launches[0]!.options.detached, true);
    assert.equal(h.kills.length, 0);
});

test("parser retains comm spaces, supports split UTF-8 and final lines without newline", { skip: !supported }, async (t) => {
    const bytes = Buffer.from("  12 worker with spaces\n34 caf\u00e9\n56  leading space");
    helper(t, (child) => {
        const split = bytes.indexOf(Buffer.from("\u00e9")) + 1;
        child.stdout.write(bytes.subarray(0, split));
        child.stdout.end(bytes.subarray(split));
        child.emit("close", 0);
    });
    assert.deepEqual((await unconfined().execute("parse", {})).details, {
        processes: [{ pid: 12, name: "worker with spaces" }, { pid: 34, name: "caf\u00e9" }, { pid: 56, name: " leading space" }],
        truncated: false, scope: "current-user",
    });
});

test("limit counts filtered matches across all output, not just the first page", { skip: !supported }, async (t) => {
    helper(t, (child) => {
        child.stdout.end(Array.from({ length: 202 }, (_, i) => `${i + 1} ${i < 2 ? "other" : "worker"}\n`).join(""));
        child.emit("close", 0);
    });
    const tool = unconfined();
    for (const [params, count, truncated] of [
        [{}, 100, true], [{ limit: 200 }, 200, true], [{ name: "worker", limit: 200 }, 200, false],
        [{ name: "WORKER", limit: 1 }, 1, true], [{ name: "absent", limit: 1 }, 0, false],
        [{ name: "x".repeat(128) }, 0, false], [{ name: "" }, 100, true],
    ] as const) {
        const result = (await tool.execute("limits", params)).details;
        assert.equal(result.processes.length, count);
        assert.equal(result.truncated, truncated);
        if (params.name === "WORKER") assert.deepEqual(result.processes, [{ pid: 3, name: "worker" }]);
    }
});

test("malformed output fails closed rather than silently dropping processes", { skip: !supported }, async (t) => {
    for (const stdout of ["not a process\n", "0 worker\n", "9007199254740992 worker\n", "12\n", "12 \n", "12 worker\n12 duplicate\n", "12 bad\0name\n", "12 name\r\n"]) {
        await t.test(JSON.stringify(stdout), async (t) => {
            helper(t, (child) => { child.stdout.end(stdout); child.emit("close", 0); });
            await assert.rejects(unconfined().execute("malformed", {}), /malformed pgrep process-name output/);
        });
    }
});

test("exit 1 alone means no matches; other exit codes and signals are errors with bounded diagnostics", { skip: !supported }, async (t) => {
    for (const [code, signal, stdout, diagnostic] of [[1, null, "", false], [1, null, "", true], [1, null, "12 unexpected\n", true], [2, null, "", true], [3, null, "", true], [null, "SIGTERM", "", true]] as const) {
        await t.test(`${code ?? signal}/${stdout.length}`, async (t) => {
            helper(t, (child) => {
                child.stdout.end(stdout);
                child.stderr.end(diagnostic ? Buffer.alloc(4096, 65) : Buffer.alloc(0));
                child.emit("close", code, signal);
            });
            const run = unconfined().execute("exit", {});
            if (code === 1 && !stdout && !diagnostic) {
                assert.deepEqual((await run).details, { processes: [], truncated: false, scope: "current-user" });
            } else {
                await assert.rejects(run, (error: Error) => {
                    assert.match(error.message, /helper failed/);
                    assert.equal(error.message.split(": ")[1]!.length, 2048);
                    return true;
                });
            }
        });
    }
});

test("stdout cap rejects overflow and kills only the owned helper", { skip: !supported }, async (t) => {
    const h = helper(t, (child) => child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 65)));
    await assert.rejects(unconfined().execute("overflow", { limit: 1 }), /stdout exceeds 1 MiB/);
    assert.deepEqual(h.kills, [{ pid: -h.launches[0]!.child.pid, signal: "SIGKILL" }]);
});

test("stdout at the byte cap remains readable and result limits do not stop the drain", { skip: !supported }, async (t) => {
    helper(t, (child) => {
        const first = "12 worker\n";
        child.stdout.end(first + "34 " + "x".repeat(1024 * 1024 - Buffer.byteLength(first) - 4) + "\n");
        child.emit("close", 0);
    });
    assert.deepEqual((await unconfined().execute("boundary", { limit: 1 })).details,
        { processes: [{ pid: 12, name: "worker" }], truncated: true, scope: "current-user" });
});

test("timeout and in-flight abort terminate the helper, clear listeners, and report errors", { skip: !supported }, async (t) => {
    for (const reason of ["abort", "timeout"] as const) {
        await t.test(reason, async (t) => {
            const h = helper(t);
            const abort = new AbortController();
            const remove = t.mock.method(abort.signal, "removeEventListener");
            t.mock.timers.enable({ apis: ["setTimeout"] });
            const run = unconfined().execute("cancel", {}, abort.signal);
            const rejection = assert.rejects(run, reason === "abort" ? /aborted/ : /timed out after 5 seconds/);
            if (reason === "abort") abort.abort();
            else t.mock.timers.tick(5000);
            await rejection;
            assert.deepEqual(h.kills, [{ pid: -h.launches[0]!.child.pid, signal: "SIGKILL" }]);
            assert.equal(remove.mock.callCount(), 1);
            t.mock.timers.tick(5000);
            assert.equal(h.kills.length, 1);
        });
    }
});

test("unsafe, missing, retargeted, and changed fixed executables are unsupported without fallback", { skip: !supported }, async (t) => {
    const originalStat = fs.lstatSync;
    const originalRealpath = fs.realpathSync.native;
    for (const reason of ["missing", "setuid", "setgid", "writable", "owner", "directory", "ancestor", "canonical", "changed"] as const) {
        await t.test(reason, async (t) => {
            const h = helper(t, (child) => { child.emit("close", 1); });
            let change = false;
            t.mock.method(fs, "lstatSync", (path: fs.PathLike) => {
                if (path === "/usr/bin/pgrep") {
                    if (reason === "missing") throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
                    const info = originalStat(path, { bigint: true });
                    return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
                        mode: reason === "setuid" ? info.mode | 0o4000n : reason === "setgid" ? info.mode | 0o2000n : reason === "writable" ? info.mode | 0o020n : info.mode,
                        uid: reason === "owner" ? 123n : info.uid,
                        ino: info.ino + (change ? 1n : 0n),
                        isFile: () => reason !== "directory",
                    });
                }
                const info = originalStat(path, { bigint: true });
                if (reason === "ancestor" && path === "/usr/bin") return { ...info, mode: info.mode | 0o002n, isDirectory: () => true };
                return info;
            });
            t.mock.method(fs.realpathSync, "native", (path: fs.PathLike) => reason === "canonical" && path === "/usr/bin/pgrep" ? "/tmp/pgrep" : originalRealpath(path));
            syncBuiltinESMExports();
            const tool = unconfined();
            if (reason === "changed") {
                await tool.execute("first", {});
                change = true;
            }
            await assert.rejects(tool.execute("unsafe", {}), /process_list unsupported.*(fixed|pgrep)/);
            assert.equal(h.launches.length, reason === "changed" ? 1 : 0);
        });
    }
});

test("unsupported platforms fail before looking up or spawning any utility", async (t) => {
    const h = helper(t);
    t.mock.property(process, "platform", "win32");
    await assert.rejects(unconfined().execute("platform", {}), /unsupported on win32/);
    assert.equal(h.launches.length, 0);
});

test("confined launches preserve policy and retire private profiles on every outcome", { skip: !mac }, async (t) => {
    for (const outcome of ["success", "exit", "parse", "overflow", "abort", "timeout", "throw", "error"] as const) {
        await t.test(outcome, async (t) => {
            const f = fixture(t);
            const originalPolicy = structuredClone(f.plan.policy);
            const abort = new AbortController();
            const h = helper(t, (child) => {
                if (outcome === "error") { child.emit("error", new Error("fixture launch failed")); child.emit("close", -2); }
                else if (outcome === "overflow") child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
                else if (outcome === "abort") abort.abort();
                else if (outcome !== "timeout") {
                    child.stdout.end(outcome === "parse" ? "bad\n" : "12 fixture\n");
                    child.emit("close", outcome === "exit" ? 3 : 0);
                }
            }, (file: string, argv: string[], options: SpawnOptions) => {
                assert.equal(file, "/usr/bin/sandbox-exec");
                assert.deepEqual(argv.slice(2), ["/usr/bin/pgrep", "-l", "-u", String(process.getuid!()), "."]);
                assert.deepEqual(options.env, { LC_ALL: "C", HOME: f.home, PATH: "/usr/bin:/bin" });
                const profile = readFileSync(argv[1]!, "utf8");
                assert.match(profile, /\(deny network\*\)/);
                assert.ok(profile.includes(`(deny file-write* (subpath "${f.root}"))`), "read-only project must remain read-only");
                assert.ok(profile.includes(`(deny file-write* (subpath "${f.control}"))`), "control protection must remain");
                assert.ok(profile.includes(`${f.home}/.ssh`), "credential rules must remain");
                if (outcome === "throw") throw new Error("fixture synchronous failure");
            });
            t.mock.timers.enable({ apis: ["setTimeout"] });
            const tool = createProcessListToolDefinition(f.root, { requireLaunchPlan: () => f.plan }, () => "read");
            const run = tool.execute("confined", {}, abort.signal);
            const verification = outcome === "success" ? run.then((result) => assert.deepEqual(result.details.processes, [{ pid: 12, name: "fixture" }]))
                : assert.rejects(run, /helper failed|malformed|stdout exceeds|aborted|timed out|fixture.*failure|fixture launch failed/);
            if (outcome === "timeout") t.mock.timers.tick(5000);
            await verification;
            assert.deepEqual(readdirSync(f.control), [], "all generated profiles must be retired before settling");
            assert.deepEqual(f.plan.policy, originalPolicy, "helper privilege must not mutate the selected policy");
            if (["abort", "timeout", "overflow"].includes(outcome)) assert.equal(h.kills.length, 1);
        });
    }
});

test("backend build failure and access revocation never fall back to a host launch", { skip: !supported }, async (t) => {
    const f = fixture(t);
    const h = helper(t);
    f.plan.profilePath = join(f.control, "missing", "task.sb");
    if (process.platform === "linux") f.plan.policy.permissions!.storedCredentials = "off";
    const tool = createProcessListToolDefinition(f.root, { requireLaunchPlan: () => f.plan }, () => "read");
    await assert.rejects(tool.execute("backend", {}), /ENOENT|sandbox|bubblewrap/i);
    assert.equal(h.launches.length, 0);
    assert.deepEqual(readdirSync(f.control), []);
    let accesses = 0;
    const revoking = createProcessListToolDefinition(f.root, { requireLaunchPlan: () => ({ confined: false }) }, () => ++accesses === 1 ? "read" : "off");
    await assert.rejects(revoking.execute("revoked", {}), /access is Off/);
    assert.equal(h.launches.length, 0);
});

test("real selected kernel can inventory only an owned fixture with task commands Off", { skip: !mac && !linux, timeout: 15000 }, async (t) => {
    const f = fixture(t);
    const name = "pl-fixture";
    const executable = join(f.root, name);
    copyFileSync("/bin/sleep", executable);
    const child = childProcess.spawn(executable, ["60"], { stdio: "ignore", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    try {
        await once(child, "spawn");
        assert.ok(child.pid);
        const tool = createProcessListToolDefinition(f.root, { requireLaunchPlan: () => f.plan }, () => "read");
        const result = await tool.execute("kernel", { name, limit: 200 });
        // Do not print real inventory or query any unrelated PID.
        const owned = result.details.processes.find((entry) => entry.pid === child.pid);
        assert.ok(owned, "kernel-confined pgrep must see the owned fixture");
        assert.equal(owned.name, name);
        assert.deepEqual(Object.keys(owned).sort(), ["name", "pid"]);
        assert.deepEqual(JSON.parse(result.content[0]!.text), result.details);
        assert.deepEqual(readdirSync(f.control), []);
        f.plan.policy.permissions!.storedCredentials = "off";
        if (mac) {
            assert.ok((await tool.execute("kernel-off", { name })).details.processes.some((entry) => entry.pid === child.pid));
            assert.deepEqual(readdirSync(f.control), []);
        }
    } finally {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
    }
});
