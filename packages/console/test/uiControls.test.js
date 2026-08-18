/**
 * The config-editing controls, executed rather than merely imported.
 *
 * Rendering in this console is a FULL REBUILD on every state change. That makes one mistake fatal
 * and invisible: a control that reports a value while constructing itself stages that value, which
 * re-renders, which rebuilds the control, which reports again — unbounded recursion that blows the
 * stack before the view can draw. It is not a hypothetical; `durationInput` did exactly this, and
 * it took every view owning a millisecond option down with it. Lint, prettier and a render harness
 * whose `render` is a no-op all pass it happily, so the guard has to be a real render loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, find } from './domShim.js';

installDom();

const { control, durationInput, card, listEditor, originPill, highlight, formatValue } = await import(
	'../src/admin/ui.js'
);

const inputOf = (node) => find(node, (n) => n.tagName === 'INPUT');
const selectOf = (node) => find(node, (n) => n.tagName === 'SELECT');

test('a duration control does NOT report a value while it is being constructed', () => {
	let calls = 0;
	durationInput(86_400_000, { onChange: () => calls++ });
	assert.equal(
		calls,
		0,
		'constructing a control must be silent — a construction-time report re-renders the view that is ' +
			'currently building this control, which rebuilds it, which reports again'
	);
});

test('a duration control survives a render loop that rebuilds it on every change', () => {
	// The real shape: onChange stages and re-renders, and re-rendering rebuilds the control. If
	// construction reports, this never terminates.
	let depth = 0;
	let staged = 3_600_000;
	const build = () =>
		durationInput(staged, {
			onChange: (next) => {
				if (++depth > 50) throw new Error('durationInput recursed — construction is reporting a value');
				staged = next;
				build(); // what ctx.render() does
			},
		});

	assert.doesNotThrow(() => build());
	assert.equal(depth, 0, 'nothing should have been reported at all');
});

test('typing in a duration control DOES report, in canonical milliseconds', () => {
	const reported = [];
	const node = durationInput(3_600_000, { onChange: (value) => reported.push(value) });
	const amount = inputOf(node);

	amount.value = '2';
	amount.fire('input');
	// 3600000ms renders as `1 h`, so 2 in that unit is two hours.
	assert.deepEqual(reported, [7_200_000], 'the stored value is always milliseconds, whatever unit is shown');
});

test('changing the unit re-expresses the same duration and reports nothing', () => {
	const reported = [];
	const node = durationInput(1_800_000, { onChange: (value) => reported.push(value) });
	const amount = inputOf(node);
	const unit = selectOf(node);

	assert.equal(amount.value, '30', '1,800,000ms is shown as 30 m');

	unit.value = 'h';
	unit.fire('change');

	assert.equal(amount.value, '0.5', 'switching to hours must mean the SAME half hour, not 30 hours');
	assert.deepEqual(reported, [], 'a display change is not a value change');
});

test('a non-editable option never yields an editable control', () => {
	for (const option of [
		{ path: 'renderNow.token', type: 'string', default: '', secret: true, uiEditable: false },
		{ path: 'management.enabled', type: 'boolean', default: true, uiEditable: false },
	]) {
		const node = control(option, '<set: 41 chars>', () => {
			throw new Error('a locked option must not be wired to a change handler');
		});
		assert.equal(inputOf(node), null, `${option.path} must not render an input`);
		assert.equal(selectOf(node), null, `${option.path} must not render a select`);
		assert.match(node.textContent, /not editable|secret/i, 'and must say why, rather than just being absent');
	}
});

test('an enum option renders a select over exactly its allowed values', () => {
	const node = control(
		{ path: 'ingress.mode', type: 'string', enum: ['prefix', 'forwarded'], uiEditable: true },
		'prefix',
		() => {}
	);
	assert.equal(node.tagName, 'SELECT');
	assert.deepEqual(
		node.children.map((child) => child.attributes.value),
		['prefix', 'forwarded']
	);
});

test('a closed item set renders checkboxes, because a typo there rejects the WHOLE list', () => {
	const node = control(
		{ path: 'cacheKey.decodeReserved', type: 'array', itemEnum: [':', ',', '@'], default: [], uiEditable: true },
		[':'],
		() => {}
	);
	const boxes = [];
	find(node, (n) => {
		if (n.tagName === 'INPUT' && n.attributes.type === 'checkbox') boxes.push(n);
		return false;
	});
	assert.equal(boxes.length, 3, 'one box per allowed entry — free text would let a rogue value cost the option');
});

test('a scalar list round-trips through lines, dropping blanks rather than storing empty entries', () => {
	const reported = [];
	const node = listEditor(['a', 'b'], { onChange: (value) => reported.push(value) });
	assert.equal(node.value, 'a\nb');

	node.value = 'a\n\n  c  \n';
	node.fire('input', { target: node });
	assert.deepEqual(reported.at(-1), ['a', 'c'], 'several of these options reject an empty entry outright');
});

test('a title-less, head-less card does not render a stray zero', () => {
	// `head.length` of an empty head is the NUMBER 0, and append skips null/false/'' but not 0.
	const node = card(null, { body: [] });
	assert.equal(node.textContent, '', 'an empty card must be empty');
});

test('originPill distinguishes an override that is in force from one that was refused', () => {
	assert.match(originPill('override').textContent, /override/);
	assert.match(
		originPill('override-rejected').textContent,
		/REJECTED|not in effect/,
		'a stored-but-refused override must not read as a working one'
	);
	assert.match(originPill('file').textContent, /config\.yaml/);
});

test('highlight marks matches without ever building DOM from a string', () => {
	const parts = highlight('queue.jobLeaseTime', 'lease');
	const marks = parts.filter((part) => typeof part === 'object' && part.tagName === 'MARK');
	assert.equal(marks.length, 1);
	assert.equal(marks[0].textContent, 'Lease', 'the matched run keeps its original casing');
	assert.equal(
		parts.map((part) => (typeof part === 'string' ? part : part.textContent)).join(''),
		'queue.jobLeaseTime'
	);
});

test('formatValue distinguishes an empty string from an unset value', () => {
	assert.equal(formatValue(undefined), '—');
	assert.equal(formatValue(''), '(empty)');
	assert.equal(formatValue(0), '0');
	assert.equal(formatValue(false), 'false');
});
