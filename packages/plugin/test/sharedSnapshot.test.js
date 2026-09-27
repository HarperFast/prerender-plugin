import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedSnapshot, snapshotBufferBytes } from '../src/util/sharedSnapshot.js';

/**
 * The shared JSON snapshot, against a plain ArrayBuffer.
 *
 *   - A READER NEVER GETS HALF A DOCUMENT: the writer fills the inactive slot and flips, and a
 *     document too large for a slot is refused, not truncated.
 *   - BEFORE THE FIRST WRITE THERE IS NOTHING, not an empty object a caller could mistake for an
 *     empty queue.
 */

const snapshot = (slotBytes = 1024) =>
	createSharedSnapshot({ buffer: new ArrayBuffer(snapshotBufferBytes(slotBytes)) });

test('reads null before anything is written', () => {
	assert.equal(snapshot().read(), null);
});

test('round-trips a document, and each write replaces the last', () => {
	const s = snapshot();
	assert.deepEqual(s.write({ a: 1 }), { ok: true, bytes: 7 });
	assert.deepEqual(s.read(), { a: 1 });
	s.write({ a: 2, list: [1, 2, 3] });
	assert.deepEqual(s.read(), { a: 2, list: [1, 2, 3] });
	s.write({ a: 3 });
	assert.deepEqual(s.read(), { a: 3 });
	assert.equal(s.generation, 3);
});

test('a document larger than a slot is refused and the previous one stays readable', () => {
	const s = snapshot(64);
	s.write({ ok: true });
	const result = s.write({ big: 'x'.repeat(200) });
	assert.equal(result.ok, false);
	assert.ok(result.bytes > 64);
	assert.deepEqual(s.read(), { ok: true });
});

test('two views of one buffer see the same document, as two workers would', () => {
	const buffer = new ArrayBuffer(snapshotBufferBytes(256));
	const writer = createSharedSnapshot({ buffer });
	const reader = createSharedSnapshot({ buffer });
	writer.write({ node: 'a', due: 5 });
	assert.deepEqual(reader.read(), { node: 'a', due: 5 });
});
