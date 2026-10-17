/**
 * Session bundle: one tar archive that carries a coding session and its git
 * workspace between hosts. Agent-agnostic (no Pi imports): the caller says which
 * session files and state to include and what agent produced them.
 *
 * Archive layout (all members are regular files; symlinks travel in the manifest):
 *   manifest.json          BundleManifest, see below
 *   git.bundle             `git bundle` of the branch (or HEAD) plus the base ref
 *   tracked.patch          `git diff --binary HEAD` for dirty tracked files (optional)
 *   untracked/<path>       untracked, non-ignored files that pass the exclusion rules
 *   session/<name>         session transcript files
 *   state/<name>           session-scoped harness state
 *
 * The manifest checksums every member and also the full worktree, so a restore can
 * prove the rebuilt tree is the one that left. It never lists credential content.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { exclusionReason } from "./exclusions.ts";

export const BUNDLE_FORMAT_VERSION = 1;

export type BundleFileRole = "git-bundle" | "tracked-patch" | "untracked" | "session" | "state";

export interface BundleFile {
  /** Path inside the archive. */
  path: string;
  role: BundleFileRole;
  sha256: string;
  size: number;
}

export interface WorktreeEntry {
  /** Repo-relative path. */
  path: string;
  /** Hex sha256 of the file content, or of the link target for a symlink. */
  sha256: string;
  mode: "644" | "755" | "symlink";
}

export interface BundleManifest {
  formatVersion: typeof BUNDLE_FORMAT_VERSION;
  createdAt: string;
  /** The agent that produced the session files; the importing side decides whether it can read them. */
  agent: { kind: string; version: string; extensions: Record<string, string> };
  session: { id: string; name?: string; model?: string; createdAt?: string; metadata?: Record<string, unknown> };
  /** Logical-session ownership at export time; the importer takes epoch + 1. */
  ownership: { epoch: number; from: string; moveId: string };
  repo: {
    remote?: string;
    branch?: string;
    head: string;
    /** Ref the bundle also carries so the target can diff against it. */
    baseRef?: string;
    baseSha?: string;
  };
  files: BundleFile[];
  /** Untracked symlinks, recreated on restore. */
  symlinks: Array<{ path: string; target: string }>;
  /** Paths left out and why. Never the content. */
  excluded: Array<{ path: string; reason: "credential" | "generated" }>;
  /** Digest of every file the worktree should hold after restore. */
  worktree: WorktreeEntry[];
  totals: { files: number; bytes: number; worktreeFiles: number; worktreeBytes: number };
}

export interface CreateBundleOptions {
  /** Top-level directory of the git work tree. */
  cwd: string;
  outFile: string;
  agent: BundleManifest["agent"];
  session: BundleManifest["session"];
  ownership: BundleManifest["ownership"];
  /** Transcript files to carry, stored as `session/<name>`. */
  sessionFiles?: Array<{ name: string; path: string }>;
  /** Harness state to carry, stored as `state/<name>`. */
  stateFiles?: Array<{ name: string; content: string | Buffer }>;
  /** Branch the work is based on; default: the first of origin/main, origin/master, main, master that exists. */
  baseRef?: string;
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

function git(cwd: string, args: string[], options: { input?: Buffer; allowFailure?: boolean } = {}): Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      input: options.input,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    if (options.allowFailure) return Buffer.alloc(0);
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new BundleError(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function gitText(cwd: string, args: string[], allowFailure = false): string {
  return git(cwd, args, { allowFailure }).toString("utf8").trim();
}

function splitNul(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Of(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Paths git considers part of the worktree (tracked + untracked, not ignored) that the bundle policy allows. */
function worktreePaths(cwd: string): { included: string[]; excluded: Array<{ path: string; reason: "credential" | "generated" }> } {
  const all = splitNul(git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  const included: string[] = [];
  const excluded: Array<{ path: string; reason: "credential" | "generated" }> = [];
  for (const path of [...new Set(all)].sort()) {
    const reason = exclusionReason(path);
    if (reason) excluded.push({ path, reason });
    else included.push(path);
  }
  return { included, excluded };
}

/**
 * Checksums of the files a restored worktree must hold. Same function runs on both ends.
 * Throws when a listed path is a directory (nested repo / submodule): the move is refused rather than silently omitting it.
 */
export function digestWorktree(cwd: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const nested: string[] = [];
  for (const path of worktreePaths(cwd).included) {
    const full = join(cwd, path);
    let info;
    try {
      info = lstatSync(full);
    } catch {
      continue; // tracked but deleted in the work tree
    }
    if (info.isSymbolicLink()) {
      entries.push({ path, sha256: sha256Of(readlinkSync(full)), mode: "symlink" });
    } else if (info.isFile()) {
      entries.push({ path, sha256: sha256File(full), mode: info.mode & 0o111 ? "755" : "644" });
    } else if (info.isDirectory()) {
      // Untracked nested git repo or submodule: its contents are not part of this repo's history or file list.
      nested.push(path);
    }
  }
  if (nested.length > 0) {
    throw new BundleError(
      `${nested.join(", ")} ${nested.length === 1 ? "is a nested git repository or submodule" : "are nested git repositories or submodules"}; a bundle cannot carry ${nested.length === 1 ? "it" : "them"}. Commit and push ${nested.length === 1 ? "it" : "them"} separately, or move ${nested.length === 1 ? "it" : "them"} out of the workspace, then retry the move.`,
    );
  }
  return entries;
}

function detectBase(cwd: string, branch: string | undefined, requested: string | undefined): string | undefined {
  const candidates = requested ? [requested] : ["origin/main", "origin/master", "main", "master"];
  for (const candidate of candidates) {
    if (candidate === branch) continue;
    if (git(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { allowFailure: true }).length > 0) return candidate;
  }
  if (requested) throw new BundleError(`Base ref ${requested} does not exist in ${cwd}`);
  return undefined;
}

function stageFile(stage: string, archivePath: string, source: string | Buffer, files: BundleFile[], role: BundleFileRole): void {
  const target = join(stage, archivePath);
  mkdirSync(dirname(target), { recursive: true });
  if (typeof source === "string") copyFileSync(source, target);
  else writeFileSync(target, source);
  files.push({ path: archivePath, role, sha256: sha256File(target), size: statSync(target).size });
}

function tar(args: string[]): void {
  try {
    execFileSync("tar", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new BundleError(`tar failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function isBsdTar(): boolean {
  return execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("bsdtar");
}

/** Package the session and its workspace into `outFile`. The work tree is only read, never changed. */
export function createBundle(options: CreateBundleOptions): BundleManifest {
  const cwd = resolve(options.cwd);
  const root = gitText(cwd, ["rev-parse", "--show-toplevel"], true);
  if (!root) throw new BundleError(`${cwd} is not inside a git work tree; a session can only move with a git workspace`);
  if (resolve(root) !== resolve(cwd) && !existsSync(join(cwd, ".git"))) {
    throw new BundleError(`${cwd} is not the top of its git work tree (${root}); move the session from the repository root`);
  }
  const head = gitText(cwd, ["rev-parse", "--verify", "HEAD"], true);
  if (!head) throw new BundleError(`${cwd} has no commits yet; commit once so the history can travel`);
  const branch = gitText(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], true) || undefined;
  const remote = gitText(cwd, ["remote", "get-url", "origin"], true) || undefined;
  const baseRef = detectBase(cwd, branch, options.baseRef);
  const baseSha = baseRef ? gitText(cwd, ["rev-parse", `${baseRef}^{commit}`]) : undefined;

  const scratch = mkdtempSync(join(dirname(resolve(options.outFile)), ".bundle-stage-"));
  try {
    const files: BundleFile[] = [];
    const excluded = new Map<string, "credential" | "generated">();

    // History: the branch (or detached HEAD) and the base ref, as a git bundle.
    const gitBundle = join(scratch, "git.bundle.tmp");
    const refs = [branch ? `refs/heads/${branch}` : "HEAD", ...(baseRef ? [baseRef] : [])];
    git(cwd, ["bundle", "create", gitBundle, ...refs]);
    stageFile(scratch, "git.bundle", gitBundle, files, "git-bundle");
    rmSync(gitBundle);

    // Dirty tracked changes (staged and unstaged) against HEAD, minus excluded paths.
    const changed = splitNul(git(cwd, ["diff", "-z", "--name-only", "--no-renames", "HEAD"]));
    const patchPaths: string[] = [];
    for (const path of changed) {
      const reason = exclusionReason(path);
      if (reason) excluded.set(path, reason);
      else patchPaths.push(path);
    }
    if (patchPaths.length > 0) {
      const patch = git(cwd, ["diff", "--binary", "--no-renames", "--no-ext-diff", "HEAD", "--", ...patchPaths]);
      stageFile(scratch, "tracked.patch", patch, files, "tracked-patch");
    }

    // Untracked, non-ignored files, minus excluded paths.
    const symlinks: BundleManifest["symlinks"] = [];
    for (const path of splitNul(git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"])).sort()) {
      const reason = exclusionReason(path);
      if (reason) {
        excluded.set(path, reason);
        continue;
      }
      const full = join(cwd, path);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) {
        // Restore refuses absolute, escaping and .git-bound links, so fail here rather than ship a bundle that cannot restore.
        const link = { path, target: readlinkSync(full) };
        assertSafeSymlinkTarget(link);
        symlinks.push(link);
      } else if (info.isFile()) {
        stageFile(scratch, `untracked/${path}`, full, files, "untracked");
        if (info.mode & 0o111) chmodSync(join(scratch, "untracked", path), info.mode & 0o777);
      }
    }

    for (const file of options.sessionFiles ?? []) {
      assertPlainName(file.name);
      stageFile(scratch, `session/${file.name}`, file.path, files, "session");
    }
    for (const file of options.stateFiles ?? []) {
      assertPlainName(file.name);
      stageFile(scratch, `state/${file.name}`, typeof file.content === "string" ? Buffer.from(file.content) : file.content, files, "state");
    }

    const worktree = digestWorktree(cwd);
    const totals = {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      worktreeFiles: worktree.length,
      worktreeBytes: worktree.reduce((sum, entry) => sum + (entry.mode === "symlink" ? 0 : statSync(join(cwd, entry.path)).size), 0),
    };
    const manifest: BundleManifest = {
      formatVersion: BUNDLE_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      agent: options.agent,
      session: options.session,
      ownership: options.ownership,
      repo: { ...(remote ? { remote } : {}), ...(branch ? { branch } : {}), head, ...(baseRef ? { baseRef, baseSha } : {}) },
      files,
      symlinks,
      excluded: [...excluded].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path)),
      worktree,
      totals,
    };
    writeFileSync(join(scratch, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const members = ["manifest.json", "git.bundle", ...["tracked.patch", "untracked", "session", "state"].filter((m) => existsSync(join(scratch, m)))];
    // macOS bsdtar would otherwise embed extended attributes that GNU tar warns about on the target.
    tar(["-cf", resolve(options.outFile), ...(isBsdTar() ? ["--no-xattrs"] : []), "-C", scratch, ...members]);
    return manifest;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function assertPlainName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.startsWith("-")) {
    throw new BundleError(`Unsafe bundle member name: ${JSON.stringify(name)}`);
  }
}

export interface ExtractedBundle {
  manifest: BundleManifest;
  /** Directory holding the verified members; the caller removes it. */
  dir: string;
}

/**
 * Unpack `archive` into a fresh directory under `workDir` and check it against its
 * manifest: every member listed, every checksum and size equal, nothing extra, and
 * no member that could escape the directory. Throws BundleError on any mismatch.
 */
export function verifyBundle(archive: string, workDir: string): ExtractedBundle {
  const listing = execFileSync("tar", ["-tvf", archive], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  for (const line of listing.split("\n").filter(Boolean)) {
    if (line[0] !== "-" && line[0] !== "d") throw new BundleError(`Bundle has a member that is not a plain file or directory: ${line}`);
  }
  const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
  for (const name of names) {
    if (name.startsWith("/") || name.split("/").includes("..")) throw new BundleError(`Bundle member escapes the archive: ${name}`);
  }

  mkdirSync(workDir, { recursive: true });
  const dir = mkdtempSync(join(workDir, "extract-"));
  try {
    tar(["-xf", archive, "-C", dir]);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) throw new BundleError("Bundle has no manifest.json");
    let manifest: BundleManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BundleManifest;
    } catch {
      throw new BundleError("Bundle manifest is not valid JSON");
    }
    if (manifest.formatVersion !== BUNDLE_FORMAT_VERSION) {
      throw new BundleError(`Unsupported bundle format ${String(manifest.formatVersion)}; this build reads format ${BUNDLE_FORMAT_VERSION}`);
    }
    const listed = new Set<string>();
    let bytes = 0;
    for (const file of manifest.files) {
      if (file.path.startsWith("/") || file.path.split("/").includes("..")) throw new BundleError(`Manifest path escapes the bundle: ${file.path}`);
      const full = join(dir, file.path);
      if (!existsSync(full) || !statSync(full).isFile()) throw new BundleError(`Bundle is missing ${file.path}`);
      if (statSync(full).size !== file.size) throw new BundleError(`Size mismatch for ${file.path}`);
      if (sha256File(full) !== file.sha256) throw new BundleError(`Checksum mismatch for ${file.path}`);
      listed.add(file.path);
      bytes += file.size;
    }
    if (manifest.totals.files !== manifest.files.length || manifest.totals.bytes !== bytes) throw new BundleError("Manifest totals do not match its file list");
    for (const found of walkFiles(dir)) {
      if (found !== "manifest.json" && !listed.has(found)) throw new BundleError(`Bundle holds ${found}, which the manifest does not list`);
    }
    for (const entry of manifest.worktree) {
      const reason = exclusionReason(entry.path);
      if (reason) throw new BundleError(`Bundle worktree lists ${reason} path ${entry.path}`);
    }
    assertSafeWorkspaceEntries(manifest);
    return { manifest, dir };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Bundle paths and link targets use POSIX semantics, as the restoring filesystem does: '/' is the only separator. */
function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".");
}

function hasGitSegment(path: string): boolean {
  return pathSegments(path).some(isDotGitName);
}

/** A segment that names `.git` on some filesystem: case variants, plus the NTFS aliases git's is_ntfs_dotgit refuses ('.git.', '.git ', 'git~1', a ':stream' suffix). */
function isDotGitName(segment: string): boolean {
  const name = segment.toLowerCase().split(":")[0]!.replace(/[. ]+$/, "");
  return name === ".git" || name === "git~1";
}

/** The rule restore applies to a symlink's target: present, no backslash, not absolute, not climbing out of the workspace, not into `.git`. */
function assertSafeSymlinkTarget(link: { path: string; target: string }): void {
  if (typeof link.target !== "string" || link.target === "") throw new BundleError(`Symlink ${link.path} has no target`);
  if (link.target.includes("\\")) throw new BundleError(`Symlink ${link.path} target contains a backslash: ${link.target}`);
  if (isAbsolute(link.target) || link.target.startsWith("/") || /^[A-Za-z]:/.test(link.target)) {
    throw new BundleError(`Symlink ${link.path} has an absolute target: ${link.target}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(pathSegments(link.path).join("/")), link.target));
  if (resolved === ".." || resolved.startsWith("../")) throw new BundleError(`Symlink ${link.path} points outside the workspace: ${link.target}`);
  if (hasGitSegment(resolved) || hasGitSegment(link.target)) throw new BundleError(`Symlink ${link.path} points into .git: ${link.target}`);
}

/**
 * Refuse, before anything is written, a bundle that could plant or redirect writes into `.git`
 * (a hook, `core.fsmonitor`, ...) or outside the workspace: any `.git` path segment (case-insensitive)
 * in files, worktree entries or symlinks; a backslash in any path or symlink target (a filename character on
 * POSIX that other tools read as a separator); symlinks that are absolute, climb out of the workspace, or
 * point into `.git`; and members whose path runs through another bundled symlink.
 */
export function assertSafeWorkspaceEntries(manifest: BundleManifest): void {
  const workspacePath = (path: string, what: string): void => {
    if (path.includes("\\")) throw new BundleError(`${what} contains a backslash: ${path}`);
    if (isAbsolute(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path) || pathSegments(path).includes("..")) {
      throw new BundleError(`${what} escapes the workspace: ${path}`);
    }
    if (hasGitSegment(path)) throw new BundleError(`${what} writes into .git: ${path}`);
  };
  for (const file of manifest.files) {
    if (file.role === "untracked") workspacePath(file.path.slice("untracked/".length), "Untracked path");
  }
  for (const entry of manifest.worktree) workspacePath(entry.path, "Worktree path");
  const linkPaths = new Set<string>();
  for (const link of manifest.symlinks) {
    workspacePath(link.path, "Symlink path");
    assertSafeSymlinkTarget(link);
    linkPaths.add(pathSegments(link.path).join("/"));
  }
  const members = [
    ...manifest.files.filter((f) => f.role === "untracked").map((f) => f.path.slice("untracked/".length)),
    ...manifest.symlinks.map((l) => l.path),
  ];
  for (const member of members) {
    const parts = pathSegments(member);
    for (let i = 1; i < parts.length; i++) {
      if (linkPaths.has(parts.slice(0, i).join("/"))) throw new BundleError(`Bundle path ${member} runs through symlink ${parts.slice(0, i).join("/")}`);
    }
  }
}

/**
 * Resolve `relative` (a path under `root`) segment by segment with lstat/readlink, following links the way the
 * kernel does ('..' applies to the already-resolved prefix). Returns the segments of the final location relative
 * to `root`, or null when it leaves `root` or a link target holds a backslash. A missing segment ends the walk:
 * the rest is taken literally.
 */
function resolveInside(root: string, relative: string): string[] | null {
  const resolved: string[] = [];
  const pending = pathSegments(relative).reverse();
  for (let hops = 0; pending.length > 0; ) {
    const part = pending.pop()!;
    if (part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    let target: string | undefined;
    try {
      const full = join(root, ...resolved, part);
      if (lstatSync(full).isSymbolicLink()) target = readlinkSync(full);
    } catch {
      // missing: nothing further to follow
    }
    if (target === undefined) {
      resolved.push(part);
      continue;
    }
    if (++hops > 40) return null;
    if (target.includes("\\") || isAbsolute(target) || target.startsWith("/") || /^[A-Za-z]:/.test(target)) return null;
    pending.push(...pathSegments(target).reverse());
  }
  return resolved;
}

/**
 * After the whole restore (checkout, patch, untracked files, symlinks) every symlink in the work tree must
 * resolve, through any other links, to a place inside the workspace and outside `.git`.
 */
function assertSymlinksContained(dest: string, prefix = ""): void {
  for (const entry of readdirSync(join(dest, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!prefix && entry.name.toLowerCase() === ".git") continue;
      assertSymlinksContained(dest, relative);
    } else if (entry.isSymbolicLink()) {
      const final = resolveInside(dest, relative);
      if (!final) throw new BundleError(`Symlink ${relative} points outside the workspace`);
      if (final[0]?.toLowerCase() === ".git") throw new BundleError(`Symlink ${relative} points into .git`);
    }
  }
}

/** Refuse to write `relative` under `dest` when a parent directory already is a symlink (e.g. a tracked link into .git). */
function assertNoSymlinkParent(dest: string, relative: string): void {
  const parts = pathSegments(relative);
  let current = dest;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) throw new BundleError(`Bundle path ${relative} runs through symlink ${part}`);
  }
}

function walkFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, relative));
    else out.push(relative);
  }
  return out;
}

export interface MaterializeResult {
  cwd: string;
  files: number;
  bytes: number;
}

/**
 * Rebuild the workspace in `destDir` (absent or empty) from a verified bundle:
 * history, then dirty tracked changes, then untracked files. Fails unless the
 * result matches the manifest's worktree digest; on failure `destDir` is removed.
 */
export function materializeWorkspace(extracted: ExtractedBundle, destDir: string): MaterializeResult {
  const { manifest, dir } = extracted;
  const dest = resolve(destDir);
  assertSafeWorkspaceEntries(manifest);
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new BundleError(`Destination ${dest} already exists and is not empty`);
  const created = !existsSync(dest);
  mkdirSync(dest, { recursive: true });
  try {
    const { repo } = manifest;
    git(dest, ["init", "-q", ...(repo.branch ? ["-b", repo.branch] : [])]);
    const bundlePath = join(dir, "git.bundle");
    git(dest, ["fetch", "-q", "--update-head-ok", bundlePath, "+refs/heads/*:refs/heads/*", "+refs/remotes/*:refs/remotes/*"]);
    if (repo.branch) git(dest, ["checkout", "-q", "-f", repo.branch]);
    else git(dest, ["checkout", "-q", "-f", "--detach", repo.head]);
    const head = gitText(dest, ["rev-parse", "HEAD"]);
    if (head !== repo.head) throw new BundleError(`Restored HEAD ${head} is not the bundled ${repo.head}`);
    if (repo.remote) git(dest, ["remote", "add", "origin", repo.remote], { allowFailure: true });

    const patch = join(dir, "tracked.patch");
    if (existsSync(patch)) git(dest, ["apply", "--binary", "--whitespace=nowarn", patch]);

    for (const file of manifest.files.filter((f) => f.role === "untracked")) {
      const relative = file.path.slice("untracked/".length);
      const target = join(dest, relative);
      if (!resolve(target).startsWith(dest + sep)) throw new BundleError(`Untracked path escapes the workspace: ${relative}`);
      assertNoSymlinkParent(dest, relative);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(dir, file.path), target);
      chmodSync(target, statSync(join(dir, file.path)).mode & 0o777);
    }
    for (const link of manifest.symlinks) {
      const target = join(dest, link.path);
      if (!resolve(target).startsWith(dest + sep)) throw new BundleError(`Symlink path escapes the workspace: ${link.path}`);
      assertNoSymlinkParent(dest, link.path);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(link.target, target);
    }

    assertSymlinksContained(dest);
    const restored = digestWorktree(dest);
    const mismatches = diffDigests(manifest.worktree, restored);
    if (mismatches.length > 0) {
      throw new BundleError(`Restored workspace differs from the bundle in ${mismatches.length} file(s): ${mismatches.slice(0, 5).join(", ")}`);
    }
    return { cwd: dest, files: restored.length, bytes: manifest.totals.worktreeBytes };
  } catch (error) {
    if (created) rmSync(dest, { recursive: true, force: true });
    else for (const name of readdirSync(dest)) rmSync(join(dest, name), { recursive: true, force: true });
    throw error;
  }
}

export function diffDigests(expected: WorktreeEntry[], actual: WorktreeEntry[]): string[] {
  const have = new Map(actual.map((entry) => [entry.path, entry]));
  const diff: string[] = [];
  for (const entry of expected) {
    const found = have.get(entry.path);
    if (!found || found.sha256 !== entry.sha256 || found.mode !== entry.mode) diff.push(entry.path);
    have.delete(entry.path);
  }
  diff.push(...have.keys());
  return diff;
}
