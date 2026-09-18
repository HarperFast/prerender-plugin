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

import { installDom } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render } = await import('../src/admin/views/inspect.js');

const HOUR = 3_600_000;

const BROWSE = { rows: [], total: { recordCount: 0 }, nextCursor: null };

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
	const ctx = {
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
		async post() {
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
