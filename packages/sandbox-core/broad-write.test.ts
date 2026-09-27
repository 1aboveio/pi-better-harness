/**
 * The broad-write profile: write across home and temp, remove only where it is
 * disposable, and keep one fixed deny list. Policy compilation is unit-tested
 * on every platform; the real-kernel suite runs on the macOS Seatbelt and Linux
 * Bubblewrap confinement lanes.
 * @covers sandbox.broad-write
 * @level integration
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    buildSandboxCommand, compileWritePolicy, evaluateDeleteAccess, evaluateReadAccess, evaluateWriteAccess,
    isBroadWritePermissions, isRemovableUnderWrite, resetRecoverySnapshotClock, takeRecoverySnapshot,
    type SandboxPermissions, type SandboxSeams,
} from "./index.ts";

const broad: SandboxPermissions = {
    projectFiles: "read-write", outsideProject: "write", storedCredentials: "read",
    commands: true, network: true,
};

/**
 * A fixture home outside every temp root: a home under temp would make every
 * path in it removable and prove nothing about the home rules.
 */
function fixture(run: (paths: { base: string; home: string; project: string; sibling: string }) => void): void {
    const base = realpathSync(mkdtempSync(join(import.meta.dirname, ".broad-fixture-")));
    const home = join(base, "home");
    const project = join(home, "projects", "task");
    const sibling = join(home, "projects", "other-repo");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(sibling, "src"), { recursive: true });
    writeFileSync(join(sibling, "README.md"), "keep me");
    writeFileSync(join(sibling, "src", "main.ts"), "export {};");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
        run({ base, home, project, sibling });
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        spawnSync("/bin/chmod", ["-R", "u+rwx", base]);
        rmSync(base, { recursive: true, force: true });
    }
}

describe("broad-write policy compilation", () => {
    it("selects the profile only for Outside project = Write", () => {
        assert.equal(isBroadWritePermissions(broad), true);
        assert.equal(isBroadWritePermissions({ ...broad, outsideProject: "read-write" }), false);
        assert.equal(isBroadWritePermissions({ ...broad, outsideProject: "read" }), false);
        fixture(({ home, project }) => {
            const legacy = compileWritePolicy({ writableRoot: project, home, permissions: { ...broad, outsideProject: "read-write" } });
            assert.equal(legacy.broad, undefined);
            assert.equal(legacy.permissions?.storedCredentials, "read");
        });
    });

    it("forces credentials off and decides write, read and removal per path", () => fixture(({ home, project, sibling }) => {
        const policy = compileWritePolicy({
            writableRoot: project, home, permissions: broad, denyWrite: [join(home, ".registry")],
        }, { platform: () => "darwin" });
        assert.equal(policy.permissions?.storedCredentials, "off", "the credential deny list is not optional");
        const darwin: SandboxSeams = { platform: () => "darwin" };
        const write = (path: string) => evaluateWriteAccess(path, policy, darwin).allowed;
        const remove = (path: string) => evaluateDeleteAccess(path, policy, darwin);
        assert.equal(write(join(sibling, "README.md")), true, "sibling repos stay writable in place");
        assert.equal(write(join(home, ".gradle", "wrapper", "x.lck")), true);
        assert.equal(write(join(home, ".ssh", "id_ed25519")), false);
        assert.equal(write(join(home, ".zshrc")), false);
        assert.equal(write(join(home, ".pi", "agent", "settings.json")), false);
        assert.equal(write(join(home, ".registry", "state.json")), false);
        assert.equal(write("/etc/hosts"), false, "writes stay inside home and temp");
        assert.equal(evaluateReadAccess(join(home, ".ssh", "id_ed25519"), policy).allowed, false);
        assert.equal(evaluateReadAccess(join(home, "Library", "Keychains", "login.keychain-db"), policy).allowed, false);
        assert.equal(evaluateReadAccess(join(home, ".zshrc"), policy).allowed, true, "code that runs later stays readable");
        assert.equal(remove(join(sibling, "README.md")).allowed, false);
        assert.deepEqual(remove(join(sibling, "README.md")), { allowed: false, path: join(sibling, "README.md"), reason: "delete-denied" });
        assert.equal(remove(sibling).allowed, false);
        assert.equal(remove(join(project, "build", "out.o")).allowed, true);
        assert.equal(remove(project).allowed, false, "the workspace root itself cannot be removed");
        assert.equal(remove(join(home, "projects")).allowed, false);
        assert.equal(remove(join(home, ".cache", "pip", "wheel")).allowed, true);
        assert.equal(remove(join(home, ".gradle")).allowed, true);
        assert.equal(remove(join(home, "projects", "repo-worktrees", "feature", "file")).allowed, true);
        assert.equal(remove(join(home, "projects", "repo", ".worktrees", "feature", "file")).allowed, true);
        assert.equal(remove(join(home, "projects", "repo-worktrees")).allowed, false, "only a worktree folder's contents");
        assert.equal(remove(join(home, ".config")).allowed, false, "an ancestor of a deny-list entry cannot move");
        assert.equal(remove("/private/tmp/scratch-file").allowed, true);
        const writeAndDelete = compileWritePolicy({ writableRoot: project, home, permissions: { ...broad, outsideProject: "read-write" } }, darwin);
        assert.equal(evaluateDeleteAccess(join(sibling, "README.md"), writeAndDelete, darwin).allowed, true);
    }));

    it("treats Project files = Write as writable but not removable, except worktree folders", () => fixture(({ home, project }) => {
        const darwin: SandboxSeams = { platform: () => "darwin" };
        for (const outsideProject of ["write", "read"] as const) {
            const policy = compileWritePolicy({ writableRoot: project, home,
                permissions: { ...broad, outsideProject, projectFiles: "write" } }, darwin);
            assert.equal(evaluateWriteAccess(join(project, "src", "a.ts"), policy, darwin).allowed, true, outsideProject);
            assert.equal(evaluateDeleteAccess(join(project, "src", "a.ts"), policy, darwin).allowed, false, outsideProject);
            assert.equal(evaluateDeleteAccess(join(project, ".worktrees", "b", "a.ts"), policy, darwin).allowed, true, outsideProject);
        }
        assert.throws(() => compileWritePolicy({ writableRoot: home, home, permissions: broad }), /not home itself/);
        assert.throws(() => buildSandboxCommand({
            profilePath: join(project, "p.sb"), execPath: "/bin/true", execArgs: [],
            policy: { writableRoot: project, home, permissions: { ...broad, projectFiles: "write" } },
        }, { platform: () => "linux", lookupExecutable: () => "/usr/bin/bwrap" }), /cannot separate removal/);
    }));

    it("answers removal for a symlink's own entry without resolving it", () => fixture(({ home, project, sibling }) => {
        const policy = compileWritePolicy({ writableRoot: project, home, permissions: broad }, { platform: () => "darwin" });
        assert.equal(isRemovableUnderWrite(join(home, ".nvm", "current"), policy), true);
        assert.equal(isRemovableUnderWrite(join(sibling, "link"), policy), false);
        assert.equal(isRemovableUnderWrite(join(home, ".pi", "agent"), policy), false, "the deny list wins over dot entries");
    }));

    it("takes a recovery snapshot only for Outside Write & delete on macOS, rate-limited and never throwing", () => {
        resetRecoverySnapshotClock();
        let runs = 0;
        const run = () => { runs++; return { status: 0, output: "Created local snapshot with date: 2026-09-27-120000" }; };
        const writeAndDelete = { ...broad, outsideProject: "read-write" as const };
        assert.deepEqual(takeRecoverySnapshot(broad, { platform: () => "darwin", run }), { taken: false, reason: "not-needed" });
        assert.deepEqual(takeRecoverySnapshot(writeAndDelete, { platform: () => "linux", run }), { taken: false, reason: "unsupported" });
        assert.equal(takeRecoverySnapshot(writeAndDelete, { platform: () => "darwin", run, now: () => 1_000 }).taken, true);
        assert.deepEqual(takeRecoverySnapshot(writeAndDelete, { platform: () => "darwin", run, now: () => 2_000 }),
            { taken: false, reason: "rate-limited" });
        assert.equal(runs, 1);
        resetRecoverySnapshotClock();
        assert.deepEqual(takeRecoverySnapshot(writeAndDelete, { platform: () => "darwin", run: () => ({ status: 1, output: "Operation not permitted" }) }),
            { taken: false, reason: "failed", detail: "Operation not permitted" });
        assert.deepEqual(takeRecoverySnapshot(writeAndDelete, { platform: () => "darwin", run: () => { throw new Error("spawn failed"); } }),
            { taken: false, reason: "failed", detail: "spawn failed" });
        resetRecoverySnapshotClock();
    });

    it("keeps ordinary Linux home folders read-only in the bubblewrap fallback", () => fixture(({ home, project, sibling }) => {
        const linux: SandboxSeams = { platform: () => "linux" };
        const policy = compileWritePolicy({ writableRoot: project, home, permissions: broad }, linux);
        assert.equal(evaluateWriteAccess(join(sibling, "README.md"), policy, linux).allowed, false);
        assert.equal(evaluateWriteAccess(join(home, ".cache", "x"), policy, linux).allowed, true);
        assert.equal(evaluateWriteAccess(join(project, "x"), policy, linux).allowed, true);
    }));

    it("orders the Seatbelt profile so the deny list overrides every grant", () => fixture(({ base, home, project }) => {
        let profile = "";
        buildSandboxCommand({
            profilePath: join(base, "p.sb"), execPath: "/bin/true", execArgs: [],
            policy: { writableRoot: project, home, permissions: broad, denyWrite: [join(home, ".registry")] },
        }, { platform: () => "darwin", writeProfile: (_path, contents) => { profile = contents; } });
        const at = (rule: string) => {
            const index = profile.indexOf(rule);
            assert.ok(index >= 0, `missing rule ${rule}\n${profile}`);
            return index;
        };
        const deny = at("(deny file-write-unlink)\n");
        assert.ok(at(`(allow file-write* (subpath "${home}"))`) < deny);
        assert.ok(deny < at(`(deny file-write* (subpath "${join(home, ".zshrc")}"))`));
        assert.ok(at(`(deny file-read* (subpath "${join(home, ".ssh")}"))`) > deny);
        assert.ok(at(`(deny file-write* (subpath "${join(home, ".registry")}"))`) > deny);
        assert.ok(at(`(deny file-write-unlink (literal "${home}"))`) > at(`(deny file-write* (subpath "${join(home, ".registry")}"))`));
    }));

    it("plans Linux mounts: read-only root, writable dot entries and workspace, masked credentials", () => fixture(({ base, home, project }) => {
        mkdirSync(join(home, ".cache"));
        mkdirSync(join(home, ".ssh"));
        mkdirSync(join(home, ".config", "gh"), { recursive: true });
        writeFileSync(join(home, ".zshrc"), "");
        mkdirSync(join(home, "projects", "repo-worktrees", "a"), { recursive: true });
        const mask = { directory: join(base, "mask-dir"), file: join(base, "mask-file") };
        const command = buildSandboxCommand({
            profilePath: join(base, "p.sb"), execPath: "/bin/true", execArgs: [],
            policy: { writableRoot: project, home, permissions: { ...broad, network: false } },
        }, { platform: () => "linux", lookupExecutable: () => "/usr/bin/bwrap", maskSources: () => mask, makeDirectory: () => {} });
        const argv = command.fileArgs;
        const mount = (option: string, source: string, path = source) =>
            argv.findIndex((arg, index) => arg === option && argv[index + 1] === source && argv[index + 2] === path);
        assert.deepEqual(argv.slice(0, 3), ["--ro-bind", "/", "/"]);
        assert.ok(mount("--bind", join(home, ".cache")) > 0);
        assert.ok(mount("--bind", project) > 0);
        assert.ok(mount("--bind", join(home, "projects", "repo-worktrees")) > 0);
        assert.equal(mount("--bind", join(home, "projects")), -1, "ordinary folders stay read-only");
        assert.ok(mount("--ro-bind", mask.directory, join(home, ".ssh")) > 0);
        assert.ok(mount("--ro-bind", mask.directory, join(home, ".config", "gh")) > mount("--bind", join(home, ".config")));
        assert.ok(mount("--ro-bind", join(home, ".zshrc")) > 0);
        assert.ok(argv.includes("--unshare-net"));
    }));
});

const macKernel = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const linuxKernel = process.platform === "linux" &&
    spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"]).status === 0;
const required = process.env.PI_SANDBOX_REQUIRE_BACKEND;
if ((required === "macos-seatbelt" && !macKernel) || (required === "linux-bubblewrap" && !linuxKernel)) {
    throw new Error(`PI_SANDBOX_REQUIRE_BACKEND=${required} but that backend is unavailable here.`);
}

describe("broad-write profile (real kernel)", { skip: !macKernel && !linuxKernel ? "requires Seatbelt or Bubblewrap" : false }, () => {
    function run(paths: { base: string; home: string; project: string }, script: string, permissions = broad, denyWrite: string[] = []) {
        const command = buildSandboxCommand({
            profilePath: join(paths.base, `profile-${Math.random().toString(36).slice(2)}.sb`),
            execPath: "/bin/sh", execArgs: ["-c", script],
            policy: { writableRoot: paths.project, home: paths.home, permissions, denyWrite },
        });
        return spawnSync(command.file, command.fileArgs, {
            cwd: paths.project, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: paths.home },
        });
    }
    const output = (result: ReturnType<typeof spawnSync>) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

    it("lets a build use a user cache dir with no per-tool configuration", () => fixture((paths) => {
        const gradle = join(paths.home, ".gradle");
        mkdirSync(gradle);
        // Existing cache roots: the Linux fallback keeps home itself read-only,
        // so a brand-new top-level dot directory cannot be created there.
        mkdirSync(join(paths.home, ".cache"));
        const result = run(paths, [
            'mkdir -p "$HOME/.gradle/wrapper/dists/gradle-8.14.3-bin"',
            'cd "$HOME/.gradle/wrapper/dists/gradle-8.14.3-bin"',
            "printf lock > gradle-8.14.3-bin.zip.lck",
            "printf zip > gradle-8.14.3-bin.zip.part && mv gradle-8.14.3-bin.zip.part gradle-8.14.3-bin.zip",
            "rm gradle-8.14.3-bin.zip.lck",
            'mkdir -p "$HOME/.cache/tool" && printf ok > "$HOME/.cache/tool/entry" && rm -rf "$HOME/.cache/tool"',
            `cd '${paths.project}' && printf built > out.txt`,
        ].join(" && "));
        assert.equal(result.status, 0, output(result));
        assert.equal(readFileSync(join(gradle, "wrapper", "dists", "gradle-8.14.3-bin", "gradle-8.14.3-bin.zip"), "utf8"), "zip");
        assert.equal(existsSync(join(gradle, "wrapper", "dists", "gradle-8.14.3-bin", "gradle-8.14.3-bin.zip.lck")), false);
    }));

    it("refuses rm, rm -rf and mv of a sibling repo and keeps its data", () => fixture((paths) => {
        const readme = join(paths.sibling, "README.md");
        for (const script of [
            `rm '${readme}'`,
            `rm -rf '${paths.sibling}'`,
            `mv '${paths.sibling}' '${join(paths.home, ".cache-moved")}'`,
            `mv '${paths.sibling}' '${join(paths.project, "stolen")}'`,
            `mv '${readme}' '${join(paths.sibling, "renamed.md")}'`,
        ]) {
            const result = run(paths, script);
            assert.notEqual(result.status, 0, `${script} must be refused`);
            assert.equal(readFileSync(readme, "utf8"), "keep me", script);
            assert.equal(readFileSync(join(paths.sibling, "src", "main.ts"), "utf8"), "export {};", script);
        }
    }));

    it("edits a sibling repo in place on macOS; Linux keeps it read-only", () => fixture((paths) => {
        const file = join(paths.sibling, "src", "main.ts");
        const result = run(paths, `printf 'export const x = 1;' > '${file}'`);
        if (macKernel) {
            assert.equal(result.status, 0, output(result));
            assert.equal(readFileSync(file, "utf8"), "export const x = 1;");
        } else {
            assert.notEqual(result.status, 0, "the Linux fallback cannot separate removal from writing");
            assert.equal(readFileSync(file, "utf8"), "export {};");
        }
    }));

    it("allows removal in the workspace, temp, dot caches and worktree folders", () => fixture((paths) => {
        const worktree = join(paths.home, "projects", "other-repo-worktrees", "feature");
        mkdirSync(worktree, { recursive: true });
        mkdirSync(join(paths.home, ".npm"));
        writeFileSync(join(worktree, "file.txt"), "old");
        const temp = realpathSync(mkdtempSync(join(tmpdir(), "broad-temp-")));
        try {
            const result = run(paths, [
                "mkdir -p build/sub && printf x > build/sub/o && rm -rf build",
                `printf x > '${join(temp, "t")}' && rm '${join(temp, "t")}'`,
                'mkdir -p "$HOME/.npm/_cacache" && printf x > "$HOME/.npm/_cacache/i" && rm -rf "$HOME/.npm/_cacache"',
                // An atomic save: write a temp file and rename it over the original.
                `printf new > '${join(worktree, "file.txt.tmp")}' && mv '${join(worktree, "file.txt.tmp")}' '${join(worktree, "file.txt")}'`,
            ].join(" && "));
            assert.equal(result.status, 0, output(result));
            assert.equal(readFileSync(join(worktree, "file.txt"), "utf8"), "new");
            assert.equal(existsSync(join(paths.project, "build")), false);
        } finally {
            rmSync(temp, { recursive: true, force: true });
        }
    }));

    it("keeps deny-list paths unreadable or unwritable and harness state unwritable", () => fixture((paths) => {
        mkdirSync(join(paths.home, ".ssh"));
        writeFileSync(join(paths.home, ".ssh", "id_ed25519"), "synthetic-secret");
        writeFileSync(join(paths.home, ".zshrc"), "# rc");
        mkdirSync(join(paths.home, ".pi", "agent"), { recursive: true });
        const registry = join(paths.home, ".cache", "pi-better-subagents");
        mkdirSync(join(registry, "task-runtime"), { recursive: true });
        writeFileSync(join(registry, "task-runtime", "sa_1.json"), "{}");
        const secret = join(paths.home, ".ssh", "id_ed25519");
        const cases: [string, string][] = [
            [`cat '${secret}'`, "read a credential"],
            [`printf x > '${secret}'`, "write a credential"],
            [`printf x > '${join(paths.home, ".ssh", "authorized_keys")}'`, "create inside a credential dir"],
            [`printf 'curl evil' >> '${join(paths.home, ".zshrc")}'`, "append to a shell rc"],
            [`printf x > '${join(paths.home, ".pi", "agent", "extensions.ts")}'`, "plant agent code"],
            [`mv '${join(paths.home, ".pi")}' '${join(paths.home, ".pi-old")}'`, "move agent config away"],
            [`printf '{"forged":1}' > '${join(registry, "task-runtime", "sa_2.json")}'`, "forge provenance"],
            [`rm -rf '${registry}'`, "delete the registry"],
            // Seatbelt ranks a `file-write-unlink` rule above a `file-write*`
            // one, so these prove the deny list also outranks removal grants.
            [`rm -f '${secret}'`, "delete a credential inside a dot directory"],
            [`mv '${join(paths.home, ".ssh")}' '${join(paths.home, ".cache", "ssh")}'`, "move a credential dir"],
            [`mv '${join(paths.home, ".cache")}' '${join(paths.home, ".cache-old")}'`, "move a protected path's ancestor"],
        ];
        for (const [script, label] of cases) {
            const result = run(paths, script, broad, [registry]);
            assert.notEqual(result.status, 0, `${label} must be refused: ${output(result)}`);
            assert.doesNotMatch(result.stdout ?? "", /synthetic-secret/, label);
        }
        assert.equal(readFileSync(secret, "utf8"), "synthetic-secret");
        assert.equal(readFileSync(join(paths.home, ".zshrc"), "utf8"), "# rc");
        assert.equal(existsSync(join(registry, "task-runtime", "sa_2.json")), false);
        assert.equal(existsSync(join(registry, "task-runtime", "sa_1.json")), true);
        const readable = run(paths, `cat '${join(paths.home, ".zshrc")}'`);
        assert.equal(readable.status, 0, output(readable));
    }));

    it("refuses an atomic swap of a sibling repo with a disposable directory", { skip: !macKernel || !existsSync("/usr/bin/python3") }, () => fixture((paths) => {
        const disposable = join(paths.home, ".cache", "swap");
        mkdirSync(disposable, { recursive: true });
        // renamex_np(RENAME_SWAP) exchanges two entries in one call.
        const swap = (a: string, b: string) => `/usr/bin/python3 -c 'import ctypes,sys; sys.exit(0 if ctypes.CDLL(None).renamex_np(sys.argv[1].encode(), sys.argv[2].encode(), 2) == 0 else 1)' '${a}' '${b}'`;
        const other = join(paths.home, ".cache", "other");
        mkdirSync(other);
        const control = run(paths, swap(disposable, other));
        assert.equal(control.status, 0, `positive control: disposable entries can swap. ${output(control)}`);
        const result = run(paths, swap(paths.sibling, disposable));
        assert.notEqual(result.status, 0, output(result));
        assert.equal(readFileSync(join(paths.sibling, "README.md"), "utf8"), "keep me");
    }));

    it("keeps Project files = Write editable but not removable (macOS)", { skip: !macKernel }, () => fixture((paths) => {
        const permissions = { ...broad, projectFiles: "write" as const };
        writeFileSync(join(paths.project, "keep.txt"), "v1");
        const edit = run(paths, "printf v2 > keep.txt && printf new > added.txt", permissions);
        assert.equal(edit.status, 0, output(edit));
        assert.equal(readFileSync(join(paths.project, "keep.txt"), "utf8"), "v2");
        for (const script of ["rm keep.txt", "rm -rf .", "mv keep.txt moved.txt"]) {
            assert.notEqual(run(paths, script, permissions).status, 0, script);
            assert.equal(readFileSync(join(paths.project, "keep.txt"), "utf8"), "v2", script);
        }
    }));

    it("restores removal wherever writes are allowed with Write & delete", () => fixture((paths) => {
        // Stored credentials Read / write: the Linux Write & delete mount cannot mask credentials.
        const result = run(paths, `rm -rf '${paths.sibling}'`, { ...broad, outsideProject: "read-write", storedCredentials: "read-write" });
        assert.equal(result.status, 0, output(result));
        assert.equal(existsSync(paths.sibling), false);
    }));
});
