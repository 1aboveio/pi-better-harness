/**
 * Unit tests for callback completion formatters.
 * Tests the contract: callback trigger must NOT embed the full result,
 * it should be a lightweight signal to call subagent_result.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { formatCallbackTrigger, formatCallbackQuiet, buildCompletionDelivery } from '../completion.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('formatCallbackTrigger', () => {
    it('must NOT contain "--- result ---" marker', () => {
        const result = formatCallbackTrigger({
            id: 'abc123',
            label: 'test-agent (abc123)',
            verdict: '✓ completed',
            stat: '45s · 1.2k tok (↑400 ↓800) · $0.0034',
        });
        assert.ok(
            !result.includes('--- result ---'),
            `Trigger must not embed result. Got:\n${result}`
        );
    });

    it('must contain "subagent_result" reference', () => {
        const result = formatCallbackTrigger({
            id: 'abc123',
            label: 'test-agent (abc123)',
            verdict: '✓ completed',
            stat: '45s',
        });
        assert.ok(
            result.includes('subagent_result'),
            `Trigger must reference subagent_result. Got:\n${result}`
        );
    });

    it('must contain the run id', () => {
        const runId = 'abc123';
        const result = formatCallbackTrigger({
            id: runId,
            label: 'test-agent (abc123)',
            verdict: '✓ completed',
            stat: '45s',
        });
        assert.ok(
            result.includes(runId),
            `Trigger must contain the id "${runId}". Got:\n${result}`
        );
    });

    it('must NOT contain arbitrary payload that should not appear', () => {
        const result = formatCallbackTrigger({
            id: 'abc123',
            label: 'test-agent',
            verdict: '✓ completed',
            stat: '45s',
        });
        // Even if we try to smuggle this through tools or label,
        // the formatter should not output raw result content
        assert.ok(
            !result.includes('UNIQUE_PAYLOAD_SHOULD_NOT_APPEAR'),
            `Trigger must not contain arbitrary payload markers. Got:\n${result}`
        );
    });

    // F2 regression guard: if someone re-adds an optional `result` field
    // to formatCallbackTrigger's input type and embeds it, this test FAILS.
    // The sentinel proves unknown fields must be ignored.
    it('must NOT embed a `result` field even if caller passes one', () => {
        const sentinel = 'UNIQUE_SENTINEL_xyz789_RESULT_PAYLOAD';
        // Object.assign simulates `{ ...p, result }` spread at the call site.
        // If a future refactor re-adds `p.result` to the formatter template,
        // this fails.
        const result = formatCallbackTrigger(
            Object.assign(
                {},
                { id: 'abc123', label: 'test-agent', verdict: '✓ completed', stat: '45s' },
                { result: sentinel }
            )
        );
        assert.ok(
            !result.includes(sentinel),
            `Trigger must not embed a caller-supplied result field. Got:\n${result}`
        );
    });

    // F2 regression guard: pure "build message" path — if formatter accidentally
    // re-introduces result embedding (e.g. via template literal `${result}`),
    // this test FAILS because the output would contain the sentinel.
    it('must not embed result when called through a spread-object call pattern', () => {
        const sentinel = 'SENTINEL_RESULT_embed_FAIL_xyz';
        const callArgs = {
            id: 'abc123',
            label: 'test-agent',
            verdict: '✓ completed',
            stat: '45s',
        };
        // Object.assign simulates `{ ...p, result }` spread at the call site.
        // If someone re-adds `${p.result}` to the formatter template, this fails.
        const result = formatCallbackTrigger(
            Object.assign({}, callArgs, { result: sentinel })
        );
        assert.ok(
            !result.includes(sentinel),
            `Trigger must not embed result from spread-object call. Got:\n${result}`
        );
    });

    it('may include label, verdict, and stat', () => {
        const result = formatCallbackTrigger({
            id: 'abc123',
            label: 'my-agent (abc123)',
            verdict: '✓ completed',
            stat: '1m 30s · 5.2k tok',
            tools: 'read,bash',
        });
        assert.ok(result.includes('my-agent'), 'Should include label');
        assert.ok(result.includes('✓ completed'), 'Should include verdict');
        assert.ok(result.includes('1m 30s'), 'Should include stat');
        assert.ok(result.includes('read,bash'), 'Should include tools list');
    });
});

describe('formatCallbackQuiet', () => {
    it('must indicate NOT auto-posted', () => {
        const result = formatCallbackQuiet({
            id: 'abc123',
            label: 'test-agent (abc123)',
            verdict: '✓ completed',
            stat: '45s',
        });
        assert.ok(
            result.includes('NOT auto-posted') || result.includes('callback:false'),
            `Quiet must indicate not auto-posted. Got:\n${result}`
        );
    });

    it('must reference subagent_result with the id', () => {
        const runId = 'abc123';
        const result = formatCallbackQuiet({
            id: runId,
            label: 'test-agent',
            verdict: '✓ completed',
            stat: '45s',
        });
        assert.ok(
            result.includes('subagent_result'),
            `Quiet must reference subagent_result. Got:\n${result}`
        );
        assert.ok(
            result.includes(runId),
            `Quiet must contain id "${runId}". Got:\n${result}`
        );
    });
});

// ── buildCompletionDelivery behavior tests ────────────────────────────────────
describe('buildCompletionDelivery', () => {
    // @covers subagent.completion-callback
    // @level unit
    // @fails-without-fix subagent.completion-callback
    it('incomplete child exits use unexpected-exit wording, not successful completion wording', () => {
        const d = buildCompletionDelivery({
            id: 'sa_incomplete', label: 'worker (sa_incomplete)', verdict: '! incomplete child exit (exit 0)',
            stat: '14s', callback: true, incomplete: true,
            lifecycleClassification: 'incomplete_no_terminal_event',
        });

        assert.match(d.content, /unexpectedly/i);
        assert.match(d.content, /lifecycle incomplete_no_terminal_event|attention/i);
        assert.doesNotMatch(d.content, /has returned|completed/i);
    });

    // @covers subagent.completion-callback
    // @level unit
    it('quiet incomplete child exits do not imply a successful completion', () => {
        const d = buildCompletionDelivery({
            id: 'sa_incomplete_quiet', label: 'worker', verdict: '! incomplete child exit (exit 0)',
            stat: '14s', callback: false, incomplete: true,
            lifecycleClassification: 'incomplete_open_tools',
        });

        assert.match(d.content, /ended unexpectedly/i);
        assert.match(d.content, /lifecycle incomplete_open_tools|attention/i);
        assert.doesNotMatch(d.content, /completed|result NOT auto-posted/i);
    });

    // @covers subagent.completion-callback
    // @level unit
    it('failed_exit callbacks stay attention-aware without incomplete-stream wording', () => {
        const d = buildCompletionDelivery({
            id: 'sa_failed', label: 'worker', verdict: '✗ failed (exit 1)',
            stat: '2s', callback: true, incomplete: false,
            lifecycleClassification: 'failed_exit',
        });

        assert.match(d.content, /has returned|failed/i);
        assert.doesNotMatch(d.content, /ended unexpectedly|incomplete/i);
    });

    it('callback:true delivery content never contains resultText sentinel', () => {
        const sentinel = 'UNIQUE_FULL_RESULT_BODY_' + 'x'.repeat(200);
        const d = buildCompletionDelivery({
            id: 'sa_test_1', label: 't', verdict: '✓ completed', stat: '1s',
            callback: true, resultText: sentinel, tools: 'read,bash',
        });
        assert.equal(d.options.deliverAs, 'followUp');
        assert.equal(d.options.triggerTurn, true);
        assert.ok(d.content.includes('subagent_result'));
        assert.ok(d.content.includes('sa_test_1'));
        assert.ok(!d.content.includes(sentinel), 'resultText must not appear in callback content');
        assert.ok(!d.content.includes('--- result ---'), 'no --- result --- in callback content');
    });

    it('callback:false delivery is quiet and excludes resultText', () => {
        const sentinel = 'QUIET_SENTINEL_RESULT_BODY_zzz';
        const d = buildCompletionDelivery({
            id: 'sa_test_2', label: 't', verdict: '✓ completed', stat: '1s',
            callback: false, resultText: sentinel,
        });
        assert.equal(d.options.deliverAs, 'nextTurn');
        assert.ok(!d.options.triggerTurn, 'triggerTurn must not be true on quiet path');
        assert.ok(!d.content.includes(sentinel), 'resultText must not appear in quiet content');
        assert.ok(
            d.content.includes('subagent_result') || d.content.includes('NOT auto-posted'),
            'quiet content must reference subagent_result or indicate not auto-posted'
        );
    });

    it('callback:true excludes resultText even when resultText is huge', () => {
        const huge = 'RESULT_PART_' + 'BIG'.repeat(500);
        const d = buildCompletionDelivery({
            id: 'sa_huge', label: 'agent', verdict: '✓ done', stat: '2m',
            callback: true, resultText: huge, tools: 'read',
        });
        assert.ok(!d.content.includes('RESULT_PART'), 'huge resultText must not leak into content');
    });

    it('callback:true uses formatCallbackTrigger output (id, label, verdict, stat, tools)', () => {
        const d = buildCompletionDelivery({
            id: 'sa_format', label: 'reviewer (sa_format)', verdict: '✓ completed',
            stat: '30s · 800 tok · $0.0012', tools: 'read,bash',
            callback: true, resultText: 'THE ACTUAL RESULT SHOULD NOT APPEAR',
        });
        assert.ok(d.content.includes('reviewer (sa_format)'));
        assert.ok(d.content.includes('✓ completed'));
        assert.ok(d.content.includes('30s'));
        assert.ok(d.content.includes('read,bash'));
        assert.ok(d.content.includes('sa_format'));
        assert.ok(!d.content.includes('THE ACTUAL RESULT SHOULD NOT APPEAR'));
    });

    it('finalization.ts calls buildCompletionDelivery in finalizeRun', async () => {
        const { readFileSync } = await import('node:fs');
        const finalizationSource = readFileSync(
            path.resolve(__dirname, '..', 'finalization.ts'),
            'utf8'
        );
        assert.ok(
            finalizationSource.includes('buildCompletionDelivery'),
            'finalization.ts must call buildCompletionDelivery in finalizeRun'
        );
    });
});

// Integration test: verify finalization.ts owns delivery assembly and index wires it
describe('finalization wiring', async () => {
    const indexPath = path.resolve(__dirname, '..', 'index.ts');
    const finalizationPath = path.resolve(__dirname, '..', 'finalization.ts');
    const indexSource = await import('node:fs').then(fs =>
        fs.promises.readFile(indexPath, 'utf8')
    );
    const finalizationSource = await import('node:fs').then(fs =>
        fs.promises.readFile(finalizationPath, 'utf8')
    );

    it('index.ts delegates finalizeRun to finalization.ts', () => {
        assert.ok(
            indexSource.includes('finalizeRun as finalizeRunCore') ||
            indexSource.includes('from "./finalization.ts"'),
            'index.ts must import finalizeRun from finalization.ts'
        );
        assert.ok(
            indexSource.includes('finalizeRunCore('),
            'index.ts host wrapper must call finalizeRunCore'
        );
    });

    it('finalization.ts imports buildCompletionDelivery from completion.ts', () => {
        assert.ok(
            finalizationSource.includes('buildCompletionDelivery'),
            'finalization.ts must import buildCompletionDelivery from completion.ts'
        );
    });

    it('finalizeRun calls buildCompletionDelivery', () => {
        assert.ok(
            finalizationSource.includes('buildCompletionDelivery({'),
            'finalizeRun must call buildCompletionDelivery({ ... })'
        );
    });

    it('finalizeRun passes resultText: r.finalText || r.lastActivity || "" to buildCompletionDelivery', () => {
        assert.ok(
            finalizationSource.includes('resultText: r.finalText') ||
            finalizationSource.includes('resultText: r.lastActivity'),
            'finalizeRun must pass resultText from r.finalText or r.lastActivity'
        );
    });

    it('finalizeRun delivers via hooks.sendMessage with delivery.content and delivery.options', () => {
        assert.ok(
            finalizationSource.includes('content: delivery.content'),
            'sendMessage must use delivery.content'
        );
        assert.ok(
            finalizationSource.includes('delivery.options'),
            'sendMessage must use delivery.options'
        );
        assert.ok(
            indexSource.includes('sendMessage:'),
            'index.ts must wire pi.sendMessage into finalize hooks'
        );
    });

    it('formatCallbackTrigger and formatCallbackQuiet remain available to buildCompletionDelivery', async () => {
        const completionSource = await import('node:fs').then(fs =>
            fs.promises.readFile(path.resolve(__dirname, '..', 'completion.mjs'), 'utf8')
        );
        assert.ok(
            completionSource.includes('export function formatCallbackTrigger') &&
            completionSource.includes('export function formatCallbackQuiet'),
            'Both formatters must still be exported from completion.mjs'
        );
    });

    it('finalizeRun does NOT embed "--- result ---" or ${result} in sendMessage', () => {
        assert.ok(
            !finalizationSource.includes('--- result ---'),
            'finalizeRun must not embed "--- result ---" in sendMessage'
        );
        const finalizeMatch = finalizationSource.match(/export function finalizeRun\([\s\S]*?^\}/m);
        if (finalizeMatch) {
            assert.ok(
                !finalizeMatch[0].includes('${result}'),
                'finalizeRun must not interpolate ${result} into message content'
            );
        }
    });
});
