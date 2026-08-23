import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { selectPackedResult } from "./stage-harness-dependencies.mjs";
import {
  sharedSandboxCoreContent,
  sharedSandboxCoreTargets,
  syncSharedSandboxCore,
} from "./sync-shared-sandbox-core.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = mkdtempSync(join(tmpdir(), "sync-shared-sandbox-core-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

// @covers sandbox-core.private-sync
// @level integration
test("syncSharedSandboxCore regenerates every consumer copy from the canonical source", () => {
  const sourceRoot = join(fixtureRoot, "packages", "sandbox-core");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "index.ts"), "export const mechanism = true;\n");

  for (const target of sharedSandboxCoreTargets(fixtureRoot)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "// stale hand edit\n");
  }

  syncSharedSandboxCore(fixtureRoot);

  const targets = sharedSandboxCoreTargets(fixtureRoot);
  assert.ok(targets.length > 0, "at least one consumer must vendor sandbox-core");
  for (const target of targets) {
    assert.equal(
      readFileSync(target, "utf8"),
      "// Generated from packages/sandbox-core/index.ts. Do not edit directly.\nexport const mechanism = true;\n",
      "a hand edit in a consumer copy must be replaced by the canonical source",
    );
  }
});

// @covers sandbox-core.private-sync
// @level integration
test("the committed consumer copies match packages/sandbox-core/index.ts byte for byte", () => {
  const expected = sharedSandboxCoreContent(repoRoot);
  for (const target of sharedSandboxCoreTargets(repoRoot)) {
    assert.equal(
      readFileSync(target, "utf8"),
      expected,
      `${target} is out of sync — run npm run sync:shared-sandbox-core`,
    );
  }
});

// @covers sandbox-core.private-sync
// @level integration
test("packing pi-better-subagents includes the generated sandbox-core copy", () => {
  const stdout = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "-w", "packages/pi-better-subagents"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const pack = selectPackedResult(stdout);
  const packed = pack.files.map((file) => file.path);
  assert.ok(
    packed.includes("shared-sandbox-core.ts"),
    `published tarball must carry the generated shared module; got:\n${packed.join("\n")}`,
  );
  assert.ok(packed.includes("sandbox.ts"), "the subagent policy adapter must stay published");
});

// @covers sandbox-core.private-sync
// @level integration
test("packing pi-better-background-tasks includes the generated sandbox-core copy", () => {
  const stdout = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "-w", "packages/pi-better-background-tasks"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const pack = selectPackedResult(stdout);
  const packed = pack.files.map((file) => file.path);
  // This package publishes `src/**/*.ts`, so its copy is a root-level file
  // inside `src/` rather than at the package root.
  assert.ok(
    packed.includes("src/shared-sandbox-core.ts"),
    `published tarball must carry the generated shared module; got:\n${packed.join("\n")}`,
  );
  assert.ok(packed.includes("src/sandbox.ts"), "the background-task policy consumer must stay published");
  // The unrelated vendored modules this package already ships must survive the
  // sandbox-core sync untouched.
  assert.ok(packed.includes("src/shared-log-utils.ts"), "shared-log-utils must stay published");
  assert.ok(packed.includes("src/shared-ssh-core/index.ts"), "shared-ssh-core must stay published");
});

// @covers sandbox-core.private-sync
// @level integration
test("packing pi-better-sandbox includes the generated sandbox-core copy and no launcher", () => {
  const stdout = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "-w", "packages/pi-better-sandbox"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const pack = selectPackedResult(stdout);
  const packed = pack.files.map((file) => file.path);
  // This package publishes `*.ts` from its root, so its copy is a root-level
  // file — the placement differs from background-tasks on purpose.
  assert.ok(
    packed.includes("shared-sandbox-core.ts"),
    `published tarball must carry the generated shared module; got:\n${packed.join("\n")}`,
  );
  assert.ok(packed.includes("index.ts"), "the extension entry point must stay published");
  assert.ok(
    !packed.some((path) => path.startsWith("bin/")),
    "users invoke ordinary `pi`; this package must ship no launcher executable",
  );
  assert.ok(
    !packed.some((path) => path.startsWith("test/")),
    "test fixtures must not reach the published tarball",
  );
});

// @covers sandbox-core.private-sync
// @level unit
test("sandbox-core itself is a private workspace package that is never published", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "packages/sandbox-core/package.json"), "utf8"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.name, "sandbox-core");
});
