import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
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

test("independent Pi and Harness processes update settings without losing sibling values", { timeout: 15000 }, async t => {
  const f = fixture(t);
  writeFileSync(f.path, '{"theme":"dark"}');
  const module = new URL("./index.ts", import.meta.url).href;
  const releaseOwner = join(f.root, "release-owner"), ownerReleased = join(f.root, "owner-released");
  const waitForGate = `
    function waitForGate(path) {
      const deadline = performance.now() + 5000;
      const word = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(path)) {
        if (performance.now() >= deadline) throw new Error('Settings fixture gate did not open: ' + path);
        Atomics.wait(word, 0, 0, 5);
      }
    }`;
  const children = ["goal", "callbacks", "sandbox", "subagents", "pi"].map(key => {
    const initialize = key === "pi"
      ? `import assert from 'node:assert/strict'; import {SettingsManager} from '@earendil-works/pi-coding-agent'; const pi=SettingsManager.create(${JSON.stringify(f.root)},${JSON.stringify(f.root)}); assert.deepEqual(pi.drainErrors(),[]);`
      : `import {updateHarnessSetting} from ${JSON.stringify(module)};`;
    const writes = key === "pi"
      ? `
        const sdkLock = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('proper-lockfile');
        const lockSync = sdkLock.lockSync;
        let contended = false;
        sdkLock.lockSync = (path, options) => {
          try { return lockSync(path, options); }
          catch (error) {
            if (!contended && error.code === 'ELOCKED' && path === ${JSON.stringify(f.path)}) {
              contended = true;
              process.send('contended');
              waitForGate(${JSON.stringify(ownerReleased)});
            }
            throw error;
          }
        };
        pi.setTheme('light');
        await pi.flush();
        assert.deepEqual(pi.drainErrors(), []);
        assert.equal(contended, true, 'Pi must observe a real Harness lock collision');`
      : `updateHarnessSetting(${JSON.stringify(key)}, () => {
        ${key === "goal" ? `process.send('holding'); waitForGate(${JSON.stringify(releaseOwner)});` : ""}
        return { saved: true };
      }, { agentDir: () => ${JSON.stringify(f.root)} });`;
    const code = `import {once} from 'node:events'; import {existsSync} from 'node:fs';
      import {createRequire} from 'node:module'; ${waitForGate} ${initialize}
      process.send('ready'); await once(process,'message'); ${writes} process.disconnect();`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      code], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", data => { stderr += data; });
    const exited = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve() : reject(new Error(`${key}: ${stderr || `exit ${code}`}`)));
    });
    const ready = Promise.race([once(child, "message"), exited.then(() => { throw new Error(`${key} exited before ready`); })]);
    return { key, child, ready, exited };
  });
  try {
    // Pi retains an initial read error and silently skips later saves. Exercise
    // concurrent writes only after every independent manager has loaded safely.
    await Promise.all(children.map(value => value.ready));
    const owner = children.find(value => value.key === "goal")!;
    const pi = children.find(value => value.key === "pi")!;
    const nextMessage = (value: typeof owner) => Promise.race([
      once(value.child, "message"), value.exited.then(() => { throw new Error(`${value.key} exited before its lock checkpoint`); }),
    ]);
    const holding = nextMessage(owner);
    owner.child.send("write");
    const [holdingMessage] = await holding;
    assert.equal(holdingMessage, "holding");
    const contention = nextMessage(pi);
    pi.child.send("write");
    const [contentionMessage] = await contention;
    assert.equal(contentionMessage, "contended");
    assert.equal(lstatSync(f.path + ".lock").isDirectory(), true);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { theme: "dark" });
    // Resume Pi's normal retry only after the proven lock owner has released.
    writeFileSync(releaseOwner, "release");
    await owner.exited;
    assert.equal(existsSync(f.path + ".lock"), false);
    writeFileSync(ownerReleased, "released");
    await pi.exited;
    for (const value of children) if (value !== owner && value !== pi) value.child.send("write");
    await Promise.all(children.map(value => value.exited));
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled(children.map(value => value.exited));
  }
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {
    theme: "light", piBetterHarness: {
      goal: { saved: true }, callbacks: { saved: true }, sandbox: { saved: true }, subagents: { saved: true },
    },
  });
});

test("a Harness writer waits for a briefly delayed settings lock holder and preserves its update", async t => {
  const f = fixture(t);
  writeFileSync(f.path, '{"theme":"dark"}');
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import lockfile from 'proper-lockfile';
    import {readFileSync, writeFileSync} from 'node:fs';
    const path = ${JSON.stringify(f.path)};
    const release = lockfile.lockSync(path, {realpath:false});
    process.send('locked');
    setTimeout(() => {
      const settings = JSON.parse(readFileSync(path, 'utf8'));
      settings.theme = 'light';
      writeFileSync(path, JSON.stringify(settings));
      release();
      process.disconnect();
    }, 350);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", data => { stderr += data; });
  const exited = once(child, "close");
  try {
    await Promise.race([
      once(child, "message"),
      exited.then(() => { throw new Error(stderr || "lock holder exited before ready"); }),
    ]);
    updateHarnessSetting("goal", () => ({ saved: true }), f.seams);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {
      theme: "light", piBetterHarness: { goal: { saved: true } },
    });
  } finally {
    const [code] = await exited;
    assert.equal(code, 0, stderr);
  }
});
