/**
 * The config editor's state model, tested without a DOM.
 *
 * These are the two questions the module exists to get right, and neither is visible in the
 * rendering: WHERE an unwritten edit lives (it must survive a node-scope switch, because an
 * override is cluster-wide intent rather than one node's data), and WHAT counts as a change (a
 * value typed back to the running one must unstage rather than queue a pointless write).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { configState, optionIndex, pathsUnder } from '../src/admin/views/_configEdit.js';

// The shell's contract, reduced to what this module touches: per-view scratch keyed by view id,
// which app.js REPLACES wholesale when the node scope changes.
function makeShell(payload = null) {
	let views = { config: { payload } };
	return {
		ctx: {
			scratch: (id) => (views[id] ??= {}),
			get busy() {
				return false;
			},
			render: () => {},
		},
		/** Exactly what app.js does in the node picker's onchange. */
		switchScope() {
			views = {};
		},
	};
}

const PAYLOAD = {
	schema: {
		kind: 'group',
		children: {
			queue: {
				kind: 'group',
				children: {
					jobLeaseTime: { kind: 'option', type: 'number', default: 600000, uiEditable: true },
					maxLeases: { kind: 'option', type: 'number', default: 4096, scope: 'restart', uiEditable: true },
				},
			},
			renderNow: {
				kind: 'group',
				children: { token: { kind: 'option', type: 'string', default: '', secret: true, uiEditable: false } },
			},
		},
	},
	layers: [
		{ path: 'queue.jobLeaseTime', source: 'file', effective: 120000, overridden: false },
		{ path: 'queue.maxLeases', source: 'default', effective: 4096, overridden: false },
		{ path: 'renderNow.token', source: 'default', effective: '<empty>', overridden: false },
	],
	pendingRestart: [],
	divergences: [],
};

test('a staged edit survives a node-scope switch, because an override is cluster-wide and not a node’s data', () => {
	const shell = makeShell(PAYLOAD);
	const before = configState(shell.ctx);
	before.staged['queue.jobLeaseTime'] = 300000;
	before.cleared['queue.maxLeases'] = true;

	shell.switchScope();

	const after = configState(shell.ctx);
	assert.equal(
		after.staged['queue.jobLeaseTime'],
		300000,
		'switching which node you are READING must not discard an edit that applies to every node'
	);
	assert.equal(after.cleared['queue.maxLeases'], true, 'a pending revert is the same kind of intent');
});

test('the payload does NOT survive a scope switch, so no node’s answer is ever shown under another node’s name', () => {
	const shell = makeShell(PAYLOAD);
	assert.ok(configState(shell.ctx).payload, 'precondition: a payload is loaded');

	shell.switchScope();

	assert.equal(
		configState(shell.ctx).payload,
		undefined,
		'the fetched config belongs to the scope it came from and must be re-fetched'
	);
});

test('a preview does not survive a scope switch either — it is one node’s answer about a prospective config', () => {
	const shell = makeShell(PAYLOAD);
	configState(shell.ctx).preview = { changes: [] };
	shell.switchScope();
	assert.equal(configState(shell.ctx).preview, undefined);
});

test('two surfaces reach the same staging area, so one coherent edit produces one write', () => {
	// Queue stages one option, Sitemaps stages another; both go through configState and must land
	// in a single changeset. Two half-applied writes is the failure this shares state to avoid.
	const shell = makeShell(PAYLOAD);
	configState(shell.ctx).staged['queue.jobLeaseTime'] = 300000;
	configState(shell.ctx).staged['sitemap.refreshTime'] = '03:00';

	assert.deepEqual(Object.keys(configState(shell.ctx).staged).sort(), ['queue.jobLeaseTime', 'sitemap.refreshTime']);
});

test('optionIndex joins the schema to the layers, because a row needs both and only the layers know which won', () => {
	const index = optionIndex(PAYLOAD);

	const option = index.get('queue.jobLeaseTime');
	assert.equal(option.type, 'number', 'type comes from the schema');
	assert.equal(option.default, 600000, 'and so does the default');
	assert.equal(option.source, 'file', 'provenance comes from the layers');
	assert.equal(option.effective, 120000, 'and so does the running value');
	assert.equal(option.path, 'queue.jobLeaseTime');
});

test('optionIndex carries uiEditable through, so a secret can never be rendered as a control', () => {
	assert.equal(optionIndex(PAYLOAD).get('renderNow.token').uiEditable, false);
});

test('pathsUnder matches a whole group and also a leaf option named exactly by its prefix', () => {
	const index = optionIndex(PAYLOAD);
	assert.deepEqual(pathsUnder(index, 'queue'), ['queue.jobLeaseTime', 'queue.maxLeases']);
	// `management.pageSize` is a leaf, not a group; a card asking for it by name must still find it.
	assert.deepEqual(pathsUnder(index, 'renderNow.token'), ['renderNow.token']);
	assert.deepEqual(pathsUnder(index, 'nosuchgroup'), []);
});

test('an empty payload yields an empty index rather than throwing', () => {
	assert.equal(optionIndex(null).size, 0);
	assert.equal(optionIndex({}).size, 0);
});
