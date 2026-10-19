// The one ESM main-module guard every skill script in this repo uses.
//
// Not a style preference — the hand-written versions of this three-line check had two opposite
// silent failure modes in production, and both shipped:
//
//   #718  `import.meta.url === pathToFileURL(process.argv[1]).href`
//         Node resolves `import.meta.url` to the REAL path; `argv[1]` keeps whatever the caller
//         typed. A skills install is a symlink farm (`~/.claude/skills/<skill>` → the checkout),
//         so through the install path the two never match: the CLI does not run and node exits 0.
//         `coverage-ledger.mjs` shipped this and recorded a false pass in the wild
//         (a consumer product repo: epic #352, unit #379, PR #384) on a gate whose only job is to
//         say no. Fails OPEN, invisibly — "passed" and "never ran" are byte-identical evidence.
//
//   #446  `fs.realpathSync(process.argv[1]) === …`, unguarded.
//         `node -` sets `argv[1]` to the literal string `"-"` — truthy, so the usual
//         `process.argv[1] &&` prefix does not save it — and realpath throws ENOENT at MODULE
//         LOAD, before a line of the module's own code runs. The module cannot be imported by
//         anything that does not launch it as a file. Fails CLOSED, at load.
//
// So the contract has exactly two obligations, one per failure mode:
//   1. realpath BOTH sides before comparing, so a symlinked invocation is still the main module;
//   2. degrade to `false` — "not the main module" — for anything that does not resolve, never throw.
//
// WHY IT IS SHARED RATHER THAN COPIED. PR #278 fixed twelve copies of failure mode #718 by hand and
// mechanized nothing. Five weeks later `mergify/scripts/audit.mjs` was written with the pre-#278
// form, and `coverage-ledger.mjs` survived the whole pass because it spelled the same bug a third
// way that #278's grep did not match. One module plus `main-guard-hygiene.test.mjs` is what stops
// the next copy: there is now no second place for this logic to drift to, and adding one fails CI.
//
// WHERE IT LIVES, AND WHY HERE. Native Skills CLI installation flattens selected packages into
// sibling directories under `~/.agents/skills`, while this repository nests them under
// `skills/engineering`. A Workflow consumer at `<skill>/scripts` therefore imports
// `../../engineering-runtime/scripts/main-module.mjs`: the same specifier reaches this package in
// both layouts. Claude Code launches through a per-skill symlink into the canonical store; node's
// realpath-aware module resolution and this predicate preserve that path as well.
//
// `engineering-runtime` owns the helper as an installable support package rather than a user
// capability. Every consumer imports this package directly.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Is the module identified by `importMetaUrl` the script node was launched with?
 *
 * Symlink-transparent, and total: any input that does not resolve to a real file answers `false`
 * instead of throwing, so importing a CLI module is always safe.
 *
 * @param {string} importMetaUrl the caller's own `import.meta.url`
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false; // imported, or an embedding harness

  let entryPath;
  try {
    entryPath = fs.realpathSync(entry);
  } catch {
    return false; // #446: `node -` gives "-"; some harnesses give a path that is not on disk
  }

  let selfPath;
  try {
    selfPath = fileURLToPath(importMetaUrl);
  } catch {
    return false; // a data:/http: module has no path to compare, so it is never the launched script
  }
  try {
    // #718: the launched side is resolved above, so this side must be too. Under Node's default
    // resolution `import.meta.url` is already real and this is a no-op; under `--preserve-symlinks`
    // it is the half that makes the comparison hold.
    selfPath = fs.realpathSync(selfPath);
  } catch {
    // The module is executing, so it existed a moment ago. Compare what we have rather than
    // claiming "not main" — a vanished file should not silently disable a running CLI.
  }

  return entryPath === selfPath;
}
