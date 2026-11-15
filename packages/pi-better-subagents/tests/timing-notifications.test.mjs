import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTimingWake, MAX_PENDING_TIMING_WAKES, receiptTimingWake, timingWakeReceipt, removeTimingReceipt } from '../timing-notifications.ts';

test('unavailable recipient retains bounded detailed notices and an explicit overflow summary', () => {
    let pending = [];
    for (let i = 0; i < 10000; i++) pending = appendTimingWake(pending, { kind: 'tool-wait', key: `tool-wait:${i}`, content: `call ${i}` });
    assert.equal(pending.length, MAX_PENDING_TIMING_WAKES + 1);
    assert.equal(pending[0].key, 'tool-wait:0');
    assert.equal(pending.at(-1).key, 'timing-overflow');
    assert.match(pending.at(-1).content, /Additional timing notifications/);
    assert.equal(appendTimingWake(pending, pending[0]), pending);
});

test('recipient receipt is durable, idempotent and scoped to the exact run and event key', () => {
    const id = 'sa_timing_receipt_1';
    assert.equal(timingWakeReceipt(id, 'deadline'), undefined);
    receiptTimingWake(id, 'deadline', 123);
    receiptTimingWake(id, 'deadline', 456);
    assert.equal(timingWakeReceipt(id, 'deadline'), 123);
    assert.equal(timingWakeReceipt(id, 'stuck:123'), undefined);
    assert.equal(timingWakeReceipt('sa_other_receipt_1', 'deadline'), undefined);
    removeTimingReceipt(id, 'deadline');
    assert.equal(timingWakeReceipt(id, 'deadline'), undefined);
});
