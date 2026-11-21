import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("import setup evaluates modules but does not invoke extension factories", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-import-setup-"));
  try {
    const marker = join(root, "imported");
    writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["extension.ts"] } }));
    writeFileSync(join(root, "extension.ts"), `import { writeFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
const schema: unknown = Type.String();
if (!schema) throw new Error("host alias was not resolved");
writeFileSync(${JSON.stringify(marker)}, "loaded");
export default function () { throw new Error("factory must run only in the timed journey"); }
`);
    const result = spawnSync(process.execPath, [new URL("warm-tui-imports.mjs", import.meta.url).pathname, root], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(marker), "setup must actually evaluate the extension module");
    writeFileSync(join(root, "extension.ts"), 'throw new Error("broken import");');
    const broken = spawnSync(process.execPath, [new URL("warm-tui-imports.mjs", import.meta.url).pathname, root], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.notEqual(broken.status, 0, "a broken extension import must block setup");
    assert.match(broken.stderr, /broken import/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});