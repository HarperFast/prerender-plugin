/**
 * The Sitemaps view, executed — specifically the difference between a sitemap and a sitemap INDEX.
 *
 * They are different documents. A `<urlset>` lists pages, and every column the entry table grew
 * was about a page: its changefreq, its priority, whether it is cached and scheduled, and a link
 * to explain its cache key. An index lists SITEMAPS, and none of that applies — `<changefreq>` and
 * `<priority>` are not in the sitemapindex schema at all, and asking "is this cached and
 * scheduled" of an XML document that is never prerendered produces a row of alarming-looking
 * verdicts about nothing. Worse, the answer an operator actually wants from an index row — open
 * that child — was not reachable from this console at all: the root list is roots only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render } = await import('../src/admin/views/sitemaps.js');

const ROOT = 'https://example.com/sitemap-index.xml';
const CHILD = 'https://example.com/sitemap-products-1.xml';

const LIST = {
	node: 'node-a',
	lastFullPass: Date.now() - 3_600_000,
	sitemaps: [{ url: ROOT, entryCount: 2, lastRefreshed: Date.now() - 7_200_000, refresh: { state: 'idle' } }],
};

/** The index detail: entries are child sitemaps, and the server still sends page-shaped fields. */
const INDEX_DETAIL = {
	node: 'node-a',
	sitemap: { url: ROOT, isIndex: true, entryCount: 2, lastRefreshed: Date.now() - 7_200_000, parentUrl: null },
	refresh: { state: 'idle', finishedAt: Date.now() - 7_200_000 },
	// Structurally zero for an index: a walk attributes every Target to the child that listed it.
	targetCount: { count: 0, cap: 1000, truncated: false },
	entries: [
		{ loc: CHILD, changefreq: null, priority: null, state: 'no target' },
		{ loc: 'https://example.com/sitemap-products-2.xml', changefreq: null, priority: null, state: 'filtered' },
	],
	offset: 0,
	limit: 50,
};

const CHILD_DETAIL = {
	node: 'node-a',
	sitemap: { url: CHILD, isIndex: false, entryCount: 1, lastRefreshed: Date.now() - 7_200_000, parentUrl: ROOT },
	refresh: null,
	targetCount: { count: 1, cap: 1000, truncated: false },
	entries: [{ loc: 'https://example.com/p/widget', changefreq: 'daily', priority: 0.8, state: 'cached' }],
	offset: 0,
	limit: 50,
};

function makeCtx() {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	const calls = { posts: [], reloads: 0 };
	const ctx = {
		calls,
		scratch,
		busy: false,
		get data() {
			return scratch('sitemaps');
		},
		async get(route) {
			if (route === 'sitemaps') return { ok: true, body: LIST };
			return { ok: true, body: null };
		},
		async post(route, body) {
			calls.posts.push({ route, body });
			if (route !== 'sitemap') return { ok: true, body: {} };
			if (body.url === ROOT) return { ok: true, body: INDEX_DETAIL };
			if (body.url === CHILD) return { ok: true, body: CHILD_DETAIL };
			return { ok: false, status: 404, body: { error: `No sitemap stored under ${body.url}` } };
		},
		render() {},
		async reload() {
			calls.reloads++;
			await load(ctx);
		},
		go() {},
	};
	return ctx;
}

const draw = (ctx) => el('div', null, render(ctx));
const textOf = (ctx) => draw(ctx).textContent;
const linkSaying = (node, text) => find(node, (n) => n.tagName === 'BUTTON' && n.textContent.includes(text));

const ready = async () => {
	const ctx = makeCtx();
	await load(ctx);
	return ctx;
};

test('an index does not offer page controls for documents that are not pages', async () => {
	const ctx = await ready();
	const text = textOf(ctx);

	assert.match(text, /child sitemap/, 'the column should name what the rows actually are');
	assert.doesNotMatch(text, /changefreq/, 'not part of the sitemapindex schema');
	assert.doesNotMatch(text, /priority/, 'likewise');
	assert.equal(linkSaying(draw(ctx), 'explain →'), null, 'a sitemap file has no cache key worth explaining');
	// The per-entry state verdicts the server still sends are page verdicts; showing them here
	// makes every child look broken.
	assert.doesNotMatch(text, /no target/);
	assert.doesNotMatch(text, /filtered/);
});

test('an index reports what it has, not zero of what it structurally cannot have', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	assert.match(text, /Child sitemaps/);
	assert.match(text, /an index lists sitemaps, not URLs/);
	// "Targets 0 / Coverage 0%" is the shape of the data, not a finding — and on the largest
	// sitemap in a deployment it reads as total failure.
	assert.doesNotMatch(text, /Coverage/);
});

test('a child sitemap can be opened from its index — the only way to reach one', async () => {
	const ctx = await ready();
	assert.equal(ctx.data.selected, ROOT);

	linkSaying(draw(ctx), 'open →').fire('click');
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(ctx.data.selected, CHILD, 'the selection must survive the reload that follows the click');
	assert.equal(ctx.data.detail.sitemap.url, CHILD);
	// And now it is a URL table again, with everything an index row had no business showing.
	const text = textOf(ctx);
	assert.match(text, /changefreq/);
	assert.ok(linkSaying(draw(ctx), 'explain →'));
});

test('a child offers a way back to the index that lists it', async () => {
	const ctx = await ready();
	linkSaying(draw(ctx), 'open →').fire('click');
	await new Promise((resolve) => setTimeout(resolve, 10));

	const back = linkSaying(draw(ctx), '↑');
	assert.ok(back, 'a child is not in the root list, so it needs its own way back');
	back.fire('click');
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(ctx.data.selected, ROOT);
});

test('a selection that no longer resolves falls back to a root instead of a dead pane', async () => {
	const ctx = makeCtx();
	ctx.data.selected = 'https://example.com/sitemap-deleted.xml';
	await load(ctx);
	assert.equal(ctx.data.selected, ROOT);
	assert.equal(ctx.data.detail.sitemap.url, ROOT);
});
