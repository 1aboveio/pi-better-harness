import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting } from "./index.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "harness-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seams = { agentDir: () => root };
  return { root, seams, path: harnessSettingsPath(seams) };
}

test("settings updates preserve Pi fields, sibling defaults and atomic readers", async t => {
  const f = fixture(t);
  writeFileSync(f.path, JSON.stringify({ theme: "dark", packages: ["npm:example"], piBetterHarness: { goal: { autoContinue: false } } }));
  const reader = openSync(f.path, "r");
  try {
    updateHarnessSetting("toolOutput", () => ({ version: 1, enabled: true }), f.seams);
    assert.equal(JSON.parse(readFileSync(reader, "utf8")).piBetterHarness.toolOutput, undefined);
  } finally { closeSync(reader); }
  const pi = SettingsManager.create(f.root, f.root);
  pi.setTheme("light");
  await pi.flush();
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {
    theme: "light", packages: ["npm:example"],
    piBetterHarness: { goal: { autoContinue: false }, toolOutput: { version: 1, enabled: true } },
  });
});

test("validated legacy settings migrate once and existing global choices take precedence", t => {
  const f = fixture(t);
  const path = join(f.root, "legacy.json");
  writeFileSync(path, '{"enabled":true}');
  const legacy = { path, parse(value: unknown) {
    assert.equal(typeof (value as { enabled?: unknown }).enabled, "boolean");
    return value;
  } };
  assert.deepEqual(readHarnessSetting("toolOutput", f.seams, legacy), { enabled: true });
  updateHarnessSetting("toolOutput", () => ({ enabled: false }), f.seams);
  writeFileSync(path, "{broken");
  assert.deepEqual(readHarnessSetting("toolOutput", f.seams, legacy), { enabled: false });
  assert.equal(readFileSync(path, "utf8"), "{broken", "legacy artifacts are not deleted or rewritten");
});

test("saves and migration preserve dotfiles symlinks and update their target", async t => {
  const f = fixture(t);
  const target = join(f.root, "managed-settings.json");
  const legacy = join(f.root, "legacy.json");
  writeFileSync(target, '{"theme":"dark"}');
  symlinkSync(target, f.path);
  writeFileSync(legacy, '{"version":1,"enabled":true}');
  readHarnessSetting("toolOutput", f.seams, { path: legacy, parse: value => value });
  updateHarnessSetting("toolOutput", () => ({ version: 1, enabled: false }), f.seams);
  const pi = SettingsManager.create(f.root, f.root);
  pi.setTheme("light");
  await pi.flush();
  assert.equal(lstatSync(f.path).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
    theme: "light", piBetterHarness: { toolOutput: { version: 1, enabled: false } },
  });
  rmSync(target);
  assert.throws(() => updateHarnessSetting("toolOutput", () => true, f.seams), { code: "ENOENT" });
  assert.equal(lstatSync(f.path).isSymbolicLink(), true, "a dangling dotfiles link is not replaced either");
});

test("malformed global settings cannot be discarded by a preference save", t => {
  const f = fixture(t);
  for (const raw of ["{broken", "null", "[]", '{"theme":"dark","piBetterHarness":null}']) {
    writeFileSync(f.path, raw);
    assert.throws(() => updateHarnessSetting("toolOutput", () => true, f.seams));
    assert.equal(readFileSync(f.path, "utf8"), raw);
  }
});

test("independent Pi and Harness processes update settings without losing sibling values", async t => {
  const f = fixture(t);
  writeFileSync(f.path, '{"theme":"dark"}');
  const module = new URL("./index.ts", import.meta.url).href;
  await Promise.all(["goal", "callbacks", "sandbox", "subagents", "pi"].map(key => new Promise<void>((resolve, reject) => {
    const code = key === "pi"
      ? `import {SettingsManager} from '@earendil-works/pi-coding-agent'; const pi=SettingsManager.create(${JSON.stringify(f.root)},${JSON.stringify(f.root)}); for(let i=0;i<10;i++){pi.setTheme('light'); await pi.flush();}`
      : `import {updateHarnessSetting} from ${JSON.stringify(module)}; for(let i=0;i<10;i++) updateHarnessSetting(${JSON.stringify(key)},()=>({saved:true}),{agentDir:()=>${JSON.stringify(f.root)}});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      code], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
  })));
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {
    theme: "light", piBetterHarness: {
      goal: { saved: true }, callbacks: { saved: true }, sandbox: { saved: true }, subagents: { saved: true },
    },
  });
});