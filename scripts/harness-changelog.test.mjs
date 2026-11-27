import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { projectHarnessChangelog } from "./generate-harness-changelog.mjs";
import { selectPackedResult } from "./stage-harness-dependencies.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("projection preserves Harness notes and dates, excludes other packages and unscoped entries", () => {
  const source = "# Changelog\r\n## [pi-better-server@1.0.0]\r\nserver\r\n## [pi-better-harness@1.0.0] - today\r\n### Fixed\r\nnotes\r\n```md\r\n## example\r\n```\r\n## [Unreleased]\r\nunreleased\r\n## [pi-better-harness@0.9.0]\r\nold";
  assert.equal(projectHarnessChangelog(source, "1.0.0"), "# Changelog\n\n## [1.0.0] - today\n### Fixed\nnotes\n```md\n## example\n```\n\n## [0.9.0]\nold\n");
});

test("packing requires notes for the manifest version, even with older notes present", () => {
  assert.throws(() => projectHarnessChangelog("## [pi-better-harness@0.42.0]\nold", "0.42.1"), /no pi-better-harness@0\.42\.1 entry/);
  assert.throws(() => projectHarnessChangelog("## [pi-better-server@0.42.1]\nother", "0.42.1"), /no pi-better-harness@0\.42\.1 entry/);
});

test("current version rejects empty, whitespace-only, and subheading-only notes", () => {
  for (const body of ["", " \n\t\n", "### Fixed\n\n### Changed\n"]) {
    assert.throws(() => projectHarnessChangelog(`## [pi-better-harness@0.42.1]\n${body}\n## [pi-better-harness@0.42.0]\nOlder notes`, "0.42.1"), /pi-better-harness@0\.42\.1 entry has no notes/);
  }
  assert.match(projectHarnessChangelog("## [pi-better-harness@0.42.1]\n### Fixed\n- Include update notes.", "0.42.1"), /- Include update notes\./);
});

test("real Harness tarball contains projected notes and staged bundled components", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-changelog-test-"));
  try {
    const output = execFileSync("npm", ["pack", "-w", "packages/pi-better-harness", "--json", "--pack-destination", dir], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const packed = selectPackedResult(output);
    const tarball = join(dir, packed.filename);
    const notes = execFileSync("tar", ["-xOf", tarball, "package/CHANGELOG.md"], { encoding: "utf8" });
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
    assert.equal(notes, projectHarnessChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"), manifest.version));
    assert.match(notes, /^## \[0\.42\.0\] - 2026-11-10$/m);
    assert.match(notes, /optional durable work ledger/);
    assert.doesNotMatch(notes, /^## \[pi-better-/m);
    const paths = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
    for (const name of manifest.bundledDependencies) assert.ok(paths.includes(`package/node_modules/${name}/package.json`), name);
    if (process.env.PI_CHANGELOG_PARSER) {
      const { parseChangelog, getNewEntries } = await import(pathToFileURL(resolve(process.env.PI_CHANGELOG_PARSER)).href);
      const file = join(dir, "CHANGELOG.md");
      writeFileSync(file, notes);
      const entries = parseChangelog(file);
      assert.ok(entries.some(({ major, minor, patch, content }) => major === 0 && minor === 42 && patch === 0 && content.includes("optional durable work ledger")));
      assert.equal(entries.length, (notes.match(/^## \[\d/gm) ?? []).length);
      const newEntries = getNewEntries(entries, "0.41.3");
      const current = newEntries.find(({ major, minor, patch }) => `${major}.${minor}.${patch}` === manifest.version);
      assert.ok(current, "Pi selects the packed manifest version's notes after an update");
      assert.ok(current.content.split("\n").slice(1).some((line) => line.trim() && !line.trimStart().startsWith("#")), "Selected current entry has actual notes");
      const historic = newEntries.find(({ major, minor, patch }) => major === 0 && minor === 42 && patch === 0);
      const canonicalHistoric = readFileSync(join(root, "CHANGELOG.md"), "utf8")
        .split("## [pi-better-harness@0.42.0]")[1].split("\n## ")[0].trimEnd();
      assert.equal(historic?.content, `## [0.42.0]${canonicalHistoric}`, "Pi preserves the complete historic 0.42.0 entry");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
