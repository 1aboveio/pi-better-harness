import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";
import type { RuntimePlatform, ServerBuild, StagedRuntime } from "../../src/startup/managed-types.ts";

export const NODE_CHECKSUMS: Record<RuntimePlatform, string> = {
  "linux-x64": "ace9fa104992ed0829642629c46ca7bd7fd6e76278cb96c958c4b387d29658ea",
  "linux-arm64": "734ff04fa7f8ed2e8a78d40cacf5ac3fc4515dac2858757cbab313eb483ba8a2",
  "darwin-x64": "2526230ad7d922be82d4fdb1e7ee1e84303e133e3b4b0ec4c2897ab31de0253d",
  "darwin-arm64": "25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe",
};
export function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function validateBuild(value: any): ServerBuild {
  if (!value || value.format !== 1 || !Object.hasOwn(NODE_CHECKSUMS, value.platform) || value.nodeVersion !== "24.14.1"
    || !/^\d+\.\d+\.\d+$/.test(value.piSdkVersion) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.serverVersion)
    || !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1
    || ![value.contentId, value.sourceDigest, value.dependencyLockDigest].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) throw new Error("Artifact: invalid build metadata or unsupported platform");
  const { contentId, ...identity } = value;
  if (digest(stable(identity)) !== contentId) throw new Error("Artifact: content identity mismatch");
  return value;
}
export interface ArtifactPayload { format: 1; build: ServerBuild; files: { path: string; data: string }[] }
export function safeSourcePath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 512 && !path.includes("\\") && !/[\0-\x1f\x7f]/.test(path)
    && !isAbsolute(path) && path === posix.normalize(path) && !path.split("/").some((p) => !p || p === ".." || p === "." || p === "node_modules" || p === ".git" || p === "test-support" || p.startsWith(".env") || p === "auth.json" || p === "settings.json")
    && (path.startsWith("src/") || ["package.json", "scripts/private-runtime/format.ts", "scripts/private-runtime/installer.ts", "scripts/private-runtime/package.json", "scripts/private-runtime/package-lock.json"].includes(path));
}
export function validatePayload(value: any): ArtifactPayload {
  if (!value || value.format !== 1 || !Array.isArray(value.files) || value.files.length > 10000) throw new Error("Artifact: invalid file table");
  validateBuild(value.build);
  const paths = new Set<string>();
  let size = 0;
  for (const file of value.files) {
    if (!file || Object.keys(file).sort().join(",") !== "data,path" || !safeSourcePath(file.path) || paths.has(file.path)) throw new Error("Artifact: unsafe or duplicate path");
    if (typeof file.data !== "string" || file.data.length > 16 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new Error("Artifact: invalid or oversized file");
    size += Buffer.byteLength(file.data, "base64");
    if (size > 48 * 1024 * 1024) throw new Error("Artifact: decoded size limit");
    paths.add(file.path);
  }
  for (const path of paths) {
    for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) if (paths.has(parent)) throw new Error("Artifact: file/directory path collision");
  }
  for (const required of ["src/cli.ts", "src/server.ts", "package.json", "scripts/private-runtime/format.ts", "scripts/private-runtime/installer.ts", "scripts/private-runtime/package-lock.json", "scripts/private-runtime/package.json"]) if (!paths.has(required)) throw new Error(`Artifact: missing ${required}`);
  if (digest(stable(value.files)) !== value.build.sourceDigest) throw new Error("Artifact: source integrity mismatch");
  const lock = JSON.parse(Buffer.from(value.files.find((f: any) => f.path === "scripts/private-runtime/package-lock.json").data, "base64").toString());
  if (digest(stable(lock)) !== value.build.dependencyLockDigest || lock.lockfileVersion !== 3 || lock.packages?.[""]?.dependencies?.["@earendil-works/pi-coding-agent"] !== value.build.piSdkVersion) throw new Error("Artifact: dependency lock mismatch");
  for (const [path, pkg] of Object.entries(lock.packages) as [string, any][]) {
    if (!path) continue;
    if (!path.startsWith("node_modules/") || path.includes("..") || pkg.link || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version)
      || typeof pkg.resolved !== "string" || !pkg.resolved.startsWith("https://registry.npmjs.org/") || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity)) throw new Error(`Artifact: dependency lacks official locked integrity: ${path}`);
  }
  return value;
}
export function validateStaged(value: any): StagedRuntime {
  if (!value || value.format !== 1) throw new Error("Staging: invalid runtime manifest");
  validateBuild(value.build);
  for (const key of ["root", "node", "entrypoint", "manifestPath", "installRoot"]) if (typeof value[key] !== "string" || !isAbsolute(value[key]) || /[\0\r\n]/.test(value[key]) || posix.normalize(value[key]) !== value[key]) throw new Error(`Staging: invalid ${key}`);
  if (value.root !== `${value.installRoot}/releases/${value.build.contentId}` || value.root.split("/").includes("node_modules")
    || value.node !== `${value.root}/node/bin/node` || value.entrypoint !== `${value.root}/src/cli.ts` || value.manifestPath !== `${value.root}/runtime.json`) throw new Error("Staging: runtime path identity mismatch");
  return value;
}
