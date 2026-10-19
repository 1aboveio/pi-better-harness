import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deliverToThread } from "../src/codex/deliver.ts";
import { PreflightError } from "../src/move/preflight.ts";
import { command } from "../src/remote/return.ts";
import type { RemoteContext } from "../src/remote/context.ts";

function fakeContext(connect: () => Promise<unknown>, host = "box"): RemoteContext {
  return { host, json: false, signal: new AbortController().signal, connect, stdout() {}, stderr() {}, close: async () => {} } as unknown as RemoteContext;
}

describe("pi-remote return with no daemon", () => {
  it("refuses with the daemon check and install hint instead of the raw connect error", async () => {
    const context = fakeContext(async () => {
      throw new Error("ssh: connect to host box port 22: Connection refused");
    });
    await assert.rejects(
      command.run({ values: {}, positionals: ["s1"] }, context),
      (error: Error) => {
        assert.ok(error instanceof PreflightError);
        assert.match(error.message, /Refusing to move; nothing was changed\. daemon: no daemon answered on box: ssh: connect/);
        assert.match(error.message, /bootstrap-host\.sh/);
        return true;
      },
    );
  });

  it("does not apply the Pi version check to a Codex host", async () => {
    const codexHost = { server: { extensionVersions: { "codex-cli": "1.0.0" } }, close() {} };
    const context = fakeContext(async () => codexHost);
    // Past the connect check it goes on as a Codex return; that needs a real daemon, so only the refusal matters here.
    await assert.rejects(command.run({ values: {}, positionals: ["s1"] }, context), (error: Error) => !(error instanceof PreflightError));
  });
});

describe("deliverToThread", () => {
  function fakeRuntime(calls: string[], turnsList: () => Array<{ id: string; status: string }>) {
    const client = {
      async call(method: string) {
        calls.push(method);
        if (method === "thread/read") return { thread: { status: { type: "idle" } } };
        if (method === "thread/turns/list") return { data: turnsList() };
        if (method === "turn/steer") return {};
        if (method === "turn/start") return { turn: { id: "t2" } };
        return {};
      },
    };
    return { client: async () => client, rolloutPath: () => "/x" } as never;
  }
  const adapter = { ownership: { get: () => ({ state: "owned" }) } } as never;

  it("steers when another client started a turn after the status read said idle", async () => {
    const calls: string[] = [];
    const result = await deliverToThread(adapter, fakeRuntime(calls, () => [{ id: "t1", status: "inProgress" }]), "th", "hi");
    assert.equal(result.delivered, "steer");
    assert.ok(!calls.includes("turn/start"));
  });

  it("starts a turn when the thread is really idle", async () => {
    const calls: string[] = [];
    const result = await deliverToThread(adapter, fakeRuntime(calls, () => [{ id: "t1", status: "completed" }]), "th", "hi");
    assert.equal(result.delivered, "prompt");
  });
});
