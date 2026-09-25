/**
 * The Inspect view's explainer, executed — specifically the RENDER CADENCE card.
 *
 * The card exists because "how often does this URL re-render" had no honest answer in this console
 * before plugin v0.77.0. The Target's `renderInterval` was the only interval on screen, and it is
 * the CEILING the demand ladder schedules inside — for most of a corpus with the ladder armed it is
 * not the cadence, and there was nothing to say so. `explain` now resolves it exactly as the
 * scheduler does and reports the clamp that bound; this pins that the console shows the resolution
 * rather than the ceiling, and that a clamp is legible without arithmetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render, meta } = await import('../src/admin/views/inspect.js');

const HOUR = 3_600_000;

const BROWSE = { pages: [], total: { recordCount: 1234 }, nextCursor: null };

const CONFIG = {
	schema: {
		children: {
			page: { children: { ttl: { kind: 'option' } } },
			cacheKey: { children: { includeDevice: { kind: 'option' } } },
			management: { children: { pageSize: { kind: 'option' } } },
		},
	},
	layers: [{ path: 'page.ttl', effective: 24 * HOUR }],
};

/** The explain body, shaped as PrerenderAdmin.explain returns it. */
const explain = (cadence) => ({
	resolved: {
		cacheKey: 'www.example.com/catalog/x.jsp?CN=a|desktop',
		canonicalUrl: 'https://www.example.com/catalog/x.jsp?CN=a',
		deviceType: 'desktop',
		deviceTypeFellBack: false,
	},
	ingress: { mode: 'forwarded', routeClass: 'prerender', route: null },
	allowlist: { used: ['CN'], source: 'route' },
	underGlobalAllowlist: { differs: false, allowlist: ['CN'] },
	eligibility: { prerendered: true, domainAllowed: true, excludedByPattern: null },
	verdict: { recurring: true, suppressed: false },
	residency: { scheduleReadIsAuthoritative: true, scheduleAuthoritative: true, queriedNode: 'node-a' },
	degraded: null,
	cadence,
	rows: {
		renderTarget: { url: 'https://www.example.com/catalog/x.jsp?CN=a', renderInterval: 24 * HOUR, state: 'active' },
		renderSchedule: null,
		prerenderedPage: null,
		suppression: null,
	},
});

function makeCtx(result) {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	const calls = { posts: [] };
	const ctx = {
		calls,
		scratch,
		busy: false,
		get data() {
			return scratch('inspect');
		},
		async get(route) {
			if (route === 'pages') return { ok: true, body: BROWSE };
			if (route === 'config') return { ok: true, body: CONFIG };
			return { ok: true, body: {} };
		},
		async post(route, body) {
			calls.posts.push({ route, body });
			return { ok: true, body: {} };
		},
		render() {},
		reload() {},
		go() {},
	};
	ctx.data.result = result;
	return ctx;
}

const textOf = (ctx) => el('div', null, render(ctx)).textContent;

const ready = async (cadence) => {
	const ctx = makeCtx({ ok: true, body: explain(cadence) });
	await load(ctx);
	return ctx;
};

test('the cadence card shows the resolution, and the target row is labelled as the ceiling', async () => {
	const ctx = await ready({
		effectiveInterval: 6 * HOUR,
		baseFrom: 'route',
		baseInterval: 24 * HOUR,
		routeInterval: 24 * HOUR,
		storedInterval: null,
		defaultInterval: 24 * HOUR,
		demandInterval: 6 * HOUR,
		demandFloor: null,
		clampedBy: null,
	});
	const text = textOf(ctx);
	assert.match(text, /Render cadence/);
	assert.match(text, /Effective interval/);
	assert.match(text, /what the scheduler actually files/);
	assert.match(text, /ladder rung applied/);
	// The Target card's interval is the ceiling this is clamped into — reading it as the cadence is
	// the mistake the card exists to prevent, so it says which it is.
	assert.match(text, /Render interval \(ceiling\)/);
});

test('a floor clamp says the ladder has no range here, which one number could never say', async () => {
	const ctx = await ready({
		effectiveInterval: 12 * HOUR,
		baseFrom: 'route',
		baseInterval: 24 * HOUR,
		routeInterval: 24 * HOUR,
		storedInterval: null,
		defaultInterval: 24 * HOUR,
		demandInterval: 6 * HOUR,
		demandFloor: 12 * HOUR,
		clampedBy: 'floor',
	});
	const text = textOf(ctx);
	assert.match(text, /clamped by demandFloor/);
	assert.match(text, /no range to work in/);
	// Both sides of the clamp are on screen: the rung the ladder wanted, and the floor that refused.
	assert.match(text, /Demand rung/);
	assert.match(text, /Demand floor/);
});

test('a ceiling clamp reports the rung as inert rather than as the cadence', async () => {
	const ctx = await ready({
		effectiveInterval: 2 * HOUR,
		baseFrom: 'route',
		baseInterval: 2 * HOUR,
		routeInterval: 2 * HOUR,
		storedInterval: null,
		defaultInterval: 24 * HOUR,
		demandInterval: 6 * HOUR,
		demandFloor: null,
		clampedBy: 'ceiling',
	});
	const text = textOf(ctx);
	assert.match(text, /clamped by the route ceiling/);
	assert.match(text, /the rung is inert here/);
});

test('a URL with no target gets no cadence card at all — absence is the answer, not a row of dashes', async () => {
	const ctx = await ready(null);
	assert.doesNotMatch(textOf(ctx), /Render cadence/);
});

test('an older plugin that sends no intervals never formats a missing one as a real cadence', async () => {
	// `duration()` takes Math.abs, so an unguarded null formats as "0s" and undefined as "NaNs" —
	// both of which read as a configured cadence rather than as an absent field.
	const ctx = await ready({
		effectiveInterval: 24 * HOUR,
		baseFrom: 'default',
		baseInterval: 24 * HOUR,
		routeInterval: null,
		storedInterval: null,
		defaultInterval: 24 * HOUR,
		demandInterval: null,
		demandFloor: null,
		clampedBy: null,
	});
	const text = textOf(ctx);
	assert.doesNotMatch(text, /NaN/);
	assert.doesNotMatch(text, /\b0s\b/);
	assert.match(text, /the ladder has not evaluated this target/);
	assert.match(text, /base interval/);
});

// ---- the redesign: no header, explanations behind help, alerts short but intact ------------

const draw = (ctx) => el('div', null, render(ctx));
const helpText = (node) => {
	const out = [];
	find(node, (n) => {
		if (n.attributes?.class === 'help') out.push(n.textContent);
		return false;
	});
	return out.join('\n');
};

test('no header of its own: the page count moves onto the page-cache card, settings into a section', async () => {
	const ctx = await ready(null);
	const tree = draw(ctx);
	assert.equal(meta.crumb, undefined);
	assert.equal(
		find(tree, (n) => n.attributes?.class === 'view-head'),
		null
	);
	const cacheCard = find(
		tree,
		(n) => String(n.attributes?.class).startsWith('card') && /^Page cache/.test(n.children[0]?.textContent ?? '')
	);
	assert.ok(cacheCard, 'the browse half is a titled card');
	assert.match(cacheCard.children[0].textContent, /1,234 pages/);
	assert.ok(
		find(tree, (n) => n.attributes?.class === 'section'),
		'settings collapse into a section'
	);
});

test('the explainer still posts explain, and its "what is this" text is behind help', async () => {
	const ctx = await ready({
		effectiveInterval: 6 * HOUR,
		baseFrom: 'route',
		baseInterval: 24 * HOUR,
		routeInterval: 24 * HOUR,
		storedInterval: null,
		defaultInterval: 24 * HOUR,
		demandInterval: 6 * HOUR,
		demandFloor: null,
		clampedBy: null,
	});
	const tree = draw(ctx);
	assert.match(helpText(tree), /the fastest way to explain a page that never seems to hit cache/);
	assert.match(helpText(tree), /ceiling this is clamped into/, 'the cadence resolution note is kept');
	const input = find(tree, (n) => n.tagName === 'INPUT' && n.attributes.placeholder?.startsWith('https://'));
	input.value = 'https://www.example.com/catalog/x.jsp?CN=a';
	find(tree, (n) => n.tagName === 'BUTTON' && n.textContent === 'Explain').fire('click');
	assert.deepEqual(ctx.calls.posts.at(-1), {
		route: 'explain',
		body: { url: 'https://www.example.com/catalog/x.jsp?CN=a', deviceType: undefined },
	});
});

test('the hedges survive the shortening: unknown is not absent, not-owner is not "not scheduled"', async () => {
	const body = explain(null);
	body.degraded = { timedOutReads: ['prerenderedPage'] };
	body.residency = {
		scheduleReadIsAuthoritative: false,
		scheduleAuthoritative: false,
		queriedNode: 'node-a',
		scheduleOwnedBy: 'node-b',
		peerError: 'timeout',
	};
	const ctx = makeCtx({ ok: true, body });
	await load(ctx);
	const tree = draw(ctx);
	const text = tree.textContent;
	assert.match(text, /Reads timed out: prerenderedPage/);
	assert.match(text, /unknown, not absent/);
	assert.match(text, /node-a is not this URL’s schedule owner \(node-b\) and could not reach it \(timeout\)/);
	assert.match(text, /“not scheduled on this node”, not “not scheduled”/);
	assert.ok(find(tree, (n) => n.attributes?.class === 'note bad' && /Reads timed out/.test(n.textContent)));
});

test('a row below the owner’s claim floor is still the loud fault, with its cause on the tooltip', async () => {
	const body = explain(null);
	body.residency = {
		scheduleReadIsAuthoritative: false,
		scheduleAuthoritative: true,
		queriedNode: 'node-a',
		scheduleOwnedBy: 'node-b',
	};
	body.rows.renderSchedule = {
		leased: false,
		overdue: true,
		dueInMs: 9 * 60_000,
		belowClaimFloor: true,
		fromSitemap: true,
	};
	const ctx = makeCtx({ ok: true, body });
	await load(ctx);
	const tree = draw(ctx);
	const alarm = find(tree, (n) => n.attributes?.class === 'note bad' && /claim floor/.test(n.textContent));
	assert.ok(alarm);
	assert.match(alarm.textContent, /Scheduled BELOW node-b’s claim floor — nothing will claim it or report an error/);
	assert.match(alarm.textContent, /reset-claim-floor/);
	assert.match(alarm.attributes.title, /written straight to the table/);
	assert.match(tree.textContent, /Schedule row fetched from its owner, node-b \(authoritative\)/);
});
