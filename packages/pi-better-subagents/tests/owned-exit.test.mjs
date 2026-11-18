import test from "node:test";
import assert from "node:assert/strict";
import { completeOwnedExit } from "../owned-exit.ts";
import { createCallbackBatcher } from "../shared-callback-batcher.ts";
import { registerFixtureRun, retireFixtureRun, settleFixtureRun, captureRunRemovalEvidence } from "./fixture-run-ownership.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";

for (const mode of ["success", "removal-error", "capture-error", "bounded-output"]) test(`original timing reap preserves removal and receipt authority: ${mode}`, async () => {
    const source = readFileSync(new URL("./timing_lifecycle.test.mjs", import.meta.url), "utf8");
    const tree = ts.createSourceFile("timing_lifecycle.test.mjs", source, ts.ScriptTarget.Latest, true);
    const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "reap");
    assert.ok(declaration);
    const root = mkdtempSync(join(tmpdir(), "timing-reap-boundary-"));
    mkdirSync(join(root, "timing-receipts")); writeFileSync(join(root, "timing-receipts", "receipt.json"), "private payload");
    const run = { id: "owned-fixture", pid: 123 }, original = Object.assign(new Error("original removal"), { code: "ENOTEMPTY" });
    const batcher = createCallbackBatcher({ sendMessage() {} });
    const receipt = { pid: run.pid, start: "captured", completion: Promise.resolve(), completionState: "fulfilled", pi: {},
        recipientEvidence: () => ({ recipient: { connected: true, exitCode: null }, receiptSettlement: "unknown", recentDeliveries: [] }) };
    const owned = new Map([[run.id, receipt]]), live = [run], output = [];
    let attempts = 0, captures = 0;
    const reap = new Function("assert", "ownedExits", "getCallbackBatcher", "realProcessProbe", "processStartToken", "killProcessTree",
        "settleFixtureRun", "runDir", "rmSync", "retireFixtureRun", "liveRuns", "captureRunRemovalEvidence", "stopRuntime", "console",
        `return (${declaration.getText(tree)});`)(assert, owned, () => batcher,
        { pidExists: () => false, groupAlive: () => false }, () => assert.fail("no new identity probe"), () => assert.fail("no signal"),
        settleFixtureRun, () => root, () => { attempts++; if (mode !== "success") throw original; }, retireFixtureRun, live,
        directory => {
            captures++; if (mode === "capture-error") throw new Error("capture refused");
            const evidence = captureRunRemovalEvidence(directory);
            if (mode === "bounded-output") while (evidence.entries.length < 24) evidence.entries.push({ relative: "\u0001".repeat(256) });
            return evidence;
        },
        { diagnostics: () => ({ exitCode: null, stderr: "not captured" }) }, { error: (...args) => output.push(args) });
    try {
        if (mode === "success") {
            await reap(run);
            assert.equal(captures, 0); assert.equal(output.length, 0);
            assert.equal(owned.size, 0); assert.equal(live.length, 0);
        } else {
            await assert.rejects(reap(run), error => error === original);
            assert.equal(owned.get(run.id), receipt, "failed deletion cannot retire its exact owner");
            assert.equal(live.length, 1); assert.equal(captures, 1);
            if (mode === "capture-error") assert.equal(output[0][0], "[timing-reap-writer-unavailable]");
            else {
                const evidence = JSON.parse(output[0][1]);
                assert.equal(output[0][0], "[timing-reap-writer]");
                assert.ok(evidence.residual.entries.some(entry => entry.relative === "timing-receipts/receipt.json"));
                assert.equal(evidence.localOwner.completion, "fulfilled");
                assert.equal(evidence.localOwner.exactReceipt, true);
                assert.equal(evidence.recipient.recipient.connected, true);
                assert.equal(evidence.daemon.foldSettlement, "not observed by local exit owner");
                assert.doesNotMatch(output[0][1], /private payload|not captured/);
                assert.ok(Buffer.byteLength(output[0][1]) < 32768);
                if (mode === "bounded-output") {
                    assert.ok(evidence.residual.entries.length <= 8);
                    assert.equal(evidence.residual.truncated, true);
                }
            }
        }
        assert.equal(attempts, 1, "no deletion retry on any path");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("timing removal evidence distinguishes residual receipt and journal names without reading contents or following links", () => {
    const root = mkdtempSync(join(tmpdir(), "timing-residue-")), run = join(root, "run"), outside = join(root, "outside");
    mkdirSync(join(run, "timing-receipts"), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(run, "timing-receipts", "receipt.json"), "PRIVATE_RECEIPT_CONTENT");
    writeFileSync(join(run, "failures.jsonl.observed"), "");
    writeFileSync(join(run, ".meta.pending.tmp"), "PRIVATE_META_CONTENT");
    writeFileSync(join(outside, "not-owned"), "PRIVATE_OUTSIDE_CONTENT");
    symlinkSync(outside, join(run, "foreign-link"), "junction");
    try {
        const evidence = captureRunRemovalEvidence(run), encoded = JSON.stringify(evidence);
        assert.ok(evidence.entries.some(entry => entry.relative === "timing-receipts/receipt.json" && entry.size === "23"));
        assert.ok(evidence.entries.some(entry => entry.relative === "failures.jsonl.observed"));
        assert.ok(evidence.entries.some(entry => entry.relative === ".meta.pending.tmp"));
        assert.equal(evidence.entries.find(entry => entry.relative === "foreign-link").kind, "symlink");
        assert.equal(captureRunRemovalEvidence(join(run, "foreign-link")).entries[0].kind, "symlink");
        assert.doesNotMatch(encoded, /PRIVATE_|not-owned/);
        assert.ok(evidence.entries.every(entry => !entry.relative.startsWith(root)));
        assert.equal(evidence.truncated, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("timing removal metadata is bounded and a vanished directory remains an explicit observation", () => {
    const root = mkdtempSync(join(tmpdir(), "timing-residue-cap-"));
    try {
        for (let i = 0; i < 100; i++) writeFileSync(join(root, `file-${i}`), "x");
        const evidence = captureRunRemovalEvidence(root);
        assert.equal(evidence.entries.length, 24);
        assert.equal(evidence.truncated, true);
        assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 32768);
        const missing = captureRunRemovalEvidence(join(root, "vanished"));
        assert.equal(missing.entries[0].error, "ENOENT");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test("timing teardown waits for both owned finalization and pending callback writes before group proof", async () => {
    const finalizer = deferred(), handoff = deferred();
    const batcher = createCallbackBatcher({ sendMessage: () => handoff.promise });
    let receiptWritten = false, removed = false;
    const delivery = batcher.deliverUrgent({ source: "subagent", id: "timing", label: "timing", status: "lost",
        customType: "health", content: "attention", onDelivered: () => { receiptWritten = true; } });
    const completion = settleFixtureRun({ completion: finalizer.promise }, batcher, () => {
        assert.equal(receiptWritten, true, "group proof cannot precede in-flight receipt writes");
    }).then(() => { removed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed, false);
    finalizer.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed, false, "terminal finalization alone cannot authorize removal");
    handoff.resolve(); await delivery; await completion;
    assert.equal(removed, true);
    const failure = new Error("finalizer refused");
    await assert.rejects(settleFixtureRun({ completion: Promise.reject(failure) }, batcher,
        () => assert.fail("failed finalizer cannot authorize group proof or deletion")), error => error === failure);
});

test("fixture cleanup registration follows the actual exit observer, not the tool caller", () => {
    const run = { id: "local", pid: 123 }, liveRuns = [];
    const owned = new Map([[run.id, { pid: run.pid, completion: Promise.resolve() }]]);
    registerFixtureRun(run, owned, liveRuns);
    assert.deepEqual(liveRuns, [run]);
    registerFixtureRun({ id: "remote", pid: 456 }, owned, liveRuns, "continuation-fixture");
    assert.deepEqual(liveRuns, [run], "remote fixture close, not the local reaper, owns its managed child");
    assert.throws(() => registerFixtureRun({ id: "unknown", pid: 789 }, owned, liveRuns), /exact owned exit/);
    assert.throws(() => registerFixtureRun({ ...run, pid: 999 }, owned, liveRuns), /exact owned exit/);
    assert.throws(() => registerFixtureRun(run, owned, liveRuns, "continuation-fixture"), /two fixture teardown owners/);
    assert.deepEqual(liveRuns, [run], "refused ownership must not register a kill or deletion");
    assert.throws(() => retireFixtureRun(run, { pid: run.pid, completion: Promise.resolve() }, owned, liveRuns), /exact exit owner receipt/);
    assert.deepEqual(liveRuns, [run], "a different receipt cannot retire scheduled cleanup");
    retireFixtureRun(run, owned.get(run.id), owned, liveRuns);
    assert.equal(owned.size, 0);
    assert.deepEqual(liveRuns, []);
});

test("owned exit acknowledgement waits beyond lease release and rejects failed finalization", async () => {
    const exit = deferred(), settlement = deferred();
    const order = [];
    const completion = completeOwnedExit(exit.promise, code => order.push(`finalize:${code}`),
        () => order.push("release"), async () => { await settlement.promise; order.push("settled"); });
    let removable = false;
    void completion.then(() => { removable = true; });
    exit.resolve(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ["finalize:0", "release"]);
    assert.equal(removable, false, "released lease is not permission to remove the directory");
    settlement.resolve();
    await completion;
    assert.equal(removable, true);
    assert.deepEqual(order, ["finalize:0", "release", "settled"]);
    let released = false, settled = false;
    await assert.rejects(completeOwnedExit(Promise.resolve(null), () => { throw new Error("terminal refused"); },
        () => { released = true; }, async () => { settled = true; }), /terminal refused/);
    assert.equal(released, true);
    assert.equal(settled, false, "failed finalization must not acknowledge quiescence");
    await assert.rejects(completeOwnedExit(Promise.resolve(0), () => {}, () => {},
        async () => { throw new Error("park settlement refused"); }), /park settlement refused/);
});

for (const urgent of [true, false]) test(`cancelled callback owner waits for its ${urgent ? "urgent" : "ordinary"} handoff acknowledgement`, async () => {
    const handoff = deferred();
    const batcher = createCallbackBatcher({ sendMessage: () => handoff.promise });
    // Urgent handoffs write their durable delivery marker after sendMessage resolves.
    let delivered = false;
    const event = { id: "owned", source: "subagent", label: "owned", status: "orphaned", customType: "health", content: "health",
        onDelivered: () => { delivered = true; } };
    let pending;
    if (urgent) pending = batcher.deliverUrgent(event);
    else { batcher.enqueue(event); pending = batcher.flush(); }
    batcher.cancel();
    let quiescent = false;
    const completion = batcher.settled().then(() => { quiescent = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(quiescent, false);
    handoff.resolve();
    await pending; await completion;
    assert.equal(delivered, true);
    assert.equal(quiescent, true);
});
