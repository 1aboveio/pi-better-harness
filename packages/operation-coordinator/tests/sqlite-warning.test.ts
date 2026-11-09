import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { cleanupHarnesses, createHarness } from "./support.ts";

/**
 * Opening the store must not replace a global process hook. The coordinator is a
 * library embedded in the host process, so silencing `node:sqlite`'s experimental
 * warning by patching `process.emitWarning` would hide every other warning too.
 */
const originalEmitWarning = process.emitWarning;

afterEach(cleanupHarnesses);

it("does not replace process.emitWarning when the store opens node:sqlite", () => {
    const harness = createHarness();
    assert.ok(harness.store.getOperation("op-missing") === null);
    assert.equal(process.emitWarning, originalEmitWarning);
});
