/**
 * Unit: sandbox-core selects a backend, compiles a write policy, and builds the
 * OS write-confinement wrapper.
 * @covers sandbox.backend-selection
 * @covers sandbox.command-wrapper
 * @covers sandbox.spawn-policy
 * @covers sandbox.write-containment
 * @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    buildSandboxCommand,
    canonicalizePath,
    compileWritePolicy,
    describeSandboxSupport,
    evaluateWriteAccess,
    maybeBuildSandboxCommand,
    sandboxSupported,
    type SandboxCommandArgs,
} from "./index.ts";

function sandboxArgs(base: string, writableRoot: string): SandboxCommandArgs {
    return {
        profilePath: join(base, "profile.sb"),
        policy: { writableRoot, home: join(base, "home") },
        execPath: "/usr/bin/true",
        execArgs: ["-p", "--mode", "json", "original prompt"],
    };
}

async function withPlatform<T>(value: string, run: () => T | Promise<T>): Promise<T> {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value });
    try {
        return await run();
    } finally {
        Object.defineProperty(process, "platform", descriptor);
    }
}

async function withPath<T>(value: string, run: () => T | Promise<T>): Promise<T> {
    const previous = process.env.PATH;
    process.env.PATH = value;
    try {
        return await run();
    } finally {
        if (previous === undefined) delete process.env.PATH;
        else process.env.PATH = previous;
    }
}

async function withUnreadablePath<T>(run: () => T | Promise<T>): Promise<T> {
    const previous = process.env;
    process.env = new Proxy(previous, {
        get(target, property, receiver) {
            if (property === "PATH") throw new Error("PATH must not be read for sandbox:false");
            return Reflect.get(target, property, receiver);
        },
    });
    try {
        return await run();
    } finally {
        process.env = previous;
    }
}

function writeBwrapStub(dir: string, body: string, mode = 0o755): string {
    const path = join(dir, "bwrap");
    writeFileSync(path, body);
    chmodSync(path, mode);
    return path;
}

describe("sandbox-core backend selection and wrapper construction", () => {
    // @characterizes sandbox.command-wrapper
    // @covers sandbox.command-wrapper
    // @level unit
    it("keeps the existing macOS sandbox-exec wrapper and profile", async () => {
        const base = mkdtempSync(join(tmpdir(), "sbxcore-macos-"));
        const writable = join(base, "work");
        mkdirSync(writable, { recursive: true });
        try {
            await withPlatform("darwin", () => {
                const args = sandboxArgs(base, writable);
                const cmd = buildSandboxCommand(args);
                assert.equal(cmd.file, "/usr/bin/sandbox-exec");
                assert.deepEqual(
                    cmd.fileArgs,
                    ["-f", args.profilePath, "/usr/bin/true", "-p", "--mode", "json", "original prompt"],
                    "wrapper must preserve the executable and original argv order",
                );

                const body = readFileSync(args.profilePath, "utf8");
                assert.match(body, /\(version 1\)/);
                assert.match(body, /\(allow default\)/);
                assert.match(body, /\(deny file-write\*\)/);
                assert.ok(body.includes(`(allow file-write* (subpath "${realpathSync(writable)}"))`));
                assert.match(body, /\/private\/var\/folders/);
                assert.match(body, /\/private\/tmp/);
                assert.match(body, /\/dev/);
                assert.ok(body.includes(".pi"), `profile should allow home/.pi:\n${body}`);
                assert.equal(
                    body.includes("(deny file-write* (subpath"),
                    false,
                    "an empty deny list must add no deny-subpath rules",
                );
            });
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.backend-selection
    // @covers sandbox.backend-selection
    // @level unit
    it("discovers an executable Linux bwrap without executing or probing it", async () => {
        const base = mkdtempSync(join(tmpdir(), "sbxcore-discovery-"));
        const executed = join(base, "executed");
        writeBwrapStub(base, `#!/bin/sh\nprintf executed > '${executed}'\nexit 99\n`);
        try {
            await withPlatform("linux", () => withPath(base, () => {
                assert.equal(sandboxSupported(), true);
                assert.equal(existsSync(executed), false, "support discovery must not execute bwrap");
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.backend-selection
    // @covers sandbox.backend-selection
    // @level unit
    it("reports Linux sandbox support false for absent or non-executable bwrap", async () => {
        const base = mkdtempSync(join(tmpdir(), "sbxcore-absent-"));
        try {
            await withPlatform("linux", () => withPath(base, () => {
                assert.equal(sandboxSupported(), false, "an absent bwrap is not a supported backend");
                writeBwrapStub(base, "#!/bin/sh\nexit 0\n", 0o644);
                assert.equal(sandboxSupported(), false, "a non-executable bwrap is not a supported backend");
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.spawn-policy
    // @covers sandbox.spawn-policy
    // @level unit
    it("errors explicitly without bwrap but default-on degrades to a direct command", async () => {
        const base = mkdtempSync(join(tmpdir(), "sbxcore-policy-"));
        const writable = join(base, "work");
        mkdirSync(writable, { recursive: true });
        try {
            await withPlatform("linux", () => withPath(base, () => {
                const args = sandboxArgs(base, writable);
                assert.equal(
                    maybeBuildSandboxCommand(args, { sandboxEnabled: true, explicitSandbox: false }),
                    undefined,
                    "default-on mode must preserve the direct-execution degradation when bwrap is absent",
                );
                assert.throws(
                    () => maybeBuildSandboxCommand(args, { sandboxEnabled: true, explicitSandbox: true }),
                    /Linux sandbox requires executable bubblewrap \(bwrap\) on PATH/i,
                );
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.spawn-policy
    // @covers sandbox.spawn-policy
    // @level unit
    it("bypasses backend discovery and wrapper construction for sandbox:false", async () => {
        const base = mkdtempSync(join(tmpdir(), "sbxcore-opt-out-"));
        const writable = join(base, "work");
        mkdirSync(writable, { recursive: true });
        try {
            await withPlatform("linux", () => withUnreadablePath(() => {
                assert.equal(
                    maybeBuildSandboxCommand(sandboxArgs(base, writable), {
                        sandboxEnabled: false,
                        explicitSandbox: false,
                    }),
                    undefined,
                );
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.command-wrapper
    // @covers sandbox.command-wrapper
    // @level unit
    it("builds the Linux bubblewrap topology with canonical workdir and original argv", async () => {
        const base = mkdtempSync(join(tmpdir(), "sbxcore-bwrap-command-"));
        const writable = join(base, "work");
        mkdirSync(writable, { recursive: true });
        writeBwrapStub(base, "#!/bin/sh\nexit 0\n");
        try {
            await withPlatform("linux", () => withPath(base, () => {
                const args = sandboxArgs(base, writable);
                const cmd = buildSandboxCommand(args);
                const canonicalWorkdir = realpathSync(writable);
                assert.equal(cmd.file, join(base, "bwrap"));
                assert.deepEqual(cmd.fileArgs, [
                    "--ro-bind", "/", "/",
                    "--bind", canonicalWorkdir, canonicalWorkdir,
                    "--bind", "/tmp", "/tmp",
                    "--dev", "/dev",
                    "--", "/usr/bin/true", "-p", "--mode", "json", "original prompt",
                ]);
                assert.equal(cmd.fileArgs.includes("--unshare-net"), false, "network must remain shared");
                assert.equal(cmd.fileArgs.includes("--die-with-parent"), false, "detached children must remain durable");
                assert.equal(cmd.fileArgs.some((arg) => arg.includes(".pi")), false, "~/.pi must have no writable binding");
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.spawn-policy
    // @covers sandbox.spawn-policy
    // @level integration
    it("fails closed after bwrap selection and never executes the direct child", async () => {
        const base = mkdtempSync(join(tmpdir(), "sbxcore-fail-closed-"));
        const writable = join(base, "work");
        const backendMarker = join(base, "backend-ran");
        const directMarker = join(base, "direct-child-ran");
        mkdirSync(writable, { recursive: true });
        writeBwrapStub(base, `#!/bin/sh\nprintf backend > '${backendMarker}'\nexit 73\n`);
        try {
            await withPlatform("linux", () => withPath(base, () => {
                const args = sandboxArgs(base, writable);
                args.execPath = "/bin/sh";
                args.execArgs = ["-c", 'printf direct-child > "$1"', "sh", directMarker];
                const cmd = maybeBuildSandboxCommand(args, { sandboxEnabled: true, explicitSandbox: true });
                assert.ok(cmd, "an executable bwrap must be selected");

                const spawned = spawnSync(cmd.file, cmd.fileArgs, { cwd: writable });
                assert.equal(spawned.status, 73);
                assert.equal(existsSync(backendMarker), true, "the selected backend was invoked");
                assert.equal(existsSync(directMarker), false, "a failed backend must never retry the child bare");
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});

describe("sandbox-core support diagnostics", () => {
    // @covers sandbox.backend-selection
    // @level unit
    it("names the selected backend and its executable per platform", () => {
        assert.deepEqual(describeSandboxSupport({ platform: () => "darwin" }), {
            supported: true,
            platform: "darwin",
            backend: "macos-seatbelt",
            executable: "/usr/bin/sandbox-exec",
        });
        assert.deepEqual(
            describeSandboxSupport({
                platform: () => "linux",
                lookupExecutable: (name) => (name === "bwrap" ? "/opt/bin/bwrap" : undefined),
            }),
            {
                supported: true,
                platform: "linux",
                backend: "linux-bubblewrap",
                executable: "/opt/bin/bwrap",
            },
        );
    });

    // @covers sandbox.backend-selection
    // @level unit
    it("explains why an unsupported platform or missing backend has none", () => {
        const linux = describeSandboxSupport({ platform: () => "linux", lookupExecutable: () => undefined });
        assert.equal(linux.supported, false);
        assert.match(linux.reason, /bubblewrap \(bwrap\) on PATH/);

        const windows = describeSandboxSupport({ platform: () => "win32" });
        assert.equal(windows.supported, false);
        assert.match(windows.reason, /unsupported on win32/);
    });

    // @covers sandbox.backend-selection
    // @level unit
    it("routes backend discovery through the injected seams instead of the host", () => {
        let looked = 0;
        const seams = {
            platform: () => "linux",
            lookupExecutable: () => {
                looked += 1;
                return "/seam/bwrap";
            },
        };
        assert.equal(sandboxSupported(seams), true);
        assert.equal(looked, 1, "discovery must ask the injected lookup, not scan the real PATH");
    });
});

describe("sandbox-core write policy compilation and containment", () => {
    // @covers sandbox.write-containment
    // @level unit
    it("canonicalizes a target that does not exist yet through its real parent", () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-canon-")));
        const real = join(base, "real");
        const alias = join(base, "alias");
        mkdirSync(real, { recursive: true });
        symlinkSync(real, alias);
        try {
            assert.equal(canonicalizePath(join(alias, "not-created-yet.txt")), join(real, "not-created-yet.txt"));
            assert.equal(canonicalizePath(alias), real);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.write-containment
    // @level unit
    it("compiles a policy to canonical, deduplicated, ordered paths", () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-compile-")));
        const root = join(base, "project");
        const alias = join(base, "project-alias");
        mkdirSync(root, { recursive: true });
        symlinkSync(root, alias);
        try {
            const compiled = compileWritePolicy({
                writableRoot: alias,
                home: "/home/who",
                denyWrite: [join(alias, ".env"), join(root, ".env"), join(alias, ".git/hooks")],
            });
            assert.equal(compiled.writableRoot, root, "a symlink alias must not become the writable root");
            assert.deepEqual(
                compiled.denyWrite,
                [join(root, ".git/hooks"), join(root, ".env")].sort(),
                "deny entries must canonicalize, deduplicate, and order",
            );
            assert.equal(compiled.home, "/home/who");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.write-containment
    // @level unit
    it("permits writes inside the root and refuses outside, denied, and alias paths", () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-contain-")));
        const root = join(base, "project");
        const outside = join(base, "elsewhere");
        mkdirSync(join(root, ".git", "hooks"), { recursive: true });
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "target.txt"), "outside");
        symlinkSync(join(outside, "target.txt"), join(root, "escape-link"));
        try {
            const policy = compileWritePolicy({
                writableRoot: root,
                home: base,
                denyWrite: [join(root, ".git/hooks"), join(root, ".env")],
            });

            assert.deepEqual(evaluateWriteAccess(join(root, "src/app.ts"), policy), {
                allowed: true,
                path: join(root, "src/app.ts"),
            });

            assert.deepEqual(evaluateWriteAccess(join(outside, "new.txt"), policy), {
                allowed: false,
                path: join(outside, "new.txt"),
                reason: "outside-writable-root",
            });

            assert.deepEqual(evaluateWriteAccess(join(root, ".env"), policy), {
                allowed: false,
                path: join(root, ".env"),
                reason: "write-denied",
                deniedBy: join(root, ".env"),
            });

            assert.deepEqual(evaluateWriteAccess(join(root, ".git/hooks/pre-commit"), policy), {
                allowed: false,
                path: join(root, ".git/hooks/pre-commit"),
                reason: "write-denied",
                deniedBy: join(root, ".git/hooks"),
            });

            const throughSymlink = evaluateWriteAccess(join(root, "escape-link"), policy);
            assert.equal(throughSymlink.allowed, false, "a symlink inside the root must not reach outside it");
            assert.equal(throughSymlink.path, join(outside, "target.txt"));

            const siblingPrefix = evaluateWriteAccess(`${root}-sibling/file.txt`, policy);
            assert.equal(siblingPrefix.allowed, false, "a sibling sharing the root's name prefix is outside it");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.command-wrapper
    // @level unit
    it("compiles denied paths into macOS deny rules that follow the allowances", async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-macos-deny-")));
        const root = join(base, "project");
        mkdirSync(root, { recursive: true });
        try {
            await withPlatform("darwin", () => {
                const profilePath = join(base, "profile.sb");
                buildSandboxCommand({
                    profilePath,
                    policy: { writableRoot: root, home: base, denyWrite: [join(root, ".env")] },
                    execPath: "/usr/bin/true",
                    execArgs: [],
                });
                const body = readFileSync(profilePath, "utf8");
                const allowRoot = body.indexOf(`(allow file-write* (subpath "${root}"))`);
                const denyEnv = body.indexOf(`(deny file-write* (subpath "${join(root, ".env")}"))`);
                assert.ok(allowRoot >= 0, `profile must allow the root:\n${body}`);
                assert.ok(denyEnv >= 0, `profile must deny the denied path:\n${body}`);
                assert.ok(denyEnv > allowRoot, "SBPL applies the last match, so deny rules must come after allows");
            });
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.command-wrapper
    // @level unit
    it("never overwrites a denied path that already exists", async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-linux-keep-")));
        const root = join(base, "project");
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, ".env"), "SECRET=original\n");
        writeBwrapStub(base, "#!/bin/sh\nexit 0\n");
        try {
            await withPlatform("linux", () => withPath(base, () => {
                const cmd = buildSandboxCommand({
                    profilePath: join(base, "unused.sb"),
                    policy: { writableRoot: root, home: base, denyWrite: [join(root, ".env")] },
                    execPath: "/usr/bin/true",
                    execArgs: [],
                });
                assert.ok(cmd.fileArgs.includes("--ro-bind"));
                assert.equal(cmd.fileArgs.includes("--ro-bind-try"), false);
            }));
            assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=original\n");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.command-wrapper
    // @level unit
    it("leaves a denied directory alone instead of standing a file in its place", async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-linux-dir-")));
        const root = join(base, "project");
        const denied = join(root, ".git", "hooks");
        mkdirSync(denied, { recursive: true });
        writeFileSync(join(denied, "pre-commit"), "#!/bin/sh\nexit 0\n");
        writeBwrapStub(base, "#!/bin/sh\nexit 0\n");
        try {
            await withPlatform("linux", () => withPath(base, () => {
                const cmd = buildSandboxCommand({
                    profilePath: join(base, "unused.sb"),
                    policy: { writableRoot: root, home: base, denyWrite: [denied] },
                    execPath: "/usr/bin/true",
                    execArgs: [],
                });
                assert.deepEqual(cmd.fileArgs.slice(-5, -2), ["--ro-bind", denied, denied]);
            }));
            assert.equal(statSync(denied).isDirectory(), true);
            assert.equal(readFileSync(join(denied, "pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.command-wrapper
    // @level unit
    it("creates no placeholder for a denied path the sandbox never makes writable", async () => {
        // Not tmpdir(): on Linux that IS /tmp, which the sandbox rebinds
        // writable, so a fixture there would sit inside the very region this
        // case exists to stay out of. /var/tmp is outside both backends'
        // writable allowances on both platforms.
        const base = realpathSync(mkdtempSync(join(realpathSync("/var/tmp"), "sbxcore-linux-elsewhere-")));
        const root = join(base, "project");
        mkdirSync(root, { recursive: true });
        // Outside the writable root and outside the /tmp rebind, so the
        // read-only bind of / already covers it: materializing here would
        // litter the host to deny nothing new.
        const elsewhere = join(base, "elsewhere", "secret");
        writeBwrapStub(base, "#!/bin/sh\nexit 0\n");
        try {
            await withPlatform("linux", () => withPath(base, () => {
                const cmd = buildSandboxCommand({
                    profilePath: join(base, "unused.sb"),
                    policy: { writableRoot: root, home: base, denyWrite: [elsewhere] },
                    execPath: "/usr/bin/true",
                    execArgs: [],
                });
                assert.deepEqual(cmd.fileArgs.slice(-5, -2), ["--ro-bind-try", elsewhere, elsewhere]);
            }));
            assert.equal(existsSync(join(base, "elsewhere")), false);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.command-wrapper
    // @level unit
    it("falls back to a try-bind for a denied path this user cannot create", async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-linux-uncreatable-")));
        const root = join(base, "project");
        mkdirSync(root, { recursive: true });
        // The parent is a regular file, so nothing can exist beneath it — and a
        // confined process running as this same user cannot create it either.
        writeFileSync(join(root, "blocked"), "not a directory\n");
        const denied = join(root, "blocked", "secret");
        writeBwrapStub(base, "#!/bin/sh\nexit 0\n");
        try {
            await withPlatform("linux", () => withPath(base, () => {
                const cmd = buildSandboxCommand({
                    profilePath: join(base, "unused.sb"),
                    policy: { writableRoot: root, home: base, denyWrite: [denied] },
                    execPath: "/usr/bin/true",
                    execArgs: [],
                });
                assert.deepEqual(cmd.fileArgs.slice(-5, -2), ["--ro-bind-try", denied, denied]);
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.command-wrapper
    // @level unit
    it("compiles denied paths into Linux read-only binds layered over the writable root", async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-linux-deny-")));
        const root = join(base, "project");
        mkdirSync(root, { recursive: true });
        writeBwrapStub(base, "#!/bin/sh\nexit 0\n");
        try {
            await withPlatform("linux", () => withPath(base, () => {
                const cmd = buildSandboxCommand({
                    profilePath: join(base, "unused.sb"),
                    policy: { writableRoot: root, home: base, denyWrite: [join(root, ".env")] },
                    execPath: "/usr/bin/true",
                    execArgs: [],
                });
                // A hard --ro-bind, not --ro-bind-try: the absent .env was
                // materialized first, because bubblewrap skips a bind whose
                // source does not exist and would otherwise deny nothing.
                assert.deepEqual(cmd.fileArgs, [
                    "--ro-bind", "/", "/",
                    "--bind", root, root,
                    "--bind", "/tmp", "/tmp",
                    "--dev", "/dev",
                    "--ro-bind", join(root, ".env"), join(root, ".env"),
                    "--", "/usr/bin/true",
                ]);
                assert.equal(readFileSync(join(root, ".env"), "utf8"), "");
            }));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});
