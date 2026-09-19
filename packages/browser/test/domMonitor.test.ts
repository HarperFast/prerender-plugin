import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { monitorSource, MONITOR_NS } from '../dist/domMonitor.js';

// The document-start monitor answers "how long has this page been still?" from mutation records.
// It is half of a readiness contract's stop condition — the half that protects content no clause
// can name — so each test here pins a way it has been wrong:
//   - it reported the still period BEFORE a burst as if it had accrued after it (measured: 2s quiet,
//     500 insertions, read 2,153ms quiet 150ms later), which made "held && quiet" stop with no dwell;
//   - it counted a subtree once per record and once per ancestor's record (parent + 10 children in
//     one task read as +21; a 13k-element document as 41,878), so ordinary churn tripped the
//     tolerance and the page read as never quiet.

let browser: Browser;
before(async () => {
	browser = await puppeteer.launch({ headless: true });
});
after(async () => {
	await browser.close();
});

const open = async (body = '<div id="root"></div>'): Promise<Page> => {
	const page = await browser.newPage();
	await page.evaluateOnNewDocument(monitorSource());
	await page.goto(`data:text/html,<!doctype html><html><body>${body}</body></html>`, { waitUntil: 'load' });
	return page;
};

const quiet = (page: Page, tolerance: number) =>
	page.evaluate((ns: string, tol: number) => (window as any)[ns].quietMs(tol), MONITOR_NS, tolerance);
const elements = (page: Page) => page.evaluate((ns: string) => (window as any)[ns].elements(), MONITOR_NS);
const recount = (page: Page) => page.evaluate((ns: string) => (window as any)[ns].recount(), MONITOR_NS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('quiet is measured from the LAST change, not from the change before it', async () => {
	const page = await open();
	// Still for a while, then a burst — the canonical "lull, then the rails arrive" shape.
	await sleep(600);
	await page.evaluate(() => {
		const root = document.getElementById('root')!;
		for (let i = 0; i < 500; i++) root.appendChild(document.createElement('div'));
	});
	await sleep(120);
	const q = await quiet(page, 120);
	assert.ok(q >= 100 && q < 400, `quiet since the burst should be ~120ms, not the ~700ms before it (got ${q})`);
	await page.close();
});

test('a parent inserted with its children in one task is counted once', async () => {
	const page = await open();
	const before = await elements(page);
	await page.evaluate(() => {
		const root = document.getElementById('root')!;
		const parent = document.createElement('section');
		root.appendChild(parent); // one record for the parent...
		for (let i = 0; i < 10; i++) parent.appendChild(document.createElement('span')); // ...and one per child
	});
	await sleep(30);
	assert.equal((await elements(page)) - before, 11, 'incremental count matches the 11 elements that were added');
	assert.equal(await elements(page), await recount(page), 'and agrees with a full recount');

	// The same shape rooted at an <a>, whose native `host` is a STRING (its URL's host) — the ancestor
	// walk must not follow it. A product tile is exactly this: an anchor wrapping an image and text.
	const mid = await elements(page);
	await page.evaluate(() => {
		const root = document.getElementById('root')!;
		const tile = document.createElement('a');
		tile.href = 'https://example.com/product/1';
		root.appendChild(tile);
		for (let i = 0; i < 4; i++) tile.appendChild(document.createElement('span'));
	});
	await sleep(30);
	assert.equal((await elements(page)) - mid, 5, 'an anchor-rooted subtree is counted once too');
	assert.equal(await elements(page), await recount(page));
	await page.close();
});

test('the incremental count of a parser-built document matches a full recount', async () => {
	const rows = Array.from(
		{ length: 400 },
		(_, i) => `<li class="row"><a href="/p/${i}"><img alt=""><span>${i}</span></a></li>`
	);
	const page = await open(`<ul>${rows.join('')}</ul><div id="root"></div>`);
	await sleep(30);
	assert.equal(await elements(page), await recount(page));
	await page.close();
});

test('churn within the tolerance does not reset the quiet; drift beyond it does', async () => {
	const page = await open();
	await sleep(300);
	// A carousel rotating 20 items in and out: the count moves by ±20, never by more than 120.
	await page.evaluate(async () => {
		const root = document.getElementById('root')!;
		for (let i = 0; i < 6; i++) {
			const batch = Array.from({ length: 20 }, () => root.appendChild(document.createElement('i')));
			await new Promise((r) => setTimeout(r, 20));
			for (const el of batch) el.remove();
			await new Promise((r) => setTimeout(r, 20));
		}
	});
	assert.ok((await quiet(page, 120)) >= 500, 'still quiet through the churn');
	await page.evaluate(() => {
		const root = document.getElementById('root')!;
		for (let i = 0; i < 200; i++) root.appendChild(document.createElement('b'));
	});
	await sleep(40);
	assert.ok((await quiet(page, 120)) < 200, 'a real change resets it');
	await page.close();
});

test('a history too long to answer from says so, rather than overstating the quiet', async () => {
	const page = await open();
	// Mutation records are delivered at the microtask checkpoint, so yielding a microtask between two
	// mutations records them as two changes. First force the history past HISTORY_MAX with swings no
	// tolerance would absorb; then make more than HISTORY_MAX moves of one element, so every entry
	// still retained is within tolerance of the final count and the boundary the scan looks for was
	// dropped with the old history.
	await page.evaluate(async () => {
		const root = document.getElementById('root')!;
		const tick = () => Promise.resolve();
		for (let i = 0; i < 20; i++) {
			for (let j = 0; j < 200; j++) root.appendChild(document.createElement('u'));
			await tick();
			root.replaceChildren();
			await tick();
		}
		for (let i = 0; i < 700; i++) {
			root.appendChild(document.createElement('u'));
			await tick();
			root.lastChild!.remove();
			await tick();
		}
	});
	await sleep(200);
	// From what is left the count never moved beyond tolerance, but 200-element swings were dropped —
	// answering "quiet since the start" would overstate it, so the honest answer is "cannot say".
	assert.equal(await quiet(page, 120), -1);
	await page.close();
});

test('the patched attachShadow keeps its name, and open roots are observed', async () => {
	const page = await open();
	assert.equal(await page.evaluate(() => Element.prototype.attachShadow.name), 'attachShadow');
	await sleep(200);
	await page.evaluate(() => {
		const host = document.createElement('x-host');
		document.getElementById('root')!.appendChild(host);
		const sr = host.attachShadow({ mode: 'open' });
		for (let i = 0; i < 300; i++) sr.appendChild(document.createElement('p'));
	});
	await sleep(40);
	assert.ok((await quiet(page, 120)) < 200, 'insertion inside an open shadow root counts as a change');
	assert.equal(await elements(page), await recount(page), 'and is counted once');
	await page.close();
});
