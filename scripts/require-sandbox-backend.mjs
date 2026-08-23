/**
 * Fail a CI lane loudly when the sandbox backend it exists to prove is missing.
 *
 * The real-kernel suites gate on `describeSandboxSupport()` and skip themselves
 * when no backend is available, which is right for a developer laptop and wrong
 * for the platform lane whose entire job is that backend: a silent "0 tests, all
 * skipped" run reports green while proving nothing. Running this first turns
 * that into a red step, using the same backend selection the suites use, so the
 * probe and the suites can never disagree.
 *
 * Usage: node --import tsx scripts/require-sandbox-backend.mjs <expected-backend>
 *   e.g. node --import tsx scripts/require-sandbox-backend.mjs linux-bubblewrap
 */

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * Decide whether a support report satisfies the lane's requirement.
 *
 * Pure so it can be tested without a backend on the machine running the test.
 */
export function evaluateBackendRequirement(support, expectedBackend) {
  if (!support.supported) {
    return {
      ok: false,
      message:
        `No sandbox backend is available on ${support.platform}: ${support.reason}\n` +
        "This lane exists to prove real kernel confinement, so a missing backend " +
        "is a failure rather than a skipped suite.",
    };
  }
  if (expectedBackend !== undefined && support.backend !== expectedBackend) {
    return {
      ok: false,
      message:
        `Expected the ${expectedBackend} backend but this runner selected ` +
        `${support.backend} (${support.executable}) on ${support.platform}.`,
    };
  }
  return {
    ok: true,
    message: `sandbox backend ${support.backend} at ${support.executable} on ${support.platform}`,
  };
}

/** Read the live backend selection and evaluate it against the lane's requirement. */
export async function requireSandboxBackend(expectedBackend, root = repoRoot) {
  // Imported lazily: the module is TypeScript, so a static import would make
  // this file unloadable from a plain `node --test` process.
  const { describeSandboxSupport } = await import(
    pathToFileURL(resolve(root, "packages/sandbox-core/index.ts")).href
  );
  return evaluateBackendRequirement(describeSandboxSupport(), expectedBackend);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const expectedBackend = process.argv[2];
  const result = await requireSandboxBackend(expectedBackend);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${result.message}\n`);
}
