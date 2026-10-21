import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { digest, stable, validatePayload, validateStaged } from "./format.ts";

const [work, installRoot, expectedSha, mode] = process.argv.slice(2) as [string, string, string, string];
let lock: string | undefined;
let acquired = false;
let ownsWork = false;
let candidate: string | undefined;
function cancelled() { if (existsSync(join(work, "cancel"))) throw new Error("installation cancelled"); }
function plainDirectory(path: string) {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error(`permission: unsafe directory ${path}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(path: string) {
    for (const name of readdirSync(join(root, path)).sort()) {
      const rel = path ? `${path}/${name}` : name;
      if (rel === "integrity.json") continue;
      const full = join(root, rel);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(full);
        if (!target.startsWith(`${realpathSync(root)}/`)) throw new Error(`corrupt cache: symlink escape ${rel}`);
        result[rel] = `link:${readlinkSync(full)}`;
      } else if (stat.isDirectory()) visit(rel);
      else if (stat.isFile()) result[rel] = `${stat.mode & 0o111}:${digest(readFileSync(full))}`;
      else throw new Error(`corrupt cache: special file ${rel}`);
    }
  }
  visit("");
  return result;
}
function seal(root: string) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) seal(path);
    else chmodSync(path, stat.mode & 0o111 ? 0o500 : 0o400);
  }
  chmodSync(root, 0o500);
}
function removeOwned(path: string) {
  // Undo this attempt's sealing only; never touch a published release.
  if (!existsSync(path)) return;
  function writable(dir: string) {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) { const p = join(dir, name); if (lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink()) writable(p); }
  }
  writable(path);
  rmSync(path, { recursive: true, force: true });
}

try {
  writeFileSync(join(work, "installer.pid"), String(process.pid), { flag: "wx", mode: 0o600 });
  ownsWork = true;
  cancelled();
  const bytes = readFileSync(join(work, "artifact.gz"));
  if (bytes.length > 32 * 1024 * 1024 || digest(bytes) !== expectedSha) throw new Error("artifact integrity mismatch or size limit");
  const payload = validatePayload(JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString()));
  if (`${process.platform}-${process.arch}` !== payload.build.platform || process.versions.node !== payload.build.nodeVersion) throw new Error("unsupported platform or Node version mismatch");
  if (realpathSync(installRoot) !== resolve(installRoot)) throw new Error("permission: install root contains symlink");
  const releases = join(installRoot, "releases");
  const locks = join(installRoot, "locks");
  plainDirectory(releases); plainDirectory(locks);
  const finalRoot = join(releases, payload.build.contentId);
  lock = join(locks, payload.build.contentId);
  // Never reclaim an owner on elapsed time. A crashed owner requires explicit repair.
  const deadline = Date.now() + 300_000;
  let reportedWait = false;
  for (;;) {
    cancelled();
    try { mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lstatSync(lock).isSymbolicLink()) throw new Error("permission: unsafe build lock");
      if (!reportedWait) { process.stderr.write("Waiting for runtime build owner; the lock will not be reclaimed by age.\n"); reportedWait = true; }
      if (Date.now() >= deadline) throw new Error("build lock busy: owner was not reclaimed");
      await delay(200);
    }
  }
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, work }), { flag: "wx", mode: 0o600 });
  const runtime = validateStaged({ format: 1, build: payload.build, root: finalRoot, node: join(finalRoot, "node/bin/node"), entrypoint: join(finalRoot, "src/cli.ts"), manifestPath: join(finalRoot, "runtime.json"), installRoot });
  if (existsSync(finalRoot)) {
    if (lstatSync(finalRoot).isSymbolicLink()) throw new Error("corrupt cache: release symlink");
    for (const path of [runtime.manifestPath, join(finalRoot, "integrity.json"), ...payload.files.map((file) => join(finalRoot, file.path))]) {
      if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`corrupt cache: expected regular file ${path}`);
    }
    if (stable(inventory(finalRoot)) !== stable(JSON.parse(readFileSync(join(finalRoot, "integrity.json"), "utf8")))) throw new Error("corrupt cache: runtime closure integrity mismatch");
    if (stable(JSON.parse(readFileSync(runtime.manifestPath, "utf8"))) !== stable(runtime)) throw new Error("corrupt cache: manifest mismatch");
    for (const file of payload.files) if (!readFileSync(join(finalRoot, file.path)).equals(Buffer.from(file.data, "base64"))) throw new Error(`corrupt cache: source mismatch ${file.path}`);
    cancelled();
    process.stdout.write(JSON.stringify(runtime));
  } else {
    candidate = join(work, "release");
    removeOwned(candidate);
    mkdirSync(candidate, { mode: 0o700 });
    for (const file of payload.files) {
      const path = join(candidate, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(file.data, "base64"), { flag: "wx", mode: 0o600 });
    }
    cpSync(join(work, "node"), join(candidate, "node"), { recursive: true, dereference: false, verbatimSymlinks: true });
    const deps = join(work, "dependencies");
    plainDirectory(deps);
    for (const file of ["package.json", "package-lock.json"]) cpSync(join(candidate, "scripts/private-runtime", file), join(deps, file));
    const home = join(work, "home");
    plainDirectory(home); plainDirectory(join(home, "agent"));
    const env = { HOME: home, PATH: `${join(candidate, "node/bin") }:/usr/bin:/bin`, PI_CODING_AGENT_DIR: join(home, "agent"), PI_SERVER_DIR: join(home, "server"), npm_config_userconfig: join(home, "npmrc"), npm_config_globalconfig: join(home, "global-npmrc"), npm_config_cache: join(work, "npm-cache"), npm_config_registry: "https://registry.npmjs.org", npm_config_update_notifier: "false" };
    writeFileSync(env.npm_config_userconfig, ""); writeFileSync(env.npm_config_globalconfig, "");
    const node = join(candidate, "node/bin/node");
    const npm = join(candidate, "node/lib/node_modules/npm/bin/npm-cli.js");
    function npmRun(args: string[]) {
      cancelled();
      const child = spawnSync(node, [npm, ...args, "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: deps, env, encoding: "utf8", timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
      cancelled();
      return child;
    }
    if (mode === "offline") {
      for (const archive of readdirSync(join(work, "archives"))) {
        const result = npmRun(["cache", "add", join(work, "archives", archive), "--offline"]);
        if (result.status !== 0) throw new Error(`dependency cache import: ${result.stderr}`);
      }
    }
    const installed = npmRun(["ci", ...(mode === "offline" ? ["--offline"] : [] )]);
    if (installed.status !== 0) {
      if (mode === "online" && !/ENOSPC|EACCES|EPERM/.test(installed.stderr)) {
        process.stderr.write(`dependency download failed; client upload required: ${installed.stderr}`);
        process.exitCode = 75;
      } else throw new Error(`dependency installation: ${installed.error ?? installed.stderr}`);
    } else {
      renameSync(join(deps, "node_modules"), join(candidate, "node_modules"));
      writeFileSync(join(candidate, "managed-build.json"), stable(payload.build));
      writeFileSync(join(candidate, "runtime.json"), stable(runtime));
      const check = spawnSync(node, ["--input-type=module", "-e", `const sdk = await import('@earendil-works/pi-coding-agent'); if (sdk.VERSION !== ${JSON.stringify(payload.build.piSdkVersion)}) throw new Error('SDK version mismatch'); await import('./src/server.ts');`], { cwd: candidate, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
      if (check.status !== 0) throw new Error(`isolated import/version check: ${check.error ?? check.stderr}`);
      cancelled();
      seal(candidate);
      // macOS requires write permission on a directory while renaming it.
      chmodSync(candidate, 0o700);
      writeFileSync(join(candidate, "integrity.json"), stable(inventory(candidate)), { mode: 0o400 });
      cancelled();
      renameSync(candidate, finalRoot);
      candidate = undefined;
      chmodSync(finalRoot, 0o500);
      process.stdout.write(JSON.stringify(runtime));
    }
  }
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  process.stderr.write(`Runtime staging ${code === "ENOSPC" ? "disk space" : code === "EACCES" || code === "EPERM" ? "permission" : "verification/install"}: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (candidate) removeOwned(candidate);
  if (acquired && lock) rmSync(lock, { recursive: true, force: true });
  if (ownsWork) {
    rmSync(join(work, "installer.pid"), { force: true });
    if (existsSync(join(work, "cancel"))) removeOwned(work);
  }
}
