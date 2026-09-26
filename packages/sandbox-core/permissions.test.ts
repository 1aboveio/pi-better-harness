import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildSandboxCommand, compileWritePolicy, credentialFilePaths, evaluateReadAccess,
    evaluateWriteAccess, maybeBuildSandboxCommand, type SandboxCommandArgs,
    type SandboxPermissions,
} from "./index.ts";

const modes: SandboxPermissions = {
    projectFiles: "read-write", outsideProject: "off", storedCredentials: "off",
    commands: true, network: false,
};

function fixture(run: (base: string, project: string, home: string) => void): void {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "sbx-permissions-")));
    const project = join(base, "project");
    const home = join(base, "home");
    mkdirSync(project);
    mkdirSync(home);
    try { run(base, project, home); } finally { rmSync(base, { recursive: true, force: true }); }
}

function args(base: string, project: string, home: string, permissions: SandboxPermissions = modes): SandboxCommandArgs {
    return {
        profilePath: join(base, "profile.sb"),
        policy: { writableRoot: project, home, permissions },
        execPath: "/bin/sh", execArgs: ["-c", "true"],
    };
}

const linux = { platform: () => "linux", lookupExecutable: () => "/usr/bin/bwrap" };
const mac = { platform: () => "darwin" };

describe("shared capability decisions", () => {
    it("preserves legacy reads and write decisions when permissions are absent", () => fixture((base, project, home) => {
        const policy = compileWritePolicy({ writableRoot: project, home });
        assert.deepEqual(evaluateReadAccess(join(base, "elsewhere"), policy), {
            allowed: true, path: join(base, "elsewhere"),
        });
        assert.deepEqual(evaluateWriteAccess(join(base, "elsewhere"), policy), {
            allowed: false, path: join(base, "elsewhere"), reason: "outside-writable-root",
        });
        assert.equal(policy.permissions, undefined);
    }));

    it("applies off/read/read-write, runtime exceptions and explicit denyWrite precedence", () => fixture((base, project, home) => {
        const outside = join(base, "outside");
        const denied = join(project, "control");
        for (const projectFiles of ["off", "read", "read-write"] as const) {
            const policy = compileWritePolicy({ writableRoot: project, home, denyWrite: [denied],
                permissions: { ...modes, projectFiles } });
            assert.equal(evaluateReadAccess(join(project, "file"), policy).allowed, projectFiles !== "off");
            assert.equal(evaluateWriteAccess(join(project, "file"), policy).allowed, projectFiles === "read-write");
            assert.deepEqual(evaluateWriteAccess(denied, policy), {
                allowed: false, path: denied, reason: "write-denied", deniedBy: denied,
            });
            assert.equal(evaluateReadAccess(outside, policy).allowed, false);
            assert.equal(evaluateReadAccess("/usr/bin/env", policy).allowed, true);
        }
        for (const outsideProject of ["off", "read", "read-write"] as const) {
            const policy = compileWritePolicy({ writableRoot: project, home,
                permissions: { ...modes, outsideProject } });
            assert.equal(evaluateReadAccess(outside, policy).allowed, outsideProject !== "off");
            assert.equal(evaluateWriteAccess(outside, policy).allowed, outsideProject === "read-write");
        }
    }));

    it("canonicalizes known credential files and symlink aliases before project/outside modes", () => fixture((base, project, home) => {
        const secret = join(base, "synthetic-secret");
        writeFileSync(secret, "test-only");
        symlinkSync(secret, join(home, ".npmrc"));
        symlinkSync(secret, join(project, "shortcut"));
        const paths = credentialFilePaths(home);
        assert.ok(paths.includes(secret));
        assert.ok(paths.includes(join(home, ".ssh")));
        assert.ok(paths.length >= 11);
        for (const storedCredentials of ["off", "read", "read-write"] as const) {
            const policy = compileWritePolicy({ writableRoot: project, home,
                permissions: { ...modes, storedCredentials } });
            assert.equal(evaluateReadAccess(join(project, "shortcut"), policy).allowed, storedCredentials !== "off");
            assert.equal(evaluateWriteAccess(join(home, ".npmrc"), policy).allowed, storedCredentials === "read-write");
        }
    }));

    it("protects Pi auth in a configured agent directory", () => fixture((base, project, home) => {
        const previous = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = join(project, "agent");
        try {
            const policy = compileWritePolicy({ writableRoot: project, home, permissions: modes });
            const auth = join(project, "agent", "auth.json");
            assert.equal(evaluateReadAccess(auth, policy).allowed, false);
            assert.equal(evaluateWriteAccess(auth, policy).allowed, false);
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previous;
        }
    }));

    it("normalizes macOS Data-volume aliases before credential and project decisions", () => fixture((base, project, home) => {
        if (process.platform !== "darwin") return;
        const credential = join(home, ".npmrc");
        writeFileSync(credential, "synthetic-only");
        const alias = `/System/Volumes/Data${credential}`;
        if (!existsSync(alias)) return;
        const policy = compileWritePolicy({ writableRoot: project, home,
            permissions: { ...modes, outsideProject: "read-write" } });
        assert.equal(evaluateReadAccess(alias, policy).allowed, false);
        assert.equal(evaluateWriteAccess(alias, policy).allowed, false);
    }));

    it("lets credential mode override project/off but never explicit denyWrite", () => fixture((base, project) => {
        const secret = join(project, ".npmrc");
        writeFileSync(secret, "synthetic-only");
        const policy = compileWritePolicy({ writableRoot: project, home: project,
            denyWrite: [secret], permissions: { ...modes, projectFiles: "off", storedCredentials: "read-write" } });
        assert.equal(evaluateReadAccess(secret, policy).allowed, true);
        assert.deepEqual(evaluateWriteAccess(secret, policy), {
            allowed: false, path: secret, reason: "write-denied", deniedBy: secret,
        });
        assert.equal(evaluateReadAccess(join(project, "ordinary"), policy).allowed, false);
    }));

    it("fails closed without a backend when capabilities are requested", () => fixture((base, project, home) => {
        const command = args(base, project, home);
        const unsupported = { platform: () => "win32" };
        assert.throws(() => buildSandboxCommand(command, unsupported), /Cannot enforce sandbox permissions.*unsupported/);
        assert.throws(() => maybeBuildSandboxCommand(command, {
            sandboxEnabled: true, explicitSandbox: false,
        }, unsupported), /Cannot enforce sandbox permissions.*unsupported/);
    }));

    it("blocks both launch entry points when commands are off, including bootstrap", () => fixture((base, project, home) => {
        const command = args(base, project, home, { ...modes, commands: false });
        assert.throws(() => buildSandboxCommand(command, mac), /enable commands.*bootstrap/i);
        assert.throws(() => maybeBuildSandboxCommand(command, { sandboxEnabled: true, explicitSandbox: true }, mac), /enable commands.*bootstrap/i);
    }));
});

describe("backend permission construction", () => {
    it("layers macOS credential, project and denyWrite rules after global and runtime rules", () => fixture((base, project) => {
        const denied = join(project, ".npmrc");
        const command = args(base, project, project, { ...modes, projectFiles: "off", storedCredentials: "read-write" });
        command.policy.denyWrite = [denied];
        buildSandboxCommand(command, mac);
        const profile = readFileSync(command.profilePath, "utf8");
        assert.ok(profile.indexOf("(deny file-read*)") < profile.indexOf(`(deny file-read* (subpath "${project}"))`));
        assert.ok(profile.indexOf(`(deny file-read* (subpath "${project}"))`) <
            profile.indexOf(`(allow file-read* (subpath "${denied}"))`));
        assert.ok(profile.indexOf(`(deny file-write* (subpath "${denied}"))`) >
            profile.indexOf(`(allow file-write* (subpath "${denied}"))`));
        assert.match(profile, /\(deny network\*\)/);
    }));

    it("protects writable ancestors of restricted paths on macOS", () => fixture((base, project, home) => {
        const restricted = args(base, project, home, { ...modes, outsideProject: "read-write" });
        restricted.policy.denyWrite = [join(project, "control", "secret")];
        buildSandboxCommand(restricted, mac);
        const profile = readFileSync(restricted.profilePath, "utf8");
        assert.ok(profile.includes(`(deny file-write-unlink (literal "${project}/control"))`));
        assert.ok(profile.includes(`(deny file-write-unlink (literal "${home}"))`));
    }));

    it("keeps macOS network enabled when the capability is true", () => fixture((base, project, home) => {
        const command = args(base, project, home, { ...modes,
            outsideProject: "read-write", storedCredentials: "read-write", network: true });
        buildSandboxCommand(command, mac);
        const profile = readFileSync(command.profilePath, "utf8");
        assert.ok(profile.indexOf("(allow file-write*)") < profile.indexOf(`(allow file-write* (subpath "${project}"))`));
        assert.equal(profile.includes("(deny network*)"), false);
    }));

    it("rejects a home under a runtime bind when outsideProject is off", () => fixture((base, project) => {
        const command = args(base, project, "/opt/homebrew/synthetic-home");
        assert.throws(() => buildSandboxCommand(command, mac), /cannot expose a home/);
        assert.throws(() => buildSandboxCommand(command, linux), /cannot expose a home/);
    }));

    it("uses a hidden Linux root and private temp, with runtime binds and network namespace", () => fixture((base, project, home) => {
        const command = buildSandboxCommand(args(base, project, home), linux);
        assert.deepEqual(command.fileArgs.slice(0, 2), ["--tmpfs", "/"]);
        assert.ok(command.fileArgs.includes("--ro-bind"));
        assert.ok(command.fileArgs.join(" ").includes(`--bind ${project} ${project}`));
        assert.ok(command.fileArgs.join(" ").includes("--tmpfs /tmp"));
        assert.ok(command.fileArgs.includes("--unshare-net"));
        assert.equal(command.fileArgs.includes("--proc"), false);
    }));

    it("allows Linux read-only outside with readable credentials and isolates project writes", () => fixture((base, project, home) => {
        const command = buildSandboxCommand(args(base, project, home, { ...modes,
            outsideProject: "read", storedCredentials: "read", network: true }), linux);
        assert.deepEqual(command.fileArgs.slice(0, 3), ["--ro-bind", "/", "/"]);
        assert.ok(command.fileArgs.join(" ").includes(`--bind ${project} ${project}`));
        assert.equal(command.fileArgs.includes("--unshare-net"), false);
    }));

    it("rejects Linux projects nested under stricter credential or write-denied ancestors", () => fixture((base, project, home) => {
        const nested = join(home, ".aws", "project");
        mkdirSync(nested, { recursive: true });
        assert.throws(() => buildSandboxCommand(args(base, nested, home), linux), /credential directory contains the project/);
        assert.throws(() => buildSandboxCommand(args(base, nested, home, { ...modes, storedCredentials: "read" }), linux), /credential directory contains the project/);
        const denied = args(base, project, home);
        denied.policy.denyWrite = [base];
        assert.throws(() => buildSandboxCommand(denied, linux), /inside a write-denied directory/);
    }));

    it("mounts protected ancestors and fails closed for impossible visible-root masks", () => fixture((base, project, home) => {
        const denied = args(base, project, home);
        denied.policy.denyWrite = [join(project, "control", "secret")];
        const command = buildSandboxCommand(denied, linux);
        assert.ok(command.fileArgs.join(" ").includes(`--bind ${project}/control ${project}/control`));
        assert.ok(command.fileArgs.join(" ").includes(`--ro-bind ${project}/control/secret ${project}/control/secret`));
        assert.throws(() => buildSandboxCommand(args(base, project, home, { ...modes,
            outsideProject: "read", projectFiles: "off" }), linux), /hide (a project|stored credentials)/);
        mkdirSync(join(home, ".ssh"));
        assert.throws(() => buildSandboxCommand(args(base, project, home, { ...modes,
            outsideProject: "read" }), linux), /hide stored credentials/);
    }));
});

const macKernel = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") &&
    spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
if (process.env.PI_SANDBOX_REQUIRE_BACKEND === "macos-seatbelt" && !macKernel) {
    throw new Error("macOS Seatbelt kernel required but unavailable");
}

const linuxKernel = process.platform === "linux" &&
    spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"]).status === 0;
if (process.env.PI_SANDBOX_REQUIRE_BACKEND === "linux-bubblewrap" && !linuxKernel) {
    throw new Error("Linux Bubblewrap kernel required but unavailable");
}

describe("runtime state and protected ancestors (real kernel)", { skip: !macKernel && !linuxKernel }, () => {
    it("writes an actual Pi session only inside the assigned runtime directory", () => fixture((base, project, home) => {
        const runtime = join(base, "runtime");
        mkdirSync(runtime);
        const command = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read", network: true });
        command.policy.runtimeWrite = [runtime];
        command.execPath = process.execPath;
        command.execArgs = ["--input-type=module", "-e", `
            import { SessionManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
            import { writeFileSync, readFileSync } from 'node:fs';
            const session = SessionManager.create(${JSON.stringify(project)}, ${JSON.stringify(runtime)});
            session.appendMessage({role:'assistant',content:[{type:'text',text:'runtime probe'}],timestamp:Date.now()});
            if (!readFileSync(session.getSessionFile(), 'utf8').includes('runtime probe')) process.exit(3);
            try { writeFileSync(${JSON.stringify(join(base, "forbidden"))}, 'no'); process.exit(4); }
            catch (error) { if (!['EPERM','EACCES','EROFS'].includes(error.code)) throw error; }
        `];
        const wrapper = buildSandboxCommand(command);
        const result = spawnSync(wrapper.file, wrapper.fileArgs, { cwd: project, encoding: "utf8", timeout: 10_000 });
        assert.equal(result.status, 0, `${result.signal}: ${result.stderr}`);
        assert.equal(existsSync(join(base, "forbidden")), false);
    }));

    it("protects a nested leaf and every movable ancestor in a writable project", () => fixture((base, project, home) => {
        mkdirSync(join(project, "parent", "protected"), { recursive: true });
        const secret = join(project, "parent", "protected", "secret");
        writeFileSync(secret, "synthetic-only");
        const command = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read", network: true });
        command.policy.denyWrite = [secret];
        for (const [script, allowed] of [
            ["printf ok > ordinary", true],
            ["mv parent moved", false],
            ["mv parent/protected parent/moved", false],
            ["printf no > parent/protected/secret", false],
        ] as const) {
            command.execArgs = ["-c", script];
            const wrapper = buildSandboxCommand(command);
            const result = spawnSync(wrapper.file, wrapper.fileArgs, { cwd: project, encoding: "utf8" });
            assert.equal(result.status === 0, allowed, `${script}: ${result.stderr}`);
        }
        assert.equal(readFileSync(secret, "utf8"), "synthetic-only");
    }));
});

describe("macOS capability enforcement (real kernel)", { skip: !macKernel }, () => {
    function run(base: string, project: string, home: string, permissions: SandboxPermissions, script: string) {
        const command = args(base, project, home, permissions);
        command.execArgs = ["-c", script];
        const wrapper = buildSandboxCommand(command);
        return spawnSync(wrapper.file, wrapper.fileArgs, { cwd: project, encoding: "utf8" });
    }

    it("enforces project/off, outside/off, credential overrides and denyWrite", () => fixture((base, project, home) => {
        const outside = join(base, "outside");
        const secret = join(home, ".npmrc");
        writeFileSync(outside, "outside-only");
        writeFileSync(secret, "synthetic-only");
        const command = args(base, project, home);
        const check = (script: string, allowed: boolean) => {
            command.execArgs = ["-c", script];
            const wrapper = buildSandboxCommand(command);
            const result = spawnSync(wrapper.file, wrapper.fileArgs, { cwd: project, encoding: "utf8" });
            assert.equal(result.status === 0, allowed, `${script}: ${result.stderr}`);
        };
        check(`printf ok > '${join(project, "allowed")}'`, true);
        check(`head -c 2 '${join(project, "allowed")}' > /dev/null`, true);
        check(`head -c 2 '${outside}' > /dev/null`, false);
        const volumeAlias = `/System/Volumes/Data${outside}`;
        if (existsSync(volumeAlias)) check(`head -c 2 '${volumeAlias}' > /dev/null`, false);
        check(`head -c 2 '${secret}' > /dev/null`, false);
        check(`printf no > '${secret}'`, false);
        check("head -c 2 /usr/bin/env > /dev/null", true);
        assert.equal(readFileSync(secret, "utf8"), "synthetic-only");
        assert.equal(run(base, project, home, { ...modes, projectFiles: "off" },
            `head -c 2 '${join(project, "allowed")}' > /dev/null`).status === 0, false);
        assert.equal(run(base, project, home, { ...modes, projectFiles: "read" },
            `printf no > '${join(project, "allowed")}'`).status === 0, false);
        assert.equal(run(base, project, home, { ...modes, outsideProject: "read" },
            `head -c 2 '${outside}' > /dev/null`).status, 0);
        assert.equal(run(base, project, home, { ...modes, storedCredentials: "read" },
            `head -c 2 '${secret}' > /dev/null`).status, 0);
    }));

    it("uses last-match precedence for credentials inside an off project and denyWrite", () => fixture((base, project) => {
        const secret = join(project, ".npmrc");
        writeFileSync(secret, "synthetic-only");
        const command = args(base, project, project, { ...modes, projectFiles: "off", storedCredentials: "read-write" });
        command.policy.denyWrite = [secret];
        const execute = (script: string) => {
            command.execArgs = ["-c", script];
            const wrapper = buildSandboxCommand(command);
            return spawnSync(wrapper.file, wrapper.fileArgs, { cwd: project, encoding: "utf8" });
        };
        assert.equal(execute(`head -c 2 '${secret}' > /dev/null`).status, 0);
        assert.notEqual(execute(`printf no > '${secret}'`).status, 0);
        assert.notEqual(execute(`printf no > '${join(project, "ordinary")}'`).status, 0);
        assert.equal(readFileSync(secret, "utf8"), "synthetic-only");
    }));

    it("keeps default project writes usable without allowing protected ancestor replacement", () => fixture((base, project, home) => {
        mkdirSync(join(project, "protected"));
        const secret = join(project, "protected", "secret");
        writeFileSync(secret, "synthetic-only");
        const command = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read", network: true });
        command.policy.denyWrite = [secret];
        const execute = (script: string) => {
            command.execArgs = ["-c", script];
            const wrapper = buildSandboxCommand(command);
            return spawnSync(wrapper.file, wrapper.fileArgs, { cwd: project, encoding: "utf8" });
        };
        assert.equal(execute("printf ok > ordinary").status, 0);
        assert.notEqual(execute("mv protected moved").status, 0);
        assert.notEqual(execute("printf no > protected/secret").status, 0);
        assert.equal(readFileSync(secret, "utf8"), "synthetic-only");
    }));

    it("blocks loopback networking when network is false", async () => {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            fixture((base, project, home) => {
                const port = (server.address() as { port: number }).port;
                const command = args(base, project, home);
                command.execPath = process.execPath;
                command.execArgs = ["-e", `const s=require('node:net').connect(${port},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(2));`];
                const wrapper = buildSandboxCommand(command);
                const result = spawnSync(wrapper.file, wrapper.fileArgs, { cwd: project, encoding: "utf8", timeout: 5000 });
                assert.equal(result.signal, null, `process must initialize: ${result.stderr}`);
                assert.equal(result.status, 2, result.stderr);
                command.policy.permissions = { ...modes, network: true };
                const allowed = buildSandboxCommand(command);
                const connected = spawnSync(allowed.file, allowed.fileArgs, { cwd: project, encoding: "utf8", timeout: 5000 });
                assert.equal(connected.status, 0, connected.stderr);
            });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
