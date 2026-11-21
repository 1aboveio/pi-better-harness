// Generated fixed launch domain from packages/pi-better-subagents/isolated-workspace.ts. Do not edit directly.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectGitWorkspace, syncGitRemotes } from "./git-workspace.domain.mjs";
import { restoreTree, snapshotTree, verifyTree } from "./workspace-files.domain.mjs";
import { durableSubagentRoot } from "./session-store.domain.mjs";
import { taskWorkspaceDir } from "./registry.domain.mjs";
// Every mutating git command uses an argv array. Restoring a checkout cannot run a post-checkout hook.
function git(cwd, args) {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_NO_LAZY_FETCH: "1",
        },
    });
}
const value = (cwd, args) => git(cwd, args).toString().trim();
const recoveryRoot = () => join(durableSubagentRoot(), "workspaces");
function paths(w) {
    const currentRoot = taskWorkspaceDir(w.owner);
    const record = join(recoveryRoot(), w.owner);
    const root = w.root ?? currentRoot;
    if (!isAbsolute(root) ||
        root !== resolve(root) ||
        basename(root) !== w.owner ||
        basename(dirname(root)) !== "pi-better-subagent-workspaces")
        throw new Error("Invalid owned workspace location");
    if (root !== currentRoot && readFileSync(join(record, "root"), "utf8") !== root)
        throw new Error("Recorded workspace location changed");
    if (resolve(root, w.subdir) !== root && !resolve(root, w.subdir).startsWith(root + sep))
        throw new Error("Invalid workspace subdirectory");
    return { root, record, store: join(recoveryRoot(), "blobs") };
}
export function workspaceChoice(source, owner, mode, tools, exclude) {
    const disabled = new Set(exclude.split(",").map((s) => s.trim()));
    if (!tools
        .split(",")
        .some((t) => ["write", "edit", "apply_patch", "multi_edit"].includes(t.trim()) && !disabled.has(t.trim())))
        return;
    if (!existsSync(source))
        return; // The normal launcher reports a missing cwd.
    let ancestor = realpathSync(source);
    while (!existsSync(join(ancestor, ".git"))) {
        const parent = dirname(ancestor);
        if (ancestor === parent)
            return;
        ancestor = parent;
    }
    let info;
    try {
        info = inspectGitWorkspace(source);
    }
    catch (error) {
        if (String(error).includes("not a git repository"))
            return;
        throw error;
    }
    const subdir = relative(info.repoRoot, realpathSync(source));
    // A directory ignored by its enclosing checkout (e.g. a separate project in
    // build output) is not part of that checkout's selected Git base.
    if (subdir) {
        try {
            git(info.repoRoot, ["check-ignore", "--quiet", "--", subdir]);
            return;
        }
        catch (error) {
            if (error.status !== 1)
                throw error;
        }
    }
    let base;
    try {
        base = value(source, ["rev-parse", "--verify", "HEAD"]);
    }
    catch {
        throw new Error("An isolated Git workspace requires a base commit. Commit the initial files or use isolation:false at " +
            source);
    }
    return { owner, root: taskWorkspaceDir(owner), mode, source: info.repoRoot, subdir, base };
}
function addLinked(source, root, commit) {
    git(source, ["worktree", "add", "--detach", root, commit]);
}
export function createIsolatedWorkspace(w, reserved = false) {
    const { root } = paths(w);
    mkdirSync(dirname(root), { recursive: true });
    if (!reserved && existsSync(root))
        throw new Error("Isolated workspace already exists: " + root);
    if (w.mode === "worktree")
        addLinked(w.source, root, w.base);
    else {
        // Local source preserves unpublished commits and works offline. Separate objects protect the source from worker writes.
        git(w.source, ["clone", "--local", "--no-hardlinks", "--no-checkout", "--", w.source, root]);
        git(root, ["checkout", "--detach", w.base]);
        syncGitRemotes(w.source, root);
        for (const key of ["user.name", "user.email", "user.signingkey"]) {
            let setting;
            try {
                setting = value(w.source, ["config", "--local", "--get", key]);
            }
            catch {
                continue;
            }
            git(root, ["config", "--local", key, setting]);
        }
    }
    const cwd = join(root, w.subdir);
    if (!existsSync(cwd))
        throw new Error("Directory is missing from the selected Git commit. Use isolation:false for uncommitted inputs at " +
            join(w.source, w.subdir));
    if (!realpathSync(cwd).startsWith(realpathSync(root) + sep) && realpathSync(cwd) !== realpathSync(root))
        throw new Error("Invalid workspace directory: " + cwd);
    return cwd;
}
// Move the intact checkout out of the canonical path before recursively removing it.
// After a crash, admission and cleanup finish the same registered move and can restore
// the verified copy without ever mistaking half a checkout for a live workspace.
function finishRetirement(w) {
    const retired = paths(w).root + "-retired";
    if (!existsSync(retired))
        return;
    if (w.mode === "worktree")
        git(w.source, ["worktree", "remove", "--force", retired]);
    else
        rmSync(retired, { recursive: true, force: true });
}
function removeOwned(w) {
    const { root } = paths(w);
    finishRetirement(w);
    if (!existsSync(root))
        return;
    if (w.mode === "worktree")
        git(w.source, ["worktree", "move", root, root + "-retired"]);
    else
        renameSync(root, root + "-retired");
    finishRetirement(w);
}
export function discardWorkspace(w) {
    if (w.mode === "worktree" && existsSync(join(paths(w).root, ".git")))
        git(w.source, ["worktree", "remove", "--force", paths(w).root]);
    else
        rmSync(paths(w).root, { recursive: true, force: true });
}
const withoutGit = new Set([".git"]);
const worktreePointers = new Set(["commondir", "gitdir"]);
const sharedGitEntries = new Set(["config", "objects", "packed-refs", "refs", "logs", "info", "shallow", "hooks"]);
const pendingOperation = [
    "index.lock",
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "sequencer",
];
function atomicText(path, content) {
    const tmp = path + "-" + randomUUID();
    try {
        writeFileSync(tmp, content, { mode: 0o600 });
        renameSync(tmp, path);
    }
    finally {
        rmSync(tmp, { force: true });
    }
}
function attemptFile(record, id) {
    if (!/^sa_[a-z0-9]+_[a-z0-9]+$/i.test(id))
        throw new Error("Invalid workspace attempt");
    return join(record, "attempt-" + id);
}
function checkpointDir(w, attempt) {
    const { record } = paths(w);
    const generation = readFileSync(attempt ? attemptFile(record, attempt) : join(record, "current"), "utf8");
    if (!/^save-[a-zA-Z0-9]+$/.test(generation))
        throw new Error("Invalid workspace checkpoint");
    return join(record, generation);
}
function readCheckpoint(w, attempt) {
    const dir = checkpointDir(w, attempt);
    const cp = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    if (cp.workspace.owner !== w.owner || cp.workspace.source !== w.source || cp.workspace.base !== w.base)
        throw new Error("Workspace checkpoint identity changed");
    return { dir, cp };
}
export function hasWorkspaceCheckpoint(w) {
    try {
        readCheckpoint(w);
        return true;
    }
    catch {
        return false;
    }
}
function currentWorkspace(w) {
    const { root, record } = paths(w);
    if (!existsSync(join(record, "handoff")))
        return w;
    readCheckpoint(w);
    // The marker precedes removal. A crash can leave the verified original in place.
    if (existsSync(root) && lstatSync(join(root, ".git")).isFile())
        return { ...w, mode: "worktree" };
    return { ...w, mode: "clone" };
}
function inspectOwned(w) {
    const { root } = paths(w);
    const info = inspectGitWorkspace(root);
    if (lstatSync(root).isSymbolicLink() || info.repoRoot !== root || info.isLinkedWorktree !== (w.mode === "worktree"))
        throw new Error("Workspace ownership changed at " + root);
    if (w.mode === "clone" && (info.gitDir !== join(root, ".git") || info.commonGitDir !== info.gitDir))
        throw new Error("Clone metadata moved outside " + root);
    if (w.mode === "worktree" &&
        (info.commonGitDir !== inspectGitWorkspace(w.source).commonGitDir ||
            !info.gitDir.startsWith(join(info.commonGitDir, "worktrees") + sep) ||
            realpathSync(readFileSync(join(info.gitDir, "gitdir"), "utf8").trim()) !== join(root, ".git")))
        throw new Error("Worktree registration changed at " + root);
    return info;
}
function materializeClone(target, cp, store) {
    restoreTree(target, store, cp.files);
    verifyTree(target, cp.files);
    const gitDir = join(target, ".git");
    if (cp.privateGit) {
        // The linked checkout has its own HEAD and index. Prefer its per-worktree
        // records over similarly named entries in the main worktree.
        const merged = new Map(cp.git.map((entry) => [entry.name, entry]));
        for (const entry of cp.privateGit)
            merged.set(entry.name, entry);
        const entries = [...merged.values()].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
        restoreTree(gitDir, store, entries);
        // verifyTree compares depth-first order. Verify the two inventories by name.
        const actual = snapshotTree(gitDir).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
        if (JSON.stringify(actual) !== JSON.stringify(entries))
            throw new Error("Recovered Git metadata failed verification");
        // A linked checkout may belong to a bare parent. The exported checkout owns its new working directory.
        git(target, ["config", "--file", join(gitDir, "config"), "core.bare", "false"]);
    }
    else {
        restoreTree(gitDir, store, cp.git);
        verifyTree(gitDir, cp.git);
    }
    const info = inspectGitWorkspace(target);
    if (info.repoRoot !== realpathSync(target) || info.gitDir !== realpathSync(gitDir))
        throw new Error("Recovered checkout refers to external Git metadata");
}
function checkIndependentHistory(proof, head) {
    // Only inspect Git's object graph. Repository config, hooks and global config
    // are not inputs to verification and must not run helpers on the worker's behalf.
    const config = join(proof, ".git", "config"), original = join(dirname(proof), "verification-config");
    renameSync(config, original);
    try {
        const format = head.length === 64
            ? "[core]\nrepositoryformatversion=1\n[extensions]\nobjectformat=sha256\n"
            : "[core]\nrepositoryformatversion=0\n";
        writeFileSync(config, format, { mode: 0o600 });
        const args = ["--git-dir", join(proof, ".git"), "--work-tree", proof];
        const options = {
            cwd: proof,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                PATH: process.env.PATH,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_NO_LAZY_FETCH: "1",
                GIT_ALLOW_PROTOCOL: "",
                GIT_NO_REPLACE_OBJECTS: "1",
            },
        };
        if (execFileSync("git", [...args, "rev-parse", "HEAD"], options)
            .toString()
            .trim() !== head)
            throw new Error("Saved HEAD failed verification");
        execFileSync("git", [...args, "fsck", "--cache", "--connectivity-only", "--no-dangling", "--no-reflogs", head], options);
    }
    finally {
        renameSync(original, config);
    }
}
function discardUnpublishedGenerations(record) {
    const names = readdirSync(record);
    const referenced = new Set(names
        .filter((name) => name === "current" || /^attempt-sa_[a-z0-9]+_[a-z0-9]+$/i.test(name))
        .map((name) => readFileSync(join(record, name), "utf8")));
    for (const name of names)
        if (/^save-[a-zA-Z0-9]+$/.test(name) && !referenced.has(name))
            rmSync(join(record, name), { recursive: true, force: true });
}
function checkpoint(w, attempt) {
    const { root, record, store } = paths(w);
    const info = inspectOwned(w);
    const linked = w.mode === "worktree";
    if (pendingOperation.some((name) => existsSync(join(info.gitDir, name))) ||
        existsSync(join(info.commonGitDir, "objects/info/alternates")) ||
        (existsSync(join(info.commonGitDir, "worktrees")) && !linked)) {
        throw new Error("Git operation or dependent checkout requires the original checkout retained at " + root);
    }
    const head = value(root, ["rev-parse", "--verify", "HEAD"]);
    const branch = value(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const files = snapshotTree(root, store, withoutGit);
    if (files.some((e) => e.name.endsWith("/.git") && e.type !== "directory"))
        throw new Error("Nested worktree requires retaining " + root);
    // Never archive another checkout's index, HEAD, in-progress operation, or registration.
    const commonGit = linked
        ? new Set([...readdirSync(info.commonGitDir).filter((name) => !sharedGitEntries.has(name)), "logs/HEAD"])
        : undefined;
    const cp = {
        workspace: w,
        head,
        branch: branch === "HEAD" ? "" : branch,
        files,
        git: snapshotTree(info.commonGitDir, store, commonGit),
    };
    if (cp.git.some((e) => e.type === "symlink"))
        throw new Error("External Git storage requires retaining " + root);
    if (linked)
        cp.privateGit = snapshotTree(info.gitDir, store, worktreePointers);
    if (cp.privateGit?.some((e) => e.type === "symlink"))
        throw new Error("External worktree metadata requires retaining " + root);
    mkdirSync(record, { recursive: true, mode: 0o700 });
    atomicText(join(record, "root"), root);
    discardUnpublishedGenerations(record);
    const dir = mkdtempSync(join(record, "save-")), proof = join(dir, "proof");
    try {
        materializeClone(proof, cp, store);
        checkIndependentHistory(proof, head);
        verifyTree(root, files, withoutGit);
        if (value(root, ["rev-parse", "HEAD"]) !== head)
            throw new Error("Workspace HEAD changed while saving " + root);
        if (linked)
            verifyTree(info.gitDir, cp.privateGit, worktreePointers);
        else
            verifyTree(info.gitDir, cp.git);
        rmSync(proof, { recursive: true, force: true });
        const manifest = JSON.stringify(cp);
        const pointer = attemptFile(record, attempt);
        if (existsSync(pointer)) {
            const prior = readCheckpoint(w, attempt);
            if (readFileSync(join(prior.dir, "manifest.json"), "utf8") === manifest) {
                rmSync(dir, { recursive: true, force: true });
                atomicText(join(record, "current"), prior.dir.slice(record.length + 1));
                return prior;
            }
        }
        writeFileSync(join(dir, "manifest.json"), manifest, { mode: 0o600 });
        const generation = dir.slice(record.length + 1);
        atomicText(attemptFile(record, attempt), generation);
        atomicText(join(record, "current"), generation);
        return { dir, cp };
    }
    catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
    }
}
export function reclaimWorkspace(original, attempt = original.owner) {
    finishPendingRestore(original);
    if (existsSync(paths(original).root + "-retired"))
        finishRetirement(readCheckpoint(original).cp.workspace);
    const w = currentWorkspace(original);
    const { root, record } = paths(w);
    // A continuation froze the previous attempt before accepting the next writer.
    // Only an attempt without such a frozen result can own the remaining checkout.
    if (existsSync(attemptFile(record, attempt))) {
        readCheckpoint(w, attempt);
        if (!existsSync(root))
            return;
        if (existsSync(join(record, "writer")) && readFileSync(join(record, "writer"), "utf8") !== attempt)
            return;
    }
    if (!existsSync(root)) {
        readCheckpoint(w, attempt);
        return;
    }
    checkpoint(w, attempt);
    removeOwned(w);
}
export function markWorkspaceWriter(w, id) {
    const { record } = paths(w);
    mkdirSync(record, { recursive: true, mode: 0o700 });
    atomicText(join(record, "root"), paths(w).root);
    atomicText(join(record, "writer"), id);
}
function finishPendingRestore(w) {
    const { root, record } = paths(w);
    const marker = join(record, "restoring");
    if (!existsSync(marker))
        return;
    readCheckpoint(w);
    const staging = readFileSync(marker, "utf8");
    if (dirname(staging) !== dirname(root) || !basename(staging).startsWith(basename(root) + "-restore-"))
        throw new Error("Invalid pending restore");
    const target = join(staging, "checkout");
    if (existsSync(join(target, ".git")) && lstatSync(join(target, ".git")).isFile())
        git(w.source, ["worktree", "remove", "--force", target]);
    rmSync(staging, { recursive: true, force: true });
    rmSync(marker);
}
// Called under the conversation lease, after confirming that the previous writer is gone.
export function restoreWorkspace(original, inClone = false, prior = original.owner) {
    finishPendingRestore(original);
    if (existsSync(paths(original).root + "-retired"))
        finishRetirement(readCheckpoint(original).cp.workspace);
    const w = currentWorkspace(original);
    const { root, record, store } = paths(w);
    const exists = existsSync(root);
    if (exists)
        inspectOwned(w);
    const { cp } = exists ? checkpoint(w, prior) : readCheckpoint(w, prior);
    const after = { ...w, mode: inClone ? "clone" : w.mode };
    if (exists && after.mode === w.mode)
        return w;
    mkdirSync(dirname(root), { recursive: true });
    const staging = mkdtempSync(root + "-restore-"), target = join(staging, "checkout");
    atomicText(join(record, "restoring"), staging);
    try {
        if (after.mode === "clone") {
            materializeClone(target, cp, store);
            if (inClone)
                atomicText(join(record, "handoff"), "clone");
            if (exists)
                removeOwned(w);
            renameSync(target, root);
        }
        else {
            // Let Git enforce branch occupancy. Keep the checkpoint when the source has moved or lost an object.
            if (cp.branch && value(w.source, ["rev-parse", "--verify", "refs/heads/" + cp.branch]) !== cp.head)
                throw new Error("Worktree branch moved. The saved checkout is available in Clone.");
            git(w.source, [
                "worktree",
                "add",
                "--no-checkout",
                ...(cp.branch ? [] : ["--detach"]),
                target,
                cp.branch || cp.head,
            ]);
            const admin = inspectGitWorkspace(target).gitDir;
            for (const name of readdirSync(admin))
                if (!worktreePointers.has(name))
                    rmSync(join(admin, name), { recursive: true, force: true });
            restoreTree(admin, store, cp.privateGit);
            restoreTree(target, store, cp.files);
            verifyTree(target, cp.files, withoutGit);
            verifyTree(admin, cp.privateGit, worktreePointers);
            git(target, ["fsck", "--connectivity-only", "--no-dangling", "--no-reflogs"]);
            git(w.source, ["worktree", "move", target, root]);
        }
        return after;
    }
    finally {
        finishPendingRestore(w);
    }
}
export function workspaceDelivery(w, cwd, confined, attempt = w.owner) {
    const { record } = paths(w);
    let location = cwd;
    if (existsSync(attemptFile(record, attempt))) {
        const manifest = join(checkpointDir(w, attempt), "manifest.json");
        location = `${manifest} (restore a copy with pi-subagents-recover ${attempt} <new-directory>)`;
    }
    const guidance = w.mode === "worktree" && confined
        ? " If Git metadata writes are denied, review the saved changes or continue with recover_in_clone:true."
        : "";
    return `Git workspace (${w.mode}): ${location}. Base: ${w.base}.${guidance}`;
}
export function exportWorkspace(w, attempt, destination) {
    const dest = resolve(destination);
    if (existsSync(dest))
        throw new Error("Choose a new destination directory.");
    const { cp } = readCheckpoint(w, attempt);
    // Reserve the destination exclusively. A failed export has no effect on the saved copy.
    mkdirSync(dest, { mode: 0o700 });
    try {
        materializeClone(dest, cp, paths(w).store);
    }
    catch (error) {
        rmSync(dest, { recursive: true, force: true });
        throw error;
    }
}
