import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { claimDaemonOwner } from "../src/daemon-owner.ts";
import { makeEnv } from "./helpers.ts";

function contender(serverDir: string) {
  const source = `import {claimDaemonOwner} from ${JSON.stringify(new URL("../src/daemon-owner.ts", import.meta.url).href)};
    try {
      const release = claimDaemonOwner(${JSON.stringify(serverDir)});
      console.log("owned");
      process.stdin.resume();
      process.stdin.on("end", () => { release(); process.exit(0); });
    } catch (error) { console.log("blocked: " + error.message); process.exit(3); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const report = new Promise<string>((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.includes("\n")) resolve(output.trim());
    });
    child.once("exit", () => { if (!output) reject(new Error("Contender exited without reporting ownership")); });
  });
  return { child, report, exited };
}

test("simultaneous processes converge on one daemon owner and release permits a new owner", async t => {
  const env = makeEnv();
  mkdirSync(env.serverDir);
  const runs = Array.from({ length: 4 }, () => contender(env.serverDir));
  t.after(async () => {
    for (const run of runs) run.child.stdin.end();
    await Promise.all(runs.map(run => run.exited));
  });
  const results = await Promise.all(runs.map(run => run.report));
  assert.equal(results.filter(value => value === "owned").length, 1, results.join("\n"));
  assert.equal(results.filter(value => /blocked: Daemon owner .*already running/.test(value)).length, 3);
  for (const run of runs) run.child.stdin.end();
  await Promise.all(runs.map(run => run.exited));
  const release = claimDaemonOwner(env.serverDir);
  release();
  release();
  assert.deepEqual(readdirSync(env.serverDir), []);
});

test("a killed owner is reclaimable without leaving an index writer alive", async t => {
  const env = makeEnv();
  mkdirSync(env.serverDir);
  const run = contender(env.serverDir);
  t.after(() => { run.child.kill("SIGKILL"); });
  assert.equal(await run.report, "owned");
  run.child.kill("SIGKILL");
  await run.exited;
  const release = claimDaemonOwner(env.serverDir);
  assert.throws(() => claimDaemonOwner(env.serverDir), /already running/);
  release();
  assert.deepEqual(readdirSync(env.serverDir), []);
});

test("an empty crash-cleanup directory can be replaced, but unknown ownership is never erased", () => {
  const env = makeEnv();
  mkdirSync(env.serverDir);
  const lock = join(env.serverDir, "daemon-owner");
  mkdirSync(lock);
  claimDaemonOwner(env.serverDir)();
  mkdirSync(lock);
  writeFileSync(join(lock, "foreign"), "keep");
  assert.throws(() => claimDaemonOwner(env.serverDir), /Unrecognized daemon ownership/);
  assert.equal(readFileSync(join(lock, "foreign"), "utf8"), "keep");
});

test("malformed process identity metadata cannot make a live owner reclaimable", () => {
  const env = makeEnv();
  mkdirSync(env.serverDir);
  const release = claimDaemonOwner(env.serverDir);
  const lock = join(env.serverDir, "daemon-owner");
  const path = join(lock, readdirSync(lock)[0]!);
  const original = JSON.parse(readFileSync(path, "utf8"));
  try {
    for (const fields of [{ boot: 1 }, { start: {} }, { boot: "broken" }, { start: "NaN" }]) {
      writeFileSync(path, JSON.stringify({ ...original, ...fields }));
      assert.throws(() => claimDaemonOwner(env.serverDir), /Invalid daemon ownership/);
      assert.equal(existsSync(path), true);
    }
  } finally { release(); }
});

test("release can be retried after a filesystem permission failure", { skip: process.getuid?.() === 0 ? "root bypasses directory permissions" : false }, () => {
  const env = makeEnv();
  mkdirSync(env.serverDir);
  const release = claimDaemonOwner(env.serverDir);
  const lock = join(env.serverDir, "daemon-owner");
  try {
    chmodSync(lock, 0o500);
    assert.throws(release, /EACCES|EPERM/);
  } finally { chmodSync(lock, 0o700); }
  release();
  assert.equal(existsSync(lock), false);
});

test("a candidate file creation failure cleans up its private staging directory", () => {
  const env = makeEnv();
  mkdirSync(env.serverDir);
  const source = `import {claimDaemonOwner} from ${JSON.stringify(new URL("../src/daemon-owner.ts", import.meta.url).href)};
    process.on("SIGXFSZ", () => {});
    try { claimDaemonOwner(${JSON.stringify(env.serverDir)}); process.exitCode = 2; }
    catch (error) { console.log(error.code); }`;
  const out = execFileSync("bash", ["-c", 'ulimit -f 0; exec "$1" --input-type=module -e "$2"', "limit", process.execPath, source], { encoding: "utf8" });
  assert.match(out, /EFBIG/);
  assert.deepEqual(readdirSync(env.serverDir), []);
});