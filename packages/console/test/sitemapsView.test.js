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
const { load, render, meta } = await import('../src/admin/views/sitemaps.js');

const ROOT = 'https://example.com/sitemap-index.xml';
const CHILD = 'https://example.com/sitemap-products-1.xml';

const LIST = {
	node: 'node-a',
	lastFullPass: Date.now() - 3_600_000,
	sitemaps: [
		{
			url: ROOT,
			// INGESTED two hours ago, CHECKED five minutes ago. That gap is the normal steady state
			// under conditional fetching, and a console that prints the first under the second's label
			// sends an operator chasing a sitemap that is not stale.
			entryCount: 2,
			lastRefreshed: Date.now() - 7_200_000,
			refresh: { state: 'idle', finishedAt: Date.now() - 300_000 },
		},
	],
};

const HOUR = 3_600_000;
const BUCKETS = 4;

/** One analytics combo, as `util/analyticsRead.js` emits it — value series, so mean x count. */
const combo = (path, count, value) => ({
	metric: 'prerender_ops',
	path,
	method: null,
	type: null,
	count,
	total: 0,
	mean: value,
	median: value,
	p95: value,
	counts: new Array(BUCKETS).fill(count / BUCKETS),
	means: new Array(BUCKETS).fill(value),
});

/** A day of walks: 30 documents fetched, 24 of them unchanged, 10 creates of which 6 went fast. */
const ANALYTICS = {
	available: true,
	scope: 'node',
	node: 'node-a',
	rangeMs: 24 * HOUR,
	startMs: 0,
	endMs: 24 * HOUR,
	bucketMs: 6 * HOUR,
	bucketCount: BUCKETS,
	cacheAgeMs: 0,
	scan: { ms: 9, scanned: 400, kept: 20, cap: 20_000 },
	series: [
		combo('sitemap_sitemaps', 2, 15),
		combo('sitemap_not_modified', 2, 12),
		combo('sitemap_created', 2, 5),
		combo('sitemap_created_soon', 2, 3),
		combo('sitemap_updated', 2, 1),
		combo('sitemap_skipped', 2, 400),
		combo('sitemap_removed', 2, 2),
		combo('sitemap_failed', 2, 0),
	],
};

/** The index detail: entries are child sitemaps, and the server still sends page-shaped fields. */
const INDEX_DETAIL = {
	node: 'node-a',
	sitemap: { url: ROOT, isIndex: true, entryCount: 2, lastRefreshed: Date.now() - 7_200_000, parentUrl: null },
	refresh: {
		state: 'idle',
		finishedAt: Date.now() - 300_000,
		created: 10,
		createdSoon: 6,
		updated: 1,
		removed: 2,
		notModified: 24,
		sitemapsProcessed: 30,
	},
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

function makeCtx({ analytics = ANALYTICS, list = async () => ({ ok: true, body: LIST }) } = {}) {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	const calls = { gets: [], posts: [], reloads: 0, order: [] };
	const ctx = {
		calls,
		scratch,
		busy: false,
		get data() {
			return scratch('sitemaps');
		},
		async get(route, query) {
			calls.gets.push({ route, query });
			calls.order.push(`get ${route}`);
			if (route === 'sitemaps') return list();
			if (route === 'analytics') return { ok: true, body: analytics };
			return { ok: true, body: null };
		},
		async post(route, body) {
			calls.posts.push({ route, body });
			calls.order.push(`post ${route}`);
			if (route !== 'sitemap') return { ok: true, body: {} };
			if (body.url === ROOT) return { ok: true, body: INDEX_DETAIL };
			if (body.url === CHILD) return { ok: true, body: CHILD_DETAIL };
			return { ok: false, status: 404, body: { error: `No sitemap stored under ${body.url}` } };
		},
		async run(fn) {
			return fn();
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

// ---- ingested vs checked, and the walk counters -----------------------------

test('a sitemap reports when it was INGESTED and, separately, when it was checked', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	// Under conditional fetching a 304 writes nothing, so the document's own timestamp is the last
	// time its ENTRIES changed. Labelling that "refreshed" reads as a walk that has not reached
	// this sitemap in hours, which is exactly the feature working.
	assert.match(text, /ingested/);
	assert.match(text, /checked/);
	assert.doesNotMatch(text, /never refreshed/, 'the old label conflated the two timestamps');
});

test('the last walk reports its 304s and its fast-path creates, not just created/updated/removed', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	// sitemap_not_modified non-zero is the ONLY evidence conditional fetching works: a walk that
	// re-parses every document succeeds exactly like one that skipped 24 of 30.
	assert.match(text, /Not modified \(304\)/);
	assert.match(text, /24 of 30 documents/);
	// A SUBSET of created, stated with its denominator so it can never be read as a fourth count.
	assert.match(text, /6 of the creates rendered soon/);
});

test('the walk panel sums passes across roots and nodes, and names the fast-path share', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	assert.match(text, /Walk activity/);
	// 2 emits x 15 documents = 30 fetched, 24 not modified: 80%.
	assert.match(text, /Documents fetched/);
	assert.match(text, /80%/);
	// 10 created, 6 of them soon.
	assert.match(text, /60% rendered soon/);
});

test('zero 304s across a day of walks is reported as the rollout not working', async () => {
	const analytics = {
		...ANALYTICS,
		series: ANALYTICS.series.map((s) =>
			s.path === 'sitemap_not_modified' ? { ...s, mean: 0, means: s.means.map(() => 0) } : s
		),
	};
	const ctx = makeCtx({ analytics });
	await load(ctx);
	const text = textOf(ctx);
	// Nothing errors and no walk fails — the only symptom is a full re-parse and prune scan per
	// document, forever, which is the entire saving the feature was for.
	assert.match(text, /No document was answered 304 in this window/);
	assert.match(text, /If-Modified-Since/);
});

test('a window with no finished walk says so rather than reading as a dead scheduler', async () => {
	const ctx = makeCtx({ analytics: { ...ANALYTICS, series: [] } });
	await load(ctx);
	const tree = draw(ctx);
	assert.match(tree.textContent, /Walk activity — node node-a, last 24h/);
	assert.match(tree.textContent, /No sitemap walk data in this window/);
	// Why it is empty is one click away, not a paragraph on the page.
	const help = find(tree, (n) => n.attributes?.class === 'help');
	assert.ok(help, 'expected the explanation behind the help toggle');
	assert.match(help.textContent, /once per FINISHED walk/);
	assert.match(help.textContent, /no walk completed/);
});

// ---- the redesign: shell-owned header, fixed window, concurrent loads ----------------------

test('the view has no header of its own, but keeps the walk-triggering buttons', async () => {
	const ctx = await ready();
	const tree = draw(ctx);
	assert.equal(meta.crumb, undefined);
	// The walk window is a daily pass — this view deliberately does not follow the global range.
	assert.ok(!meta.ranged);
	assert.equal(
		find(tree, (n) => n.attributes?.class === 'view-head'),
		null
	);
	// "Refresh all" and "Refresh now" run walks (a POST), so they are actions and stay; the shell owns
	// only the re-read.
	assert.equal(
		find(tree, (n) => n.tagName === 'BUTTON' && n.textContent === 'Refresh'),
		null
	);
	linkSaying(tree, 'Refresh all').fire('click');
	assert.deepEqual(ctx.calls.posts.at(-1), { route: 'sitemap-refresh', body: {} });
	linkSaying(tree, 'Refresh now').fire('click');
	assert.deepEqual(ctx.calls.posts.at(-1), { route: 'sitemap-refresh', body: { url: ROOT } });
	assert.match(tree.textContent, /last full pass 1h ago/);
});

test('the walk counters are read over a fixed 24h window, not the global range', async () => {
	const ctx = await ready();
	const analytics = ctx.calls.gets.find((call) => call.route === 'analytics');
	assert.deepEqual(analytics.query, { range: 24 * HOUR });
});

test('the 24h scan does not wait for the list, and a known selection loads beside it', async () => {
	let release;
	const pending = new Promise((resolve) => (release = resolve));
	const ctx = makeCtx({ list: () => pending.then(() => ({ ok: true, body: LIST })) });
	ctx.data.selected = CHILD;
	const loading = load(ctx);
	await new Promise((resolve) => setImmediate(resolve));
	// The list has not answered, and both the scan and the selected sitemap's detail are already out.
	assert.ok(ctx.calls.order.includes('get analytics'), 'the analytics scan should start with the list');
	assert.ok(
		ctx.calls.posts.some((call) => call.route === 'sitemap' && call.body.url === CHILD),
		'a known selection should not wait for the list'
	);
	release();
	await loading;
	assert.equal(ctx.data.detail.sitemap.url, CHILD);
	assert.equal(
		ctx.calls.posts.filter((call) => call.route === 'sitemap').length,
		1,
		'and the detail is not fetched twice'
	);
});

test('with no selection yet, the detail waits for the list to name the first root', async () => {
	const ctx = await ready();
	assert.deepEqual(
		ctx.calls.posts.filter((call) => call.route === 'sitemap').map((call) => call.body.url),
		[ROOT]
	);
	assert.ok(ctx.calls.order.indexOf('get sitemaps') < ctx.calls.order.indexOf('post sitemap'));
});

test('a failed list is an error, never "no sitemaps"', async () => {
	const ctx = makeCtx({ list: async () => ({ ok: false, status: 503, body: { error: 'upstream down' } }) });
	await load(ctx);
	const text = textOf(ctx);
	assert.match(text, /upstream down/);
	assert.doesNotMatch(text, /No sitemaps registered/);
});
