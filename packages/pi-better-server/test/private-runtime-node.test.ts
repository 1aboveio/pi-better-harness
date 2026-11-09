import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { privateRuntimeNode } from "./private-runtime-node.ts";

function binary(t: TestContext, body: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-test-private-node-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const node = join(root, "node");
  writeFileSync(node, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return node;
}

test("private runtime fixtures select and execute the configured pin or the pinned host", () => {
  const runtime = privateRuntimeNode();
  assert.equal(runtime.node, realpathSync(process.env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath));
  assert.equal(execFileSync(runtime.node, ["--version"], { encoding: "utf8" }).trim(), "v24.14.1");
  assert.equal(runtime.version, "24.14.1");
});

for (const version of ["v22.0.0", "v24.14.2"]) {
  test(`private runtime fixtures reject an executable reporting ${version}`, t => {
    const node = binary(t, `printf '%s\\n' '${version}'`);
    assert.throws(() => privateRuntimeNode(node), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`is ${version}; expected v24.14.1`));
      assert.match(error.message, /PI_TEST_PRIVATE_RUNTIME_NODE/);
      return true;
    });
  });
}

test("private runtime fixtures fail with setup guidance when the executable is missing or fails", t => {
  const node = binary(t, "exit 1");
  for (const executable of [node, `${node}-missing`]) {
    assert.throws(() => privateRuntimeNode(executable), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cannot execute private test Node.*PI_TEST_PRIVATE_RUNTIME_NODE.*24\.14\.1/);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
});
