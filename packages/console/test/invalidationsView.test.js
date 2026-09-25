/**
 * The Invalidations view, EXECUTED — its "what the invalidations are doing" panel above all.
 *
 * That panel reads three analytics series nobody read before console v0.12.0 (`page_verification`,
 * `invalidation_reenqueue`, `invalidation_error`) beside the `verified` serve status, and the
 * arithmetic has two rules a reader cannot verify from the screen:
 *
 *   - `forwarded` is NEVER added to `lowered`. A forwarded heal is counted again by the owner under
 *     its own verdict in the same series, so under cluster scope adding the two double-counts.
 *   - Refused and rescued are ONE population split two ways, and the shares are stated against
 *     that population, not against all serves.
 *
 * The rest is the empty states: nothing invalidated is a steady state, not a fault; verification
 * off explains a 100% refusal rate rather than letting it read as the feature failing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render, meta } = await import('../src/admin/views/invalidations.js');

const HOUR = 3_600_000;

/** One analytics combo, in the shape `util/analyticsRead.js` emits (four buckets, flat). */
const combo = (metric, path, method, type, count) => ({
	metric,
	path,
	method,
	type,
	count,
	total: 0,
	counts: [count / 4, count / 4, count / 4, count / 4],
});

const LIST = {
	enabled: true,
	maxScopes: 8,
	knownScopes: ['all', 'route:prefix:/product/'],
	invalidations: [
		{
			scope: 'route:prefix:/product/',
			resolvable: true,
			invalidatedAt: new Date(Date.now() - HOUR).toISOString(),
			reason: 'promo flip',
			updatedBy: 'ops',
		},
	],
};

const EMPTY_LIST = { ...LIST, invalidations: [] };

const ANALYTICS = {
	available: true,
	scope: 'node',
	node: 'node-a',
	rangeMs: HOUR,
	startMs: 0,
	endMs: HOUR,
	bucketMs: HOUR / 4,
	bucketCount: 4,
	scan: { ms: 4, scanned: 100, kept: 20, cap: 20_000 },
	series: [
		// 300 refused, 100 rescued: 75% / 25% of the population the invalidation touched.
		combo('bot_serve', 'origin', 'invalidated', 'googlebot', 300),
		combo('bot_serve', 'cache', 'verified', 'googlebot', 100),
		combo('bot_serve', 'cache', 'hit', 'googlebot', 5000),
		// Verifications the sweep recorded, one of them failing to write.
		combo('prerender_ops', 'page_verification', 'written', null, 4000),
		combo('prerender_ops', 'page_verification', 'write-error', null, 3),
		// Heal outcomes. 60 lowered on THIS node, 40 forwarded to owners (who count their own), the
		// classic not-owner ceiling on the rest.
		combo('prerender_ops', 'invalidation_reenqueue', 'lowered', 'route:prefix:/product/', 60),
		combo('prerender_ops', 'invalidation_reenqueue', 'forwarded', 'route:prefix:/product/', 40),
		combo('prerender_ops', 'invalidation_reenqueue', 'not-owner', 'route:prefix:/product/', 100),
		combo('prerender_ops', 'invalidation_reenqueue', 'not-sooner', 'route:prefix:/product/', 20),
		combo('prerender_ops', 'invalidation_reenqueue', 'forward-failed', 'route:prefix:/product/', 5),
	],
};

const config = (over = {}) => ({
	schema: {
		children: {
			invalidation: {
				children: {
					enabled: { kind: 'option' },
					verification: { children: { enabled: { kind: 'option' } } },
					reenqueue: {
						children: { enabled: { kind: 'option' }, crossNode: { children: { enabled: { kind: 'option' } } } },
					},
				},
			},
		},
	},
	layers: [
		{ path: 'invalidation.enabled', effective: true },
		{ path: 'invalidation.verification.enabled', effective: over.verification ?? true },
		{ path: 'invalidation.reenqueue.enabled', effective: over.reenqueue ?? true },
		{ path: 'invalidation.reenqueue.crossNode.enabled', effective: over.crossNode ?? false },
	],
});

function makeCtx({ list = LIST, analytics = ANALYTICS, cfg = config() } = {}) {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	const calls = { gets: [], queries: {}, posts: [], failures: [] };
	return {
		calls,
		scratch,
		busy: false,
		// The shell's global range (top bar); 6h here so a hard-coded window would show.
		rangeMs: 6 * HOUR,
		get data() {
			return scratch('invalidations');
		},
		async get(route, query) {
			calls.gets.push(route);
			calls.queries[route] = query;
			if (route === 'invalidations') return { ok: true, body: list };
			if (route === 'analytics')
				return analytics ? { ok: true, body: analytics } : { ok: false, status: 500, body: {} };
			if (route === 'config') return { ok: true, body: cfg };
			return { ok: true, body: null };
		},
		async post(route, data) {
			calls.posts.push({ route, data });
			return { ok: true, body: {} };
		},
		async run(fn) {
			return fn();
		},
		fail(message) {
			calls.failures.push(message);
		},
		render() {},
		reload() {},
		go() {},
	};
}

const draw = (ctx) => el('div', null, render(ctx));
const tile = (ctx, label) =>
	find(draw(ctx), (n) => n.attributes?.class === 'stat' && n.children[0]?.textContent === label);

const ready = async (options) => {
	const ctx = makeCtx(options);
	await load(ctx);
	return ctx;
};

test('the view reads the GLOBAL range alongside the rows, and says so to the shell', async () => {
	const ctx = await ready();
	assert.ok(ctx.calls.gets.includes('analytics'));
	assert.deepEqual(ctx.calls.queries.analytics, { range: 6 * HOUR });
	assert.equal(meta.ranged, true, 'the top bar shows the range picker for this view');
	assert.equal(meta.crumb, undefined);
	assert.match(draw(ctx).textContent, /What the invalidations are doing — node node-a/);
	assert.doesNotMatch(draw(ctx).textContent, /last hour/, 'the window is the top bar’s, not a fixed hour');
});

test('no header of its own: the enforcement state rides the Active card, and the shell owns Refresh', async () => {
	const ctx = await ready();
	const tree = draw(ctx);
	assert.equal(
		find(tree, (n) => n.attributes?.class === 'view-head'),
		null
	);
	assert.equal(
		find(tree, (n) => n.tagName === 'BUTTON' && n.textContent === 'Refresh'),
		null
	);
	const activeCard = find(
		tree,
		(n) =>
			String(n.attributes?.class).startsWith('card') && /^Active invalidations/.test(n.children[0]?.textContent ?? '')
	);
	assert.match(activeCard.children[0].textContent, /enforcement on/);
	assert.match(activeCard.children[0].textContent, /1 of 8 scope slots/);

	const off = await ready({ list: { ...LIST, enabled: false, killSwitchHidingRows: true } });
	const text = draw(off).textContent;
	assert.match(text, /invalidation\.enabled is FALSE/);
	assert.ok(
		find(draw(off), (n) => n.attributes?.class === 'note bad' && /recorded and NOT enforced/.test(n.textContent)),
		'the kill switch hiding rows is still the loud banner'
	);
});

test('the long explanations sit behind help toggles, not on the page', async () => {
	const tree = draw(await ready());
	const helps = [];
	find(tree, (n) => {
		if (n.attributes?.class === 'help') helps.push(n.textContent);
		return false;
	});
	assert.ok(
		helps.some((text) => /never added to “lowered”/.test(text)),
		'the forwarded-heal rule is kept'
	);
	assert.ok(
		helps.some((text) => /LATEST instant wins/.test(text)),
		'the overlap precedence is kept'
	);
	assert.equal(
		find(tree, (n) => n.attributes?.class === 'muted chart-note'),
		null,
		'no explanatory paragraphs left in the body'
	);
});

test('recording is still preview-first: the dry run, then an explicit second click', async () => {
	const ctx = await ready();
	const button = (text) => find(draw(ctx), (n) => n.tagName === 'BUTTON' && n.textContent === text);
	// No reason, no preview.
	await button('Preview (writes nothing)').listeners.click[0]();
	assert.equal(ctx.calls.posts.length, 0);
	assert.match(ctx.calls.failures[0], /reason is required/);

	// The reason input is drawn from the form state, so filling that fills the field.
	ctx.data.form.reason = 'promo flip';
	ctx.post = async (route, data) => {
		ctx.calls.posts.push({ route, data });
		return { ok: true, body: { scope: data.scope, precedence: 'max', effect: 'refuses pre-epoch pages', limits: [] } };
	};
	await button('Preview (writes nothing)').listeners.click[0]();
	assert.deepEqual(ctx.calls.posts.at(-1), {
		route: 'invalidate',
		data: { scope: 'all', reason: 'promo flip', dryRun: true },
	});
	assert.match(draw(ctx).textContent, /Preview — nothing has been written/);
	await button('Invalidate all now').listeners.click[0]();
	assert.deepEqual(ctx.calls.posts.at(-1), { route: 'invalidate', data: { scope: 'all', reason: 'promo flip' } });
});

test('refused and rescued are one population, and the shares are stated against it', async () => {
	const ctx = await ready();
	const refused = tile(ctx, 'Refused');
	const rescued = tile(ctx, 'Rescued');
	assert.ok(refused && rescued, 'expected both tiles');
	assert.match(refused.textContent, /300/);
	assert.match(refused.textContent, /75% of touched serves/);
	assert.match(rescued.textContent, /100/);
	assert.match(rescued.textContent, /25%/);
	// 5,000 ordinary hits are NOT in the denominator: 300 of 5,400 would read "6%".
	assert.doesNotMatch(refused.textContent, /\b6%/);
});

test('verification writes are counted, and a write fault is on the tile rather than in a log', async () => {
	const ctx = await ready();
	const writes = tile(ctx, 'Verifications recorded');
	assert.match(writes.textContent, /4,000/);
	assert.match(writes.textContent, /3 write-error/);
	assert.ok(
		find(writes, (n) => n.attributes?.class === 'value warn'),
		'a write fault should warn'
	);
});

test('forwarded heals are never added to lowered — the owner counts them under its own verdict', async () => {
	const ctx = await ready();
	const heals = tile(ctx, 'Heals attempted');
	// 60 + 40 + 100 + 20 + 5 attempts; 60 lowered, not 100.
	assert.match(heals.textContent, /225/);
	assert.match(heals.textContent, /60 lowered/);
	assert.match(heals.textContent, /44% not-owner/);
	const text = draw(ctx).textContent;
	for (const outcome of ['lowered', 'forwarded', 'not-owner', 'not-sooner', 'forward-failed']) {
		assert.match(text, new RegExp(outcome));
	}
});

test('a not-owner majority warns only while cross-node forwarding is off — it is the lever', async () => {
	const off = await ready({
		analytics: {
			...ANALYTICS,
			series: [
				combo('prerender_ops', 'invalidation_reenqueue', 'lowered', 'all', 10),
				combo('prerender_ops', 'invalidation_reenqueue', 'not-owner', 'all', 90),
			],
		},
	});
	assert.ok(
		find(tile(off, 'Heals attempted'), (n) => n.attributes?.class === 'value warn'),
		'should warn with crossNode off'
	);

	const on = await ready({
		analytics: {
			...ANALYTICS,
			series: [
				combo('prerender_ops', 'invalidation_reenqueue', 'lowered', 'all', 10),
				combo('prerender_ops', 'invalidation_reenqueue', 'not-owner', 'all', 90),
			],
		},
		cfg: config({ crossNode: true }),
	});
	assert.equal(
		find(tile(on, 'Heals attempted'), (n) => n.attributes?.class === 'value warn'),
		null
	);
	assert.match(draw(on).textContent, /heal on · cross-node/);
});

test('an outcome this console has never heard of still gets a row — the list must sum to the attempts', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [combo('prerender_ops', 'invalidation_reenqueue', 'teleported', 'all', 7)] },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /teleported/);
	assert.match(tile(ctx, 'Heals attempted').textContent, /7/);
});

test('lkg-expired is the bad note: those requests failed OPEN', async () => {
	const ctx = await ready({
		analytics: {
			...ANALYTICS,
			series: [
				combo('prerender_ops', 'invalidation_error', 'read-error', null, 4),
				combo('prerender_ops', 'invalidation_error', 'lkg-expired', null, 2),
			],
		},
	});
	const node = draw(ctx);
	const bad = find(node, (n) => n.attributes?.class === 'note bad' && n.textContent.includes('epoch resolution'));
	assert.ok(bad, 'expected a bad note');
	assert.match(bad.textContent, /6 epoch resolution failure/);
	assert.match(bad.textContent, /failed OPEN/);
});

test('a read-error alone is a warning, not the open-failure alarm', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [combo('prerender_ops', 'invalidation_error', 'read-error', null, 4)] },
	});
	const node = draw(ctx);
	assert.ok(find(node, (n) => n.attributes?.class === 'note warn' && n.textContent.includes('epoch resolution')));
	assert.doesNotMatch(node.textContent, /failed OPEN/);
});

test('nothing invalidated and nothing touched is the steady state, and the panel says so', async () => {
	const ctx = await ready({
		list: EMPTY_LIST,
		analytics: { ...ANALYTICS, series: [combo('bot_serve', 'cache', 'hit', 'googlebot', 500)] },
	});
	assert.match(draw(ctx).textContent, /Zeros here are the steady state, not a fault/);
});

test('every serve refused with verification OFF is explained as the setting, not the feature failing', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [combo('bot_serve', 'origin', 'invalidated', 'googlebot', 300)] },
		cfg: config({ verification: false }),
	});
	const text = draw(ctx).textContent;
	assert.match(text, /verification off/);
	assert.match(text, /Every touched serve was refused because/);
	// With verification ON and nothing rescued, the refused tile warns instead.
	const on = await ready({
		analytics: { ...ANALYTICS, series: [combo('bot_serve', 'origin', 'invalidated', 'googlebot', 300)] },
	});
	assert.ok(find(tile(on, 'Refused'), (n) => n.attributes?.class === 'value warn'));
});

test('an analytics window that failed to load leaves the rest of the view standing', async () => {
	const ctx = await ready({ analytics: null });
	const text = draw(ctx).textContent;
	assert.match(text, /Active invalidations/);
	assert.match(text, /Record an invalidation/);
	assert.match(text, /No bot_serve data in this window/);
});
