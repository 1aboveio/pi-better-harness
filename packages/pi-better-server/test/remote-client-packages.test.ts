import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installPackageCatalog, planPackageSync, readLocalPackageCatalog, type PackageSpec } from "../src/remote-client/packages.ts";

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function readJson(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "package-sync-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const settings = join(agentDir, "settings.json");
  const installed = (base: string, name: string, version: string) => json(join(base, "npm", "node_modules", name, "package.json"), { name, version });
  return { root, agentDir, cwd, settings, installed };
}

// This external CLI double records actual execFile argv and simulates Pi's
// string-form persistence plus an unrelated settings change during installation.
const fakeCli = `
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const dir = process.env.PI_CODING_AGENT_DIR;
const log = join(dir, 'calls.jsonl');
const active = join(dir, 'install-active');
const fd = openSync(active, 'wx');
closeSync(fd);
const args = process.argv.slice(2);
appendFileSync(log, JSON.stringify({args, execPath:process.execPath, cwd:process.cwd()}) + '\\n');
if (args[0] !== 'install' || args.length !== 2) process.exit(24);
await new Promise(resolve => setImmediate(resolve));
if (args[1] === 'npm:fail@1.0.0') { unlinkSync(active); console.error('registry-token-DO-NOT-FORWARD'); process.exit(23); }
const path = join(dir, 'settings.json');
const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
settings.theme = 'changed-during-install';
settings.packages = [...(settings.packages ?? []), args[1]];
writeFileSync(path, JSON.stringify(settings));
const npm = /^npm:(.+)@([^@]+)$/.exec(args[1]);
if (npm) {
  const manifest = join(dir, 'npm', 'node_modules', npm[1], 'package.json');
  mkdirSync(dirname(manifest), {recursive:true});
  writeFileSync(manifest, JSON.stringify({name:npm[1], version:npm[2]}));
}
unlinkSync(active);
`;

function installer(f: ReturnType<typeof fixture>, afterInstall = "") {
  const piCli = join(f.root, "pi cli.mjs");
  writeFileSync(piCli, fakeCli + afterInstall);
  return { agentDir: f.agentDir, piCli };
}

function calls(f: ReturnType<typeof fixture>): Array<{ args: string[]; execPath: string; cwd: string }> {
  const path = join(f.agentDir, "calls.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

test("catalog pins installed npm versions and exports only package fields, not secrets or local source contents", async t => {
  const f = fixture(t);
  const filters = { extensions: ["extensions/*.ts", "!extensions/old.ts"], skills: [], prompts: ["+prompts/review.md"], themes: ["-themes/old.json"], autoload: false };
  json(f.settings, {
    packages: [
      { source: "npm:@example/tools", ...filters, auth: "package-secret", env: { TOKEN: "package-env-secret" }, argv: ["--approve"] },
      "npm:ranged@^2", "npm:tagged@latest", "npm:missing@1.0.0", "./private-extension.ts",
      "git:https://user:URL-SECRET@example.com/team/tools", "npm:bad@https://user:NPM-SECRET@example.com/x",
    ],
    defaultProvider: "provider-secret", apiKey: "settings-secret", env: { TOKEN: "settings-env-secret" },
    extensions: ["/private/extension.ts"],
  });
  json(join(f.agentDir, "auth.json"), { token: "auth-secret" });
  f.installed(f.agentDir, "@example/tools", "1.2.3");
  f.installed(f.agentDir, "ranged", "2.5.0");
  f.installed(f.agentDir, "tagged", "3.0.0-beta.2");
  const before = readFileSync(f.settings, "utf8");
  const catalog = await readLocalPackageCatalog(f.agentDir, f.cwd);
  assert.deepEqual(catalog.packages, [
    { source: "npm:@example/tools@1.2.3", ...filters },
    { source: "npm:ranged@2.5.0" }, { source: "npm:tagged@3.0.0-beta.2" },
  ]);
  assert.deepEqual(catalog.unsupported, ["/private/extension.ts", "./private-extension.ts", "[unsupported package source]", "npm:missing@1.0.0"]);
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET|secret/);
  assert.equal(readFileSync(f.settings, "utf8"), before);
  assert.equal(readJson(join(f.agentDir, "auth.json")).token, "auth-secret");
});

test("catalog summarizes 80 resource selectors and bare paths without hiding local directories", async t => {
  const f = fixture(t);
  const bare = Array.from({ length: 40 }, (_, i) => `skills/local-${i}/SKILL.md`);
  const selectors = Array.from({ length: 40 }, (_, i) => `${["", "!", "+", "-"][i % 4]}skills/group-${i}/*`);
  const localDirs = ["./local-tools", "/private/local-skills"];
  json(f.settings, { skills: [...selectors, ...bare], packages: [...localDirs, ...localDirs] });
  json(join(f.cwd, ".pi", "settings.json"), { skills: [...selectors, ...bare], extensions: [localDirs[0]] });
  new ProjectTrustStore(f.agentDir).set(f.root, true);

  const catalog = await readLocalPackageCatalog(f.agentDir, f.cwd);
  assert.deepEqual(catalog.packages, []);
  assert.deepEqual(new Set(catalog.unsupported), new Set(["[local resource selectors]", ...bare, ...localDirs]));
  assert.equal(catalog.unsupported.length, new Set(catalog.unsupported).size);
});

test("catalog keeps safe resource paths and deduplicates redacted registry, URL and control entries", async t => {
  const f = fixture(t);
  const unsafe = [
    "registry:private?token=REGISTRY-SECRET",
    "https://user:URL-SECRET@example.com/tools?token=QUERY-SECRET",
    "git:https://user:GIT-SECRET@example.com/team/tools",
    "./https://user:PATH-SECRET@example.com/tools",
    "/private/tools?token=PATH-QUERY-SECRET",
    "skills/hidden\u001b[31mCONTROL-SECRET",
    "skills/hidden\u009bCONTROL-SECRET",
    "skills/hidden\u202eCONTROL-SECRET",
  ];
  json(f.settings, {
    extensions: ["extensions/local tool.ts", "npm:missing@latest", ...unsafe],
    skills: ["skills", "skills", ...unsafe],
    prompts: ["+prompts/review.md", "!prompts/old.md"],
    themes: ["themes/*.json", "-themes/old.json"],
    packages: ["npm:missing@latest", unsafe[1], unsafe[1]],
  });
  const catalog = await readLocalPackageCatalog(f.agentDir, f.cwd);
  assert.deepEqual(catalog, {
    packages: [],
    unsupported: ["extensions/local tool.ts", "npm:missing@latest", "[unsupported package source]", "skills", "[local resource selectors]"],
  });
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET/);
});

test("global catalog omits trusted project declarations without reading project settings or trust", async t => {
  const f = fixture(t);
  json(f.settings, { defaultProjectTrust: "always", packages: ["npm:shared"], skills: ["global-skills"] });
  const projectPath = join(f.cwd, ".pi", "settings.json");
  json(projectPath, { packages: ["npm:shared", "npm:project-only"], skills: ["project-skills"] });
  f.installed(f.agentDir, "shared", "1.0.0");
  f.installed(join(f.cwd, ".pi"), "shared", "2.0.0");
  f.installed(join(f.cwd, ".pi"), "project-only", "3.0.0");
  const trust = new ProjectTrustStore(f.agentDir);
  trust.set(f.root, true);
  const trustPath = join(f.agentDir, "trust.json");
  const before = [f.settings, projectPath, trustPath].map(path => readFileSync(path, "utf8"));
  const expected = { packages: [{ source: "npm:shared@1.0.0" }], unsupported: ["global-skills"] };
  assert.deepEqual(await readLocalPackageCatalog(f.agentDir, f.cwd, { scope: "global" }), expected);
  assert.deepEqual([f.settings, projectPath, trustPath].map(path => readFileSync(path, "utf8")), before);
  assert.deepEqual((await readLocalPackageCatalog(f.agentDir, f.cwd, { scope: "workspace" })).packages, [
    { source: "npm:shared@2.0.0" }, { source: "npm:project-only@3.0.0" },
  ]);

  writeFileSync(projectPath, "{ broken");
  await assert.rejects(readLocalPackageCatalog(f.agentDir, f.cwd), /Cannot read trusted project package settings/);
  // An existing lock makes even an attempted project/trust read observable.
  mkdirSync(`${projectPath}.lock`);
  mkdirSync(`${trustPath}.lock`);
  assert.deepEqual(await readLocalPackageCatalog(f.agentDir, f.cwd, { scope: "global" }), expected);
  assert.equal(readFileSync(projectPath, "utf8"), "{ broken");
  assert.equal(readFileSync(trustPath, "utf8"), before[2]);
  assert.deepEqual(readdirSync(`${projectPath}.lock`), []);
  assert.deepEqual(readdirSync(`${trustPath}.lock`), []);
});

test("workspace catalog hides untrusted project resource paths and retains SDK skill migration", async t => {
  const f = fixture(t);
  const localDirs = ["skills/local", "~/shared-skills"];
  json(f.settings, { defaultProjectTrust: "always", skills: { customDirectories: localDirs } });
  const projectPath = join(f.cwd, ".pi", "settings.json");
  json(projectPath, { skills: [...localDirs, "project/PRIVATE-RESOURCE"], packages: ["./PRIVATE-PACKAGE"] });
  const trust = new ProjectTrustStore(f.agentDir);
  trust.set(f.cwd, false);
  const expected = { packages: [], unsupported: localDirs };
  assert.deepEqual(await readLocalPackageCatalog(f.agentDir, f.cwd), expected);
  writeFileSync(projectPath, "{ broken");
  assert.deepEqual(await readLocalPackageCatalog(f.agentDir, f.cwd, { scope: "workspace" }), expected);
  trust.set(f.cwd, true);
  await assert.rejects(readLocalPackageCatalog(f.agentDir, f.cwd), /Cannot read trusted project package settings/);
});

test("global catalog still rejects malformed global settings and creates no project or trust files", async t => {
  const f = fixture(t);
  json(f.settings, { packages: [] });
  assert.deepEqual(await readLocalPackageCatalog(f.agentDir, f.cwd, { scope: "global" }), { packages: [], unsupported: [] });
  assert.deepEqual(readdirSync(f.agentDir), ["settings.json"]);
  assert.deepEqual(readdirSync(f.cwd), []);
  writeFileSync(f.settings, "{ broken");
  await assert.rejects(readLocalPackageCatalog(f.agentDir, f.cwd, { scope: "global" }), /Cannot read Pi package settings/);
});

test("project declarations require Pi trust, replace global entries, and use the project Pi npm root", async t => {
  const f = fixture(t);
  json(f.settings, { packages: ["npm:shared", "npm:global-only"] });
  json(join(f.cwd, ".pi", "settings.json"), { packages: [{ source: "npm:shared", extensions: [] }, "npm:project-only"], defaultProjectTrust: "always" });
  f.installed(f.agentDir, "shared", "1.0.0");
  f.installed(f.agentDir, "global-only", "1.0.0");
  f.installed(join(f.cwd, ".pi"), "shared", "2.0.0");
  f.installed(join(f.cwd, ".pi"), "project-only", "3.0.0");
  assert.deepEqual((await readLocalPackageCatalog(f.agentDir, f.cwd)).packages, [{ source: "npm:shared@1.0.0" }, { source: "npm:global-only@1.0.0" }]);
  const trust = new ProjectTrustStore(f.agentDir);
  trust.set(f.root, true);
  assert.deepEqual((await readLocalPackageCatalog(f.agentDir, f.cwd)).packages, [
    { source: "npm:shared@2.0.0", extensions: [] }, { source: "npm:global-only@1.0.0" }, { source: "npm:project-only@3.0.0" },
  ]);
  trust.set(f.cwd, false);
  json(f.settings, { packages: ["npm:shared"], defaultProjectTrust: "always" });
  assert.deepEqual((await readLocalPackageCatalog(f.agentDir, f.cwd)).packages, [{ source: "npm:shared@1.0.0" }]);
  trust.set(f.cwd, null);
  assert.equal((await readLocalPackageCatalog(f.agentDir, f.cwd)).packages.length, 2);
});

test("catalog refuses to flatten a layered project autoload delta", async t => {
  const f = fixture(t);
  json(f.settings, { defaultProjectTrust: "always", packages: [{ source: "npm:tools", extensions: ["extensions/*.ts"] }] });
  json(join(f.cwd, ".pi", "settings.json"), { packages: [{ source: "npm:tools", autoload: false, extensions: ["-extensions/old.ts"] }] });
  f.installed(f.agentDir, "tools", "1.0.0");
  const catalog = await readLocalPackageCatalog(f.agentDir, f.cwd);
  assert.deepEqual(catalog, { packages: [], unsupported: ["npm:tools"] });
});

test("git catalog pins the installed checkout commit rather than a moving ref, without fetching", async t => {
  const f = fixture(t);
  const repo = join(f.agentDir, "git", "example.com", "team", "tools");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git("init", "--quiet");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture");
  const commit = git("rev-parse", "HEAD");
  json(f.settings, { packages: [{ source: "git:example.com/team/tools.git@main", skills: [] }, "git:example.com/team/missing@v1"] });
  assert.deepEqual(await readLocalPackageCatalog(f.agentDir, f.cwd), {
    packages: [{ source: `git:https://example.com/team/tools.git@${commit}`, skills: [] }],
    unsupported: ["git:example.com/team/missing@v1"],
  });
});

test("catalog rejects bad manifests and malformed settings instead of guessing a version", async t => {
  const f = fixture(t);
  json(f.settings, { packages: ["npm:wrong-name", "npm:bad-version"] });
  json(join(f.agentDir, "npm", "node_modules", "wrong-name", "package.json"), { name: "different", version: "1.0.0" });
  f.installed(f.agentDir, "bad-version", "^1.0.0");
  assert.deepEqual(await readLocalPackageCatalog(f.agentDir, f.cwd), { packages: [], unsupported: ["npm:wrong-name", "npm:bad-version"] });
  writeFileSync(f.settings, "{ broken");
  await assert.rejects(readLocalPackageCatalog(f.agentDir, f.cwd), /Cannot read Pi package settings/);
});

test("preview separates additions, unchanged entries and conflicts without removing remote-only packages", () => {
  const same = { source: "npm:same@1.0.0", extensions: [] };
  const local = [same, { source: "npm:changed@2.0.0" }, { source: "npm:filters@1.0.0", skills: [] }, { source: "npm:new@1.0.0" }];
  const remote = [same, { source: "npm:changed@1.0.0" }, { source: "npm:filters@1.0.0" }, { source: "npm:remote-only@1.0.0" }];
  const original = structuredClone({ local, remote });
  assert.deepEqual(planPackageSync(local, remote), {
    install: [{ source: "npm:new@1.0.0" }], unchanged: [same],
    conflicts: [{ local: local[1], remote: remote[1] }, { local: local[2], remote: remote[2] }],
  });
  assert.deepEqual({ local, remote }, original);
  assert.deepEqual(planPackageSync([], remote), { install: [], unchanged: [] });
  assert.throws(() => planPackageSync([same, same], remote), /Duplicate local package/);
  assert.throws(() => planPackageSync([{ source: "npm:unpinned" }], []), /exact npm version/);
});

test("preview matches git identity across SSH/HTTPS and retains source differences as approval conflicts", () => {
  const commit = "a".repeat(40);
  const local = { source: `git:https://example.com/team/tools.git@${commit}` };
  const remote = { source: `git:git@example.com:team/tools@${commit}` };
  assert.deepEqual(planPackageSync([local], [remote]), { install: [], unchanged: [], conflicts: [{ local, remote }] });
});

test("installer preserves filters, remote-only entries, credentials, and settings changed while the CLI runs", async t => {
  const f = fixture(t);
  const remoteOnly = { source: "npm:remote-only@1.0.0", skills: ["skills/*"] };
  json(f.settings, { packages: [remoteOnly, { source: "npm:tools@0.9.0" }], defaultProvider: "remote-provider", apiKey: "remote-secret", retry: { maxRetries: 7 } });
  json(join(f.agentDir, "auth.json"), { token: "remote-auth-secret" });
  const authBefore = readFileSync(join(f.agentDir, "auth.json"), "utf8");
  const filtered: PackageSpec = { source: "npm:tools@1.2.3", extensions: ["+extensions/a.ts", "!extensions/b.ts"], skills: [], prompts: [], themes: [], autoload: false };
  await installPackageCatalog([filtered, { source: `git:https://example.com/team/tools@${"b".repeat(40)}`, extensions: [] }], installer(f));
  const result = readJson(f.settings);
  assert.deepEqual(result.packages, [remoteOnly, filtered, { source: `git:https://example.com/team/tools@${"b".repeat(40)}`, extensions: [] }]);
  assert.equal(result.defaultProvider, "remote-provider");
  assert.equal(result.apiKey, "remote-secret");
  assert.equal(result.theme, "changed-during-install");
  assert.deepEqual(result.retry, { maxRetries: 7 });
  assert.equal(readFileSync(join(f.agentDir, "auth.json"), "utf8"), authBefore);
  assert.deepEqual(calls(f), [filtered, { source: `git:https://example.com/team/tools@${"b".repeat(40)}` }].map(item => ({ args: ["install", item.source], execPath: process.execPath, cwd: f.agentDir })));
  assert.equal(readdirSync(f.agentDir).some(name => name.endsWith(".tmp") || name.endsWith(".lock")), false);
});

test("trusted target project overrides refuse the entire batch before installation or settings changes", async t => {
  const commit = "c".repeat(40);
  const cases = [
    { name: "inherited trust and unresolved npm", declaration: "npm:tools@latest", trust: "parent" },
    { name: "global trust default and same pin", declaration: "npm:tools@1.0.0", trust: "default" },
    { name: "layered autoload delta", declaration: { source: "npm:tools", autoload: false, extensions: ["-old.ts"] }, trust: "parent" },
    { name: "project-only approved identity", declaration: "npm:tools", trust: "default", noGlobal: true },
    { name: "git identity across transports", declaration: "git:git@example.com:team/tools.git@main", trust: "default", source: `git:https://example.com/team/tools@${commit}` },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const f = fixture(t);
    const source = scenario.source ?? "npm:tools@1.0.0";
    json(f.settings, { defaultProjectTrust: scenario.trust === "default" ? "always" : "never", packages: scenario.noGlobal ? [] : [source], apiKey: "keep-secret" });
    const projectPath = join(f.cwd, ".pi", "settings.json");
    json(projectPath, { packages: [scenario.declaration], env: { TOKEN: "project-secret" } });
    json(join(f.agentDir, "auth.json"), { token: "auth-secret" });
    if (scenario.trust === "parent") new ProjectTrustStore(f.agentDir).set(f.root, true);
    const paths = [f.settings, projectPath, join(f.agentDir, "auth.json")];
    const before = paths.map(path => readFileSync(path, "utf8"));
    await assert.rejects(installPackageCatalog([{ source: "npm:first@1.0.0" }, { source }], { ...installer(f), cwd: f.cwd }), /trusted project.*override.*Manage that project override on r5/);
    assert.deepEqual(calls(f), []);
    assert.deepEqual(paths.map(path => readFileSync(path, "utf8")), before);
    assert.equal(existsSync(join(f.agentDir, "npm")), false);
  });
});

test("untrusted target project declarations neither block nor get copied into global settings", async t => {
  for (const denied of [false, true]) await t.test(denied ? "saved denial overrides global always" : "project cannot grant itself trust", async t => {
    const f = fixture(t);
    const remoteOnly = { source: "npm:remote-only@2.0.0", skills: [] };
    json(f.settings, { defaultProjectTrust: denied ? "always" : "ask", packages: [remoteOnly], apiKey: "global-secret" });
    const projectPath = join(f.cwd, ".pi", "settings.json");
    json(projectPath, { defaultProjectTrust: "always", packages: [{ source: "npm:tools@9.0.0", extensions: [] }, "npm:project-only", "./private.ts"], apiKey: "project-secret" });
    if (denied) new ProjectTrustStore(f.agentDir).set(f.cwd, false);
    const before = readFileSync(projectPath, "utf8");
    const approved = { source: "npm:tools@1.0.0", skills: ["skills/*"], autoload: false };
    await installPackageCatalog([approved], { ...installer(f), cwd: f.cwd });
    assert.deepEqual(readJson(f.settings).packages, [remoteOnly, approved]);
    assert.equal(readJson(f.settings).apiKey, "global-secret");
    assert.equal(readFileSync(projectPath, "utf8"), before);
    assert.deepEqual((await readLocalPackageCatalog(f.agentDir, f.cwd)).packages, [approved]);
    assert.deepEqual(calls(f).map(call => call.args), [["install", approved.source]]);
    assert.equal(existsSync(join(f.cwd, ".pi", "npm")), false);
  });
});

test("cwd installation verifies all approved pins and filters while retaining unrelated trusted project packages", async t => {
  const f = fixture(t);
  json(f.settings, { defaultProjectTrust: "always", packages: ["npm:remote-only@1.0.0"], apiKey: "global-secret" });
  const projectPath = join(f.cwd, ".pi", "settings.json");
  json(projectPath, { packages: ["npm:project-only"], env: { TOKEN: "project-secret" } });
  f.installed(join(f.cwd, ".pi"), "project-only", "3.0.0");
  f.installed(f.agentDir, "remote-only", "1.0.0");
  const projectBefore = readFileSync(projectPath, "utf8");
  const approved: PackageSpec[] = [
    { source: "npm:@example/tools@1.2.3", extensions: ["!old.ts"], skills: [], prompts: ["+review.md"], themes: ["-old.json"], autoload: false },
    { source: "npm:another@2.0.0", autoload: true },
  ];
  await installPackageCatalog(approved, { ...installer(f), cwd: f.cwd });
  assert.deepEqual((await readLocalPackageCatalog(f.agentDir, f.cwd)).packages, [{ source: "npm:remote-only@1.0.0" }, ...approved, { source: "npm:project-only@3.0.0" }]);
  assert.equal(readFileSync(projectPath, "utf8"), projectBefore);
  assert.equal(readJson(f.settings).apiKey, "global-secret");
});

test("cwd verification rejects wrong or unresolved installed pins even when every installer exits successfully", async t => {
  for (const version of ["9.0.0", "not-a-version"]) await t.test(version, async t => {
    const f = fixture(t);
    const manifest = join(f.agentDir, "npm", "node_modules", "first", "package.json");
    const options = installer(f, `if (args[1] === 'npm:last@1.0.0') writeFileSync(${JSON.stringify(manifest)}, JSON.stringify({name:'first',version:${JSON.stringify(version)}}));`);
    const approved = [{ source: "npm:first@1.0.0" }, { source: "npm:last@1.0.0" }];
    await assert.rejects(installPackageCatalog(approved, { ...options, cwd: f.cwd }), /Package sync verification failed:.*npm:first@1\.0\.0/);
    assert.deepEqual(calls(f).map(call => call.args[1]), approved.map(item => item.source));
    assert.deepEqual(readJson(f.settings).packages, approved);
  });
});

test("cwd verification accepts normalized git pins and rejects a checkout that moves during install", async t => {
  const f = fixture(t);
  const repo = join(f.agentDir, "git", "example.com", "team", "tools");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git("init", "--quiet");
  const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture");
  commit();
  const first = git("rev-parse", "HEAD");
  commit();
  const second = git("rev-parse", "HEAD");
  const approved = { source: `git:example.com/team/tools.git@${second}`, themes: [], autoload: false };
  await installPackageCatalog([approved], { ...installer(f), cwd: f.cwd });
  assert.deepEqual((await readLocalPackageCatalog(f.agentDir, f.cwd)).packages, [{ ...approved, source: `git:https://example.com/team/tools.git@${second}` }]);
  const options = installer(f, `
    const {execFileSync} = await import('node:child_process');
    execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'checkout', '--quiet', ${JSON.stringify(first)}]);
  `);
  await assert.rejects(installPackageCatalog([approved], { ...options, cwd: f.cwd }), /Package sync verification failed:.*git:example\.com\/team\/tools\.git@/);
  assert.equal(git("rev-parse", "HEAD"), first);
});

test("cwd verification rereads trust when a project override becomes trusted during installation", async t => {
  const f = fixture(t);
  json(f.settings, { defaultProjectTrust: "never" });
  const projectPath = join(f.cwd, ".pi", "settings.json");
  json(projectPath, { packages: ["npm:tools@9.0.0"], apiKey: "project-secret" });
  f.installed(join(f.cwd, ".pi"), "tools", "9.0.0");
  const projectBefore = readFileSync(projectPath, "utf8");
  const trust = new ProjectTrustStore(f.agentDir);
  trust.set(f.cwd, true);
  const trustPath = join(f.agentDir, "trust.json");
  const trusted = readFileSync(trustPath, "utf8");
  trust.set(f.cwd, false);
  const options = installer(f, `writeFileSync(${JSON.stringify(trustPath)}, ${JSON.stringify(trusted)});`);
  await assert.rejects(installPackageCatalog([{ source: "npm:tools@1.0.0" }], { ...options, cwd: f.cwd }), /Package sync verification failed:.*npm:tools@1\.0\.0.*changed concurrently/);
  assert.equal(calls(f).length, 1);
  assert.equal(readFileSync(projectPath, "utf8"), projectBefore);
  assert.deepEqual((await readLocalPackageCatalog(f.agentDir, f.cwd)).packages, [{ source: "npm:tools@9.0.0" }]);
});

test("cwd verification detects concurrent trusted project changes to each filter and autoload", async t => {
  const changes = [{ extensions: [] }, { skills: [] }, { prompts: [] }, { themes: [] }, { autoload: true }, { autoload: false }];
  for (const change of changes) await t.test(JSON.stringify(change), async t => {
    const f = fixture(t);
    json(f.settings, { defaultProjectTrust: "always" });
    const projectPath = join(f.cwd, ".pi", "settings.json");
    json(projectPath, { packages: [] });
    f.installed(join(f.cwd, ".pi"), "tools", "1.0.0");
    const concurrent = { packages: [{ source: "npm:tools@1.0.0", ...change }], apiKey: "concurrent-secret" };
    const options = installer(f, `writeFileSync(${JSON.stringify(projectPath)}, ${JSON.stringify(JSON.stringify(concurrent))});`);
    await assert.rejects(installPackageCatalog([{ source: "npm:tools@1.0.0" }], { ...options, cwd: f.cwd }), /Package sync verification failed:.*filters and autoload.*changed concurrently/);
    assert.equal(calls(f).length, 1);
    assert.deepEqual(readJson(projectPath), concurrent);
    assert.deepEqual(readJson(f.settings).packages, [{ source: "npm:tools@1.0.0" }]);
  });
});

test("cwd verification reports an explicit failure if trusted project settings become unreadable", async t => {
  const f = fixture(t);
  json(f.settings, { defaultProjectTrust: "always" });
  const projectPath = join(f.cwd, ".pi", "settings.json");
  json(projectPath, { packages: [] });
  const options = installer(f, `writeFileSync(${JSON.stringify(projectPath)}, '{ broken');`);
  await assert.rejects(installPackageCatalog([{ source: "npm:tools@1.0.0" }], { ...options, cwd: f.cwd }), /Package sync verification failed: cannot read the target effective catalog/);
  assert.equal(calls(f).length, 1);
  assert.equal(readFileSync(projectPath, "utf8"), "{ broken");
});

test("installs are serialized across calls, snapshot caller filters, and recover the queue after failure", async t => {
  const f = fixture(t);
  const options = installer(f);
  const first = { source: "npm:first@1.0.0", extensions: [] as string[] };
  const a = installPackageCatalog([first], options);
  first.extensions.push("unapproved.ts");
  const b = installPackageCatalog([{ source: "npm:second@1.0.0" }], options);
  await Promise.all([a, b]);
  assert.deepEqual(readJson(f.settings).packages, [{ source: "npm:first@1.0.0", extensions: [] }, { source: "npm:second@1.0.0" }]);
  await assert.rejects(installPackageCatalog([{ source: "npm:before-failure@1.0.0", skills: [] }, { source: "npm:fail@1.0.0" }, { source: "npm:never@1.0.0" }], options), error => {
    assert.match((error as Error).message, /Package install failed: npm:fail@1.0.0/);
    assert.doesNotMatch(String(error), /registry-token/);
    return true;
  });
  await installPackageCatalog([{ source: "npm:after-failure@1.0.0" }], options);
  assert.deepEqual(calls(f).map(call => call.args[1]), ["npm:first@1.0.0", "npm:second@1.0.0", "npm:before-failure@1.0.0", "npm:fail@1.0.0", "npm:after-failure@1.0.0"]);
  assert.deepEqual(readJson(f.settings).packages, [
    { source: "npm:first@1.0.0", extensions: [] }, { source: "npm:second@1.0.0" },
    { source: "npm:before-failure@1.0.0", skills: [] }, { source: "npm:after-failure@1.0.0" },
  ]);
});

test("every malicious or unpinned source is rejected before any package in the batch installs", async t => {
  const f = fixture(t);
  const options = installer(f);
  const invalid: unknown[] = [
    { source: "" }, { source: " " }, { source: "--approve" }, { source: "./extension.ts" }, { source: "/tmp/extension.ts" },
    { source: "npm:tools" }, { source: "npm:tools@latest" }, { source: "npm:tools@^1.0.0" }, { source: "npm:tools@1.0" },
    { source: "npm:tools@1.0.0;touch /tmp/injected" }, { source: "npm:tools@1.0.0\n--approve" }, { source: "npm:tools@1.0.0\0" },
    { source: "npm:../tools@1.0.0" }, { source: "npm:tools@npm:other@1.0.0" }, { source: "npm:tools@file:/tmp/pkg" },
    { source: "git:file:///tmp/repo@" + "a".repeat(40) }, { source: "git:https://example.com/team/tools@main" },
    { source: "git:https://example.com/team/tools@abc1234" }, { source: "git:https://example.com/team/../tools@" + "a".repeat(40) },
    { source: "git:https://example.com/team/tools#" + "a".repeat(40) },
    { source: "git:https://example.com/team/%2e%2e/tools@" + "a".repeat(40) },
    { source: "git:https://user:secret@example.com/team/tools@" + "a".repeat(40) },
    { source: "git:ext::sh -c command" }, { source: "git:https://example.com/team/tools@" + "a".repeat(40) + ";command" },
    { source: "npm:tools@1.0.0", extensions: "not-an-array" }, { source: "npm:tools@1.0.0", autoload: "false" }, null,
  ];
  for (const value of invalid) {
    await assert.rejects(installPackageCatalog([{ source: "npm:valid@1.0.0" }, value] as PackageSpec[], options), /Invalid|Unsupported|Unsafe|Expected|requires|must use/);
  }
  assert.deepEqual(calls(f), []);
  assert.equal(existsSync(f.settings), false);
  await installPackageCatalog([], options);
  await assert.rejects(installPackageCatalog([{ source: "npm:valid@1.0.0" }], { agentDir: f.agentDir, piCli: "relative-cli.mjs" }), /absolute host-owned/);
});

test("installer refuses malformed existing settings before invoking Pi and keeps managed settings symlinks", async t => {
  const f = fixture(t);
  const options = installer(f);
  writeFileSync(f.settings, "{ broken");
  await assert.rejects(installPackageCatalog([{ source: "npm:tools@1.0.0" }], options), SyntaxError);
  assert.deepEqual(calls(f), []);
  rmSync(f.settings);
  const target = join(f.root, "managed-settings.json");
  json(target, { defaultProvider: "keep-provider" });
  symlinkSync(target, f.settings);
  await installPackageCatalog([{ source: "npm:tools@1.0.0", extensions: [] }], options);
  assert.equal(lstatSync(f.settings).isSymbolicLink(), true);
  assert.equal(readJson(target).defaultProvider, "keep-provider");
  assert.deepEqual(readJson(target).packages, [{ source: "npm:tools@1.0.0", extensions: [] }]);
});

test("managed installer resolves private npm and node through PATH without host npm and redacts failures", { skip: process.platform === "win32" }, async t => {
  for (const pathMode of ["inherited", "empty", "absent"] as const) await t.test(pathMode, async t => {
    const f = fixture(t);
    const bin = join(f.root, "private runtime", "node", "bin");
    mkdirSync(bin, { recursive: true });
    const node = join(bin, "node");
    // A symlink would resolve process.execPath back to the host's Node directory.
    copyFileSync(process.execPath, node);
    // Homebrew's Node needs its sibling shared libraries after relocation.
    const lib = join(dirname(process.execPath), "../lib");
    if (existsSync(lib)) symlinkSync(lib, join(bin, "../lib"), "dir");
    const inheritedBin = join(f.root, "inherited tools");
    mkdirSync(inheritedBin);
    for (const command of ["npm", "node"]) {
      writeFileSync(join(inheritedBin, command), `#!${process.execPath}\nprocess.exit(91);\n`, { mode: 0o755 });
    }
    writeFileSync(join(inheritedBin, "package-sync-helper"), "#!/usr/bin/env node\nconsole.log('inherited-tool');\n", { mode: 0o755 });
    const inheritedPath = pathMode === "inherited" ? [inheritedBin, join(f.root, "other tools")].join(delimiter) : "";
    writeFileSync(join(bin, "npm"), `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('fail@1.0.0')) {
  console.log('registry-stdout-DO-NOT-FORWARD');
  console.error('registry-stderr-DO-NOT-FORWARD');
  process.exit(23);
}
const nestedNode = execFileSync('node', ['-e', 'console.log(process.execPath)'], {encoding:'utf8'}).trim();
const helper = ${JSON.stringify(pathMode)} === 'inherited' ? execFileSync('package-sync-helper', [], {encoding:'utf8'}).trim() : null;
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'npm-args.json'), JSON.stringify({args, execPath:process.execPath, nestedNode, helper, path:process.env.PATH}));
const root = args[args.indexOf('--prefix') + 1];
const manifestDir = join(root, 'node_modules', 'fixture-tools');
mkdirSync(manifestDir, {recursive:true});
writeFileSync(join(manifestDir, 'package.json'), JSON.stringify({name:'fixture-tools', version:'1.2.3'}));
`, { mode: 0o755 });
    json(f.settings, { enableInstallTelemetry: false, enableAnalytics: false, defaultProvider: "keep-me" });
    const approved = { source: "npm:fixture-tools@1.2.3", extensions: [], autoload: false };
    const env = { ...process.env, PATH: inheritedPath };
    if (pathMode === "absent") delete (env as NodeJS.ProcessEnv).PATH;
    const output = execFileSync(node, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", `
      import { writeFileSync } from 'node:fs';
      import { installPackageCatalog } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/remote-client/packages.ts")).href)};
      const options = ${JSON.stringify({ agentDir: f.agentDir, cwd: f.cwd })};
      await installPackageCatalog([${JSON.stringify(approved)}], options);
      try {
        await installPackageCatalog([{source:'npm:fail@1.0.0'}], options);
        throw new Error('Expected install failure');
      } catch (error) {
        writeFileSync(${JSON.stringify(join(f.root, "failure.json"))}, JSON.stringify({message:error.message, stack:error.stack, cause:error.cause}));
      }
      writeFileSync(${JSON.stringify(join(f.root, "parent-path.json"))}, JSON.stringify({path:process.env.PATH}));
    `], { cwd: f.cwd, env, encoding: "utf8", timeout: 30_000 });
    const npm = readJson(join(f.agentDir, "npm-args.json"));
    assert.ok(npm.args.includes("install") && npm.args.includes("fixture-tools@1.2.3"));
    assert.equal(npm.execPath, node);
    assert.equal(npm.nestedNode, node);
    assert.equal(npm.helper, pathMode === "inherited" ? "inherited-tool" : null);
    assert.equal(npm.path, inheritedPath ? `${bin}${delimiter}${inheritedPath}` : bin);
    assert.deepEqual(readJson(join(f.root, "parent-path.json")), pathMode === "absent" ? {} : { path: inheritedPath });
    assert.deepEqual(readJson(f.settings).packages, [approved]);
    assert.equal(readJson(f.settings).defaultProvider, "keep-me");
    const failure = readJson(join(f.root, "failure.json"));
    assert.equal(failure.message, "Package install failed: npm:fail@1.0.0");
    assert.equal(failure.cause, undefined);
    assert.doesNotMatch(JSON.stringify(failure) + output, /registry-stdout|registry-stderr|DO-NOT-FORWARD/);
  });
});

test("default CLI is resolved from the installed Pi manifest and works with SDK settings", async t => {
  const f = fixture(t);
  const npmCli = join(f.root, "fake-npm.mjs");
  writeFileSync(npmCli, `import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'npm-args.json'), JSON.stringify(process.argv.slice(2)));`);
  json(f.settings, { npmCommand: [process.execPath, npmCli], enableInstallTelemetry: false, enableAnalytics: false, packages: ["npm:remote-only@1.0.0"], defaultProvider: "keep-me" });
  await installPackageCatalog([{ source: "npm:fixture-tools@1.2.3", extensions: [], autoload: false }], { agentDir: f.agentDir });
  const args: string[] = readJson(join(f.agentDir, "npm-args.json"));
  assert.ok(args.includes("install") && args.includes("fixture-tools@1.2.3"));
  const settings = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: false });
  assert.deepEqual(settings.getGlobalSettings().packages, ["npm:remote-only@1.0.0", { source: "npm:fixture-tools@1.2.3", extensions: [], autoload: false }]);
  assert.equal(settings.getDefaultProvider(), "keep-me");
  assert.deepEqual(settings.drainErrors(), []);
});
