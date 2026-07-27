import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression tests for the READ side of pause-intent resolution.
 *
 * The pure precedence logic is covered in queueControl.test.js. What broke in v0.8.0 was the
 * projection: `QueueControl.get({ id, select: 'paused' })` with a STRING select returns the
 * bare scalar, not a record (Harper `resources/Table.ts`: a string select does
 * `selected = value`, an array select builds `selected = {}`). Reading `.paused` off a
 * boolean yields undefined, which `resolveDesiredPause` correctly treats as "no opinion" —
 * so every pause resolved to "not paused" while the row sat in the table looking applied.
 *
 * The fake below reproduces that exact Harper behavior, so a string select fails the test
 * rather than silently passing.
 */

const makeFakeDatabases = (rows) => ({
	render_service: {
		QueueControl: {
			get({ id, select }) {
				const row = rows[id];
				if (!row) return Promise.resolve(undefined);

				// Mirror Harper's projection semantics exactly.
				if (typeof select === 'string') return Promise.resolve(row[select]);
				if (Array.isArray(select)) {
					const projected = {};
					for (const attribute of select) projected[attribute] = row[attribute];
					return Promise.resolve(projected);
				}
				return Promise.resolve(row);
			},
		},
	},
});

let getDesiredPause;

beforeEach(async () => {
	// Imported after the global exists, since the module reaches for `databases` at call time.
	({ getDesiredPause } = await import('../src/util/queueControl.js'));
});

afterEach(() => {
	delete globalThis.databases;
});

test('a per-node pause row resolves to paused', async () => {
	globalThis.databases = makeFakeDatabases({ 'node-a': { scope: 'node-a', paused: true } });
	assert.deepEqual(await getDesiredPause('node-a'), { paused: true, source: 'node' });
});

test('a cluster pause row resolves to paused for a node with no override', async () => {
	globalThis.databases = makeFakeDatabases({ all: { scope: 'all', paused: true } });
	assert.deepEqual(await getDesiredPause('node-a'), { paused: true, source: 'cluster' });
});

test('a node override of false keeps the node running through a cluster pause', async () => {
	globalThis.databases = makeFakeDatabases({
		'all': { scope: 'all', paused: true },
		'node-a': { scope: 'node-a', paused: false },
	});
	assert.deepEqual(await getDesiredPause('node-a'), { paused: false, source: 'node' });
	// ...while a different node still inherits the cluster pause.
	assert.deepEqual(await getDesiredPause('node-b'), { paused: true, source: 'cluster' });
});

test('no rows resolves to running', async () => {
	globalThis.databases = makeFakeDatabases({});
	assert.deepEqual(await getDesiredPause('node-a'), { paused: false, source: 'default' });
});

test('the read projects to a RECORD, not a bare scalar', async () => {
	// The actual v0.8.0 defect: with a string select the fake returns `true`, `.paused` is
	// undefined, and the result silently degrades to source 'default'. Asserting the resolved
	// source (not just `paused`) is what makes that degradation visible.
	const selects = [];
	globalThis.databases = {
		render_service: {
			QueueControl: {
				get({ id, select }) {
					selects.push(select);
					const row = id === 'node-a' ? { scope: 'node-a', paused: true } : undefined;
					if (!row) return Promise.resolve(undefined);
					if (typeof select === 'string') return Promise.resolve(row[select]);
					const projected = {};
					for (const attribute of select) projected[attribute] = row[attribute];
					return Promise.resolve(projected);
				},
			},
		},
	};

	const result = await getDesiredPause('node-a');

	assert.deepEqual(result, { paused: true, source: 'node' });
	for (const select of selects) {
		assert.ok(Array.isArray(select), `select must be an array, got ${typeof select} (${select})`);
	}
});
