import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getAgentDir, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface PackageSpec {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  autoload?: boolean;
}

export interface PackageCatalog {
  packages: PackageSpec[];
  unsupported: string[];
}

export interface PackageSyncConflict { local: PackageSpec; remote: PackageSpec }
export interface PackageSyncPlan {
  install: PackageSpec[];
  unchanged: PackageSpec[];
  conflicts?: PackageSyncConflict[];
}

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piRequire = createRequire(piEntry);
const semver = piRequire("semver") as {
  valid(value: string): string | null;
  validRange(value: string): string | null;
};
const lockfile = piRequire("proper-lockfile") as {
  lockSync(path: string, options: { realpath: boolean }): () => void;
  lock(path: string, options: { realpath: boolean; retries: { retries: number; minTimeout: number; maxTimeout: number } }): Promise<() => Promise<void>>;
};
const run = promisify(execFile);
const resources = ["extensions", "skills", "prompts", "themes"] as const;
const commitPattern = /^[a-f0-9]{40}$/;
let installs: Promise<void> = Promise.resolve();

type Source =
  | { kind: "npm"; identity: string; name: string; version?: string }
  | { kind: "git"; identity: string; repo: string; host: string; path: string; ref?: string };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function spec(value: unknown): PackageSpec {
  const input = typeof value === "string" ? { source: value } : object(value);
  if (typeof input.source !== "string" || !input.source || /[\x00-\x1f\x7f]/.test(input.source)) {
    throw new Error("Invalid package source");
  }
  const result: PackageSpec = { source: input.source };
  if (input.autoload !== undefined) {
    if (typeof input.autoload !== "boolean") throw new Error("Invalid package autoload");
    result.autoload = input.autoload;
  }
  for (const key of resources) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || !input[key].every((entry: unknown) => typeof entry === "string" && !/[\x00-\x1f\x7f]/.test(entry))) {
      throw new Error(`Invalid package ${key} filter`);
    }
    result[key] = [...input[key]] as string[];
  }
  return result;
}

function parse(source: string): Source {
  if (/\s|[\x00-\x1f\x7f\\]/.test(source)) throw new Error("Invalid package source");
  if (source.startsWith("npm:")) {
    const match = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([^@]+))?$/.exec(source);
    if (!match || (match[2] && !semver.validRange(match[2]) && !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(match[2]))) {
      throw new Error("Invalid npm package source");
    }
    return { kind: "npm", identity: `npm:${match[1]}`, name: match[1]!, version: match[2] };
  }
  let url = source.startsWith("git:") ? source.slice(4) : source;
  if (source.startsWith("git:") && url.startsWith("git@")) url = url.replace(/^git@([^:]+):/, "ssh://git@$1/");
  if (source.startsWith("git:") && !url.includes("://")) url = `https://${url}`;
  // The ref separator is in the path, never the SSH username.
  const pathStart = url.indexOf("/", url.indexOf("://") + 3);
  const refStart = Math.max(url.indexOf("@", pathStart), url.indexOf("#", pathStart));
  const repo = refStart === -1 ? url : url.slice(0, refStart);
  const ref = refStart === -1 ? undefined : url.slice(refStart + 1);
  if (ref !== undefined && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) || ref.split("/").some(part => part === ".." || part === "."))) {
    throw new Error("Invalid git package ref");
  }
  const parsed = new URL(repo);
  if (!["https:", "ssh:", "git:"].includes(parsed.protocol) || parsed.password || parsed.search || parsed.hash || parsed.port ||
      (parsed.username && !(parsed.protocol === "ssh:" && parsed.username === "git")) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(parsed.hostname)) throw new Error("Unsupported git package URL");
  const rawPath = repo.slice(repo.indexOf("/", repo.indexOf("://") + 3) + 1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(rawPath) || rawPath.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("-"))) {
    throw new Error("Unsafe git package path");
  }
  const path = rawPath.replace(/\.git$/, "");
  if (path.split("/").length < 2 || path.split("/").some(part => !part)) throw new Error("Invalid git package path");
  return { kind: "git", identity: `git:${parsed.hostname}/${path}`, repo, host: parsed.hostname, path, ref };
}

function pinned(value: unknown): PackageSpec {
  const result = spec(value);
  const source = parse(result.source);
  if (source.kind === "git" && result.source.includes("#")) throw new Error("Git package pins must use @ followed by a full commit, not a URL fragment");
  if (source.kind === "npm" ? !source.version || semver.valid(source.version) !== source.version : !commitPattern.test(source.ref ?? "")) {
    throw new Error("Package sync requires an exact npm version or full git commit");
  }
  return result;
}

function readObject(path: string): Record<string, unknown> {
  try { return object(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function acquire(path: string): () => void {
  for (let attempt = 0; ; attempt++) {
    try { return lockfile.lockSync(path, { realpath: false }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function entries(settings: Record<string, unknown>): unknown[] {
  if (settings.packages === undefined) return [];
  if (!Array.isArray(settings.packages)) throw new Error("Invalid packages setting");
  return settings.packages;
}

function identity(value: unknown): string | undefined {
  try { return parse(spec(value).source).identity; } catch { return undefined; }
}

function unsupportedLabel(value: unknown): string {
  const source = typeof value === "string" ? value : value && typeof value === "object" ? (value as PackageSpec).source : undefined;
  if (typeof source !== "string" || /[\p{C}]/u.test(source)) return "[unsupported package source]";
  if (/^(?:\.\.?\/|\/|~\/)/.test(source) && /^[\p{L}\p{M}\p{N}._~@/ -]+$/u.test(source)) return source;
  try { parse(source); return source; } catch { return "[unsupported package source]"; }
}

function resourceLabel(value: unknown): string {
  // Resource paths and selectors are not package declarations or installable sources.
  if (typeof value === "string" && /^[\p{L}\p{M}\p{N}._~@/ !+*?\[\]{},()-]+$/u.test(value)) {
    if (/^[!+-]|[\*?]/.test(value)) return "[local resource selectors]";
    return value;
  }
  return unsupportedLabel(value);
}

function readPackageSettings(agentDir: string, cwd: string, scope: "global" | "workspace" = "workspace") {
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const errors = manager.drainErrors();
  if (errors.length) throw new Error("Cannot read Pi package settings", { cause: errors[0]!.error });
  if (scope === "global") return { global: manager.getGlobalSettings(), project: {} };
  const trusted = new ProjectTrustStore(agentDir).get(cwd) ?? (manager.getDefaultProjectTrust() === "always");
  if (trusted) manager.setProjectTrusted(true);
  if (manager.drainErrors().length) throw new Error("Cannot read trusted project package settings");
  return { global: manager.getGlobalSettings(), project: manager.getProjectSettings() };
}

/** Reads only package declarations, never auth, environment, or resource contents.
 * Session-only trust overrides are not discoverable here. A host with resolved
 * session state should prefer its own pinned PackageSpec[] over rediscovery.
 * Global scope skips project settings and trust entirely; workspace is the default.
 */
export async function readLocalPackageCatalog(
  agentDir = getAgentDir(), cwd = process.cwd(), options: { scope?: "global" | "workspace" } = {},
): Promise<PackageCatalog> {
  agentDir = resolve(agentDir);
  cwd = resolve(cwd);
  const { global, project } = readPackageSettings(agentDir, cwd, options.scope);
  const selected = new Map<string, { value: unknown; base: string; layered: boolean }>();
  const catalog: PackageCatalog = { packages: [], unsupported: [] };
  for (const [settings, base] of [[global, agentDir], [project, join(cwd, ".pi")]] as const) {
    for (const key of resources) {
      const paths = settings[key];
      if (Array.isArray(paths)) for (const path of paths) catalog.unsupported.push(resourceLabel(path));
    }
    for (const value of entries(settings as Record<string, unknown>)) {
      const key = identity(value);
      if (!key) { catalog.unsupported.push(unsupportedLabel(value)); continue; }
      const layered = selected.has(key) && typeof value === "object" && value !== null && (value as PackageSpec).autoload === false;
      selected.set(key, { value, base, layered });
    }
  }
  for (const { value, base, layered } of selected.values()) {
    try {
      if (layered) throw new Error("Layered project package filters cannot be flattened");
      const item = spec(value);
      const source = parse(item.source);
      if (source.kind === "npm") {
        const installed = readObject(join(base, "npm", "node_modules", source.name, "package.json"));
        if (installed.name !== source.name || typeof installed.version !== "string" || semver.valid(installed.version) !== installed.version) {
          throw new Error("Cannot pin an uninstalled npm package");
        }
        item.source = `npm:${source.name}@${installed.version}`;
      } else {
        const root = join(base, "git", source.host, source.path);
        if (!existsSync(join(root, ".git"))) throw new Error("Cannot pin an uninstalled git package");
        const { stdout } = await run("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8", timeout: 10_000 });
        const commit = stdout.trim();
        if (!commitPattern.test(commit)) throw new Error("Cannot resolve installed git commit");
        item.source = `git:${source.repo}@${commit}`;
      }
      catalog.packages.push(pinned(item));
    } catch {
      catalog.unsupported.push(unsupportedLabel(value));
    }
  }
  catalog.unsupported = [...new Set(catalog.unsupported)];
  return catalog;
}

/** Pure preview: conflicts are not installed implicitly; remote-only entries stay untouched. */
export function planPackageSync(local: PackageSpec[], remote: PackageSpec[]): PackageSyncPlan {
  if (!Array.isArray(local) || !Array.isArray(remote)) throw new Error("Expected package arrays");
  const plan: PackageSyncPlan = { install: [], unchanged: [] };
  const seen = new Set<string>();
  for (const value of local) {
    const item = pinned(value);
    const key = parse(item.source).identity;
    if (seen.has(key)) throw new Error("Duplicate local package identity");
    seen.add(key);
    const matches = remote.filter(other => identity(other) === key).map(other => spec(other));
    if (!matches.length) plan.install.push(item);
    else if (matches.length === 1 && JSON.stringify(item) === JSON.stringify(matches[0])) plan.unchanged.push(item);
    else for (const other of matches) (plan.conflicts ??= []).push({ local: item, remote: other });
  }
  return plan;
}

function piCliPath(): string {
  let root = dirname(piEntry);
  for (;;) {
    const manifest = readObject(join(root, "package.json"));
    if (manifest.name === "@earendil-works/pi-coding-agent") {
      const bin = typeof manifest.bin === "string" ? manifest.bin : object(manifest.bin).pi;
      if (typeof bin !== "string") throw new Error("Installed Pi manifest has no CLI bin");
      const path = resolve(root, bin);
      if (!path.startsWith(`${root}/`)) throw new Error("Invalid installed Pi CLI bin");
      return path;
    }
    const parent = dirname(root);
    if (parent === root) throw new Error("Cannot find installed Pi CLI manifest");
    root = parent;
  }
}

function persistPackage(agentDir: string, item: PackageSpec): void {
  const path = join(agentDir, "settings.json");
  const release = acquire(path);
  let pending: string | undefined;
  try {
    const settings = readObject(path);
    const key = parse(item.source).identity;
    const current = entries(settings);
    const index = current.findIndex(value => identity(value) === key);
    settings.packages = current.filter(value => identity(value) !== key);
    (settings.packages as unknown[]).splice(index < 0 ? current.length : index, 0, item);
    let destination = path;
    try { if (lstatSync(path).isSymbolicLink()) destination = realpathSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    pending = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(pending, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(pending, destination);
  } finally {
    try { if (pending) rmSync(pending, { force: true }); } finally { release(); }
  }
}

/** Host-only API, invoked after preview approval. Options must never come from a socket payload.
 * Installs stop at the first failure; earlier successes remain installed. No rollback/removal.
 * With cwd, trusted project overrides are unsupported and the effective catalog
 * is verified after global installation. Project settings are never rewritten.
 */
export async function installPackageCatalog(packages: PackageSpec[], options: { agentDir?: string; piCli?: string; cwd?: string } = {}): Promise<void> {
  if (!Array.isArray(packages)) throw new Error("Expected package array");
  const approved = packages.map(pinned);
  if (new Set(approved.map(item => parse(item.source).identity)).size !== approved.length) throw new Error("Duplicate package identity");
  if (!approved.length) return;
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const cwd = options.cwd === undefined ? undefined : resolve(options.cwd);
  const cli = options.piCli ?? piCliPath();
  if (!isAbsolute(cli) || !existsSync(cli)) throw new Error("Pi CLI must be an existing absolute host-owned path");
  const install = async () => {
    mkdirSync(agentDir, { recursive: true });
    const release = await lockfile.lock(join(agentDir, ".package-sync"), {
      realpath: false, retries: { retries: 300, minTimeout: 100, maxTimeout: 1000 },
    });
    try {
      // Reject malformed existing settings before starting any installer.
      entries(readObject(join(agentDir, "settings.json")));
      if (cwd !== undefined) {
        const { project } = readPackageSettings(agentDir, cwd);
        const projectIdentities = new Set(entries(project as Record<string, unknown>).map(identity));
        const overrides = approved.filter(item => projectIdentities.has(parse(item.source).identity));
        if (overrides.length) {
          throw new Error(`Package sync refused: trusted project declarations override ${overrides.map(item => item.source).join(", ")}. Manage that project override on r5; global package sync cannot replace it. No packages were installed or settings changed.`);
        }
      }
      for (const item of approved) {
        try {
          await run(process.execPath, [cli, "install", item.source], {
            cwd: agentDir,
            env: {
              ...process.env,
              // The managed runtime's npm and its Node shebang live beside this executable.
              PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
              PI_CODING_AGENT_DIR: agentDir,
            },
            encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
          });
        } catch {
          // Installer output may contain registry credentials; do not forward it.
          throw new Error(`Package install failed: ${item.source}`);
        }
        persistPackage(agentDir, item);
      }
      if (cwd !== undefined) {
        let catalog: PackageCatalog;
        try { catalog = await readLocalPackageCatalog(agentDir, cwd); }
        catch {
          throw new Error("Package sync verification failed: cannot read the target effective catalog after global installs; settings or trust may have changed concurrently.");
        }
        for (const item of approved) {
          const source = parse(item.source);
          const expected = { ...item, source: source.kind === "git" ? `git:${source.repo}@${source.ref}` : item.source };
          const actual = catalog.packages.find(other => identity(other) === source.identity);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`Package sync verification failed: target effective catalog does not match approved declaration ${item.source} (including filters and autoload) after global installs; settings, trust, or installed packages may have changed concurrently. Manage any project override on r5.`);
          }
        }
      }
    } finally { await release(); }
  };
  const pending = installs.then(install);
  installs = pending.catch(() => {});
  await pending;
}
