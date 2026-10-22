import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { sshHostAliases } from "../src/remote-client/ssh-hosts.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ssh-host-aliases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, ".ssh", "config");
  const write = async (path: string, contents: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  };
  return { root, config, write };
}

test("discovers multiple literal aliases, ignoring patterns, targets, comments and credentials", async t => {
  const { root, config, write } = await fixture(t);
  const key = join(root, "private-key");
  await write(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nHost private-key-contents-secret\n-----END OPENSSH PRIVATE KEY-----\n");
  await write(config, `
# Host commented-out
Host first second *.example.com !excluded question? bracket[ab] *
  HostName target.example.com
  User secret-user
  IdentityFile "${key}"
  ProxyCommand printf source-secret
hOsT=third first # not-an-alias
  HOSTNAME=another-target
Host "fourth" 'fifth' !*.internal
Host\tsixth\tseventh\r
Match exec "a command that must never run"
  Host inside-match
`);
  assert.deepEqual(await sshHostAliases(config), ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "inside-match"]);
});

test("expands relative, absolute, quoted and glob Includes in lexical order at the initial config root", async t => {
  const { root, config, write } = await fixture(t);
  const ssh = dirname(config);
  const absolute = join(root, "elsewhere", "absolute config");
  await write(config, `Host before\nInClUdE = "fragments/*.conf" '${absolute}' "with spaces.conf"\nHost after\n`);
  await write(join(ssh, "fragments", "20-b.conf"), "Host beta shared\n");
  await write(join(ssh, "fragments", "10-a.conf"), "Host alpha\nInclude nested.inc\n");
  await write(join(ssh, "nested.inc"), "Host rooted-at-initial-config\n");
  await write(join(ssh, "fragments", "nested.inc"), "Host not-relative-to-included-file\n");
  await write(join(ssh, "fragments", "ignored.txt"), "Host not-in-glob\n");
  await write(absolute, "Host absolute shared\n");
  await write(join(ssh, "with spaces.conf"), "Host quoted\n");
  assert.deepEqual(await sshHostAliases(config), [
    "before", "alpha", "rooted-at-initial-config", "beta", "shared", "absolute", "quoted", "after",
  ]);
});

test("supports pathname question marks, ranges, negated classes and explicit dotfiles without recursive globstar", async t => {
  const { config, write } = await fixture(t);
  const ssh = dirname(config);
  await write(config, "Include hosts/[a-b]?.conf hosts/[!a-b]?.conf hosts/.hidden hosts/**/config \"closing[]].conf\"\n");
  await write(join(ssh, "hosts", "b2.conf"), "Host bravo\n");
  await write(join(ssh, "hosts", "a1.conf"), "Host alpha\n");
  await write(join(ssh, "hosts", "c3.conf"), "Host charlie\n");
  await symlink(join(ssh, "hosts", "c3.conf"), join(ssh, "hosts", "linked-file"));
  await write(join(ssh, "hosts", ".hidden"), "Host hidden\n");
  await write(join(ssh, "hosts", "one", "config"), "Host one-level\n");
  await write(join(ssh, "hosts", "one", "two", "config"), "Host not-recursive\n");
  await write(join(ssh, "closing].conf"), "Host closing-bracket\n");
  assert.deepEqual(await sshHostAliases(config), ["alpha", "bravo", "charlie", "hidden", "one-level", "closing-bracket"]);
});

test("glob results use lexical full-path order, including directory names with shared prefixes", async t => {
  const { config, write } = await fixture(t);
  await write(config, "Include ordered/*/*.conf\n");
  await write(join(dirname(config), "ordered", "a", "one.conf"), "Host second\n");
  await write(join(dirname(config), "ordered", "a.conf", "one.conf"), "Host first\n");
  assert.deepEqual(await sshHostAliases(config), ["first", "second"]);
});

test("deduplicates repeated Includes and aliases, including cycles through symlinks", async t => {
  const { config, write } = await fixture(t);
  const ssh = dirname(config);
  await write(config, "Host first\nInclude a.conf b.conf a.conf config linked.conf\nHost last first\n");
  await write(join(ssh, "a.conf"), "Host alpha first\nInclude b.conf\n");
  await write(join(ssh, "b.conf"), "Host beta\nInclude config a.conf linked.conf\n");
  await symlink(config, join(ssh, "linked.conf"));
  assert.deepEqual(await sshHostAliases(config), ["first", "alpha", "beta", "last"]);
});

test("missing initial configs, literal Includes and unmatched globs are harmless", async t => {
  const { config, write } = await fixture(t);
  assert.deepEqual(await sshHostAliases(config), []);
  await write(config, "Include missing missing-dir/*.conf empty-*.conf\nHost still-present\n");
  assert.deepEqual(await sshHostAliases(config), ["still-present"]);
});

test("default ~/.ssh/config and ~/ Includes use an isolated home, never the real user config", async t => {
  const { root, config, write } = await fixture(t);
  await write(config, "Host default-profile\nInclude ~/profiles/extra.conf\n");
  await write(join(root, "profiles", "extra.conf"), "Host home-include\n");
  const moduleUrl = new URL("../src/remote-client/ssh-hosts.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { sshHostAliases } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await sshHostAliases()));`,
  ], { env: { ...process.env, HOME: root, USERPROFILE: root } });
  assert.deepEqual(JSON.parse(stdout), ["default-profile", "home-include"]);
});

test("non-missing read errors remain visible without exposing source paths or contents", async t => {
  const { root, config, write } = await fixture(t);
  const directory = join(root, "source-credential-secret");
  await mkdir(directory);
  await write(config, `Host valid\nInclude "${directory}"\n`);
  for (const path of [directory, config]) {
    await assert.rejects(sshHostAliases(path), error => {
      assert.equal((error as NodeJS.ErrnoException).code, "EISDIR");
      assert.match(String(error), /Cannot read SSH configuration/);
      assert.doesNotMatch(String(error), /source-credential-secret|Host valid/);
      return true;
    });
  }
  await write(config, 'Include "unterminated-source-secret\n');
  await assert.rejects(sshHostAliases(config), error => {
    assert.match(String(error), /Invalid quoting/);
    assert.doesNotMatch(String(error), /unterminated-source-secret/);
    return true;
  });
});

test("deep Include chains fail clearly instead of returning a partial catalog", async t => {
  const { config, write } = await fixture(t);
  await write(config, "Host first\nInclude depth-1\n");
  for (let depth = 1; depth <= 33; depth++) {
    await write(join(dirname(config), `depth-${depth}`), `Host depth-${depth}\nInclude depth-${depth + 1}\n`);
  }
  await assert.rejects(sshHostAliases(config), /SSH configuration Include depth limit exceeded/);
});

test("wide Include graphs fail clearly at the file bound", async t => {
  const { config, write } = await fixture(t);
  await write(config, "Host first\nInclude profiles/*\n");
  for (let i = 0; i < 1024; i++) await write(join(dirname(config), "profiles", `${i}.conf`), `Host profile-${i}\n`);
  await assert.rejects(sshHostAliases(config), /SSH configuration file limit exceeded/);
});

test("byte and work bounds reject oversized or repetitive configs without leaking their contents", async t => {
  const { config, write } = await fixture(t);
  await write(config, `# source-secret${"x".repeat(8 * 1024 * 1024)}\n`);
  await assert.rejects(sshHostAliases(config), /SSH configuration byte limit exceeded/);
  await write(config, `Host first\nInclude ${"missing ".repeat(32_768)}\n`);
  await assert.rejects(sshHostAliases(config), /SSH configuration discovery work limit exceeded/);
});
