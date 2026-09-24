import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';

// `navigation.forceVisibleBudget`: elements a page observes with IntersectionObserver are reported
// visible without being on screen, so lazy content loads at any viewport height with no scroll pass.
// Each test pins one of the shim's promises: it loads what is below the fold, it is budgeted (a
// "load more" sentinel cannot turn into an infinite render), it never un-sees what it reported, and
// it never reports an element the page stopped observing.

let origin: http.Server;
let base = '';

const page = (body: string, script: string) =>
	`<!doctype html><html><head><title>t</title></head><body>${body}<script>${script}</script></body></html>`;

// A widget 6,000px down that fills itself only when its container is reported intersecting.
const LAZY = page(
	'<div style="height:6000px"></div><div id="w"></div>',
	`new IntersectionObserver((es, o) => { for (const e of es) if (e.isIntersecting) {
		e.target.innerHTML = '<p class="loaded">in view</p>'; o.unobserve(e.target); } }).observe(document.getElementById('w'));`
);
// An infinite list: every time the sentinel is visible, ten items and a NEW sentinel are appended.
const INFINITE = page(
	'<div id="list"></div>',
	`const list = document.getElementById('list');
	const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target);
		for (let i = 0; i < 10; i++) list.insertAdjacentHTML('beforeend', '<p class="item">x</p>');
		const s = document.createElement('div'); s.className = 'sentinel'; s.style.marginTop = '8000px'; list.append(s); io.observe(s); } });
	const s = document.createElement('div'); s.style.marginTop = '8000px'; list.append(s); io.observe(s);`
);
// A component that shows content while visible and REMOVES it when it leaves the viewport.
const TOGGLER = page(
	'<div style="height:6000px"></div><div id="t"></div>',
	`new IntersectionObserver((es) => { for (const e of es)
		e.target.innerHTML = e.isIntersecting ? '<p class="on">shown</p>' : '<p class="off">hidden</p>'; }).observe(document.getElementById('t'));`
);
// Observed and then unobserved in the same task: nothing may be reported for it.
const RETRACTED = page(
	'<div style="height:6000px"></div><div id="r"></div>',
	`const el = document.getElementById('r');
	const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) el.innerHTML = '<p class="reported">!</p>'; });
	io.observe(el); io.unobserve(el);`
);

// Budget accounting. `/repeat`: one element observed five times, then a second element — with a
// budget of 2 both must be reported (a repeat is a no-op natively and must cost nothing).
// `/refund`: an element observed and immediately unobserved, then another — with a budget of 1 the
// second must still be reported (an undelivered report gives its slot back).
const REPEAT = page(
	'<div style="height:6000px"></div><div id="a"></div><div id="b"></div>',
	`const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) e.target.innerHTML = '<p class="hit">' + e.target.id + '</p>'; });
	const a = document.getElementById('a'); for (let i = 0; i < 5; i++) io.observe(a); io.observe(document.getElementById('b'));`
);
const REFUND = page(
	'<div style="height:6000px"></div><div id="c"></div><div id="d"></div>',
	`const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) e.target.innerHTML = '<p class="hit">' + e.target.id + '</p>'; });
	const c = document.getElementById('c'); io.observe(c); io.unobserve(c);
	setTimeout(() => io.observe(document.getElementById('d')), 50);`
);

before(async () => {
	origin = http.createServer((req, res) => {
		res.setHeader('content-type', 'text/html');
		const path = (req.url ?? '').split('?')[0];
		const body = {
			'/lazy': LAZY,
			'/infinite': INFINITE,
			'/toggler': TOGGLER,
			'/retracted': RETRACTED,
			'/repeat': REPEAT,
			'/refund': REFUND,
		}[path];
		res.end(body ?? '<p>ok</p>');
	});
	await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

after(() => origin.close());

const render = (path: string, forceVisibleBudget: number) =>
	renderOnce({
		url: `${base}${path}`,
		captureNonIndexable: true,
		config: {
			devices: { desktop: { viewport: { width: 1000, height: 800 } } },
			navigation: {
				networkIdleMs: 50,
				networkIdleTimeoutMs: 300,
				domStableMs: 300,
				domStableTimeoutMs: 2000,
				forceVisibleBudget,
			},
			scroll: { enabled: false },
		} as never,
	});

test('content below the fold loads with no scroll pass once observed elements are reported visible', async () => {
	const off = await render('/lazy', 0);
	assert.doesNotMatch(off.html ?? '', /class="loaded"/, 'control: 6,000px down and never scrolled, it does not load');
	const on = await render('/lazy', 50);
	assert.match(on.html ?? '', /class="loaded"/);
});

test('the budget bounds an infinite list', async () => {
	const result = await render('/infinite', 3);
	const items = ((result.html ?? '').match(/class="item"/g) ?? []).length;
	assert.equal(
		items,
		30,
		'three reports, ten items each — then the native observer alone decides, and nothing is on screen'
	);
});

test('an element reported visible is never un-seen by the native observer', async () => {
	const result = await render('/toggler', 50);
	assert.match(result.html ?? '', /class="on"/);
	assert.doesNotMatch(result.html ?? '', /class="off"/);
});

test('nothing is reported for an element the page stopped observing', async () => {
	const result = await render('/retracted', 50);
	assert.doesNotMatch(result.html ?? '', /class="reported"/);
});

test('a repeated observe() of the same element spends no budget', async () => {
	const result = await render('/repeat', 2);
	const hits = ((result.html ?? '').match(/class="hit"/g) ?? []).length;
	assert.equal(hits, 2, 'element a (observed five times) and element b both reported on a budget of 2');
});

test('a report that was never delivered gives its budget back', async () => {
	const result = await render('/refund', 1);
	assert.match(result.html ?? '', /<p class="hit">d<\/p>/, 'the unobserved element did not keep the only slot');
	assert.doesNotMatch(result.html ?? '', /<p class="hit">c<\/p>/);
});

test('a negative or fractional budget is rejected at config load', async () => {
	const { mergeConfig } = await import('../dist/config.js');
	assert.throws(
		() => mergeConfig({ navigation: { forceVisibleBudget: -1 } } as never),
		/forceVisibleBudget must be a non-negative integer/
	);
	assert.throws(
		() => mergeConfig({ navigation: { forceVisibleBudget: 2.5 } } as never),
		/forceVisibleBudget must be a non-negative integer/
	);
	assert.doesNotThrow(() => mergeConfig({ navigation: { forceVisibleBudget: 0 } } as never));
});
