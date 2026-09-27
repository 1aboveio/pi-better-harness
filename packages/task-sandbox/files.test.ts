import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTaskFileOperations, type TaskFileController } from "./files.ts";
import type { SandboxPermissions, SandboxWritePolicy } from "../sandbox-core/index.ts";

const macKernel = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") &&
    spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
const linuxKernel = process.platform === "linux" &&
    spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"]).status === 0;
const kernel = macKernel || linuxKernel;
if (process.env.PI_SANDBOX_REQUIRE_BACKEND === "linux-bubblewrap" && !linuxKernel) {
    throw new Error("Real Linux Bubblewrap kernel required but unavailable");
}
if (process.env.PI_SANDBOX_REQUIRE_BACKEND === "macos-seatbelt" && !macKernel) {
    throw new Error("Real macOS Seatbelt kernel required but sandbox-exec cannot apply a profile");
}
const permissions: SandboxPermissions = {
    projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
    commands: false, network: false,
};

function fixture() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "task-files-")));
    const root = join(base, "project");
    const home = join(base, "home");
    const outside = join(base, "outside");
    const agent = join(home, ".pi", "agent");
    mkdirSync(root);
    mkdirSync(agent, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, "entry.txt"), "first\n");
    writeFileSync(join(outside, "notes.txt"), "outside\n");
    writeFileSync(join(agent, "auth.json"), "fixture-token");
    const policy: SandboxWritePolicy = {
        writableRoot: root, home,
        denyWrite: [join(root, ".pi"), join(root, ".env"), join(base, "profile.sb.files.sb")],
        permissions: { ...permissions },
    };
    const plan = { confined: true as const, policy, profilePath: join(base, "profile.sb") };
    const controller: TaskFileController = { requireLaunchPlan: () => plan };
    const ops = createTaskFileOperations(controller);
    return { base, root, home, outside, agent, policy, plan, ops, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function tools(f: ReturnType<typeof fixture>) {
    const ctx = { cwd: f.root } as ExtensionContext;
    return {
        ctx,
        read: createReadToolDefinition(f.root, { operations: f.ops.read }),
        write: createWriteToolDefinition(f.root, { operations: f.ops.write }),
        edit: createEditToolDefinition(f.root, { operations: f.ops.edit }),
    };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function denied(promise: Promise<unknown>, pattern: RegExp) {
    await assert.rejects(promise, pattern);
}

test("inactive plan delegates ordinary local operations", async () => {
    const f = fixture();
    try {
        const ops = createTaskFileOperations({ requireLaunchPlan: () => ({ confined: false }) });
        const target = join(f.outside, "new", "hello.txt");
        await ops.write.mkdir(join(f.outside, "new"));
        await ops.write.writeFile(target, "hello\n");
        await ops.edit.access(target);
        assert.equal((await ops.read.readFile(target)).toString(), "hello\n");
        assert.equal(await ops.read.detectImageMimeType!(target), null);
    } finally { f.cleanup(); }
});

test("SDK write/edit/read preserve file semantics with task commands disabled", { skip: !kernel }, async () => {
    const f = fixture();
    try {
        const t = tools(f);
        await t.write.execute("write", { path: "nested/new.txt", content: "alpha\n" }, undefined, undefined, t.ctx);
        assert.equal(readFileSync(join(f.root, "nested/new.txt"), "utf8"), "alpha\n");
        const edit = await t.edit.execute("edit", { path: "nested/new.txt", edits: [{ oldText: "alpha", newText: "beta" }] }, undefined, undefined, t.ctx);
        assert.match(JSON.stringify(edit.content), /Successfully replaced/);
        const read = await t.read.execute("read", { path: "nested/new.txt" }, undefined, undefined, t.ctx);
        assert.match(JSON.stringify(read.content), /beta/);
        assert.equal(readFileSync(join(f.root, "nested/new.txt"), "utf8"), "beta\n");
        // The fixture disables task commands; successful file I/O proves the
        // fixed helper retains its separate execution privilege.
    } finally { f.cleanup(); }
});

test("SDK mutations through kernel workers wait for the same file queue and serialize write before edit", { skip: !kernel }, async () => {
    const f = fixture();
    const release = deferred();
    const entered = deferred();
    const target = join(f.root, "queued.txt");
    const holder = withFileMutationQueue(target, async () => {
        entered.resolve();
        await release.promise;
        writeFileSync(target, "holder\n");
    });
    await entered.promise;
    let requests = 0;
    const ops = createTaskFileOperations({ requireLaunchPlan: () => { requests++; return f.plan; } });
    const t = tools({ ...f, ops });
    const mutations = Promise.all([
        t.write.execute("queued-write", { path: target, content: "alpha\n" }, undefined, undefined, t.ctx),
        t.edit.execute("queued-edit", { path: target, edits: [{ oldText: "alpha", newText: "beta" }] }, undefined, undefined, t.ctx),
    ]);
    try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(requests, 0, "queued tools must not start a worker or check policy while the holder is active");
        release.resolve();
        await holder;
        await mutations;
        assert.equal(readFileSync(target, "utf8"), "beta\n");
    } finally {
        release.resolve();
        await Promise.allSettled([holder, mutations]);
        f.cleanup();
    }
});

test("outside reads work, outside writes and symlink escapes do not", { skip: !kernel }, async () => {
    const f = fixture();
    try {
        const t = tools(f);
        const outsideFile = join(f.outside, "notes.txt");
        assert.equal((await f.ops.read.readFile(outsideFile)).toString(), "outside\n");
        await denied(t.write.execute("write", { path: join(f.outside, "new.txt"), content: "bad" }, undefined, undefined, t.ctx), /refused to write.*permission-denied/);
        await denied(f.ops.edit.writeFile(outsideFile, "bad"), /refused to write.*permission-denied/);
        symlinkSync(f.outside, join(f.root, "link"), "junction");
        await denied(f.ops.write.writeFile(join(f.root, "link", "new.txt"), "bad"), /refused to write/);
        await denied(f.ops.write.mkdir(join(f.root, "link", "new-dir")), /refused to write/);
        assert.equal(readFileSync(outsideFile, "utf8"), "outside\n");
        assert.equal(existsSync(join(f.outside, "new.txt")), false);
        assert.equal(existsSync(join(f.outside, "new-dir")), false);
    } finally { f.cleanup(); }
});

test("project .pi locks and content deny writes, credential-off denies reads", { skip: !kernel }, async () => {
    const f = fixture();
    try {
        const projectPi = join(f.root, ".pi");
        mkdirSync(projectPi);
        writeFileSync(join(projectPi, "state"), "unchanged");
        await denied(f.ops.write.writeFile(join(projectPi, "state"), "changed"), /write-denied/);
        await denied(f.ops.write.mkdir(join(projectPi, "new")), /write-denied/);
        await denied(f.ops.write.writeFile(join(f.root, ".env"), "secret"), /write-denied/);
        assert.equal(readFileSync(join(projectPi, "state"), "utf8"), "unchanged");
        assert.equal(existsSync(join(projectPi, "new")), false);
        f.policy.permissions = { ...permissions, storedCredentials: "off" };
        await denied(f.ops.read.readFile(join(f.agent, "auth.json")), /refused to read.*read-denied/);
        await denied(f.ops.read.access(join(f.agent, "auth.json")), /refused to read.*read-denied/);
        await denied(f.ops.read.detectImageMimeType!(join(f.agent, "auth.json")), /refused to read.*read-denied/);
    } finally { f.cleanup(); }
});

test("SDK credential writes can prepare an existing read-only parent without granting mkdir", { skip: !macKernel }, async () => {
    const f = fixture();
    try {
        f.policy.permissions = { ...permissions, storedCredentials: "read-write" };
        const target = join(f.home, ".npmrc");
        const t = tools(f);
        await t.write.execute("credential-write", { path: target, content: "synthetic-only\n" }, undefined, undefined, t.ctx);
        assert.equal(readFileSync(target, "utf8"), "synthetic-only\n");
        await denied(f.ops.write.mkdir(join(f.home, "ungranted-directory")), /refused to write/);
        assert.equal(existsSync(join(f.home, "ungranted-directory")), false);
    } finally { f.cleanup(); }
});

test("read-only project rejects write and edit while allowing read", { skip: !kernel }, async () => {
    const f = fixture();
    try {
        f.policy.permissions = { ...permissions, projectFiles: "read" };
        assert.equal((await f.ops.read.readFile(join(f.root, "entry.txt"))).toString(), "first\n");
        await denied(f.ops.write.writeFile(join(f.root, "entry.txt"), "changed"), /permission-denied/);
        const t = tools(f);
        await denied(t.edit.execute("edit", { path: "entry.txt", edits: [{ oldText: "first", newText: "other" }] }, undefined, undefined, t.ctx), /Could not edit file.*permission-denied/);
        assert.equal(readFileSync(join(f.root, "entry.txt"), "utf8"), "first\n");
    } finally { f.cleanup(); }
});

test("image detection uses bytes, preserves SDK supported still formats", { skip: !kernel }, async () => {
    const f = fixture();
    try {
        const samples: [string, Buffer, string | null][] = [
            ["png", Buffer.from("89504e470d0a1a0a0000000d494844520000000000000000000000000000000049444154", "hex"), "image/png"],
            ["jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
            ["gif", Buffer.from("GIF89a"), "image/gif"],
            ["webp", Buffer.from("RIFF0000WEBP"), "image/webp"],
            ["text", Buffer.from("normal text"), null],
        ];
        for (const [name, bytes, expected] of samples) {
            const path = join(f.root, name + ".txt");
            writeFileSync(path, bytes);
            assert.equal(await f.ops.read.detectImageMimeType!(path), expected, name);
            assert.deepEqual(await f.ops.read.readFile(path), bytes);
        }
    } finally { f.cleanup(); }
});

test("bounded confined reads and writes reject oversized content", { skip: !kernel }, async () => {
    const f = fixture();
    try {
        const atLimit = "é".repeat(4 * 1024 * 1024);
        const boundary = join(f.root, "boundary.txt");
        await f.ops.write.writeFile(boundary, atLimit);
        assert.deepEqual(await f.ops.read.readFile(boundary), Buffer.from(atLimit));
        await denied(f.ops.write.writeFile(boundary, atLimit + "é"), /8 MiB operation limit/);
        assert.equal(readFileSync(boundary, "utf8"), atLimit, "oversized writes must not truncate an existing file");
        const big = join(f.root, "big.txt");
        writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
        await denied(f.ops.read.readFile(big), /8 MiB operation limit/);
        await denied(f.ops.write.writeFile(join(f.root, "new.txt"), "x".repeat(8 * 1024 * 1024 + 1)), /8 MiB operation limit/);
        assert.equal(existsSync(join(f.root, "new.txt")), false);
    } finally { f.cleanup(); }
});

test("canonical policy prechecks reject denied paths and oversized writes without a backend", async () => {
    const f = fixture();
    try {
        symlinkSync(f.outside, join(f.root, "link"), "junction");
        await denied(f.ops.write.writeFile(join(f.root, "link", "escape.txt"), "bad"), /refused to write.*permission-denied/);
        await denied(f.ops.write.mkdir(join(f.root, ".pi", "state")), /refused to write.*write-denied/);
        await denied(f.ops.edit.access(join(f.root, ".env")), /refused to write.*write-denied/);
        f.policy.permissions = { ...permissions, storedCredentials: "off" };
        await denied(f.ops.read.readFile(join(f.agent, "auth.json")), /refused to read.*read-denied/);
        f.policy.permissions = { ...permissions, projectFiles: "read" };
        await denied(f.ops.write.writeFile(join(f.root, "entry.txt"), "bad"), /refused to write.*permission-denied/);
        f.policy.permissions = { ...permissions };
        await denied(f.ops.write.writeFile(join(f.root, "big.txt"), "x".repeat(8 * 1024 * 1024 + 1)), /8 MiB operation limit/);
        assert.equal(existsSync(join(f.outside, "escape.txt")), false);
        assert.equal(readFileSync(join(f.root, "entry.txt"), "utf8"), "first\n");
        assert.equal(existsSync(join(f.root, "big.txt")), false);
    } finally { f.cleanup(); }
});

test("failed sandbox launch never falls back to host fs", async () => {
    const f = fixture();
    try {
        f.plan.profilePath = join(f.base, "nonexistent", "profile.sb");
        // Bubblewrap does not use a profile file; force a policy it cannot enforce.
        if (process.platform === "linux") f.policy.permissions = { ...permissions, storedCredentials: "off" };
        await denied(f.ops.write.writeFile(join(f.root, "unwritten.txt"), "bad"), /sandbox|profile|failed|bubblewrap/i);
        assert.equal(existsSync(join(f.root, "unwritten.txt")), false);
        await denied(f.ops.read.readFile(join(f.root, "entry.txt")), /sandbox|profile|failed|bubblewrap/i);
    } finally { f.cleanup(); }
});
