import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function readPackage(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    return value;
  } catch (error) {
    throw new Error(`Cannot read package manifest ${path}: ${error.message}`);
  }
}

// Accept only literal relative paths and a single final '*' segment. New npm
// glob syntax must be implemented deliberately rather than silently omitted.
export function selectWorkspaces(root) {
  const manifest = readPackage(join(root, "package.json"));
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0) throw new Error("No workspace patterns declared");

  const paths = new Set();
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !/^[\w.-]+(?:\/[\w.-]+)*(?:\/\*)?$/.test(pattern) ||
        pattern.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`Unsupported workspace pattern: ${String(pattern)}`);
    }
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const path = `${parent}/${entry.name}`;
        if (existsSync(join(root, path, "package.json"))) paths.add(path);
      }
    } else {
      paths.add(pattern);
    }
  }

  const selected = [];
  let serverCount = 0;
  for (const path of paths) {
    const pkg = readPackage(join(root, path, "package.json"));
    if (pkg.name === "pi-better-server") {
      serverCount++;
    } else if (pkg.scripts && Object.hasOwn(pkg.scripts, "test")) {
      selected.push(path);
    }
  }
  if (serverCount !== 1) throw new Error(`Expected exactly one pi-better-server workspace; found ${serverCount}`);
  return selected;
}

export function runWorkspaceTests(root) {
  for (const workspace of selectWorkspaces(root)) {
    const result = spawnSync("npm", ["run", "test", "--workspace", workspace], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Workspace ${workspace} terminated by ${result.signal}`);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = runWorkspaceTests(process.cwd());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
