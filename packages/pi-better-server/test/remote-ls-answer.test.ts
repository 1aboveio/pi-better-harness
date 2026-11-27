import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PendingDialog, SessionSummary } from "../src/protocol.ts";
import { command as answer } from "../src/remote/answer.ts";
import type { RemoteContext } from "../src/remote/context.ts";
import { formatTable } from "../src/remote/ls.ts";
import { displayStatus } from "../src/remote/sessions.ts";

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "0198a000-0000-7000-8000-000000000515",
    cwd: "/work",
    sessionFile: "/work/s.jsonl",
    status: "running",
    isStreaming: false,
    live: true,
    lastSeq: 0,
    hasController: false,
    needsInput: [],
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("pi-remote ls status", () => {
  it("shows a moved-away session as moved, not closed", () => {
    const moved = summary({ status: "closed", ownership: "moved" });
    assert.equal(displayStatus(moved), "moved");
    assert.match(formatTable([moved]), /\bmoved\b/);
    assert.equal(displayStatus(summary({ status: "closed" })), "closed");
  });
});

describe("pi-remote answer without an answer flag", () => {
  it("lists the pending dialog and exits 0", async () => {
    const dialog: PendingDialog = { id: "d1", method: "confirm", title: "Proceed?" } as PendingDialog;
    const out: string[] = [];
    const daemon = {
      async request(cmd: Record<string, unknown>) {
        if (cmd.type === "list_sessions") return { success: true, data: { sessions: [summary({})] } };
        if (cmd.type === "acquire_control") return { success: true, data: { needsInput: [dialog] } };
        return { success: true, data: {} };
      },
    };
    const context = { json: false, connect: async () => daemon, stdout: (t: string) => out.push(t) } as unknown as RemoteContext;
    const code = await answer.run({ values: {}, positionals: ["0198a000"] }, context);
    assert.equal(code, 0);
    assert.match(out.join(""), /pending d1 confirm "Proceed\?"/);
  });
});
