// Live formatting/cache helpers used by the shared navigator and result tools.
// The retired legacy widget renderer is deliberately not treated as UI coverage.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fmtElapsed, fmtSpend, shortModel, isSpendCacheFresh, withinRefreshFloor } from "../widget.mjs";

describe("navigator formatting", () => {
    it("formats elapsed time across seconds, minutes, and hours", () => {
        for (const [ms, expected] of [[-1000, "0s"], [28_000, "28s"], [60_000, "1m 00s"], [125_000, "2m 05s"], [3_840_000, "1h 04m"]]) {
            assert.equal(fmtElapsed(ms), expected);
        }
    });
    it("renders measured token use and cost, and stays quiet without spend", () => {
        assert.equal(fmtSpend({ total: 1200, input: 1000, output: 200, costUSD: 0.01 }), "1.2k tok (↑1.0k ↓200) · $0.0100");
        assert.equal(fmtSpend({ total: 0, input: 0, output: 0, costUSD: 0 }), "");
        assert.equal(fmtSpend(undefined), "");
        assert.equal(shortModel("test/model"), "model");
        assert.equal(shortModel(undefined), "?");
    });
});

describe("navigator spend cache", () => {
    it("expires at the supplied TTL boundary and invalidates changed logs", () => {
        const cached = { refreshedAt: 10_000, logSize: 4096 };
        assert.equal(isSpendCacheFresh(cached, 10_749, 4096, 750), true);
        assert.equal(isSpendCacheFresh(cached, 10_750, 4096, 750), false);
        assert.equal(isSpendCacheFresh(cached, 10_001, 8192, 750), false);
        assert.equal(isSpendCacheFresh(null, 10_001, 4096, 750), false);
    });
    it("holds a growing log only until the refresh floor", () => {
        const cached = { refreshedAt: 10_000, logSize: 4096 };
        assert.equal(isSpendCacheFresh(cached, 10_299, 8192, 750), false);
        assert.equal(withinRefreshFloor(cached, 10_299, 300), true);
        assert.equal(withinRefreshFloor(cached, 10_300, 300), false);
    });
    it("does not retain missing, future, or disabled cache stamps", () => {
        assert.equal(withinRefreshFloor(null, 1000), false);
        assert.equal(withinRefreshFloor({ refreshedAt: 1000 }, undefined), false);
        assert.equal(withinRefreshFloor({ logSize: 1 }, 1000), false);
        assert.equal(withinRefreshFloor({ refreshedAt: 2000 }, 1000), false);
        assert.equal(withinRefreshFloor({ refreshedAt: 1000 }, 1000, 0), false);
    });
});
