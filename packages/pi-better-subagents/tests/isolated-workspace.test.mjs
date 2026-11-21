import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    createIsolatedWorkspace,
    discardWorkspace,
    reclaimWorkspace,
    restoreWorkspace,
    workspaceChoice,
} from "../isolated-workspace.ts";
import { taskWorkspaceDir } from "../registry.ts";
const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), "workspace-acceptance-"));
    const source = join(dir, "repo");
    mkdirSync(source);
    git(source, "init", "-q");
    git(source, "config", "user.email", "fixture@example.test");
    git(source, "config", "user.name", "Fixture");
    writeFileSync(join(source, "f"), "base\n");
    writeFileSync(join(source, ".gitignore"), "*.bin\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "base");
    const old = process.env.PI_SUBAGENT_DURABLE_DIR;
    process.env.PI_SUBAGENT_DURABLE_DIR = join(dir, "durable");
    t.after(() => {
        if (old === undefined) delete process.env.PI_SUBAGENT_DURABLE_DIR;
        else process.env.PI_SUBAGENT_DURABLE_DIR = old;
        rmSync(dir, { recursive: true, force: true });
    });
    return source;
}
const id = () => "sa_test_" + randomBytes(6).toString("hex");
for (const mode of ["clone", "worktree"])
    test(mode + " workspaces isolate writers and restore the exact index, files and commits after cleanup", (t) => {
        const source = fixture(t);
        assert.equal(workspaceChoice(source, id(), mode, "read,edit", "edit"), undefined);
        const a = workspaceChoice(source, id(), mode, "read,edit", ""),
            b = workspaceChoice(source, id(), mode, "apply_patch", "");
        const cwd = createIsolatedWorkspace(a),
            other = createIsolatedWorkspace(b);
        t.after(() => {
            for (const w of [a, b])
                if (existsSync(taskWorkspaceDir(w.owner)))
                    rmSync(taskWorkspaceDir(w.owner), { recursive: true, force: true });
        });
        assert.notEqual(cwd, other);
        assert.equal(lstatSync(join(cwd, ".git")).isFile(), mode === "worktree");
        writeFileSync(join(cwd, "f"), "commit\n");
        git(cwd, "commit", "-qam", "worker change");
        const head = git(cwd, "rev-parse", "HEAD");
        writeFileSync(join(cwd, "f"), "staged\n");
        git(cwd, "add", "f");
        writeFileSync(join(cwd, "f"), "unstaged\n");
        writeFileSync(join(cwd, "artifact.bin"), Buffer.from([0, 255, 1]));
        mkdirSync(join(cwd, "empty"));
        symlinkSync("f", join(cwd, "link"));
        assert.equal(readFileSync(join(other, "f"), "utf8"), "base\n");
        assert.equal(git(source, "status", "--porcelain"), "");
        reclaimWorkspace(a);
        assert.equal(existsSync(cwd), false);
        assert.ok(existsSync(other));
        assert.ok(!git(source, "worktree", "list", "--porcelain").includes(cwd));
        restoreWorkspace(a);
        assert.equal(git(cwd, "rev-parse", "HEAD"), head);
        assert.equal(git(cwd, "show", ":f"), "staged");
        assert.equal(readFileSync(join(cwd, "f"), "utf8"), "unstaged\n");
        assert.deepEqual(readFileSync(join(cwd, "artifact.bin")), Buffer.from([0, 255, 1]));
        assert.deepEqual(readdirSync(join(cwd, "empty")), []);
        assert.ok(lstatSync(join(cwd, "link")).isSymbolicLink());
    });
test("a Worktree to Clone handoff preserves evidence without replaying work", (t) => {
    const source = fixture(t),
        w = workspaceChoice(source, id(), "worktree", "edit", "");
    const cwd = createIsolatedWorkspace(w);
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    writeFileSync(join(cwd, "verification.txt"), "interrupted");
    mkdirSync(join(git(cwd, "rev-parse", "--absolute-git-dir"), "rebase-merge"));
    assert.throws(() => reclaimWorkspace(w), /original checkout retained/i);
    assert.equal(readFileSync(join(cwd, "verification.txt"), "utf8"), "interrupted");
    rmSync(join(git(cwd, "rev-parse", "--absolute-git-dir"), "rebase-merge"), { recursive: true });
    const after = restoreWorkspace(w, true);
    assert.equal(after.mode, "clone");
    assert.equal(taskWorkspaceDir(after.owner), realpathSync(cwd));
    assert.ok(lstatSync(join(cwd, ".git")).isDirectory());
    assert.ok(!git(source, "worktree", "list", "--porcelain").includes(cwd));
    assert.equal(readFileSync(join(cwd, "verification.txt"), "utf8"), "interrupted");
});

test("a failed Git command identifies denied metadata only when both the observed path and captured rule match", async (t) => {
    const { deniedGitOperation, worktreeDenialText } = await import("../worktree-feedback.ts");
    const { compileWritePolicy } = await import("../shared-sandbox-core.ts");
    const source = fixture(t),
        w = workspaceChoice(source, id(), "worktree", "edit", ""),
        cwd = createIsolatedWorkspace(w);
    const gitDir = git(cwd, "rev-parse", "--absolute-git-dir");
    const policy = compileWritePolicy({ writableRoot: cwd, home: source, denyWrite: [gitDir] });
    const event = (message) => ({
        toolName: "bash",
        input: { command: "git commit -m review" },
        isError: true,
        content: [{ type: "text", text: message }],
    });
    const { maybeBuildSandboxCommand, describeSandboxSupport } = await import("../shared-sandbox-core.ts");
    if (describeSandboxSupport().supported) {
        const sandboxPolicy = { writableRoot: cwd, home: homedir(), denyWrite: [gitDir] };
        const wrapped = maybeBuildSandboxCommand(
            {
                execPath: "/usr/bin/git",
                execArgs: ["add", "f"],
                profilePath: source + "-profile.sb",
                policy: sandboxPolicy,
            },
            { sandboxEnabled: true, explicitSandbox: true },
        );
        writeFileSync(join(cwd, "f"), "edited before commit");
        const result = spawnSync(wrapped.file, wrapped.fileArgs, {
            cwd,
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C" },
        });
        assert.notEqual(result.status, 0);
        const actual = { ...event(result.stderr), input: { command: "git add f" } };
        assert.equal(deniedGitOperation(actual, gitDir, policy), "add", result.stderr);
        assert.equal(readFileSync(join(cwd, "f"), "utf8"), "edited before commit");
    }
    const notice = event("fatal: Unable to create '" + join(gitDir, "index.lock") + "': Permission denied");
    assert.equal(deniedGitOperation(notice, gitDir, policy), "commit");
    assert.match(worktreeDenialText("commit", cwd), /git commit.*Review the changes.*recover_in_clone:true/);
    for (const message of [
        "fatal: Unable to create '" + join(gitDir, "index.lock") + "': File exists",
        "error: merge conflict",
        "pre-commit hook failed: Permission denied",
    ]) {
        assert.equal(deniedGitOperation(event(message), gitDir, policy), undefined);
    }
    assert.equal(
        deniedGitOperation(notice, gitDir, compileWritePolicy({ writableRoot: source, home: source, denyWrite: [] })),
        undefined,
    );
    discardWorkspace(w);
});

test("each attempt exports its own files and an explicit handoff survives retry with an older recipe", async (t) => {
    const { exportWorkspace, markWorkspaceWriter } = await import("../isolated-workspace.ts");
    const source = fixture(t),
        w = workspaceChoice(source, id(), "worktree", "edit", ""),
        later = id();
    const cwd = createIsolatedWorkspace(w);
    writeFileSync(join(cwd, "f"), "first");
    const after = restoreWorkspace(w, true);
    assert.equal(after.mode, "clone");
    markWorkspaceWriter(after, later);
    writeFileSync(join(cwd, "f"), "second");
    reclaimWorkspace(w, w.owner);
    assert.equal(readFileSync(join(cwd, "f"), "utf8"), "second");
    reclaimWorkspace(after, later);
    const first = source + "-first",
        second = source + "-second";
    exportWorkspace(w, w.owner, first);
    exportWorkspace(after, later, second);
    assert.equal(readFileSync(join(first, "f"), "utf8"), "first");
    assert.equal(readFileSync(join(second, "f"), "utf8"), "second");
    assert.equal(restoreWorkspace(w, false, later).mode, "clone");
    assert.equal(readFileSync(join(cwd, "f"), "utf8"), "second");
    discardWorkspace(after);
});

test("cleanup resumes after a process exits between retiring a linked checkout and removing its registration", async (t) => {
    const source = fixture(t);
    const w = workspaceChoice(source, id(), "worktree", "edit", "");
    const cwd = createIsolatedWorkspace(w);
    writeFileSync(join(cwd, "f"), "preserved");
    restoreWorkspace(w); // freeze the independent copy before simulating the interruption
    git(source, "worktree", "move", cwd, cwd + "-retired");
    reclaimWorkspace(w);
    assert.equal(existsSync(cwd + "-retired"), false);
    assert.ok(!git(source, "worktree", "list", "--porcelain").includes(cwd));
    const originalTmp = process.env.TMPDIR;
    process.env.TMPDIR = source;
    try {
        restoreWorkspace(w);
        assert.equal(readFileSync(join(cwd, "f"), "utf8"), "preserved");
        discardWorkspace(w);
    } finally {
        process.env.TMPDIR = originalTmp;
    }
});
