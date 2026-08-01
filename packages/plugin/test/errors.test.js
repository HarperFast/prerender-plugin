import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from '../src/util/errors.js';

test('a plain Error is just its message', () => {
	assert.equal(describeError(new Error('boom')), 'boom');
});

test('the cause chain is appended — the undici "fetch failed" case', () => {
	// This is the whole reason the helper exists. Every network failure in this plugin surfaces
	// as the word "fetch failed", with the actual diagnosis one level down. A smoke test against
	// a live Harper produced exactly this and the bare message identified nothing.
	const cause = Object.assign(new Error('invalid onRequestStart method'), { code: 'UND_ERR_INVALID_ARG' });
	const error = Object.assign(new Error('fetch failed'), { cause });

	assert.equal(describeError(error), 'fetch failed: invalid onRequestStart method (UND_ERR_INVALID_ARG)');
});

test('a code is included when present', () => {
	assert.equal(
		describeError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
		'connect ECONNREFUSED (ECONNREFUSED)'
	);
});

test('AggregateError.errors is unwrapped — the dual-stack connect failure', () => {
	// A refused connection to a host resolving to both A and AAAA arrives this way, and the
	// outer message is empty, so without unwrapping the log line says nothing at all.
	const error = new AggregateError(
		[Object.assign(new Error('connect ECONNREFUSED ::1:8099'), { code: 'ECONNREFUSED' })],
		''
	);
	assert.match(describeError(error), /ECONNREFUSED/);
});

test('the chain is depth-limited and cannot loop forever', () => {
	const a = new Error('a');
	const b = new Error('b');
	a.cause = b;
	b.cause = a; // cyclic
	const described = describeError(a);
	assert.ok(described.length < 200, 'terminates');
	assert.match(described, /^a: b/);
});

test('an identical repeated link is not duplicated', () => {
	const error = Object.assign(new Error('same'), { cause: new Error('same') });
	assert.equal(describeError(error), 'same');
});

test('non-Error throws are described without throwing', () => {
	assert.equal(describeError('a string'), 'a string');
	assert.equal(describeError(42), '42');
	// `${symbol}` raises a TypeError; String(symbol) does not. The handler must never be the
	// thing that crashes.
	assert.doesNotThrow(() => describeError(Symbol('sym')));
	assert.match(describeError(Symbol('sym')), /sym/);
});

test('null and undefined fall back to a literal', () => {
	assert.equal(describeError(null), 'null');
	assert.equal(describeError(undefined), 'undefined');
});
