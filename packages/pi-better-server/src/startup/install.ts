import { randomUUID, createHash } from "node:crypto";
import { posix } from "node:path";
import { decodeServerArtifact } from "./artifact.ts";
import { absolutePath, probeRemoteRuntime, shellQuote } from "./runtime.ts";
import type { RunRemote, ServerArtifact, StagedRuntime } from "./managed-types.ts";
import { NODE_CHECKSUMS, NODE_EXECUTABLE_CHECKSUMS, validateStaged } from "../../scripts/private-runtime/format.ts";

export interface StageRuntimeOptions {
  run: RunRemote;
  artifact: ServerArtifact;
  signal?: AbortSignal;
  installRoot?: string;
  onProgress?: (stage: string) => void;
}

async function download(url: string, integrity: string, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Runtime download: HTTP ${response.status} for ${url}`);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 128 * 1024 * 1024) throw new Error("Runtime download: archive size limit");
    parts.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(parts);
  const [algorithm, expected] = integrity.split("-", 2);
  if (createHash(algorithm!).update(bytes).digest(algorithm === "sha256" ? "hex" : "base64") !== expected) throw new Error(`Runtime download: integrity mismatch for ${url}`);
  return bytes;
}

/** Pure staging: never runs a launcher, starts a daemon, or writes a registration. */
export async function stageRuntime(options: StageRuntimeOptions): Promise<StagedRuntime> {
  const { run, artifact, signal, onProgress } = options;
  const payload = decodeServerArtifact(artifact);
  signal?.throwIfAborted();
  onProgress?.("probe");
  const probe = await probeRemoteRuntime(run, { signal, registration: false });
  if (probe.explicitCommand) throw new Error("Runtime staging: explicit PI_SERVER_COMMAND opts out of managed installation");
  if (probe.platform !== artifact.build.platform) throw new Error("Runtime staging: artifact platform does not match target");
  const root = posix.normalize(absolutePath(options.installRoot ?? `${probe.home}/.pi-better-server/managed`, "installRoot"));
  if (root === "/" || root.split("/").includes("node_modules")) throw new Error("Runtime staging: releases must be outside node_modules");
  const owner = randomUUID();
  const work = `${root}/.stage-${owner}`;
  const q = shellQuote;
  const checked = async (command: string, input?: Buffer, timeoutMs = 30_000) => {
    signal?.throwIfAborted();
    const result = await run(command, input, timeoutMs);
    signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Runtime staging: ${result.stderr || "remote command failed"}`);
    return result;
  };
  let cancellation: Promise<unknown> | undefined;
  let setupAttempted = false;
  const cancel = () => { cancellation = run(`: > ${q(`${work}/cancel`)}`, undefined, 5000).catch(() => undefined); };
  try {
    signal?.throwIfAborted();
    setupAttempted = true;
    const setup = await run(`set -eu; umask 077; p=${q(root)}; while [ "$p" != / ]; do [ ! -L "$p" ] || { echo 'permission: symlink install root' >&2; exit 1; }; p=$(dirname "$p"); done; mkdir -p ${q(root)}; mkdir ${q(work)}; printf %s ${q(owner)} > ${q(`${work}/.stage-owner`)}`, undefined, 30_000);
    if (setup.exitCode !== 0 || setup.timedOut) throw new Error(`Runtime staging setup: ${setup.stderr || "remote command failed"}`);

    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    const finalRoot = `${root}/releases/${artifact.build.contentId}`;
    const cachedArtifact = `${finalRoot}/artifact.gz`;
    const artifactPath = `${work}/artifact.gz`;
    // Older releases may lack the archive. Its contents are authenticated by the fresh installer against the requested build.
    const archiveCache = await checked(`set -eu
p=${q(finalRoot)}
while [ "$p" != / ]; do
  [ ! -L "$p" ] || { echo 'corrupt cache: symlink release path' >&2; exit 1; }
  [ ! -e "$p" ] || { [ -d "$p" ] && [ -x "$p" ]; } || { echo 'corrupt cache: unsafe release directory' >&2; exit 1; }
  p=$(dirname "$p")
done
if [ -L ${q(cachedArtifact)} ]; then echo 'corrupt cache: artifact symlink' >&2; exit 1; fi
if [ ! -e ${q(cachedArtifact)} ]; then
  if [ -e ${q(finalRoot)} ]; then printf 'legacy\\n'; else printf 'absent\\n'; fi
  exit 0
fi
[ -f ${q(cachedArtifact)} ] || { echo 'corrupt cache: expected regular artifact' >&2; exit 1; }
[ "$(wc -c < ${q(cachedArtifact)})" -le 33554432 ] || { echo 'corrupt cache: artifact size limit' >&2; exit 1; }
cp ${q(cachedArtifact)} ${q(artifactPath)}
[ "$(wc -c < ${q(artifactPath)})" -le 33554432 ] || { echo 'corrupt cache: artifact size limit' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum ${q(artifactPath)} | cut -d ' ' -f 1); else actual=$(shasum -a 256 ${q(artifactPath)} | cut -d ' ' -f 1); fi
printf 'reuse:%s\\n' "$actual"`, undefined, 120_000);
    const archiveResponse = archiveCache.stdout.trim();
    const archiveDigest = /^reuse:([a-f0-9]{64})$/.exec(archiveResponse)?.[1];
    const archiveState = archiveDigest ? "reuse" : archiveResponse;
    if (archiveState !== "reuse" && archiveState !== "absent" && archiveState !== "legacy") throw new Error("Runtime staging: unexpected artifact cache probe result");
    if (archiveState !== "reuse") {
      onProgress?.("verification-upload");
      await checked(`cat > ${q(artifactPath)}`, artifact.bytes, 120_000);
    }
    for (const name of ["installer.ts", "format.ts"]) {
      const file = payload.files.find((entry) => entry.path === `scripts/private-runtime/${name}`)!;
      await checked(`cat > ${q(`${work}/${name}`)}`, Buffer.from(file.data, "base64"));
    }
    const cachedNode = `${finalRoot}/node/bin/node`;
    const node = `${work}/node/bin/node`;
    onProgress?.("verifying");
    // Authenticate the scratch copy before executing any bytes from the cached release.
    const cached = await checked(`set -eu
p=${q(`${root}/releases`)}
while [ "$p" != / ]; do
  [ ! -L "$p" ] || { echo 'corrupt cache: symlink release path' >&2; exit 1; }
  [ ! -e "$p" ] || { [ -d "$p" ] && [ -x "$p" ]; } || { echo 'corrupt cache: unsafe release directory' >&2; exit 1; }
  p=$(dirname "$p")
done
[ ! -L ${q(finalRoot)} ] || { echo 'corrupt cache: release symlink' >&2; exit 1; }
if [ ! -e ${q(finalRoot)} ]; then printf 'absent\\n'; exit 0; fi
[ -d ${q(finalRoot)} ] && [ -x ${q(finalRoot)} ] || { echo 'corrupt cache: expected accessible release directory' >&2; exit 1; }
p=${q(cachedNode)}
while [ "$p" != ${q(finalRoot)} ]; do
  [ ! -L "$p" ] || { echo 'corrupt cache: symlink Node path' >&2; exit 1; }
  p=$(dirname "$p")
done
[ -f ${q(cachedNode)} ] && [ -x ${q(cachedNode)} ] || { echo 'corrupt cache: expected regular Node executable' >&2; exit 1; }
mkdir -p ${q(`${work}/node/bin`)}
cp ${q(cachedNode)} ${q(node)}
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum ${q(node)} | cut -d ' ' -f 1); else actual=$(shasum -a 256 ${q(node)} | cut -d ' ' -f 1); fi
[ "$actual" = ${q(NODE_EXECUTABLE_CHECKSUMS[probe.platform])} ] || { echo 'Node executable integrity mismatch' >&2; exit 1; }
printf 'reuse\\n'`, undefined, 120_000);
    const cachedState = cached.stdout.trim();
    if (cachedState !== "reuse" && cachedState !== "absent") throw new Error("Runtime staging: unexpected cache probe result");
    if (cachedState === "absent" && archiveState !== "absent") throw new Error("Runtime staging: cached release disappeared during verification");
    const reuse = cachedState === "reuse";
    if (!reuse) {
      onProgress?.("node-download");
      signal?.throwIfAborted();
      const archive = `node-v${artifact.build.nodeVersion}-${probe.platform}`;
      const url = `https://nodejs.org/dist/v${artifact.build.nodeVersion}/${archive}.tar.gz`;
      const sha = NODE_CHECKSUMS[probe.platform];
      const tar = `${work}/node.tar.gz`;
      const remote = await run(`curl -q --fail --silent --show-error --location --proto '=https' --connect-timeout 10 --max-time 120 ${q(url)} -o ${q(tar)}`, undefined, 125_000);
      signal?.throwIfAborted();
      if (remote.exitCode !== 0 || remote.timedOut) {
        onProgress?.("node-upload");
        await checked(`cat > ${q(tar)}`, await download(url, `sha256-${sha}`, signal), 120_000);
      }
      await checked(`set -eu; if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum ${q(tar)} | cut -d ' ' -f 1); else actual=$(shasum -a 256 ${q(tar)} | cut -d ' ' -f 1); fi; [ "$actual" = ${q(sha)} ] || { echo 'Node archive integrity mismatch' >&2; exit 1; }; tar -xzf ${q(tar)} -C ${q(work)}; mv ${q(`${work}/${archive}`)} ${q(`${work}/node`)}; rm ${q(tar)}`, undefined, 120_000);
    }
    const invoke = (mode: "online" | "offline" | "reuse-only") => `env -i HOME=${q(`${work}/home`)} PATH=${q(`${work}/node/bin:/usr/bin:/bin`)} ${q(node)} ${q(`${work}/installer.ts`)} ${q(work)} ${q(root)} ${q(archiveDigest ?? artifact.sha256)} ${mode} ${q(artifact.build.contentId)}`;
    if (!reuse) onProgress?.("dependencies");
    signal?.throwIfAborted();
    let installed = await run(invoke(reuse ? "reuse-only" : "online"), undefined, 600_000);
    signal?.throwIfAborted();
    if (!reuse && installed.exitCode === 75) {
      onProgress?.("dependencies-upload");
      const lock = JSON.parse(Buffer.from(payload.files.find((f) => f.path === "scripts/private-runtime/package-lock.json")!.data, "base64").toString());
      await checked(`mkdir -p ${q(`${work}/archives`)}`);
      const packages = new Map<string, string>();
      for (const pkg of Object.values(lock.packages) as any[]) if (pkg.resolved) packages.set(pkg.integrity, pkg.resolved);
      const entries = [...packages];
      for (let offset = 0; offset < entries.length; offset += 4) {
        const batch = await Promise.allSettled(entries.slice(offset, offset + 4).map(async ([integrity, url], index) => {
          await checked(`cat > ${q(`${work}/archives/${offset + index}.tgz`)}`, await download(url, integrity, signal), 120_000);
        }));
        const failed = batch.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      installed = await run(invoke("offline"), undefined, 600_000);
      signal?.throwIfAborted();
    }
    if (installed.exitCode !== 0 || installed.timedOut) throw new Error(`Runtime staging: ${installed.stderr || "installer failed"}`);
    const runtime = validateStaged(JSON.parse(installed.stdout));
    if (runtime.build.contentId !== artifact.build.contentId || runtime.installRoot !== root) throw new Error("Runtime staging: unexpected published identity");
    onProgress?.("staged");
    return runtime;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await cancellation;
    // Only this attempt's scratch directory. Published releases and other owners are never removed.
    if (setupAttempted) await run(`if [ ! -L ${q(work)} ] && [ -f ${q(`${work}/.stage-owner`)} ] && [ "$(cat ${q(`${work}/.stage-owner`)})" = ${q(owner)} ]; then if [ -f ${q(`${work}/installer.pid`)} ] && kill -0 "$(cat ${q(`${work}/installer.pid`)})" 2>/dev/null; then : > ${q(`${work}/cancel`)}; else rm -rf ${q(work)}; fi; fi`, undefined, 30_000).catch(() => undefined);
  }
}
