import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findCommandName } from "../src/remote-cli.ts";
import { command as newCommand } from "../src/remote/new.ts";
import type { RemoteContext } from "../src/remote/context.ts";
import { displayStatus } from "../src/remote/sessions.ts";

describe("pi-remote argument dispatch", () => {
  it("finds the subcommand after global options and their values", () => {
    assert.equal(findCommandName(["--host", "r9", "ls"]), "ls");
    assert.equal(findCommandName(["--socket", "/tmp/s", "--remote-dir", "/srv", "--json", "tail", "abc"]), "tail");
    assert.equal(findCommandName(["ls", "--host", "r9"]), "ls");
    assert.equal(findCommandName(["--host=r9", "ls"]), "ls");
    assert.equal(findCommandName(["--host", "r9"]), undefined);
  });
});

describe("pi-remote new when the prompt is refused", () => {
  it("prints the created session id, then fails with the daemon's error", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const client = {
      async call(request: { type: string }) {
        if (request.type === "create_session") return { sessionId: "sess-123", data: { sessionId: "sess-123" } };
        throw new Error("No API key for provider anthropic");
      },
    };
    const context = { host: undefined, json: false, connect: async () => client, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) } as unknown as RemoteContext;
    await assert.rejects(newCommand.run({ values: { cwd: "/w" }, positionals: ["hello"] }, context), /No API key/);
    assert.deepEqual(out, ["sess-123\n"]);
    assert.match(err.join(""), /sess-123.*refused/);
  });
});

describe("pi-remote ls needs-input", () => {
  it("shows needs-input when the daemon summary carries pending dialogs, even mid-stream", () => {
    const base = { status: "open", isStreaming: true, needsInput: [{ id: "d1" }] } as any;
    assert.equal(displayStatus(base), "needs-input");
    assert.equal(displayStatus({ ...base, needsInput: [] }), "running");
  });
});
