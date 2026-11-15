import test from "node:test";
import assert from "node:assert/strict";
import { intersectContinuationPermissions } from "../continuation-authority.ts";
import { acquireConversationLease, readConversationLease, releaseUnspawnedConversationLease } from "../continuation.ts";
import { nextRunId, processStartToken } from "../registry.ts";

const profile = { enabled: true, projectFiles: "read-write", outsideProject: "read", storedCredentials: "off", commands: true, network: true };
const first = { name: "web_one", package: "npm:first" }, second = { name: "web_two", package: "npm:second" };
const captured = { permissions: profile, subagentPermissions: profile, subagentTools: { applyPatch: true, trusted: [second, first] } };
const current = { main: profile, subagents: profile, subagentTools: { applyPatch: true, trusted: [first, second] } };

test("continuation tool intersection ignores ordering and never adds uncaptured provenance", () => {
    assert.deepEqual(intersectContinuationPermissions(captured, current).subagentTools, current.subagentTools);
    const narrowed = intersectContinuationPermissions(captured, { ...current, subagentTools: { applyPatch: false, trusted: [first, { ...second, package: "npm:other" }, { name: "new_tool", package: "npm:new" }] } });
    assert.deepEqual(narrowed.subagentTools, { applyPatch: false, trusted: [first] });
    assert.deepEqual(intersectContinuationPermissions(captured, { ...current, subagentTools: { applyPatch: false, trusted: [] } }).subagentTools, { applyPatch: false, trusted: [] });
});

test("undispatched lease recovery never steals a live holder or a different attempt", () => {
    const sessionId = nextRunId(), lease = acquireConversationLease({ sessionId, attemptId: sessionId });
    try {
        const input = { sessionId, attemptId: sessionId, managerPid: process.pid, managerStart: Buffer.from(processStartToken(process.pid)).toString("base64url"), canProveUnspawned: () => true };
        assert.equal(releaseUnspawnedConversationLease(input), false);
        assert.equal(releaseUnspawnedConversationLease({ ...input, attemptId: nextRunId() }), false);
        assert.equal(releaseUnspawnedConversationLease({ ...input, managerStart: "unknown" }), false);
        assert.equal(readConversationLease(sessionId).token, lease.token);
    } finally { lease.release(); }
});
