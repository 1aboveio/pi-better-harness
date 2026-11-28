import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { replayTurn } from "./prompt-turn.mjs";

async function workspaceFiles() {
  const { tsImport } = await import("tsx/esm/api");
  return tsImport("pi-better-subagents/workspace-files.ts", import.meta.url);
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function checkpoint(cwd, spec) {
  const { snapshotTree, verifyTree } = await workspaceFiles();
  if (!Number.isInteger(spec.turns) || spec.turns < 1 || spec.turns > 64 || !Array.isArray(spec.required) ||
      !Array.isArray(spec.checks) || !spec.checks.length || spec.checks.some(c => typeof c?.equals !== "string"))
    throw Error("A task manifest needs turns (1-64), required paths and file equality checks.");
  const root = realpathSync(cwd);
  const temporary = realpathSync(tmpdir());
  if (temporary === root || temporary.startsWith(root + sep)) throw Error("Task snapshot storage must be outside the source workspace.");
  if (realpathSync(git(root, "rev-parse", "--show-toplevel")) !== root) throw Error("Capture tasks from the repository root.");
  const head = git(root, "rev-parse", "HEAD");
  const store = mkdtempSync(join(tmpdir(), "harness-task-snapshot-"));
  try {
    const omit = new Set([".git", ...(spec.omit ?? [])]);
    const entries = snapshotTree(root, store, omit);
    const paths = new Set(entries.filter(e => e.type === "file").map(e => e.name));
    for (const path of [...spec.required, ...spec.checks.map(c => c.path)]) {
      if (!paths.has(path)) throw Error(`Missing required regular file: ${path}`);
    }
    verifyTree(root, entries, omit);
    if (git(root, "rev-parse", "HEAD") !== head) throw Error("Workspace revision changed during capture.");
    const repo = join(store, "revision.git");
    git(store, "init", "--bare", "--quiet", repo);
    git(repo, "fetch", "--quiet", "--depth=1", "--no-tags", root, head);
    git(repo, "update-ref", "HEAD", head);
    return { head, root, store, entries, spec, dispose: () => rmSync(store, { recursive: true, force: true }) };
  } catch (error) { rmSync(store, { recursive: true, force: true }); throw error; }
}

export async function taskArm(snapshot, body, laterInputs, generate, budget, signal) {
  const { restoreTree, verifyTree } = await workspaceFiles();
  const root = mkdtempSync(join(tmpdir(), "harness-task-arm-"));
  const files = new Set(snapshot.entries.filter(e => e.type === "file").map(e => e.name));
  const changes = new Map();
  const turns = [];
  let remaining = budget;
  try {
    git(root, "clone", "--no-checkout", "--quiet", join(snapshot.store, "revision.git"), ".");
    const head = git(root, "rev-parse", "HEAD");
    if (head !== snapshot.head) throw Error("Restored revision differs from the task checkpoint.");
    git(root, "read-tree", head);
    restoreTree(root, snapshot.store, snapshot.entries);
    verifyTree(root, snapshot.entries, new Set([".git"]));
    function dispatch(name, args) {
      if (!["read", "write"].includes(name) || typeof args?.path !== "string")
        return { reason: "Unsupported tool in isolated task" };
      const path = relative(snapshot.root, resolve(snapshot.root, args.path));
      if (!files.has(path) || realpathSync(join(root, path)) !== join(realpathSync(root), path) ||
          path.split(sep).includes(".git")) return { reason: "Path outside restored regular files" };
      const dest = join(root, path);
      if (name === "read" && Object.keys(args).every(k => k === "path")) return { content: readFileSync(dest, "utf8") };
      if (name !== "write" || typeof args.content !== "string" || Object.keys(args).some(k => !["path", "content"].includes(k)))
        return { reason: "Unsupported file arguments" };
      if (!changes.has(path)) changes.set(path, readFileSync(dest, "utf8"));
      writeFileSync(dest, args.content);
      return { content: `Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}` };
    }
    for (const input of [null, ...laterInputs]) {
      if (input) body.messages.push(structuredClone(input));
      const result = await replayTurn(body, { generate, dispatch, budget: remaining, signal });
      remaining -= result.trace.filter(item => Object.hasOwn(item, "assistant")).length;
      turns.push(result);
      if (result.status !== "completed") break;
    }
    const diff = [...changes].map(([path, before]) => ({ path, before, after: readFileSync(join(root, path), "utf8") }))
      .filter(item => item.before !== item.after);
    const checks = snapshot.spec.checks.map(c => {
      const actual = readFileSync(join(root, c.path), "utf8");
      return { ...c, actual, passed: actual === c.equals };
    });
    return { head, budget, turns, status: turns.at(-1).status, diff, checks };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
