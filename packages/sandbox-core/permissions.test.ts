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

function linuxTempFixture(run: (base: string, project: string, home: string) => void): void {
    const base = realpathSync(mkdtempSync("/tmp/sbx-compat-"));
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
const macRuntime = {
    ...mac,
    getconf: (name: "DARWIN_USER_TEMP_DIR" | "DARWIN_USER_CACHE_DIR") =>
        `/var/folders/ab/current-user/${name === "DARWIN_USER_TEMP_DIR" ? "T" : "C"}/`,
};

function mountIndex(argv: readonly string[], option: string, path: string): number {
    return argv.findIndex((arg, index) => arg === option && argv[index + 1] === path && argv[index + 2] === path);
}

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

    it("exposes only the fixed helper executable when the outside root is hidden", () => fixture((base, project, home) => {
        const request = args(base, project, home);
        request.execPath = "/opt/task-runtime/bin/node";
        const ordinary = buildSandboxCommand(request, linux);
        assert.equal(ordinary.fileArgs.includes("/opt/task-runtime/bin/node", 0), true); // argv only
        request.internalHelperExecutable = true;
        const helper = buildSandboxCommand(request, linux);
        assert.ok(helper.fileArgs.join(" ").includes("--ro-bind /opt/task-runtime/bin/node /opt/task-runtime/bin/node"));
        assert.equal(ordinary.fileArgs.join(" ").includes("--ro-bind /opt/task-runtime/bin/node"), false);
        assert.equal(helper.fileArgs.join(" ").includes("--ro-bind /opt /opt"), false);
    }));

    it("keeps protected anchors read-only inside writable runtime directories", () => fixture((base, project, home) => {
        const scratch = join(base, "scratch");
        mkdirSync(scratch);
        const anchor = join(scratch, ".sandbox-anchor");
        writeFileSync(anchor, "");
        const request = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read" });
        request.policy.runtimeWrite = [scratch];
        request.policy.denyWrite = [anchor];
        const command = buildSandboxCommand(request, linux);
        const writable = command.fileArgs.indexOf("--bind", command.fileArgs.indexOf(scratch) - 1);
        assert.ok(writable >= 0);
        assert.ok(command.fileArgs.join(" ").includes(`--ro-bind ${anchor} ${anchor}`));
        request.policy.denyWrite = [base];
        assert.throws(() => buildSandboxCommand(request, linux), /write-denied|overlaps protected/);
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

describe("bounded default runtime compatibility", () => {
    it("adds only canonical temp and MDS paths on macOS when enabled with visible outside files", () => fixture((base, project, home) => {
        const request = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read" });
        const temp = "/private/var/folders/ab/current-user/T";
        const mds = "/private/var/folders/ab/current-user/C/mds";
        const tmp = realpathSync("/tmp");
        request.policy.runtimeCompatibility = true;
        const policy = compileWritePolicy(request.policy, macRuntime);
        assert.deepEqual(policy.compatibilityWrite, [tmp, temp, mds]);
        assert.equal(evaluateWriteAccess("/tmp/install.log", policy, macRuntime).allowed, true);
        for (const path of [join(tmp, "install.log"), join(temp, "work"), join(mds, "mds.lock"), join(mds, "database")]) {
            assert.equal(evaluateWriteAccess(path, policy, macRuntime).allowed, true, path);
        }
        for (const path of [join(base, "arbitrary.lock"), "/private/var/folders/ab/current-user/C/unrelated",
            "/private/var/folders/other-user/C/mds/mds.lock", join(home, ".pi/other.lock")]) {
            assert.equal(evaluateWriteAccess(path, policy, macRuntime).allowed, false, path);
        }
        buildSandboxCommand(request, macRuntime);
        const profile = readFileSync(request.profilePath, "utf8");
        for (const path of policy.compatibilityWrite!) {
            assert.ok(profile.includes(`(allow file-write* (subpath "${path}"))`));
            assert.ok(profile.includes(`(deny file-write-unlink (literal "${path}"))`));
        }
        assert.equal(profile.includes('(allow file-write* (subpath "/private/var/folders"))'), false);
        const protectedRequest = args(base, project, join(tmp, "synthetic-home"),
            { ...modes, outsideProject: "read", storedCredentials: "read" });
        protectedRequest.policy.runtimeCompatibility = true;
        protectedRequest.policy.denyWrite = [join(tmp, "control")];
        const protectedPolicy = compileWritePolicy(protectedRequest.policy, macRuntime);
        assert.equal(evaluateWriteAccess(join(tmp, "synthetic-home/.npmrc"), protectedPolicy, macRuntime).allowed, false);
        assert.equal(evaluateWriteAccess(join(tmp, "control/state"), protectedPolicy, macRuntime).allowed, false);
        buildSandboxCommand(protectedRequest, macRuntime);
        const protectedProfile = readFileSync(protectedRequest.profilePath, "utf8");
        const tmpAllow = protectedProfile.indexOf(`(allow file-write* (subpath "${tmp}"))`);
        assert.ok(protectedProfile.indexOf(`(deny file-write* (subpath "${join(tmp, "synthetic-home/.npmrc")}"))`) > tmpAllow);
        assert.ok(protectedProfile.indexOf(`(deny file-write* (subpath "${join(tmp, "control")}"))`) > tmpAllow);
        assert.ok(protectedProfile.includes(`(deny file-write-unlink (literal "${tmp}"))`));
    }));

    it("leaves standalone defaults and Outside Off unchanged", () => fixture((base, project, home) => {
        let calls = 0;
        const seams = { ...macRuntime, getconf: (name: "DARWIN_USER_TEMP_DIR" | "DARWIN_USER_CACHE_DIR") => {
            calls++;
            return macRuntime.getconf(name);
        } };
        for (const outsideProject of ["off", "read"] as const) {
            const policy = compileWritePolicy({ writableRoot: project, home,
                permissions: { ...modes, outsideProject } }, seams);
            assert.deepEqual(policy.compatibilityWrite, []);
        }
        const off = compileWritePolicy({ writableRoot: project, home, runtimeCompatibility: true,
            permissions: { ...modes, outsideProject: "off" } }, seams);
        assert.deepEqual(off.compatibilityWrite, []);
        assert.equal(calls, 0);
        assert.equal(evaluateWriteAccess("/private/var/folders/ab/current-user/C/mds/mds.lock", off, seams).allowed, false);
        const linuxOff = compileWritePolicy({ writableRoot: project, home, runtimeCompatibility: true,
            permissions: { ...modes, outsideProject: "off" } }, linux);
        assert.deepEqual(linuxOff.compatibilityWrite, []);
        const offCommand = args(base, project, home);
        offCommand.policy.runtimeCompatibility = true;
        const wrapper = buildSandboxCommand(offCommand, linux);
        assert.ok(wrapper.fileArgs.join(" ").includes("--tmpfs /tmp"));
        assert.equal(wrapper.fileArgs.join(" ").includes("--bind /tmp /tmp"), false);
    }));

    it("rejects redirected, broad, overlapping and unavailable macOS discovery", () => fixture((base, project, home) => {
        const request = { writableRoot: project, home, runtimeCompatibility: true,
            permissions: { ...modes, outsideProject: "read" as const } };
        for (const raw of ["/", home, "/var/folders/ab/current-user/C/../T", "/var/folders/ab/current-user/T/../../other"])
            assert.throws(() => compileWritePolicy(request, { ...macRuntime, getconf: () => raw }), /runtime directory/);
        assert.throws(() => compileWritePolicy(request, { ...macRuntime, getconf: () => undefined }), /Invalid.*runtime directory/);
        assert.throws(() => compileWritePolicy({ ...request, home: "/private/var/folders/ab/current-user/T/home" }, macRuntime),
            /Unsafe.*runtime directory/);
        assert.throws(() => compileWritePolicy({ ...request, writableRoot: "/private/var/folders/ab/current-user/C/mds/project" }, macRuntime),
            /Unsafe.*runtime directory/);
        const redirected = { ...macRuntime, canonicalize: (path: string) =>
            path === "/private/var/folders/ab/current-user/T" ? home : path };
        assert.throws(() => compileWritePolicy(request, redirected), /Unsafe.*runtime directory/);
        const mdsAlias = { ...macRuntime, canonicalize: (path: string) =>
            path === "/private/var/folders/ab/current-user/C/mds" ? home : path };
        assert.throws(() => compileWritePolicy(request, mdsAlias), /Unsafe MDS/);
    }));

    it("keeps project permissions stricter than overlapping compatibility temp grants", () => {
        const root = "/private/var/folders/ab/current-user/T/project";
        const policy = compileWritePolicy({ writableRoot: root, home: "/Users/example", runtimeCompatibility: true,
            permissions: { ...modes, outsideProject: "read", projectFiles: "read", storedCredentials: "read" } }, macRuntime);
        assert.equal(evaluateWriteAccess(join(root, "data"), policy, macRuntime).allowed, false);
        assert.equal(evaluateWriteAccess("/private/var/folders/ab/current-user/T/ordinary.log", policy, macRuntime).allowed, true);
    });

    it("preserves credential and control precedence over compatibility", () => linuxTempFixture((base, project, home) => {
        const credential = join(home, ".npmrc");
        symlinkSync(home, join(base, "home-alias"));
        const control = join(base, "control");
        mkdirSync(control);
        const request = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read" });
        request.policy.runtimeCompatibility = true;
        request.policy.denyWrite = [control];
        const policy = compileWritePolicy(request.policy, linux);
        assert.equal(evaluateWriteAccess(join(base, "install.log"), policy, linux).allowed, true);
        assert.equal(evaluateWriteAccess(credential, policy, linux).allowed, false);
        assert.equal(evaluateWriteAccess(join(base, "home-alias/.npmrc"), policy, linux).allowed, false);
        assert.deepEqual(evaluateWriteAccess(join(control, "state"), policy, linux), {
            allowed: false, path: join(control, "state"), reason: "write-denied", deniedBy: control,
        });
        const wrapper = buildSandboxCommand(request, linux);
        const argv = wrapper.fileArgs.join(" ");
        assert.ok(argv.includes(`--ro-bind ${home} ${home}`));
        assert.ok(argv.includes(`--ro-bind ${control} ${control}`));
        assert.ok(argv.includes(`--bind ${base} ${base}`));
        assert.ok(argv.indexOf(`--bind ${project} ${project}`) < argv.indexOf(`--ro-bind ${home} ${home}`));
    }));

    it("orders every writable ancestor before sibling read-only guards and anchors a nested project", () => linuxTempFixture((base, _project, home) => {
        const container = join(base, "container");
        const project = join(container, "project");
        const first = join(base, "control-a");
        const second = join(base, "control-b");
        const runtime = join(base, "runtime");
        mkdirSync(project, { recursive: true });
        mkdirSync(first);
        mkdirSync(second);
        mkdirSync(runtime);
        const request = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read" });
        request.policy.runtimeCompatibility = true;
        request.policy.runtimeWrite = [runtime];
        request.policy.denyWrite = [first, second];
        const argv = buildSandboxCommand(request, linux).fileArgs;
        for (const ancestor of [base, container]) {
            const index = mountIndex(argv, "--bind", ancestor);
            assert.ok(index >= 0 && index < mountIndex(argv, "--bind", project), ancestor);
            for (const guard of [first, second, home]) {
                assert.ok(index < mountIndex(argv, "--ro-bind", guard), `${ancestor} must precede ${guard}`);
            }
        }
        const firstGuard = mountIndex(argv, "--ro-bind", first);
        assert.ok(firstGuard >= 0);
        assert.ok(mountIndex(argv, "--bind", runtime) < firstGuard);
        assert.equal(argv.slice(firstGuard + 3).includes("--bind"), false, "no writable bind after the first guard");
        assert.ok(mountIndex(argv, "--ro-bind", home) > mountIndex(argv, "--bind", base));

        request.policy.permissions = { ...request.policy.permissions!, projectFiles: "read" };
        const readArgv = buildSandboxCommand(request, linux).fileArgs;
        assert.ok(mountIndex(readArgv, "--bind", container) < mountIndex(readArgv, "--ro-bind", project));
        request.policy.permissions = { ...request.policy.permissions!, outsideProject: "off", projectFiles: "off" };
        const offArgv = buildSandboxCommand(request, linux).fileArgs;
        assert.ok(offArgv.includes("--tmpfs"));
        assert.equal(mountIndex(offArgv, "--bind", container), -1);
        assert.equal(mountIndex(offArgv, "--bind", project), -1);
    }));

    it("keeps a project beneath a guarded home writable without reopening credential siblings", () => linuxTempFixture((base, _project, home) => {
        const project = join(home, "work", "project");
        mkdirSync(project, { recursive: true });
        const request = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read" });
        request.policy.runtimeCompatibility = true;
        const argv = buildSandboxCommand(request, linux).fileArgs;
        assert.ok(mountIndex(argv, "--ro-bind", home) < mountIndex(argv, "--ro-bind", join(home, "work")));
        assert.ok(mountIndex(argv, "--ro-bind", join(home, "work")) < mountIndex(argv, "--bind", project));
    }));

    it("does not create absent protected leaves in host tmp and fails closed when unmaskable", () => linuxTempFixture((base, project, home) => {
        const missing = join(base, "control", "not-created");
        const request = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read" });
        request.policy.runtimeCompatibility = true;
        request.policy.denyWrite = [missing];
        const wrapper = buildSandboxCommand(request, linux);
        assert.equal(existsSync(missing), false);
        assert.ok(wrapper.fileArgs.join(" ").includes(`--ro-bind ${base} ${base}`));
        request.policy.denyWrite = [join(realpathSync("/tmp"), `absent-${process.pid}`, "state")];
        assert.throws(() => buildSandboxCommand(request, linux), /Cannot protect an absent path/);
        request.policy.denyWrite = [realpathSync("/tmp")];
        assert.throws(() => buildSandboxCommand(request, linux), /write-denied directory|write-denied control path/);
        request.policy.denyWrite = [];
        request.policy.permissions = { ...request.policy.permissions!, storedCredentials: "off" };
        assert.throws(() => buildSandboxCommand(request, linux), /hide stored credentials/);
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

describe("Linux compatibility guards (real kernel)", { skip: !linuxKernel }, () => {
    it("keeps sibling controls and credential files denied while ordinary tmp and project writes work", () => linuxTempFixture((base, project, home) => {
        const controls = [join(base, "control-a"), join(base, "control-b")];
        for (const control of controls) mkdirSync(control);
        // Materialize every synthetic credential so the two file denials cannot
        // pass merely because an absent sibling caused the whole home to be guarded.
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        delete process.env.PI_CODING_AGENT_DIR;
        try {
            for (const path of credentialFilePaths(home)) {
                mkdirSync(join(path, ".."), { recursive: true });
                if ([".ssh", ".aws", "gh", "gcloud", ".azure", ".kube"].includes(path.split("/").at(-1)!)) {
                    mkdirSync(path, { recursive: true });
                } else {
                    writeFileSync(path, "synthetic-only");
                }
            }
            const credentials = [join(home, ".npmrc"), join(home, ".netrc")];
            const request = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read", network: true });
            request.policy.runtimeCompatibility = true;
            request.policy.denyWrite = controls;
            request.execArgs = ["-c", [
                `printf ok > '${join(base, "ordinary")}'`,
                "printf ok > ordinary-project",
                ...controls.map((path) => `if printf no > '${join(path, "state")}' 2>/dev/null; then exit 11; fi`),
                ...credentials.map((path) => `if printf no > '${path}' 2>/dev/null; then exit 12; fi`),
            ].join("; ")];
            const wrapper = buildSandboxCommand(request);
            for (const credential of credentials) {
                assert.ok(mountIndex(wrapper.fileArgs, "--ro-bind", credential) >= 0, credential);
            }
            const result = spawnSync(wrapper.file, wrapper.fileArgs, { cwd: project, encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(readFileSync(join(base, "ordinary"), "utf8"), "ok");
            assert.equal(readFileSync(join(project, "ordinary-project"), "utf8"), "ok");
            for (const control of controls) assert.equal(existsSync(join(control, "state")), false);
            for (const credential of credentials) assert.equal(readFileSync(credential, "utf8"), "synthetic-only");
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    }));

    it("prevents renaming a project ancestor and redirecting the captured root on the next launch", () => linuxTempFixture((base, _project, home) => {
        const container = join(base, "container");
        const project = join(container, "project");
        const target = join(base, "target");
        mkdirSync(project, { recursive: true });
        mkdirSync(join(target, "project"), { recursive: true });
        for (const projectFiles of ["read-write", "read"] as const) {
            const request = args(base, project, home, { ...modes, outsideProject: "read", storedCredentials: "read", projectFiles, network: true });
            request.policy.runtimeCompatibility = true;
            request.execArgs = ["-c", `mv '${container}' '${container}-moved' && ln -s '${target}' '${container}'`];
            const captured = buildSandboxCommand(request);
            const attempt = spawnSync(captured.file, captured.fileArgs, { cwd: project, encoding: "utf8" });
            assert.notEqual(attempt.status, 0, `ancestor rename succeeded: ${attempt.stderr}`);
            assert.equal(realpathSync(container), container);
            request.execArgs = ["-c", projectFiles === "read-write" ? "printf ok > marker" : "test -d . && ! (printf no > marker 2>/dev/null)"];
            const next = buildSandboxCommand(request);
            const result = spawnSync(next.file, next.fileArgs, { cwd: project, encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(existsSync(join(target, "project", "marker")), false);
        }
        assert.equal(readFileSync(join(project, "marker"), "utf8"), "ok");
        const nested = join(home, "work", "project");
        mkdirSync(nested, { recursive: true });
        const nestedRequest = args(base, nested, home, { ...modes, outsideProject: "read", storedCredentials: "read", network: true });
        nestedRequest.policy.runtimeCompatibility = true;
        nestedRequest.execArgs = ["-c", "printf ok > marker"];
        const nestedWrapper = buildSandboxCommand(nestedRequest);
        const nestedResult = spawnSync(nestedWrapper.file, nestedWrapper.fileArgs, { cwd: nested, encoding: "utf8" });
        assert.equal(nestedResult.status, 0, nestedResult.stderr);
        assert.equal(readFileSync(join(nested, "marker"), "utf8"), "ok");
        const hidden = args(base, project, home, { ...modes, outsideProject: "off", projectFiles: "off", storedCredentials: "off", network: true });
        hidden.policy.runtimeCompatibility = true;
        hidden.execArgs = ["-c", `test ! -e '${project}'`];
        const wrapper = buildSandboxCommand(hidden);
        const result = spawnSync(wrapper.file, wrapper.fileArgs, { cwd: "/", encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
    }));
});

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
