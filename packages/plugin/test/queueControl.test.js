import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDesiredPause, CLUSTER_SCOPE } from '../src/util/queueControl.js';

test('no intent records at all means running', () => {
	assert.deepEqual(resolveDesiredPause(undefined, undefined), { paused: false, source: 'default' });
	assert.deepEqual(resolveDesiredPause(null, null), { paused: false, source: 'default' });
});

test('the cluster row applies when the node has no override', () => {
	assert.deepEqual(resolveDesiredPause(null, { paused: true }), { paused: true, source: 'cluster' });
	assert.deepEqual(resolveDesiredPause(null, { paused: false }), { paused: false, source: 'cluster' });
});

test('a node override wins over the cluster row in both directions', () => {
	// Hold one node out of a running cluster...
	assert.deepEqual(resolveDesiredPause({ paused: true }, { paused: false }), { paused: true, source: 'node' });
	// ...and keep one node running through a cluster-wide pause.
	assert.deepEqual(resolveDesiredPause({ paused: false }, { paused: true }), { paused: false, source: 'node' });
});

test('a node row with no boolean `paused` is "no opinion" and falls through to the cluster', () => {
	// A bare API PUT can create a row without `paused`. Coercing that to `false` would
	// silently override a deliberate cluster-wide pause, so it must not participate.
	for (const nodeRow of [{}, { paused: null }, { paused: undefined }]) {
		assert.deepEqual(resolveDesiredPause(nodeRow, { paused: true }), { paused: true, source: 'cluster' });
	}
});

test('non-boolean `paused` values never pause the queue', () => {
	// Truthy-but-not-boolean must not read as paused — that would stop rendering cluster-wide
	// off a malformed write.
	for (const value of ['true', 1, {}, []]) {
		assert.deepEqual(resolveDesiredPause({ paused: value }, null), { paused: false, source: 'default' });
		assert.deepEqual(resolveDesiredPause(null, { paused: value }), { paused: false, source: 'default' });
	}
});

test('cluster scope constant is the documented sentinel', () => {
	// The UI, the resource validation, and the schema comment all key off this literal.
	assert.equal(CLUSTER_SCOPE, 'all');
});
