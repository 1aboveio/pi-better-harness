import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedRemoteWorkspace, parseRemoteArgs } from "../src/remote-client/extension.ts";

test("remote command accepts an SSH alias and explicit remote connection selectors", () => {
  assert.equal(parseRemoteArgs("r5").host, "r5");
  assert.deepEqual(parseRemoteArgs("r5 --cwd /home/user/workspaces/project --session selected --remote-dir /home/user/server"), {
    host: "r5", cwd: "/home/user/workspaces/project", sessionId: "selected", remoteDir: "/home/user/server",
  });
  for (const input of ["", "r5 r6", "r5 --unknown", "r5 --cwd"]) assert.throws(() => parseRemoteArgs(input));
});

test("an explicit remote workspace cannot silently attach a session belonging to another project", () => {
  assert.equal(checkedRemoteWorkspace(undefined, "/remote/actual"), "/remote/actual");
  assert.equal(checkedRemoteWorkspace("/remote/actual", "/remote/actual"), "/remote/actual");
  assert.throws(() => checkedRemoteWorkspace("/remote/expected", "/remote/actual"), /workspace is \/remote\/actual, not the requested \/remote\/expected/);
});