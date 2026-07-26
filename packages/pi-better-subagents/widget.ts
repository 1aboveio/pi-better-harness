/**
 * TypeScript re-export of widget.mjs pure helpers.
 * Logic lives in widget.mjs for ESM unit-test compatibility (mirrors completion.ts).
 */
export {
    SPINNER,
    TICK_MS,
    SPEND_REFRESH_MS,
    WIDGET_CLEAR,
    ELAPSED_WIDTH,
    TOKENS_WIDTH,
    COST_WIDTH,
    fmtElapsed,
    fmtElapsedFixed,
    fmtTokens,
    fmtTokensFixed,
    fmtCost,
    fmtCostFixed,
    shortModel,
    fmtSpend,
    fmtSpendFixed,
    linesEqual,
    nextWidgetAction,
    buildWidgetLines,
    isSpendCacheFresh,
    isHealthLogCacheFresh,
    resolveHealthLogExtraction,
} from "./widget.mjs";
