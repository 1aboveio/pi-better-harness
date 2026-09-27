/**
 * Collect BEFORE/AFTER model-facing payloads from registered tools.
 *
 * Subagent factories in tools.ts are the objects index.ts registers.
 * Background tools come from registerTools(), the same function index.ts calls.
 * Callbacks are the `content` the real shared batcher hands to sendMessage
 * (flush for completions, deliverUrgent for health/attention), built from the
 * same field builders index.ts uses — not a formatter called in isolation.
 */
import { FROZEN_NOW } from "./isolate.mjs";
import {
    POLICY_BUDGETS_BYTES,
    PROPOSED_BUDGETS_BYTES,
    measureText,
    scanCredentials,
    textOf,
    utf8Bytes,
} from "./accounting.mjs";
import * as fixtures from "./fixtures.mjs";

const TypeStub = {
    Object: (value) => value,
    String: (value) => value ?? {},
    Number: (value) => value ?? {},
    Boolean: (value) => value ?? {},
    Array: (value) => value,
    Optional: (value) => value,
};

const theme = { fg: (_color, text) => text };

function compactTui(tool, result) {
    if (typeof tool?.renderResult !== "function") return null;
    const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {});
    const text = Array.isArray(rendered?.render?.(80)) ? rendered.render(80).join("\n") : "";
    return { utf8Bytes: utf8Bytes(text), excerpt: text.replace(/\s+/g, " ").trim().slice(0, 160) };
}

function pushCase(cases, findings, spec, text) {
    const measured = measureText(spec.id, text, {
        proposedBudgetBytes: spec.proposedBudgetBytes,
        fields: {
            family: spec.family,
            surface: spec.surface,
            tool: spec.tool,
            invokePath: spec.invokePath,
            params: spec.params,
        },
    });
    if (spec.tui) {
        measured.facts.tuiCompactUtf8Bytes = spec.tui.utf8Bytes;
        measured.facts.tuiFoldsDisplayOnly = spec.tui.utf8Bytes < measured.utf8Bytes;
    }
    if (spec.facts) Object.assign(measured.facts, spec.facts);
    cases.push(measured);
    findings.push(...scanCredentials(text, spec.id));
}

function nextCursorOf(content) {
    return String(content ?? "").match(/\bnextCursor=(\S+)/)?.[1];
}

function incidentCursorOf(content) {
    return String(content ?? "").match(/incidentCursor=(i1\.\S+)/)?.[1]
        ?? String(content ?? "").match(/cursor=(i1\.\S+)/)?.[1];
}

function budgetsFor(phase) {
    return phase === "after" ? POLICY_BUDGETS_BYTES : PROPOSED_BUDGETS_BYTES;
}

export async function collectBaseline({ phase = "before" } = {}) {
    const subagentRegistry = await import("../../packages/pi-better-subagents/registry.ts");
    const subagentTools = await import("../../packages/pi-better-subagents/tools.ts");
    const { finalizeRun } = await import("../../packages/pi-better-subagents/finalization.ts");
    const { buildHealthCallbackDelivery } = await import("../../packages/pi-better-subagents/completion.mjs");
    const callbackFields = await import("../../packages/pi-better-subagents/callback-fields.ts");
    const { collectRunFailures } = await import("../../packages/pi-better-subagents/failures.ts");
    const bgRegistry = await import("../../packages/pi-better-background-tasks/src/registry.ts");
    const bgLogs = await import("../../packages/pi-better-background-tasks/src/logs.ts");
    const bgFailures = await import("../../packages/pi-better-background-tasks/src/failures.ts");
    const { registerTools } = await import("../../packages/pi-better-background-tasks/src/tools.ts");
    const { createCallbackBatcher } = await import("../../packages/callback-batcher/index.ts");

    const origin = { cwd: fixtures.SYNTHETIC_CWD, sessionId: fixtures.SYNTHETIC_SESSION };
    const session = { getActiveOrigin: () => origin };
    const unavailableSession = { getActiveOrigin: () => undefined };
    const subagent = {
        list: subagentTools.subagentListTool(TypeStub, session),
        output: subagentTools.subagentOutputTool(TypeStub, session),
        result: subagentTools.subagentResultTool(TypeStub, session),
    };
    const subagentUnavailable = {
        result: subagentTools.subagentResultTool(TypeStub, unavailableSession),
    };

    const bgRegistered = {};
    const bgMessages = [];
    registerTools({
        on() {},
        registerTool(tool) { bgRegistered[tool.name] = tool; },
        sendMessage(message, options) { bgMessages.push({ message, options }); },
    });
    const ctx = {
        cwd: fixtures.SYNTHETIC_CWD,
        sessionManager: { getSessionId: () => fixtures.SYNTHETIC_SESSION },
    };

    const seeded = {
        success: fixtures.seedSubagentSuccess(subagentRegistry),
        failed: fixtures.seedSubagentFailed(subagentRegistry),
        incomplete: fixtures.seedSubagentIncomplete(subagentRegistry),
        orphaned: fixtures.seedSubagentOrphaned(subagentRegistry),
        unicode: fixtures.seedSubagentUnicode(subagentRegistry),
        manyFailures: fixtures.seedSubagentManyFailures(subagentRegistry),
        foreign: fixtures.seedSubagentForeign(subagentRegistry),
        bgSuccess: fixtures.seedBgSuccess(bgRegistry, bgLogs),
        bgFailed: fixtures.seedBgFailed(bgRegistry, bgLogs, bgFailures),
        bgRepeated: fixtures.seedBgRepeatedPoll(bgRegistry, bgLogs),
        bgUnicode: fixtures.seedBgUnicode(bgRegistry),
        bgManyFailures: fixtures.seedBgManyFailures(bgRegistry, bgFailures),
    };

    const callbacks = {};
    const quiet = { sendMessage() {}, notify() {}, renderWidget() {} };
    finalizeRun(seeded.success.id, 0, quiet);
    finalizeRun(seeded.failed.id, 1, quiet);
    finalizeRun(seeded.incomplete.id, 0, quiet);
    /** Deliver one completion through the real batcher, as index.ts enqueues it. */
    async function deliverCompletion(bucket, id) {
        const host = { sendMessage(message, options) { callbacks[bucket] = { content: message.content, customType: message.customType, options }; } };
        const batcher = createCallbackBatcher(host, { windowMs: 60_000, retryMs: 60_000 });
        const meta = subagentRegistry.readMeta(id);
        batcher.enqueue({ ...callbackFields.completionCallbackFields(meta, collectRunFailures(id, meta.cwd, true)), callback: true });
        await batcher.flush();
        batcher.cancel();
    }
    await deliverCompletion("success", seeded.success.id);
    await deliverCompletion("failed", seeded.failed.id);
    await deliverCompletion("incomplete", seeded.incomplete.id);

    const cases = [];
    const credentialFindings = [];

    async function measureResult(spec, tool, params) {
        const result = await tool.execute("issue-312-baseline", params, undefined, undefined, ctx);
        spec.tui = compactTui(tool, result);
        pushCase(cases, credentialFindings, spec, textOf(result));
        return result;
    }

    await measureResult({
        id: "subagent.success.result",
        family: "success",
        surface: "subagent_result",
        tool: "subagent_result",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentResultTool.execute",
        params: { id: seeded.success.id },
        proposedBudgetBytes: budgetsFor(phase).subagent_result,
    }, subagent.result, { id: seeded.success.id });

    await measureResult({
        id: "subagent.success.output",
        family: "success",
        surface: "subagent_output",
        tool: "subagent_output",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentOutputTool.execute",
        params: { id: seeded.success.id },
        proposedBudgetBytes: budgetsFor(phase).log_excerpt,
    }, subagent.output, { id: seeded.success.id });

    pushCase(cases, credentialFindings, {
        id: "subagent.success.callback",
        family: "success",
        surface: "callback",
        tool: "createCallbackBatcher.flush",
        invokePath: "packages/pi-better-subagents/callback-fields.ts#completionCallbackFields -> packages/callback-batcher/index.ts#createCallbackBatcher.flush",
        params: { id: seeded.success.id, exitCode: 0 },
        proposedBudgetBytes: budgetsFor(phase).callback_batch,
    }, callbacks.success?.content ?? "");

    await measureResult({
        id: "subagent.failed.result",
        family: "failed",
        surface: "subagent_result",
        tool: "subagent_result",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentResultTool.execute",
        params: { id: seeded.failed.id },
        proposedBudgetBytes: budgetsFor(phase).subagent_result,
    }, subagent.result, { id: seeded.failed.id });

    pushCase(cases, credentialFindings, {
        id: "subagent.failed.callback",
        family: "failed",
        surface: "callback",
        tool: "createCallbackBatcher.flush",
        invokePath: "packages/pi-better-subagents/callback-fields.ts#completionCallbackFields -> packages/callback-batcher/index.ts#createCallbackBatcher.flush",
        params: { id: seeded.failed.id, exitCode: 1 },
        proposedBudgetBytes: budgetsFor(phase).callback_batch,
    }, callbacks.failed?.content ?? "");

    await measureResult({
        id: "subagent.incomplete.result",
        family: "incomplete",
        surface: "subagent_result",
        tool: "subagent_result",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentResultTool.execute",
        params: { id: seeded.incomplete.id },
        proposedBudgetBytes: budgetsFor(phase).subagent_result,
    }, subagent.result, { id: seeded.incomplete.id });

    pushCase(cases, credentialFindings, {
        id: "subagent.incomplete.callback",
        family: "incomplete",
        surface: "callback",
        tool: "createCallbackBatcher.flush",
        invokePath: "packages/pi-better-subagents/callback-fields.ts#completionCallbackFields -> packages/callback-batcher/index.ts#createCallbackBatcher.flush",
        params: { id: seeded.incomplete.id, exitCode: 0 },
        proposedBudgetBytes: budgetsFor(phase).callback_batch,
    }, callbacks.incomplete?.content ?? "");

    await measureResult({
        id: "subagent.orphaned.result",
        family: "orphaned",
        surface: "subagent_result",
        tool: "subagent_result",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentResultTool.execute",
        params: { id: seeded.orphaned.id },
        proposedBudgetBytes: budgetsFor(phase).subagent_result,
    }, subagent.result, { id: seeded.orphaned.id });

    let orphanedCallback = "";
    {
        const meta = subagentRegistry.readMeta(seeded.orphaned.id);
        const delivery = buildHealthCallbackDelivery({ id: meta.id, label: callbackFields.runLabel(meta), status: "orphaned", callback: true });
        const host = { sendMessage(message) { orphanedCallback = message.content; } };
        const batcher = createCallbackBatcher(host, { windowMs: 60_000, retryMs: 60_000 });
        await batcher.deliverUrgent(callbackFields.healthCallbackFields(meta, "orphaned", collectRunFailures(meta.id, meta.cwd, false), delivery.content));
        batcher.cancel();
    }
    pushCase(cases, credentialFindings, {
        id: "subagent.orphaned.callback",
        family: "orphaned",
        surface: "callback",
        tool: "createCallbackBatcher.deliverUrgent",
        invokePath: "packages/pi-better-subagents/callback-fields.ts#healthCallbackFields -> packages/callback-batcher/index.ts#createCallbackBatcher.deliverUrgent",
        params: { id: seeded.orphaned.id, status: "orphaned" },
        proposedBudgetBytes: budgetsFor(phase).callback_batch,
    }, orphanedCallback);

    await measureResult({
        id: "subagent.unicode.result",
        family: "unicode-long-line-json",
        surface: "subagent_result",
        tool: "subagent_result",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentResultTool.execute",
        params: { id: seeded.unicode.id },
        proposedBudgetBytes: budgetsFor(phase).subagent_result,
        facts: { seededUnicodeJsonUtf8Bytes: utf8Bytes(fixtures.UNICODE_JSON_LINE) },
    }, subagent.result, { id: seeded.unicode.id });

    await measureResult({
        id: "subagent.many_failures.result",
        family: "many-failures",
        surface: "subagent_result",
        tool: "subagent_result",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentResultTool.execute",
        params: { id: seeded.manyFailures.id },
        proposedBudgetBytes: budgetsFor(phase).subagent_result,
    }, subagent.result, { id: seeded.manyFailures.id });

    await measureResult({
        id: "subagent.list",
        family: "many-failures",
        surface: "subagent_list",
        tool: "subagent_list",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentListTool.execute",
        params: { limit: 10 },
        proposedBudgetBytes: budgetsFor(phase).list_page,
    }, subagent.list, { limit: 10 });

    const foreignResult = await subagent.result.execute("issue-312-baseline", { id: seeded.foreign.id }, undefined, undefined, ctx);
    pushCase(cases, credentialFindings, {
        id: "subagent.foreign.result",
        family: "success",
        surface: "subagent_result",
        tool: "subagent_result",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentResultTool.execute",
        params: { id: seeded.foreign.id },
        proposedBudgetBytes: budgetsFor(phase).subagent_result,
        facts: {
            ownershipGap: /foreign session/i.test(textOf(foreignResult)),
            leakedForeignAnswer: textOf(foreignResult).includes("foreign-session secret answer"),
        },
    }, textOf(foreignResult));

    const unavailableResult = await subagentUnavailable.result.execute("issue-312-baseline", { id: seeded.success.id }, undefined, undefined, ctx);
    pushCase(cases, credentialFindings, {
        id: "subagent.ownership.unavailable",
        family: "success",
        surface: "subagent_result",
        tool: "subagent_result",
        invokePath: "packages/pi-better-subagents/tools.ts#subagentResultTool.execute",
        params: { id: seeded.success.id, session: "unavailable" },
        proposedBudgetBytes: budgetsFor(phase).subagent_result,
        facts: {
            ownershipGap: /ownership unavailable/i.test(textOf(unavailableResult)),
            leakedEvidence: textOf(unavailableResult).includes("review complete"),
        },
    }, textOf(unavailableResult));

    await measureResult({
        id: "background.success.status",
        family: "success",
        surface: "bg_task_status",
        tool: "bg_task_status",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { id: seeded.bgSuccess.id },
        proposedBudgetBytes: budgetsFor(phase).background_status,
    }, bgRegistered.bg_task_status, { id: seeded.bgSuccess.id });

    const wrapperStatus = await bgRegistered.bg_status.execute(
        "issue-312-baseline",
        { action: "status", id: seeded.bgSuccess.id },
        undefined,
        undefined,
        ctx,
    );
    const standaloneStatus = textOf(await bgRegistered.bg_task_status.execute("issue-312-baseline", { id: seeded.bgSuccess.id }, undefined, undefined, ctx));
    pushCase(cases, credentialFindings, {
        id: "background.success.status.wrapper",
        family: "success",
        surface: "bg_status",
        tool: "bg_status",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#bg_status.execute",
        params: { action: "status", id: seeded.bgSuccess.id },
        proposedBudgetBytes: budgetsFor(phase).background_status,
        facts: { wrapperMatchesStandalone: textOf(wrapperStatus) === standaloneStatus },
        tui: compactTui(bgRegistered.bg_status, wrapperStatus),
    }, textOf(wrapperStatus));

    await measureResult({
        id: "background.success.log",
        family: "success",
        surface: "bg_task_log",
        tool: "bg_task_log",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { id: seeded.bgSuccess.id },
        proposedBudgetBytes: budgetsFor(phase).log_excerpt,
    }, bgRegistered.bg_task_log, { id: seeded.bgSuccess.id });

    await measureResult({
        id: "background.failed.status",
        family: "failed",
        surface: "bg_task_status",
        tool: "bg_task_status",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { id: seeded.bgFailed.id },
        proposedBudgetBytes: budgetsFor(phase).background_status,
    }, bgRegistered.bg_task_status, { id: seeded.bgFailed.id });

    await measureResult({
        id: "background.repeated_poll.status",
        family: "repeated-poll",
        surface: "bg_task_status",
        tool: "bg_task_status",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { id: seeded.bgRepeated.id },
        proposedBudgetBytes: budgetsFor(phase).background_status,
        facts: {
            seededPollCount: seeded.bgRepeated.pollCount,
            seededDistinctStdout: seeded.bgRepeated.distinctStdout,
        },
    }, bgRegistered.bg_task_status, { id: seeded.bgRepeated.id });

    await measureResult({
        id: "background.repeated_poll.log.default",
        family: "repeated-poll",
        surface: "bg_task_log",
        tool: "bg_task_log",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { id: seeded.bgRepeated.id },
        proposedBudgetBytes: budgetsFor(phase).log_excerpt,
        facts: { seededPollCount: seeded.bgRepeated.pollCount },
    }, bgRegistered.bg_task_log, { id: seeded.bgRepeated.id });

    await measureResult({
        id: "background.repeated_poll.log.full",
        family: "repeated-poll",
        surface: "bg_task_log",
        tool: "bg_task_log",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { id: seeded.bgRepeated.id, tail_lines: 0 },
        proposedBudgetBytes: budgetsFor(phase).raw_evidence,
        facts: { seededPollCount: seeded.bgRepeated.pollCount },
    }, bgRegistered.bg_task_log, { id: seeded.bgRepeated.id, tail_lines: 0 });

    await measureResult({
        id: "background.unicode.status",
        family: "unicode-long-line-json",
        surface: "bg_task_status",
        tool: "bg_task_status",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { id: seeded.bgUnicode.id },
        proposedBudgetBytes: budgetsFor(phase).background_status,
        facts: { seededUnicodeJsonUtf8Bytes: utf8Bytes(fixtures.UNICODE_JSON_LINE) },
    }, bgRegistered.bg_task_status, { id: seeded.bgUnicode.id });

    await measureResult({
        id: "background.unicode.log",
        family: "unicode-long-line-json",
        surface: "bg_task_log",
        tool: "bg_task_log",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { id: seeded.bgUnicode.id, tail_lines: 0 },
        proposedBudgetBytes: budgetsFor(phase).raw_evidence,
        facts: { seededUnicodeJsonUtf8Bytes: utf8Bytes(fixtures.UNICODE_JSON_LINE) },
    }, bgRegistered.bg_task_log, { id: seeded.bgUnicode.id, tail_lines: 0 });

    await measureResult({
        id: "background.many_failures.status",
        family: "many-failures",
        surface: "bg_task_status",
        tool: "bg_task_status",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { id: seeded.bgManyFailures.id },
        proposedBudgetBytes: budgetsFor(phase).background_status,
    }, bgRegistered.bg_task_status, { id: seeded.bgManyFailures.id });

    await measureResult({
        id: "background.many_failures.list",
        family: "many-failures",
        surface: "bg_task_list",
        tool: "bg_task_list",
        invokePath: "packages/pi-better-background-tasks/src/tools.ts#registerTools.execute",
        params: { limit: 20 },
        proposedBudgetBytes: budgetsFor(phase).list_page,
    }, bgRegistered.bg_task_list, { limit: 20 });

    const batchHost = { sendMessage(message, options) { batchHost.last = { message, options }; } };
    const batcher = createCallbackBatcher(batchHost, { windowMs: 60_000, retryMs: 60_000 });
    for (let i = 0; i < 50; i += 1) {
        const background = i % 5 === 0;
        batcher.enqueue({
            source: background ? "background-task" : "subagent",
            id: `${background ? "bg" : "sa"}_issue312_complete_${String(i).padStart(2, "0")}`,
            label: `synthetic-${i} ${"文".repeat(40)} (${fixtures.SYNTHETIC_MARKER})`,
            status: i % 7 === 0 ? "failed" : "completed",
            detailTool: background ? "bg_task_status" : "subagent_result",
            callback: true,
        });
    }
    await batcher.flush();
    batcher.cancel();
    pushCase(cases, credentialFindings, {
        id: "callback.many_completions.batch",
        family: "many-completions",
        surface: "callback-batch",
        tool: "createCallbackBatcher.sendMessage",
        invokePath: "packages/callback-batcher/index.ts#createCallbackBatcher.flush",
        params: { eventCount: 50 },
        proposedBudgetBytes: budgetsFor(phase).callback_batch,
        facts: {
            batchedEventCount: 50,
            sendMessageCustomType: batchHost.last?.message?.customType ?? null,
        },
    }, batchHost.last?.message?.content ?? "");

    if (phase === "after") {
        const unicodeCase = cases.find((item) => item.id === "subagent.unicode.result");
        if (unicodeCase) {
            let cursor;
            let rebuilt = "";
            let pages = 0;
            for (let i = 0; i < 64; i += 1) {
                const page = textOf(await subagent.result.execute("issue-312-baseline", { id: seeded.unicode.id, cursor }, undefined, undefined, ctx));
                pages += 1;
                const body = page.split("\n---\n")[0] ?? page;
                rebuilt += body.slice(body.indexOf("\n") + 1);
                const next = nextCursorOf(page);
                if (!next || !page.includes("hasMore=true")) break;
                cursor = next;
            }
            unicodeCase.facts.reconstructedExactly = rebuilt === seeded.unicode.finalText;
            unicodeCase.facts.reconstructionPages = pages;
        }
        const many = cases.find((item) => item.id === "subagent.many_failures.result");
        if (many) {
            const cursor = incidentCursorOf(many.content);
            many.facts.incidentCursorPresent = Boolean(cursor);
            if (cursor) {
                const seen = new Map();
                const count = (text) => {
                    for (const match of text.matchAll(/failure (\d+): synthetic-op-/g)) seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
                };
                count(many.content);
                let next = cursor;
                for (let i = 0; i < 32 && next; i += 1) {
                    const page = textOf(await subagent.result.execute("issue-312-baseline", { id: seeded.manyFailures.id, cursor: next }, undefined, undefined, ctx));
                    count(page);
                    next = page.includes("hasMore=true") ? page.match(/\bnextCursor=(i1\.\S+)/)?.[1] : undefined;
                }
                many.facts.omittedIncidentsRetrievable = seen.size === 12 && [...seen.values()].every((value) => value === 1);
            }
        }
        const wrapper = cases.find((item) => item.id === "background.success.status.wrapper");
        if (wrapper) {
            wrapper.facts.wrapperMatchesStandalone = wrapper.facts.wrapperMatchesStandalone === true;
        }
    }

    const missing = fixtures.REQUIRED_FAMILIES.filter((family) => !cases.some((item) => item.family === family));
    if (missing.length) {
        throw new Error(`Harness did not measure required families: ${missing.join(", ")}`);
    }
    if (credentialFindings.length) {
        throw new Error(`Synthetic payloads contained credential-like strings: ${JSON.stringify(credentialFindings)}`);
    }

    return {
        phase,
        frozenNow: FROZEN_NOW,
        accounting: "utf8-bytes",
        proposedBudgetsBytes: budgetsFor(phase),
        policyBudgetsBytes: POLICY_BUDGETS_BYTES,
        registeredTools: {
            subagent: ["subagent_list", "subagent_output", "subagent_result"],
            background: Object.keys(bgRegistered).sort(),
        },
        cases,
        limitations: LIMITATIONS,
    };
}

export const LIMITATIONS = [
    "Accounting is UTF-8 bytes via Buffer.byteLength, plus JS UTF-16 code-unit length. Tokenizer counts are not measured.",
    "Payloads come from registered tool execute() / finalizeRun sendMessage / callback-batcher sendMessage. TUI renderResult is recorded only to show display folding is not the model-facing budget.",
    "Seeds are synthetic NDJSON / watch logs and failure journals. No live model child and no real credentials. Historical issue samples are not this checkout.",
    "Date.now is frozen for deterministic elapsed/status text. Production elapsed is live.",
    "BEFORE comparison uses the issue #312 discussion table. AFTER comparison uses OUTPUT-POLICY defaults (status/log/list 1 KiB, answer/callback 2 KiB, raw 16 KiB).",
    "Background status/log strings embed absolute registry paths. utf8Bytes includes that host prefix; facts.utf8BytesExcludingIsolatedTmpdir substitutes $TMPDIR so AFTER comparisons can ignore path-length drift.",
    "Session tools are wired with getActiveOrigin. Default list/status/result are current-session. Foreign and unavailable ownership are measured as gaps, not masked with all:true.",
    "Raw retained evidence is pageable from the oldest retained offset. Capture/retention loss is disclosed and is not recoverable as full history.",
    "Process stdout/stderr 1 MiB capture overflow is not exercised here (needs a live command); product tests cover capture counters.",
    "verbose:true status remains an explicit recovery hatch and is not the default compact payload.",
];

export function serializeReport(report, { git, measuredAt, model } = {}) {
    return {
        phase: report.phase,
        measuredAt,
        git,
        model,
        accounting: report.accounting,
        frozenNow: report.frozenNow,
        proposedBudgetsBytes: report.proposedBudgetsBytes,
        policyBudgetsBytes: report.policyBudgetsBytes,
        registeredTools: report.registeredTools,
        limitations: report.limitations,
        cases: report.cases.map((item) => {
            const { content, ...rest } = item;
            return rest;
        }),
        totals: {
            caseCount: report.cases.length,
            families: [...new Set(report.cases.map((item) => item.family))],
            utf8BytesByFamily: Object.fromEntries(
                [...new Set(report.cases.map((item) => item.family))].map((family) => [
                    family,
                    report.cases.filter((item) => item.family === family)
                        .reduce((sum, item) => sum + item.utf8Bytes, 0),
                ]),
            ),
        },
    };
}

export function renderMarkdown(serializable) {
    const rows = serializable.cases.map((item) => {
        const budget = item.facts.proposedBudgetBytes;
        const over = item.facts.exceedsProposedBudget == null
            ? "n/a"
            : item.facts.exceedsProposedBudget
                ? "yes"
                : "no";
        const tools = item.facts.orderedToolSequence ? "yes" : "no";
        return `| \`${item.id}\` | ${item.family} | ${item.tool} | ${item.utf8Bytes} | ${item.facts.utf16CodeUnits} | ${item.facts.longestLineUtf8Bytes} | ${over}${budget ? ` / ${budget}` : ""} | ${tools} |`;
    });
    return `# Issue #312 model-facing payload baseline (${serializable.phase})

Measured at ${serializable.measuredAt} from ${serializable.git?.branch ?? "?"} @ \`${serializable.git?.sha ?? "?"}\`.
Accounting: **UTF-8 bytes** (\`Buffer.byteLength(text, "utf8")\`). Tokenizer counts are not included.

Runtime model for this capture session: \`${serializable.model?.id ?? "?"}\` effort \`${serializable.model?.effort ?? "?"}\`.
No model calls were made to seed the payloads.

## How to rerun

\`\`\`bash
node --import tsx scripts/issue-312-payload-baseline.mjs --phase ${serializable.phase} \\
  --json-out docs/issue-312-payload-baseline${serializable.phase === "after" ? "-after" : ""}.json \\
  --md-out docs/issue-312-payload-baseline${serializable.phase === "after" ? "-after" : ""}.md
\`\`\`

${serializable.phase === "after"
        ? "This AFTER capture measures the shipped OUTPUT-POLICY defaults. Compare it with the BEFORE file (`--phase before`) on `utf8Bytes`, `facts.containsOrderedToolSequence`, longest-line bytes, and whether budgets are exceeded."
        : "This BEFORE capture records pre-#312 behavior. Rerun with `--phase after` to measure the shipped defaults. Do not treat this BEFORE file as a regression pin that blesses over-budget or tool-history behavior."}

## ${serializable.phase === "after" ? "OUTPUT-POLICY default budgets (enforced by the tools)" : "Proposed budgets (issue discussion, not enforced)"}

| Surface | ${serializable.phase === "after" ? "Default" : "Proposed"} UTF-8 budget |
|---|---:|
${Object.entries(serializable.proposedBudgetsBytes).map(([name, bytes]) => `| ${name} | ${bytes} |`).join("\n")}

## Cases

| id | family | tool | UTF-8 bytes | UTF-16 units | longest line (UTF-8) | exceeds budget | ordered tool sequence |
|---|---|---|---:|---:|---:|---|---|
${rows.join("\n")}

## Facts worth carrying into AFTER

These are observations about the current producer, not blessed behavior.

${serializable.cases.map((item) => {
    const notes = [];
    if (item.facts.containsOrderedToolSequence) notes.push(`ordered tool sequence: \`${item.facts.orderedToolSequence}\``);
    if (item.facts.containsToolsUsedHeader) notes.push("`tools used:` header present");
    if (item.facts.exceedsProposedBudget) notes.push(`exceeds budget ${item.facts.proposedBudgetBytes} B (${item.utf8Bytes} B)`);
    if (item.facts.additionalActiveFailuresRetained) notes.push(`${item.facts.additionalActiveFailuresRetained} additional failure observations retained beyond the 5-row summary`);
    if (item.facts.containsObservationIncomplete) notes.push("contains Observation incomplete");
    if (item.id === "background.failed.status") {
        notes.push(`matched-condition path present: ${item.facts.containsMatchedConditionPath}`);
        notes.push(`compact "Condition matched:" line present: ${item.facts.compactStatusShowsMatchedCondition}`);
        notes.push("compact result field currently shows `failure_when`");
    }
    if (item.facts.wrapperMatchesStandalone != null) notes.push(`wrapper matches standalone: ${item.facts.wrapperMatchesStandalone}`);
    if (item.facts.tuiFoldsDisplayOnly) notes.push(`TUI compact ${item.facts.tuiCompactUtf8Bytes} B vs model ${item.utf8Bytes} B`);
    if (item.facts.utf8GreaterThanUtf16 && item.family === "unicode-long-line-json") notes.push(`UTF-8 ${item.utf8Bytes} B > UTF-16 ${item.facts.utf16CodeUnits}`);
    if (item.facts.longestLineUtf8Bytes >= 2048) notes.push(`longest line ${item.facts.longestLineUtf8Bytes} B`);
    if (!notes.length) return null;
    return `- \`${item.id}\`: ${notes.join("; ")}`;
}).filter(Boolean).join("\n")}

## Limitations

${serializable.limitations.map((line) => `- ${line}`).join("\n")}

## Integration usage

The AFTER validation unit should import \`collectBaseline\` from \`scripts/issue-312-payload-baseline/run.mjs\` (after isolating TMPDIR via \`isolateHarnessEnv\`) or exec this CLI. Compare by case id. A drop in UTF-8 bytes, disappearance of ordered tool sequences from ordinary results, and explicit omission/continuation metadata are the intended deltas — not a frozen hash of this BEFORE capture.
`;
}
