import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { makeEnv } from "./helpers.ts";

test("staged SDK imports work when the source fixture inherits its installed dependencies", async t => {
  const base = resolve(".work/staged-dependencies");
  mkdirSync(base, { recursive: true });
  const source = mkdtempSync(join(base, "source-"));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const support = join(source, "packages/server/test/support");
  mkdirSync(support, { recursive: true });
  cpSync(new URL("./support/staged-dependencies.ts", import.meta.url), join(support, "staged-dependencies.ts"));
  assert.equal(existsSync(join(source, "node_modules")), false);
  const env = makeEnv();
  const staged = join(env.root, "release");
  mkdirSync(staged);
  writeFileSync(join(staged, "probe.mjs"), "import {VERSION} from '@earendil-works/pi-coding-agent'; console.log(JSON.stringify({version:VERSION,resolved:import.meta.resolve('@earendil-works/pi-coding-agent')}));\n");
  const script = `const {stageDependencies}=await import(${JSON.stringify(pathToFileURL(join(support, "staged-dependencies.ts")).href)}); stageDependencies(${JSON.stringify(staged)}); await import(${JSON.stringify(pathToFileURL(join(staged, "probe.mjs")).href)});`;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: source });
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.version, VERSION);
  assert.equal(observed.resolved, import.meta.resolve("@earendil-works/pi-coding-agent"));
});
