/**
 * Preflight for moves between a local session and a daemon: everything that can be
 * known to make the move fail is checked before the source is fenced or touched.
 *
 * Two halves. `runChecks` runs on the machine that will receive the session (the
 * daemon answers it as `move_preflight`; `pi-remote return` runs it locally): provider
 * and `gh` auth, free disk, repo remote. `connectChecked` runs on the sending side:
 * the daemon is reachable and speaks this protocol, and the pinned Pi and harness
 * versions are installed there.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient, HandshakeError } from "../client.ts";
import { SERVER_EXTENSION_VERSIONS } from "../handshake.ts";

export type CheckName = "daemon" | "versions" | "provider-auth" | "gh-auth" | "disk" | "repo-remote" | "workspace";

export interface CheckResult {
  name: CheckName;
  ok: boolean;
  detail: string;
}

export interface PreflightInput {
  /** `provider/modelId` the session uses; its provider must have working credentials on the receiver. */
  model?: string;
  /** Remote of the repo; `git ls-remote` must reach it from the receiver. */
  repoRemote?: string;
  /** The repo is hosted on GitHub, so `gh` must be installed and logged in on the receiver. */
  requireGh?: boolean;
  /** Size of the bundle; the receiver needs room for the archive, its extraction and the rebuilt workspace. */
  bytes?: number;
  /** Where the workspace will be built (default: under the receiver's server dir). */
  dir?: string;
}

export interface ChecksDeps {
  serverDir: string;
  /** Resolves when the provider's credentials work; rejects with the reason otherwise. */
  providerAuth(provider: string): Promise<void>;
}

const MIN_FREE_DEFAULT = 256 * 1024 * 1024;
const SPACE_FACTOR = 3;

function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function human(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export function isGithubRemote(remote: string | undefined): boolean {
  return remote !== undefined && /(^|[@/])github\.com[:/]/.test(remote);
}

export async function runChecks(input: PreflightInput, deps: ChecksDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  if (input.model) {
    const provider = input.model.split("/")[0]!;
    try {
      await deps.providerAuth(provider);
      results.push({ name: "provider-auth", ok: true, detail: `provider ${provider} has working credentials` });
    } catch (error) {
      results.push({ name: "provider-auth", ok: false, detail: `provider ${provider} is not authenticated there: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (input.requireGh) {
    const gh = process.env.PI_REMOTE_GH || "gh";
    const run = spawnSync(gh, ["auth", "status"], { encoding: "utf8", timeout: 20_000 });
    if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      results.push({ name: "gh-auth", ok: false, detail: `gh is not installed there (looked for \`${gh}\`)` });
    } else if (run.status !== 0) {
      results.push({ name: "gh-auth", ok: false, detail: `gh is not logged in there: ${firstLine(run.stderr || run.stdout) || `exit ${run.status}`}` });
    } else {
      results.push({ name: "gh-auth", ok: true, detail: "gh is logged in" });
    }
  }
  if (input.bytes !== undefined) {
    const dir = nearestExisting(input.dir ?? deps.serverDir);
    const stats = statfsSync(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const reserve = Number(process.env.PI_REMOTE_MIN_FREE_BYTES ?? MIN_FREE_DEFAULT);
    const needed = input.bytes * SPACE_FACTOR + reserve;
    results.push(
      free >= needed
        ? { name: "disk", ok: true, detail: `${human(free)} free, ${human(needed)} needed` }
        : { name: "disk", ok: false, detail: `only ${human(free)} free in ${dir}; the move needs about ${human(needed)} (archive, extraction and workspace)` },
    );
  }
  if (input.repoRemote) {
    const run = spawnSync("git", ["ls-remote", "--exit-code", input.repoRemote, "HEAD"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15" },
    });
    results.push(
      run.status === 0
        ? { name: "repo-remote", ok: true, detail: `${input.repoRemote} is reachable` }
        : { name: "repo-remote", ok: false, detail: `repo remote ${input.repoRemote} is not reachable there: ${firstLine(run.stderr) || `exit ${run.status}`}` },
    );
  }
  return results;
}

/** Install guidance shown when the other end lacks a matching Pi or harness. */
export function installHint(host: string | undefined): string {
  return `Install the pinned versions (Pi ${PI_VERSION}, pi-better-server ${SERVER_EXTENSION_VERSIONS["pi-better-server"]}) user-locally${host ? ` on ${host}` : ""} with packages/pi-better-server/scripts/bootstrap-host.sh, start \`pi-server\`, and retry.`;
}

/** A preflight failure: nothing was fenced, written or sent. */
export class PreflightError extends Error {
  readonly checks: CheckResult[];
  constructor(checks: CheckResult[], hint?: string) {
    const failed = checks.filter((check) => !check.ok);
    super(`Refusing to move; nothing was changed. ${failed.map((check) => `${check.name}: ${check.detail}`).join("; ")}${hint ? `\n${hint}` : ""}`);
    this.name = "PreflightError";
    this.checks = checks;
  }
}

export function assertChecks(checks: CheckResult[]): void {
  if (checks.some((check) => !check.ok)) throw new PreflightError(checks);
}

/** Connect to a daemon and refuse, with an install hint, when it is unreachable or runs other versions. `skipVersionCheck` exempts a daemon that is not a Pi one (a Codex host). */
export async function connectChecked(connect: () => Promise<DaemonClient>, host?: string, skipVersionCheck?: (client: DaemonClient) => boolean): Promise<DaemonClient> {
  let client: DaemonClient;
  try {
    client = await connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HandshakeError) throw new PreflightError([{ name: "versions", ok: false, detail: message }], installHint(host));
    throw new PreflightError([{ name: "daemon", ok: false, detail: `no daemon answered${host ? ` on ${host}` : ""}: ${message}` }], installHint(host));
  }
  if (skipVersionCheck?.(client)) return client;
  const remoteVersions = client.server?.extensionVersions ?? {};
  const wanted = SERVER_EXTENSION_VERSIONS["pi-better-server"];
  if (remoteVersions["pi-better-server"] !== wanted) {
    client.close();
    throw new PreflightError(
      [{ name: "versions", ok: false, detail: `the daemon runs pi-better-server ${remoteVersions["pi-better-server"] ?? "(unknown)"}, this side runs ${wanted}` }],
      installHint(host),
    );
  }
  return client;
}

/** URL of `origin` (or the first remote) in the repo at `cwd`, if it has one. */
export function repoRemoteOf(cwd: string): string | undefined {
  const run = spawnSync("git", ["remote"], { cwd, encoding: "utf8" });
  if (run.status !== 0) return undefined;
  const names = run.stdout.split("\n").filter(Boolean);
  const name = names.includes("origin") ? "origin" : names[0];
  if (!name) return undefined;
  const url = spawnSync("git", ["remote", "get-url", name], { cwd, encoding: "utf8" });
  return url.status === 0 ? url.stdout.trim() || undefined : undefined;
}

function treeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += treeBytes(path);
    else if (entry.isFile()) total += lstatSync(path).size;
  }
  return total;
}

/** Upper bound for the bundle: the git directory plus every non-ignored file. Over-counts generated output the bundle skips. */
export function estimateBundleBytes(cwd: string): number {
  let total = existsSync(join(cwd, ".git")) ? treeBytes(join(cwd, ".git")) : 0;
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 256 * 1024 * 1024 });
  if (listed.status !== 0) return total;
  for (const rel of listed.stdout.toString("utf8").split("\0").filter(Boolean)) {
    try {
      const info = lstatSync(join(cwd, rel));
      if (info.isFile()) total += info.size;
    } catch {
      // deleted but still tracked: it is not in the worktree
    }
  }
  return total;
}
