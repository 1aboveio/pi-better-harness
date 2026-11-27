import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { availableRemoteHosts, chooseRemoteHost, remoteArgumentCompletions, savedRemoteHosts, showRemoteHostList } from "../src/remote-client/menu.ts";
import { rememberedServerDir, rememberRemoteHost } from "../src/remote-client/profiles.ts";

test("host menu discovers saved profiles without treating temp files or malformed names as hosts", async t => {
  const root = mkdtempSync(join(tmpdir(), "remote-menu-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await savedRemoteHosts(root), []);
  const directory = join(root, "remote-client", "hosts");
  mkdirSync(directory, { recursive: true });
  for (const name of ["r5.json", "user%40r6.json", "r7.json.pending.tmp", "%FF.json", "bad%20host.json"]) writeFileSync(join(directory, name), "{}");
  mkdirSync(join(directory, "not-a-file.json"));
  assert.deepEqual(await savedRemoteHosts(root), ["r5", "user@r6"]);
});

test("saved-host selection and cancel do not request manual input", async () => {
  let inputs = 0;
  const input = async () => { inputs++; return "unexpected"; };
  assert.equal(await chooseRemoteHost({ select: async () => "Connect to r5", input }, ["r5"]), "r5");
  assert.equal(await chooseRemoteHost({ select: async () => undefined, input }, ["r5"]), undefined);
  assert.equal(inputs, 0);
});

test("manual host entry trims aliases and rejects command arguments", async () => {
  const select = async () => "Connect to another SSH host...";
  assert.equal(await chooseRemoteHost({ select, input: async () => "  user@r6  " }, []), "user@r6");
  assert.equal(await chooseRemoteHost({ select, input: async () => undefined }, []), undefined);
  for (const value of ["r5 --cwd /tmp", "--host", "disconnect", "../host"]) {
    await assert.rejects(chooseRemoteHost({ select, input: async () => value }, []), /one SSH alias/);
  }
});

test("root autocomplete offers local or connected actions without exposing host aliases or push", () => {
  assert.deepEqual(remoteArgumentCompletions("", false, ["r5"])?.map(item => item.value), ["connect", "list", "pull"]);
  assert.deepEqual(remoteArgumentCompletions("", true, ["r5"])?.map(item => item.value), ["connect", "list", "sessions", "pull", "disconnect"]);
  assert.deepEqual(remoteArgumentCompletions(" LI")?.map(item => item.value), ["list"]);
  assert.deepEqual(remoteArgumentCompletions("dis", true)?.map(item => item.value), ["disconnect"]);
  assert.deepEqual(remoteArgumentCompletions("pu")?.map(item => item.value), ["pull"]);
  for (const connected of [false, true]) {
    for (const prefix of ["r", "r5", "user@", "prod", "unknown", "push", "push r5"]) {
      assert.equal(remoteArgumentCompletions(prefix, connected, ["r5", "user@r6", "prod"]), null, `${connected}: ${prefix}`);
    }
  }
});

test("connect and pull host completions are scoped to the chosen action", () => {
  for (const connected of [false, true]) {
    assert.deepEqual(remoteArgumentCompletions("connect ", connected, ["r5", "user@r6"])?.map(item => item.value), ["connect localhost", "connect r5", "connect user@r6"]);
    assert.deepEqual(remoteArgumentCompletions("pull ", connected, ["r5", "user@r6"])?.map(item => item.value), ["pull r5", "pull user@r6"]);
    for (const action of ["connect", "pull"]) {
      assert.deepEqual(remoteArgumentCompletions(`${action} r5`, connected, ["r5", "user@r6"])?.map(item => item.value), [`${action} r5`]);
      assert.deepEqual(remoteArgumentCompletions(`  ${action.toUpperCase()} U`, connected, ["r5", "user@r6"])?.map(item => item.value), [`${action} user@r6`]);
      assert.equal(remoteArgumentCompletions(`${action} missing`, connected, ["r5"]), null);
      assert.equal(remoteArgumentCompletions(`${action} r5 --cwd `, connected, ["r5"]), null);
    }
    assert.equal(remoteArgumentCompletions("list r5", connected, ["r5"]), null);
    assert.equal(remoteArgumentCompletions("sessions r5", connected, ["r5"]), null);
  }
});

test("the host picker can choose the local daemon without asking for an SSH alias", async () => {
  let inputs = 0;
  const input = async () => { inputs++; return "unexpected"; };
  assert.equal(await chooseRemoteHost({ select: async () => "Connect to localhost (this machine, no SSH)", input }, ["r5"]), "localhost");
  assert.equal(inputs, 0);
});

test("host listing merges SSH profiles with entered history and preserves remembered directories", async t => {
  const root = mkdtempSync(join(tmpdir(), "remote-host-list-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "ssh-config");
  writeFileSync(config, "Host r5 r6\nHost *.internal !excluded\n");
  await rememberRemoteHost("r5", "/custom/server", root);
  await rememberRemoteHost("r5", undefined, root);
  await rememberRemoteHost("user@historical", undefined, root);
  assert.equal(await rememberedServerDir("r5", root), "/custom/server");
  assert.equal(await rememberedServerDir("user@historical", root), undefined);
  assert.deepEqual(await availableRemoteHosts(root, config), ["r5", "r6", "user@historical"]);
  await assert.rejects(rememberRemoteHost("bad host", undefined, root), /one SSH alias/);
  await assert.rejects(rememberRemoteHost("r5", "relative/server", root), /must be absolute/);
  assert.equal(await rememberedServerDir("r5", root), "/custom/server");
});

test("remote list returns a host for confirmation and handles an empty catalog", async () => {
  const shown: string[][] = [];
  const notes: string[] = [];
  const ui = {
    select: async (_title: string, hosts: string[]) => { shown.push(hosts); return hosts[0]; },
    notify: (message: string) => { notes.push(message); },
  };
  assert.equal(await showRemoteHostList(ui, ["r5", "r6"]), "r5");
  assert.equal(await showRemoteHostList(ui, []), undefined);
  assert.deepEqual(shown, [["r5", "r6"]]);
  assert.equal(notes.length, 1);
});