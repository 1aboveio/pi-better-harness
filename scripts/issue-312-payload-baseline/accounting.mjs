/**
 * UTF-8 payload accounting for issue #312 AC13.
 *
 * Budgets in the originating issue are discussion values, not a current
 * product contract. This module records facts. It does not treat an
 * over-budget payload as a test failure.
 */
import { createHash } from "node:crypto";

export const KIB = 1024;

/** Proposed initial budgets from issue #312 (UTF-8 bytes). Not enforced. */
export const PROPOSED_BUDGETS_BYTES = Object.freeze({
    background_status: 2 * KIB,
    subagent_result: 8 * KIB,
    log_excerpt: 4 * KIB,
    list_page: 4 * KIB,
    callback_batch: 8 * KIB,
    raw_evidence: 64 * KIB,
});

const CREDENTIAL_PATTERN =
    /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._\-\/=]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;

const ORDERED_TOOLS_USED = /tools used:\s*([A-Za-z0-9_., -]+)/i;
const ORDERED_TOOLS_SEG = / · tools:\s*([A-Za-z0-9_., -]+)/;

export function utf8Bytes(text) {
    return Buffer.byteLength(String(text ?? ""), "utf8");
}

export function sha256Utf8(text) {
    return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function textOf(result) {
    const content = result?.content;
    if (!Array.isArray(content)) return String(result ?? "");
    return content.map((part) => part?.text ?? "").join("\n");
}

export function excerpt(text, maxChars = 240) {
    const single = String(text ?? "").replace(/\s+/g, " ").trim();
    if (single.length <= maxChars) return single;
    return `${single.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function longestLineUtf8Bytes(text) {
    let max = 0;
    for (const line of String(text ?? "").split(/\r?\n/)) {
        const n = utf8Bytes(line);
        if (n > max) max = n;
    }
    return max;
}

export function scanCredentials(text, caseId) {
    const hits = String(text ?? "").match(CREDENTIAL_PATTERN) ?? [];
    return hits.map((match) => ({
        caseId,
        kind: "credential-like",
        preview: `${match.slice(0, 8)}…`,
    }));
}

export function payloadFacts(text, { proposedBudgetBytes } = {}) {
    const content = String(text ?? "");
    const bytes = utf8Bytes(content);
    const toolsUsed = content.match(ORDERED_TOOLS_USED)?.[1]?.trim() ?? null;
    const toolsSeg = content.match(ORDERED_TOOLS_SEG)?.[1]?.trim() ?? null;
    const additional = content.match(/(\d+) additional active failure observations retained/i);
    return {
        utf16CodeUnits: content.length,
        lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length,
        longestLineUtf8Bytes: longestLineUtf8Bytes(content),
        containsNonAscii: /[^\x00-\x7F]/.test(content),
        utf8GreaterThanUtf16: bytes > content.length,
        orderedToolSequence: toolsUsed || toolsSeg,
        containsOrderedToolSequence: Boolean(toolsUsed || toolsSeg),
        containsToolsUsedHeader: Boolean(toolsUsed),
        containsMatchedConditionPath: /\$\.terminalFailure|matchedCondition/i.test(content),
        containsTruncationMarker: /\[showing tail of/i.test(content) || /…/.test(content),
        containsEmptyLogMasquerade: /\(log is empty\)|\(no output yet\)/i.test(content),
        additionalActiveFailuresRetained: additional ? Number(additional[1]) : 0,
        containsUnresolvedFailure: /Unresolved failure/i.test(content),
        containsObservationIncomplete: /Observation incomplete/i.test(content),
        compactStatusShowsMatchedCondition: /Condition matched:/i.test(content),
        containsSyntheticMarker: /issue-312-synthetic/.test(content),
        proposedBudgetBytes: proposedBudgetBytes ?? null,
        exceedsProposedBudget:
            proposedBudgetBytes == null ? null : bytes > proposedBudgetBytes,
    };
}

export function utf8BytesWithoutTmpdir(text, isolatedRoot = process.env.TMPDIR) {
    const content = String(text ?? "");
    if (!isolatedRoot) return utf8Bytes(content);
    return utf8Bytes(content.split(isolatedRoot).join("$TMPDIR"));
}

export function measureText(id, text, extra = {}) {
    const content = String(text ?? "");
    const bytes = utf8Bytes(content);
    const facts = payloadFacts(content, extra);
    facts.utf8BytesExcludingIsolatedTmpdir = utf8BytesWithoutTmpdir(content);
    facts.isolatedTmpdirPrefixBytes = bytes - facts.utf8BytesExcludingIsolatedTmpdir;
    return {
        id,
        utf8Bytes: bytes,
        sha256: sha256Utf8(content),
        excerpt: excerpt(content),
        facts,
        ...extra.fields,
        content,
    };
}
