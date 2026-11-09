import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import type { ServerArtifact, ServerBuild, RuntimePlatform, StagedRuntime } from "./managed-types.ts";
import { digest, stable, validateBuild, validatePayload, validateStaged, type ArtifactPayload } from "../../scripts/private-runtime/format.ts";

export const ownPackageDir = fileURLToPath(new URL("../../", import.meta.url));

/** Only shipped source and explicitly named runtime resources enter the build. */
export function createServerArtifact(options: { platform: RuntimePlatform; packageDir?: string }): ServerArtifact {
  const root = options.packageDir ?? ownPackageDir;
  for (const path of ["package.json", "scripts", "scripts/private-runtime", "scripts/private-runtime/package-lock.json"]) {
    if (lstatSync(join(root, path)).isSymbolicLink()) throw new Error(`Artifact: symlink is forbidden: ${path}`);
  }
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "scripts/private-runtime/package-lock.json"), "utf8"));
  const files: ArtifactPayload["files"] = [];
  function add(path: string) {
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Artifact: symlink is forbidden: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, path)).sort()) {
        if (["node_modules", ".git", "test-support"].includes(name) || name.startsWith(".env") || ["auth.json", "settings.json"].includes(name)) continue;
        add(`${path}/${name}`);
      }
    } else if (stat.isFile()) {
      if (stat.size > 12 * 1024 * 1024) throw new Error(`Artifact: oversized source file: ${path}`);
      files.push({ path, data: readFileSync(join(root, path)).toString("base64") });
      if (files.length > 10000) throw new Error("Artifact: file count limit");
    }
    else throw new Error(`Artifact: non-regular source: ${path}`);
  }
  add("src");
  for (const name of ["format.ts", "installer.ts", "package.json", "package-lock.json"]) add(`scripts/private-runtime/${name}`);
  files.push({ path: "package.json", data: Buffer.from(stable({ name: metadata.name, version: metadata.version, type: "module" })).toString("base64") });
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const identity = {
    format: 1 as const, sourceDigest: digest(stable(files)), piSdkVersion: lock.packages[""].dependencies["@earendil-works/pi-coding-agent"],
    nodeVersion: "24.14.1", platform: options.platform, dependencyLockDigest: digest(stable(lock)), protocolVersion: 1, serverVersion: metadata.version,
  };
  const build: ServerBuild = { ...identity, contentId: digest(stable(identity)) };
  const payload = { format: 1 as const, build, files };
  validatePayload(payload);
  const bytes = gzipSync(stable(payload), { level: 9 });
  return { build, bytes, sha256: digest(bytes) };
}

export function decodeServerArtifact(artifact: ServerArtifact): ArtifactPayload {
  if (artifact.bytes.length > 32 * 1024 * 1024 || digest(artifact.bytes) !== artifact.sha256) throw new Error("Artifact: compressed integrity mismatch or size limit");
  const payload = validatePayload(JSON.parse(gunzipSync(artifact.bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8")));
  if (stable(payload.build) !== stable(artifact.build)) throw new Error("Artifact: build identity mismatch");
  return payload;
}

export function readOwnBuild(): ServerBuild | undefined {
  try { return validateBuild(JSON.parse(readFileSync(join(ownPackageDir, "managed-build.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function readStagedRuntime(manifestPath: string): StagedRuntime {
  const runtime = validateStaged(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (runtime.manifestPath !== manifestPath || dirname(manifestPath) !== runtime.root) throw new Error("Staging: manifest location mismatch");
  return runtime;
}
