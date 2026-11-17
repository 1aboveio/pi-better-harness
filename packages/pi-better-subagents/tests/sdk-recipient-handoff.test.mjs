import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRecipientSend } from './sdk-recipient-fixture.mjs';
import { createCallbackBatcher } from '../../callback-batcher/index.ts';

test('recipient preflight waits for an asynchronous rejection before deciding delivery', async () => {
    const decisions = [];
    let reject;
    const handoff = new Promise((_resolve, fail) => { reject = fail; });
    // Observe the refusal even on the broken adapter, which drops this promise.
    handoff.catch(() => {});
    const pending = decideRecipientSend({ send: decision => decisions.push(decision) },
        { id: 1, message: {}, options: {} }, () => handoff);
    assert.equal(decisions.length, 0, 'unsettled handoff must not approve delivery');
    reject(new Error('simulated host delivery failure'));
    await pending;
    assert.equal(decisions.length, 1);
    assert.match(decisions[0].error, /simulated host delivery failure/);
});

test('rejected urgent health handoffs remain unreceipted until reload recovery succeeds once', async () => {
    let unavailable = true;
    let attempts = 0;
    const sent = [], decisions = [];
    let marker;
    const host = { sendMessage(message, options) {
        return new Promise((resolve, reject) => {
            void decideRecipientSend({ send(decision) {
                decisions.push(decision);
                if (decision.error) reject(new Error(decision.error));
                else { sent.push({ message, options }); resolve(); }
            } }, { id: ++attempts, message, options }, async () => {
                if (unavailable) throw new Error('simulated host delivery failure');
            });
        });
    } };
    const event = { source: 'subagent', id: 'lost-attempt', status: 'lost', customType: 'subagent-health',
        label: 'lost-attempt', content: 'ATTENTION: no related process remains',
        isDelivered: () => marker !== undefined, onDelivered: at => { marker = at; } };
    const first = createCallbackBatcher(host);
    try {
        assert.equal(await first.deliverUrgent(event), false);
        // A second observation before the failed-checkpoint poll is a valid retry.
        assert.equal(await first.deliverUrgent(event), false);
        assert.equal(sent.length, 0, 'failed handoff must not count as delivered');
        assert.equal(marker, undefined, 'a rejection cannot write the delivery marker');
        // Reload cannot discard an unresolved delivery obligation either.
        const stillUnavailable = createCallbackBatcher(host);
        try {
            assert.equal(await stillUnavailable.deliverUrgent(event), false);
            assert.equal(sent.length, 0);
            assert.equal(marker, undefined);
        } finally { stillUnavailable.cancel(); }
        first.cancel();
        unavailable = false;
        const reloaded = createCallbackBatcher(host);
        try {
            assert.equal(await reloaded.deliverUrgent(event), true);
            assert.equal(await reloaded.deliverUrgent(event), true);
            assert.equal(sent.length, 1, 'exactly one successful recovery callback');
            assert.ok(marker > 0);
            assert.equal(decisions.filter(decision => decision.error).length, 3);
        } finally { reloaded.cancel(); }
    } finally { first.cancel(); }
});

test('one-shot refusal permits a successful ordinary retry before a reload checkpoint', async () => {
    let failNext = true;
    let delivered = 0;
    const sent = [];
    const batcher = createCallbackBatcher({ sendMessage(message, options) {
        if (failNext) { failNext = false; throw new Error('simulated host delivery failure'); }
        sent.push({ message, options });
    } });
    const event = { source: 'subagent', id: 'lost-attempt', status: 'lost', customType: 'subagent-health',
        label: 'lost-attempt', content: 'ATTENTION: no related process remains', onDelivered: () => { delivered++; } };
    try {
        assert.equal(await batcher.deliverUrgent(event), false);
        assert.equal(failNext, false, 'the original poll predicate is already true');
        assert.equal(delivered, 0);
        assert.equal(await batcher.deliverUrgent(event), true, 'a new observation may retry without waiting for reload');
        assert.equal(sent.length, 1, 'a successful retry can precede the original zero-delivery assertion');
        assert.equal(delivered, 1);
    } finally { batcher.cancel(); }
});
