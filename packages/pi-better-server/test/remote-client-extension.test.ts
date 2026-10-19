import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedRemoteWorkspace, chooseRemoteConnection, parseRemoteArgs } from "../src/remote-client/extension.ts";

test("remote command accepts an SSH alias and explicit remote connection selectors", () => {
  assert.equal(parseRemoteArgs("r5").host, "r5");
  assert.equal(parseRemoteArgs("connect r5").host, "r5");
  assert.deepEqual(parseRemoteArgs("r5 --cwd /home/user/workspaces/project --session selected --remote-dir /home/user/server"), {
    host: "r5", cwd: "/home/user/workspaces/project", sessionId: "selected", remoteDir: "/home/user/server",
  });
  for (const input of ["", "connect", "r5 r6", "r5 --unknown", "r5 --cwd"]) assert.throws(() => parseRemoteArgs(input));
});

test("an explicit remote workspace cannot silently attach a session belonging to another project", () => {
  assert.equal(checkedRemoteWorkspace(undefined, "/remote/actual"), "/remote/actual");
  assert.equal(checkedRemoteWorkspace("/remote/actual", "/remote/actual"), "/remote/actual");
  assert.throws(() => checkedRemoteWorkspace("/remote/expected", "/remote/actual"), /workspace is \/remote\/actual, not the requested \/remote\/expected/);
});

test("list selection asks for connection approval and cancellation never requests a connection", async () => {
  const confirmations: string[] = [];
  const ui = {
    select: async () => "r5", input: async () => undefined, notify: () => {},
    confirm: async (title: string) => { confirmations.push(title); return true; },
  };
  assert.equal((await chooseRemoteConnection("list", ui, ["r5"]))?.host, "r5");
  assert.deepEqual(confirmations, ["Connect to r5?"]);
  assert.equal(await chooseRemoteConnection("list", { ...ui, confirm: async () => false }, ["r5"]), undefined);
  const before = confirmations.length;
  assert.equal(await chooseRemoteConnection("list", { ...ui, select: async () => undefined }, ["r5"]), undefined);
  assert.equal(confirmations.length, before);
});

test("connect without a host opens selection and explicit connect bypasses selection", async () => {
  let selections = 0;
  const ui = {
    select: async () => { selections++; return "Connect to r5"; },
    input: async () => undefined, notify: () => {}, confirm: async () => { throw new Error("Unexpected confirmation"); },
  };
  assert.equal((await chooseRemoteConnection("connect", ui, ["r5"]))?.host, "r5");
  assert.equal(selections, 1);
  assert.equal((await chooseRemoteConnection("connect r6", ui, ["r5"]))?.host, "r6");
  assert.equal(selections, 1);
});