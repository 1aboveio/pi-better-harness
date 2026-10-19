/**
 * What a session bundle must never carry. Agent-agnostic: no Pi imports in this directory.
 *
 * Untracked files come from `git ls-files --exclude-standard`, which already drops
 * anything the repo ignores (including ignored `.env` files). These rules are the
 * second wall for credentials that are NOT ignored, and for heavy generated output.
 */

/** Directories that hold dependencies, build output, or caches. Never bundled, never part of the worktree digest. */
const GENERATED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".tox",
  ".venv",
  "venv",
  ".gradle",
]);

/** Directories whose whole content is credentials or credential-adjacent. */
const SECRET_DIRS: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".gcloud", ".azure"]);

const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env/i, // any name starting with .env: .env, .env.local, .envrc, .env-prod, .env_local
  /^\.(npmrc|netrc|pypirc|git-credentials|dockercfg)$/i,
  /^(auth|credentials?|secrets?)(\..+)?\.(json|ya?ml|toml|ini)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
];

/** Why a repo-relative path is left out of a bundle, or undefined when it may travel. */
export function exclusionReason(relativePath: string): "credential" | "generated" | undefined {
  const segments = relativePath.split("/");
  const name = segments[segments.length - 1] ?? "";
  for (const segment of segments.slice(0, -1)) {
    if (SECRET_DIRS.has(segment)) return "credential";
  }
  if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name))) return "credential";
  for (const segment of segments.slice(0, -1)) {
    if (GENERATED_DIRS.has(segment)) return "generated";
  }
  return undefined;
}
