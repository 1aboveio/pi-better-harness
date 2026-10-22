import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { BundleError, createBundle, materializeWorkspace, verifyBundle, type BundleManifest, type CreateBundleOptions } from "../src/core/bundle.ts";

function fixture(t: TestContext, withGit = true): CreateBundleOptions {
  const root = mkdtempSync(join(tmpdir(), "bundle-compression-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "tracked.txt"), "committed\n");
  if (withGit) {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Bundle test", "-c", "user.email=bundle@example.test", ...args], { cwd, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "tracked.txt");
    git("commit", "-q", "-m", "fixture");
    writeFileSync(join(cwd, "tracked.txt"), "committed\ndirty change\n");
    writeFileSync(join(cwd, "untracked.bin"), Buffer.from([0, 255, 1, 2]));
    symlinkSync("tracked.txt", join(cwd, "relative-link"));
    writeFileSync(join(cwd, ".env.local"), "SECRET=stay-behind\n");
  }
  const transcript = join(root, "transcript.jsonl");
  const line = JSON.stringify({ type: "message", role: "assistant", content: "Full conversation, not a summary. \u4f60\u597d " + "repeated text ".repeat(24) }) + "\n";
  writeFileSync(transcript, line.repeat(12_000));
  return {
    cwd,
    outFile: join(root, "bundle.tar"),
    agent: { kind: "test", version: "1", extensions: {} },
    session: { id: "compression-session" },
    ownership: { epoch: 1, from: "source", moveId: "compression-move" },
    sessionFiles: [{ name: "transcript.jsonl", path: transcript }],
    stateFiles: [{ name: "state.bin", content: Buffer.from([0, 255, 10, 13, 128]) }],
  };
}

function repack(stage: string, outFile: string): void {
  execFileSync("tar", ["-czf", outFile, "-C", stage, ...readdirSync(stage)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
}

it("gzip reduces transferred bytes and restores the exact transcript, state, and dirty workspace", (t) => {
  const options = fixture(t);
  const raw = createBundle(options);
  const rawBytes = statSync(options.outFile).size;
  assert.notDeepEqual([...readFileSync(options.outFile).subarray(0, 2)], [0x1f, 0x8b]);
  assert.equal(raw.workspaceIncluded, undefined, "legacy workspace bundles omit the new flag");
  const legacy = verifyBundle(options.outFile, join(options.cwd, "..", "legacy"));
  assert.deepEqual(legacy.manifest, raw);

  const compressedFile = join(options.cwd, "..", "compressed.tar");
  const manifest = createBundle({ ...options, outFile: compressedFile, compression: "gzip" });
  const compressedBytes = statSync(compressedFile).size;
  assert.deepEqual([...readFileSync(compressedFile).subarray(0, 2)], [0x1f, 0x8b]);
  assert.ok(compressedBytes < rawBytes, `${compressedBytes} compressed bytes must be less than ${rawBytes} raw bytes`);
  t.diagnostic(`Transfer bytes: raw=${rawBytes}, gzip=${compressedBytes}`);
  const extracted = verifyBundle(compressedFile, join(options.cwd, "..", "verified"));
  assert.deepEqual(extracted.manifest, manifest);
  const transcript = readFileSync(options.sessionFiles![0]!.path);
  assert.deepEqual(readFileSync(join(extracted.dir, "session/transcript.jsonl")), transcript);
  assert.deepEqual(readFileSync(join(extracted.dir, "state/state.bin")), options.stateFiles![0]!.content);
  assert.equal(manifest.files.find((file) => file.role === "session")?.sha256, createHash("sha256").update(transcript).digest("hex"));
  const dest = join(options.cwd, "..", "restored");
  materializeWorkspace(extracted, dest);
  assert.deepEqual(readFileSync(join(dest, "tracked.txt")), readFileSync(join(options.cwd, "tracked.txt")));
  assert.deepEqual(readFileSync(join(dest, "untracked.bin")), Buffer.from([0, 255, 1, 2]));
  assert.equal(readlinkSync(join(dest, "relative-link")), "tracked.txt");
  assert.equal(existsSync(join(dest, ".env.local")), false);
});

it("explicit none stays a plain archive even with a gzip filename", (t) => {
  const options = fixture(t);
  options.outFile += ".gz";
  const manifest = createBundle({ ...options, compression: "none" });
  assert.notDeepEqual([...readFileSync(options.outFile).subarray(0, 2)], [0x1f, 0x8b]);
  const extracted = verifyBundle(options.outFile, join(options.cwd, "..", "verified"));
  assert.deepEqual(extracted.manifest, manifest);
  assert.deepEqual(readFileSync(join(extracted.dir, "session/transcript.jsonl")), readFileSync(options.sessionFiles![0]!.path));
});

it("gzip still verifies each member against its manifest", (t) => {
  const options = fixture(t);
  createBundle({ ...options, compression: "gzip" });
  const extracted = verifyBundle(options.outFile, join(options.cwd, "..", "stage"));
  const transcriptPath = join(extracted.dir, "session/transcript.jsonl");
  const bytes = readFileSync(transcriptPath);
  bytes[0] = bytes[0]! ^ 1;
  writeFileSync(transcriptPath, bytes);
  repack(extracted.dir, options.outFile);
  assert.throws(() => verifyBundle(options.outFile, join(options.cwd, "..", "bad")), /Checksum mismatch for session\/transcript.jsonl/);
});

it("truncated and corrupt gzip fail before extraction and clean temporary output", (t) => {
  const options = fixture(t, false);
  createBundle({ ...options, includeWorkspace: false, compression: "gzip" });
  const good = readFileSync(options.outFile);
  const corrupt = Buffer.from(good);
  corrupt[corrupt.length - 8] = corrupt[corrupt.length - 8]! ^ 1;
  for (const bytes of [good.subarray(0, 2), good.subarray(0, good.length - 4), corrupt]) {
    writeFileSync(options.outFile, bytes);
    const work = join(options.cwd, "..", "bad");
    assert.throws(() => verifyBundle(options.outFile, work), (error: unknown) => error instanceof BundleError && /gzip/i.test(error.message));
    assert.deepEqual(readdirSync(work), []);
  }
});

it("decompression enforces the output byte limit, including concatenated gzip members", (t) => {
  const options = fixture(t, false);
  createBundle({ ...options, includeWorkspace: false });
  const raw = readFileSync(options.outFile);
  const work = join(options.cwd, "..", "limited");
  for (const compressed of [gzipSync(raw), Buffer.concat([gzipSync(raw.subarray(0, 1024)), gzipSync(raw.subarray(1024))])]) {
    writeFileSync(options.outFile, compressed);
    assert.throws(() => verifyBundle(options.outFile, work, { maxUncompressedBytes: raw.length - 1 }), /exceeds.*byte limit/i);
    assert.deepEqual(readdirSync(work), [], "an oversized stream leaves no partial tar or extraction");
    const extracted = verifyBundle(options.outFile, work, { maxUncompressedBytes: raw.length });
    assert.deepEqual(readFileSync(join(extracted.dir, "session/transcript.jsonl")), readFileSync(options.sessionFiles![0]!.path));
    rmSync(extracted.dir, { recursive: true });
  }
});

it("nested compression cannot bypass the decompression limit through tar autodetection", (t) => {
  const options = fixture(t, false);
  createBundle({ ...options, includeWorkspace: false });
  const nested = gzipSync(gzipSync(readFileSync(options.outFile)));
  writeFileSync(options.outFile, nested);
  const work = join(options.cwd, "..", "limited");
  assert.throws(() => verifyBundle(options.outFile, work, { maxUncompressedBytes: 128 * 1024 }), /plain tar archive/i);
  assert.deepEqual(readdirSync(work), []);
});

it("plain tar is bounded too, and callers cannot raise the hard limit", (t) => {
  const options = fixture(t, false);
  createBundle({ ...options, includeWorkspace: false });
  const rawBytes = statSync(options.outFile).size;
  const work = join(options.cwd, "..", "limited");
  assert.throws(() => verifyBundle(options.outFile, work, { maxUncompressedBytes: rawBytes - 1 }), /exceeds.*byte limit/i);
  assert.equal(existsSync(work), false);
  for (const maxUncompressedBytes of [0, -1, 1.5, NaN, Infinity, 1024 * 1024 * 1024 + 1]) {
    assert.throws(() => verifyBundle(options.outFile, work, { maxUncompressedBytes }), /byte limit must be an integer/i);
  }
  truncateSync(options.outFile, 1024 * 1024 * 1024 + 1);
  assert.throws(() => verifyBundle(options.outFile, work), /exceeds archive byte limit/i);
  assert.equal(existsSync(work), false);
});

it("compressed bundles retain manifest traversal and symlink checks", (t) => {
  const options = fixture(t);
  createBundle({ ...options, compression: "gzip" });
  const extracted = verifyBundle(options.outFile, join(options.cwd, "..", "stage"));
  const cases: Array<[(manifest: BundleManifest) => void, RegExp]> = [
    [(manifest) => { manifest.files[0]!.path = "../escape"; }, /Manifest path escapes/],
    [(manifest) => { manifest.worktree[0]!.path = "../escape"; }, /escapes the workspace/],
    [(manifest) => { manifest.symlinks[0]!.target = ".git/hooks"; }, /points into \.git/],
  ];
  const work = join(options.cwd, "..", "bad");
  for (const [edit, pattern] of cases) {
    const manifest = structuredClone(extracted.manifest);
    edit(manifest);
    writeFileSync(join(extracted.dir, "manifest.json"), JSON.stringify(manifest));
    repack(extracted.dir, options.outFile);
    assert.throws(() => verifyBundle(options.outFile, work), pattern);
    assert.deepEqual(readdirSync(work), []);
  }
  writeFileSync(join(extracted.dir, "manifest.json"), JSON.stringify(extracted.manifest));
  const transcript = join(extracted.dir, "session/transcript.jsonl");
  rmSync(transcript);
  symlinkSync(options.sessionFiles![0]!.path, transcript);
  repack(extracted.dir, options.outFile);
  assert.throws(() => verifyBundle(options.outFile, work), /not a plain file or directory/);
  assert.deepEqual(readdirSync(work), []);
});

it("session-only gzip bundles work outside git, make no git calls, and cannot materialize a workspace", (t) => {
  const options = fixture(t, false);
  const trace = join(options.cwd, "..", "git-trace");
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
  });
  const manifest = createBundle({ ...options, includeWorkspace: false, compression: "gzip", baseRef: "ignored-for-session-only" });
  assert.equal(existsSync(trace), false, "session-only creation never invokes git");
  assert.equal(manifest.workspaceIncluded, false);
  assert.deepEqual(manifest.repo, { head: "" });
  assert.deepEqual(manifest.worktree, []);
  assert.deepEqual(manifest.symlinks, []);
  assert.deepEqual(manifest.excluded, []);
  assert.equal(manifest.totals.worktreeFiles, 0);
  assert.equal(manifest.totals.worktreeBytes, 0);
  const extracted = verifyBundle(options.outFile, join(options.cwd, "..", "verified"));
  assert.deepEqual(extracted.manifest.files.map((file) => file.path).sort(), ["session/transcript.jsonl", "state/state.bin"]);
  assert.deepEqual(readFileSync(join(extracted.dir, "session/transcript.jsonl")), readFileSync(options.sessionFiles![0]!.path));
  assert.deepEqual(readFileSync(join(extracted.dir, "state/state.bin")), options.stateFiles![0]!.content);
  const absent = join(options.cwd, "..", "absent");
  const empty = join(options.cwd, "..", "empty");
  mkdirSync(empty);
  for (const dest of [absent, empty, options.cwd]) {
    assert.throws(() => materializeWorkspace(extracted, dest), /session-only.*workspace/i);
  }
  assert.equal(existsSync(absent), false);
  assert.deepEqual(readdirSync(empty), []);
  assert.deepEqual(readdirSync(options.cwd), ["tracked.txt"]);
  assert.equal(readFileSync(join(options.cwd, "tracked.txt"), "utf8"), "committed\n");
});

it("rejects malformed workspaceIncluded flags instead of treating them as session-only", (t) => {
  const options = fixture(t, false);
  createBundle({ ...options, includeWorkspace: false });
  const extracted = verifyBundle(options.outFile, join(options.cwd, "..", "stage"));
  for (const flag of [null, 0, "false", [], {}]) {
    writeFileSync(join(extracted.dir, "manifest.json"), JSON.stringify({ ...extracted.manifest, workspaceIncluded: flag }));
    repack(extracted.dir, options.outFile);
    assert.throws(() => verifyBundle(options.outFile, join(options.cwd, "..", "bad")), /workspaceIncluded.*boolean/);
  }
});

it("rejects a session-only manifest that claims workspace data", (t) => {
  const options = fixture(t);
  createBundle(options);
  const extracted = verifyBundle(options.outFile, join(options.cwd, "..", "stage"));
  writeFileSync(join(extracted.dir, "manifest.json"), JSON.stringify({ ...extracted.manifest, workspaceIncluded: false }));
  repack(extracted.dir, options.outFile);
  assert.throws(() => verifyBundle(options.outFile, join(options.cwd, "..", "bad")), /session-only.*workspace/i);
});

it("rejects workspace metadata and disguised workspace members in session-only manifests", (t) => {
  const options = fixture(t, false);
  createBundle({ ...options, includeWorkspace: false });
  const extracted = verifyBundle(options.outFile, join(options.cwd, "..", "stage"));
  const edits: Array<(manifest: BundleManifest) => void> = [
    (manifest) => { manifest.repo.head = "pretend-head"; },
    (manifest) => { manifest.symlinks.push({ path: "link", target: "tracked.txt" }); },
    (manifest) => { manifest.worktree.push({ path: "tracked.txt", mode: "644", sha256: "0".repeat(64) }); },
    (manifest) => { manifest.excluded.push({ path: ".env", reason: "credential" }); },
    (manifest) => { manifest.totals.worktreeBytes = 1; },
    (manifest) => { manifest.files[0]!.role = "untracked"; },
    (manifest) => { manifest.files[0]!.path = "git.bundle"; },
  ];
  for (const edit of edits) {
    const manifest = structuredClone(extracted.manifest);
    edit(manifest);
    writeFileSync(join(extracted.dir, "manifest.json"), JSON.stringify(manifest));
    repack(extracted.dir, options.outFile);
    assert.throws(() => verifyBundle(options.outFile, join(options.cwd, "..", "bad")), /session-only.*workspace/i);
  }
});
