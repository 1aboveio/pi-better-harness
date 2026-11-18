import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ownerBindingFromContext, branchContains } from "../worker-waits.ts";
import { registerAssignmentAttempt, commitAssignmentTerminal, inspectOutcome } from "../assignment-outcomes.ts";

test("completion retains its captured SDK recipient through session and branch switches", () => {
    const cwd = mkdtempSync(join(tmpdir(), "callback-recipient-"));
    try {
        const manager = SessionManager.inMemory(cwd, { id: "session-a" });
        const base = manager.appendCustomEntry("fixture-base", {});
        const originalBranch = manager.appendCustomEntry("fixture-original", {});
        const ctx = { cwd, sessionManager: manager };
        const recipient = { kind: "parent-session", ...ownerBindingFromContext(ctx) };
        const originalRecipient = { kind: "parent-session", workspace: cwd, sessionId: "session-a", branchId: originalBranch, goalId: null };
        assert.deepEqual(recipient, originalRecipient);
        const binding = { version: 1, assignmentId: "callback-recipient", recipient,
            owner: { kind: "worker-conversation", sessionId: "worker", workspace: cwd, branchId: null, goalId: null } };
        registerAssignmentAttempt(binding, "sa_callback_recipient");

        manager.branch(base);
        const sibling = manager.appendCustomEntry("fixture-sibling", {});
        assert.notEqual(sibling, originalBranch);
        assert.equal(branchContains(ctx, originalBranch), false);
        const siblingRecipient = { kind: "parent-session", ...ownerBindingFromContext(ctx) };
        const foreign = SessionManager.inMemory(cwd, { id: "session-b" });
        foreign.appendCustomEntry("fixture-foreign", {});
        const foreignCtx = { cwd, sessionManager: foreign };
        const foreignRecipient = { kind: "parent-session", ...ownerBindingFromContext(foreignCtx) };
        const logPath = join(cwd, "output.log");
        writeFileSync(logPath, "retained completion evidence\n");
        const meta = { id: "sa_callback_recipient", assignment: binding, status: "killed", exitCode: 1, cwd, sessionId: "worker", logPath };
        const outcome = commitAssignmentTerminal(meta);
        assert.deepEqual(outcome.recipient, originalRecipient, "completion uses the registered launch recipient, not the current foreground");
        assert.throws(() => inspectOutcome(meta, { recipient: foreignRecipient }), /different parent session or branch/);
        assert.throws(() => inspectOutcome(meta, { recipient: siblingRecipient }), /different parent session or branch/);
        assert.throws(() => inspectOutcome(meta, { recipient: { ...originalRecipient, workspace: join(cwd, "foreign") } }), /different parent session or branch/);
        assert.deepEqual(outcome.recipient, originalRecipient, "rejected foreign inspection cannot retarget the outcome");

        manager.branch(originalBranch);
        assert.equal(branchContains(ctx, originalBranch), true);
        const inspected = inspectOutcome(meta, { recipient: { kind: "parent-session", ...ownerBindingFromContext(ctx) } });
        assert.deepEqual(inspected.outcome.recipient, originalRecipient);
        assert.equal(inspected.outcome.disposition, null, "inspection does not consume the original recipient's outcome");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
});
