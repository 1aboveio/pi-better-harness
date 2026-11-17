import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureLaunchContext } from "../launch-context.ts";
import { ownerBindingFromContext } from "../worker-waits.ts";

test("capture preserves missing identity capabilities for downstream validation", () => {
    assert.equal(captureLaunchContext(undefined), undefined);
    const missing = { cwd: "/validation-only" };
    assert.equal(captureLaunchContext(missing), missing);
    const entries = [{ id: "validation-entry", type: "custom", customType: "settings", data: {} }];
    const partial = { cwd: missing.cwd, sessionManager: { getBranch: () => entries } };
    const captured = captureLaunchContext(partial);
    entries.push({ id: "later-entry", type: "custom", customType: "settings", data: {} });
    assert.equal(captured.sessionManager.getSessionId, undefined);
    assert.equal(captured.sessionManager.getLeafId, undefined);
    assert.equal(captured.sessionManager.getSessionFile, undefined);
    assert.deepEqual(captured.sessionManager.getBranch().map(entry => entry.id), ["validation-entry"]);
});

for (const mode of ["same-session", "cross-session"]) {
    test(`launch ownership captures the invoking ${mode} branch before preparation`, async () => {
        const cwd = mkdtempSync(join(tmpdir(), "launch-context-"));
        try {
            const original = SessionManager.create(cwd, cwd, { id: "original" });
            original.appendMessage({ role: "assistant", content: [], timestamp: 1 });
            const originalBranch = original.appendCustomEntry("original", {});
            const successor = SessionManager.create(cwd, cwd, { id: "successor" });
            successor.appendMessage({ role: "assistant", content: [], timestamp: 1 });
            const successorBranch = successor.appendCustomEntry("invoking", {});
            let current = mode === "same-session" ? original : successor;
            const expectedBranch = mode === "same-session" ? originalBranch : successorBranch;
            const expectedSession = mode === "same-session" ? "original" : "successor";
            const context = { cwd, sessionManager: {
                getSessionId: () => current.getSessionId(), getBranch: () => current.getBranch(),
                getLeafId: () => current.getLeafId(), getSessionFile: () => current.getSessionFile(),
            } };
            const captured = captureLaunchContext(context);
            const invokingFile = current.getSessionFile();
            assert.equal(existsSync(invokingFile), true, "the SDK owns the persisted invoking conversation");
            let release;
            const preparation = new Promise(resolve => { release = resolve; });
            const dispatched = (async () => { await preparation; return ownerBindingFromContext(captured); })();
            current.appendCustomEntry("internal-preparation", {});
            if (mode === "cross-session") current = original;
            release();
            assert.deepEqual(await dispatched, { workspace: cwd, sessionId: expectedSession, branchId: expectedBranch, goalId: null });
            assert.equal(captured.sessionManager.getLeafId(), expectedBranch);
            assert.equal(captured.sessionManager.getSessionFile(), invokingFile);
            assert.notEqual(context.sessionManager.getLeafId(), expectedBranch);
            assert.notEqual(ownerBindingFromContext(context).branchId, expectedBranch);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
}
