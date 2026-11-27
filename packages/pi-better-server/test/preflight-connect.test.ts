import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DaemonClient } from "../src/client.ts";
import { SERVER_EXTENSION_VERSIONS } from "../src/handshake.ts";
import { connectChecked, PreflightError } from "../src/move/preflight.ts";

function fakeClient(extensionVersions: Record<string, string> | undefined) {
  const state = { closed: 0 };
  const client = { server: extensionVersions ? { extensionVersions } : undefined, close: () => void state.closed++ } as unknown as DaemonClient;
  return { client, state };
}

describe("connectChecked", () => {
  it("refuses a daemon that runs another pi-better-server version, closes the connection and names the install step", async () => {
    const wanted = SERVER_EXTENSION_VERSIONS["pi-better-server"];
    for (const versions of [{ "pi-better-server": `${wanted}-other` }, {}, undefined]) {
      const { client, state } = fakeClient(versions as Record<string, string> | undefined);
      const error = await connectChecked(async () => client, "r9").then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof PreflightError, String(error));
      assert.equal(error.checks[0]!.name, "versions");
      assert.equal(error.checks[0]!.detail, `the daemon runs pi-better-server ${versions?.["pi-better-server"] ?? "(unknown)"}, this side runs ${wanted}`);
      assert.match(error.message, /bootstrap-host\.sh/);
      assert.match(error.message, / on r9/);
      assert.equal(state.closed, 1);
    }
  });

  it("returns the client when the versions match", async () => {
    const { client, state } = fakeClient({ ...SERVER_EXTENSION_VERSIONS });
    assert.equal(await connectChecked(async () => client), client);
    assert.equal(state.closed, 0);
  });
});
