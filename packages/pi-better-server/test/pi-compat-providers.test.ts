import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

test("Pi compatibility provider copy resolves the real Goal import closure", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const prefix = mkdtempSync(join(tmpdir(), "pi-compat-providers-"));
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/copy-pi-test-providers.mjs", import.meta.url)), root, prefix]);
    // Import-only component proof uses installed dependencies; no runtime or model starts.
    symlinkSync(join(root, "node_modules"), join(prefix, "node_modules"), "dir");
    const entry = pathToFileURL(join(prefix, "packages/pi-better-goal/src/index.ts")).href;
    const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `const goal = await import(${JSON.stringify(entry)}); console.log(typeof goal.default);`],
      { cwd: root, stdio: "pipe", encoding: "utf8" });
    assert.equal(result.trim(), "function", "the copied Goal entry exports its extension");
  } finally { rmSync(prefix, { recursive: true, force: true }); }
});
