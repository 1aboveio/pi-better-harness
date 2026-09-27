#!/usr/bin/env node
/**
 * Is <package>@<version> on npm? Used by publish.yml (#332).
 *
 *   node scripts/npm-version-visible.mjs <package> <version> [--wait-seconds N]
 *
 * Exits 0 once the version is visible, 1 if it is not visible by the deadline
 * (immediately with no --wait-seconds), 2 on bad arguments.
 *
 * It reads the registry's version document (https://registry.npmjs.org/<pkg>/<version>)
 * directly. That document usually appears well before `npm view` reports the
 * version, whose packument is cached for minutes after a publish; the old
 * 12 x 10 s `npm view` loop timed out on publishes that had succeeded, which
 * skipped the tag and GitHub release. `npm view` is still consulted as a second
 * opinion. Waits back off from 5 s to 60 s.
 *
 * Environment (for tests): NPM_VERSION_REGISTRY overrides the registry URL,
 * NPM_VERSION_INITIAL_DELAY_MS / NPM_VERSION_MAX_DELAY_MS override the backoff,
 * and NPM_VERSION_SKIP_NPM_VIEW=1 skips the `npm view` fallback.
 */
import { spawnSync } from "node:child_process";

const registry = (process.env.NPM_VERSION_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const initialDelayMs = Number(process.env.NPM_VERSION_INITIAL_DELAY_MS ?? 5_000);
const maxDelayMs = Number(process.env.NPM_VERSION_MAX_DELAY_MS ?? 60_000);
const requestTimeoutMs = 15_000;

function parseArgs(argv) {
  const positional = [];
  let waitSeconds = 0;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--wait-seconds") {
      waitSeconds = Number(argv[i + 1]);
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  const [pkg, version] = positional;
  if (!pkg || !version || positional.length !== 2 || !Number.isFinite(waitSeconds) || waitSeconds < 0) return undefined;
  return { pkg, version, waitSeconds };
}

async function versionDocument(pkg, version) {
  const url = `${registry}/${pkg.replace("/", "%2F")}/${encodeURIComponent(version)}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) return `registry ${url} answered ${response.status}`;
    const body = await response.json();
    return body?.version === version ? true : `registry ${url} returned version ${JSON.stringify(body?.version)}`;
  } catch (error) {
    return `registry ${url} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function npmView(pkg, version) {
  if (process.env.NPM_VERSION_SKIP_NPM_VIEW === "1") return "npm view skipped";
  const result = spawnSync("npm", ["view", `${pkg}@${version}`, "version", `--registry=${registry}/`], {
    encoding: "utf8",
    timeout: requestTimeoutMs,
  });
  if (result.status === 0 && result.stdout.trim() === version) return true;
  return `npm view: ${(result.stderr || result.stdout || "no output").trim().split("\n").at(-1)}`;
}

async function visible(pkg, version) {
  const document = await versionDocument(pkg, version);
  if (document === true) return { ok: true, via: "registry version document" };
  const view = npmView(pkg, version);
  if (view === true) return { ok: true, via: "npm view" };
  return { ok: false, detail: `${document}; ${view}` };
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error("usage: npm-version-visible.mjs <package> <version> [--wait-seconds N]");
  process.exit(2);
}
const { pkg, version, waitSeconds } = args;
const deadline = Date.now() + waitSeconds * 1_000;
let delayMs = initialDelayMs;
for (let attempt = 1; ; attempt += 1) {
  const result = await visible(pkg, version);
  if (result.ok) {
    console.log(`${pkg}@${version} is on npm (${result.via}, attempt ${attempt}).`);
    process.exit(0);
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    console.error(`${pkg}@${version} is not visible on npm: ${result.detail}`);
    process.exit(1);
  }
  const waitMs = Math.min(delayMs, remainingMs);
  console.log(`Waiting ${Math.round(waitMs / 1000)} s for ${pkg}@${version} on npm (attempt ${attempt}; ${result.detail}).`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  delayMs = Math.min(maxDelayMs, delayMs * 2);
}
