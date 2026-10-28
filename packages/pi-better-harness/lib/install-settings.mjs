import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

const HARNESS_PACKAGE = "pi-better-harness";
const PLAN_PACKAGE = "pi-better-plan";

// Pi's resource filters narrow the bundle to Harness-owned extensions while the
// other components keep their own package identities. Everything else in the
// bundled manifest is installed separately, so loading it here would duplicate
// those extensions (Goal, Sandbox, Subagents, ...).
export const harnessExtensionFilters = [
  "extensions/task-context/index.ts",
  "extensions/settings/index.ts",
  "extensions/minimal-output/index.ts",
];

function settingsPath(local, options) {
  if (options.path) return options.path;
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return local ? resolve(".pi/settings.json") : join(agentDir, "settings.json");
}

function packageSource(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.source === "string") return entry.source;
  return undefined;
}

function matchesPackage(entry, packageName) {
  const source = packageSource(entry);
  return source !== undefined && new RegExp(`^npm:${packageName}(?:@.*)?$`).test(source);
}

function assertSettingsShape(settings, path) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Unexpected Pi settings in ${path}: expected a JSON object`);
  }
  if (settings.packages === undefined) return;
  if (!Array.isArray(settings.packages)) {
    throw new Error(`Unexpected Pi settings in ${path}: "packages" must be an array`);
  }
  for (const entry of settings.packages) {
    if (packageSource(entry) === undefined) {
      throw new Error(`Unexpected Pi settings in ${path}: every package needs a source string`);
    }
  }
}

function parseSettings(text, path) {
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse Pi settings in ${path}: ${error.message}`);
  }
  assertSettingsShape(settings, path);
  return settings;
}

// A missing settings file is normal before the first install. A dangling
// symlink is not: replacing it would silently discard the link, so refuse.
function readSettings(path, { allowMissing = false } = {}) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      if (allowMissing) return undefined;
      throw new Error(`Pi settings not found at ${path}`);
    }
    throw error;
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && stat.isSymbolicLink()) {
      throw new Error(`Refusing to replace dangling Pi settings link at ${path}`);
    }
    throw error;
  }
  return parseSettings(text, path);
}

function writeDestination(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return path;
    throw error;
  }
  if (!stat.isSymbolicLink()) return path;
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Refusing to replace dangling Pi settings link at ${path}`);
    }
    throw error;
  }
}

function acquire(path) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      if (error.code !== "ELOCKED" || attempt === 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw new Error(`Cannot lock Pi settings at ${path}`);
}

// Read-only validation used before the installer asks Pi to touch settings.
// Returns whether the selected scope already has a Harness registration so the
// caller knows whether a failed filter write introduced an unfiltered one.
export function preflightHarnessInstall(local, options = {}) {
  const path = settingsPath(local, options);
  const settings = readSettings(path, { allowMissing: true });
  return {
    path,
    harnessRegistered: settings?.packages?.some((entry) => matchesPackage(entry, HARNESS_PACKAGE)) ?? false,
  };
}

export function configureHarnessResources(local, options = {}) {
  const path = settingsPath(local, options);
  const destination = writeDestination(path);
  let release;
  try {
    release = acquire(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Pi settings not found at ${path}`);
    throw error;
  }
  let temp;
  try {
    // Read inside the lock and replace atomically so concurrent Pi writes are
    // never clobbered by a stale snapshot.
    const settings = readSettings(path);
    const packages = settings.packages ?? [];
    const harness = packages.find((entry) => matchesPackage(entry, HARNESS_PACKAGE));
    if (!harness) throw new Error("Pi did not register pi-better-harness");

    const filteredHarness = {
      ...(typeof harness === "object" ? harness : { source: harness }),
      extensions: [...harnessExtensionFilters],
      skills: [],
      prompts: [],
      themes: [],
    };

    // Build the replacement registration first, then retire Plan in the same
    // write. Plan is removed only from the selected scope, and only once the
    // filtered Harness registration is ready to take over.
    settings.packages = [
      ...packages.filter(
        (entry) => !matchesPackage(entry, PLAN_PACKAGE) && !matchesPackage(entry, HARNESS_PACKAGE),
      ),
      filteredHarness,
    ];

    temp = join(dirname(destination), `.settings-${randomUUID()}.tmp`);
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, destination);
  } finally {
    if (temp) rmSync(temp, { force: true });
    release();
  }
}
