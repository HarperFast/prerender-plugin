/**
 * THE ENTITY SERVE: a miss for one spelling of an entity's URL is answered from the cached render of the
 * entity's canonical URL, instead of proxying the origin or raw-caching the spelling.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Crawlers ask for spellings of a product nobody declared: an old slug, a capitalised one, a placeholder
 * (`/product/prd-1/product.jsp`). Measured on one production origin, 93% of the product documents the
 * raw cache stored sat at a spelling other than their own canonical — and in every one of them the same
 * product, never another. That origin answers every spelling with the same document (identical
 * canonical, title, description, offers and breadcrumbs, 68 of 70 compared, the 2 being the origin
 * changing between fetches), declares the canonical in each, and the canonical's render was cached,
 * fresh and indexable for 199 of 200 sampled spellings. Serving that render:
 *
 *   - answers the FIRST request for a spelling, where a raw cache only answers repeats;
 *   - stores nothing, so it replicates nothing (raw rows replicate to every node);
 *   - serves the rendered page, not the unrendered origin document.
 *
 * ── WHEN IT SERVES (each guard falls through to the ordinary miss path, and is counted) ──────────
 *
 * Only for a TRUE miss (no page row for this key) on a route that sets `entityServe` beside its
 * `entityPrefix` (util/entityGate.js says what an entity prefix is), and only when ALL of these hold:
 *
 *   1. THE SPELLING HAS NO TARGET OF ITS OWN (`has-target`). A spelling with a row belongs to the render
 *      path: a new canonical arriving from the sitemap, a duplicate the render verdict suppressed.
 *   2. EXACTLY ONE CANDIDATE. Among the entity's targets in rotation, exactly one has a page for this
 *      device that is a 200, indexable, inside its own expiry (`hit` — not SWR) and not covered by an
 *      invalidation it predates. None: `no-sibling` / `no-page` / `not-indexable` / `stale` /
 *      `invalidated`; more than one, or more rows than the read covers: `ambiguous`. A choice is never
 *      guessed: measured, the entity had exactly one servable spelling in 199 of 199 cases, and it was
 *      the canonical the variant's own document declared.
 *   3. ITS CANONICAL CONFIRMED SINCE THE THRESHOLD (`unconfirmed`): rendered at or after it, or checked
 *      against the origin at or after it by a check that compared the page's canonical with the origin's
 *      and found them the same (`PageCheck.canonicalAgreed`, written by the serve-time check and by the
 *      sweep — so the probe rule must map `canonical`, and keep its slot out of `ignoreChanges` so a
 *      re-spell is a change the sweep acts on). The threshold is the last anchor in anchored mode,
 *      tightened by `maxConfirmAge`; outside anchored mode with no `maxConfirmAge`, nothing is ever
 *      confirmed. WHY: the origin re-spells slugs — one wave moved canonical-mismatch from 4% to 45% of
 *      render outcomes in 2.5h. Between a re-spell and the re-render of the old page, the old page still
 *      names its old slug while the origin already declares the new one at every spelling; serving it at
 *      more spellings would spread that contradiction. Confirmation bounds it to what the page itself
 *      already serves at its own URL. An unconfirmed candidate is OFFERED to the serve-time check, under
 *      that check's own switches, bots and budget, so the request that found it unconfirmed is what gets
 *      it confirmed.
 *   4. IT NAMES ITSELF (`not-self-canonical`): the served bytes' own `<link rel=canonical>`, read off the
 *      head (util/documentFacts.js), canonicalizes to that target's URL. `isIndexable` alone does not say
 *      this — a page with no canonical is indexable too.
 *
 * Then it is served as source and status `entity`, with the canonical's own stored headers and its own
 * validators, and counted on `bot_serve` / `route_serve`. A serve-time check of it checks the CANONICAL's
 * key, never the spelling's.
 *
 * ── WHAT IT COSTS ──────────────────────────────────────────────────────────────────────────────
 *
 * Only on an opted-in route's true misses, in place of an origin round trip: one bounded primary-key range
 * read of `Target` (node-local: Target is not residency-pinned; `replicateFrom: false` anyway), one page
 * read per target in rotation under the prefix (almost always one), a `PageCheck` read only when the
 * render alone does not confirm, the body read, and a head scan that stops at the canonical (~0.5% into a
 * product page). The range read also answers guard 1: the spelling's own row, if it has one, is under the
 * same prefix.
 *
 * ── WHAT IT NEEDS BESIDE IT ───────────────────────────────────────────────────────────────────
 *
 * The entity discovery gate, ARMED. A spelling a crawler is allowed to mint gets a Target on its first
 * miss (`handlePageScheduling`), and from then on guard 1 refuses it: with the gate in dry run, this
 * answers only the first request for each spelling a minting crawler asks for. Armed, the gate does not
 * mint a spelling whose entity is in rotation, so it never gets a row and every request for it can be
 * served from here.
 *
 * Every failure falls through: an error, an unreadable row or body, a scan that cannot read the canonical.
 * Nothing here can serve a page the guards did not pass, and nothing here can fail a request.
 */

import { config } from '../config.js';
import { metrics } from '../metrics.js';
import { CacheKey } from './cacheKey.js';
import { entityPrefixOf, inRotation, SIBLING_SELECT } from './entityGate.js';
import { resolveServeStatus } from './pageFreshness.js';
import { resolveInvalidation } from './invalidation.js';
import { queryAllowlistFor, routeScopeForEntry } from './routeClass.js';
import { readPageCheck } from './pageCheck.js';
import { lastAnchorAt, serveChecksArmed } from './changeProbe.js';
import { checkComparesFact, considerServeCheck, serveChecksOn } from './serveCheck.js';
import { materializeCachedBody } from './cachedBody.js';
import { documentFactsOf } from './documentFacts.js';
import { headersToObject } from './headers.js';
import { canonicalizeUrl } from './url.js';
import { dateColumnMs } from './time.js';

/**
 * Every outcome of one evaluation, as recorded on `prerender_ops` / `entity_serve`. Exactly one per
 * evaluation, so the series sums to "true misses on entity-serve routes".
 */
export const EntityServeOutcome = Object.freeze({
	/** Served from the canonical's render. Also `bot_serve` source `entity`. */
	SERVED: 'served',
	/** Every guard passed, but `dryRun` is on: the miss path answered it — the rollout number. */
	WOULD_SERVE: 'would-serve',
	/** This URL produced no usable entity prefix (util/entityGate.js `entityPrefixOf`). */
	NO_PREFIX: 'no-prefix',
	/** This spelling has a Target of its own: the render path's. */
	HAS_TARGET: 'has-target',
	/** No other target of the entity is in rotation. */
	NO_SIBLING: 'no-sibling',
	/** Targets in rotation, none with a page for this device. */
	NO_PAGE: 'no-page',
	/** The only pages are not a 200, or not indexable. */
	NOT_INDEXABLE: 'not-indexable',
	/** The only pages are past their expiry (SWR included: an entity serve wants a fresh page). */
	STALE: 'stale',
	/** The only pages predate an active invalidation of the route. */
	INVALIDATED: 'invalidated',
	/** More than one servable page, or more rows under the prefix than the read covers: no guessing. */
	AMBIGUOUS: 'ambiguous',
	/** The candidate was neither rendered nor checked-and-agreed since the threshold. */
	UNCONFIRMED: 'unconfirmed',
	/** The candidate's own canonical does not name it (or could not be read off its head). */
	NOT_SELF_CANONICAL: 'not-self-canonical',
	/** The candidate's body could not be read. Also counted on `serve_error`. */
	UNREADABLE: 'unreadable',
	/** A read threw. Logged. */
	ERROR: 'error',
});

/**
 * Rows one evaluation reads under the prefix — every target of the entity, its spellings suppressed or
 * not, and this spelling's own row if it has one. Larger than the discovery gate's 3 because this read
 * must prove a NEGATIVE (no second candidate, no row of its own), and only a read that ends before the
 * limit proves it: measured, no entity on a production catalog had more than 4 targets. An entity with
 * more than this falls through as `ambiguous`. Fixed, for the gate's reason: a knob would only be a way to
 * get it wrong.
 */
export const ENTITY_READ_LIMIT = 8;

/**
 * The entity's rows under `prefix`: `{ own, inRotation, complete }` — whether `url` has a row of its own,
 * the keys of the OTHER rows in rotation, and whether the read saw every row under the prefix (it ended on
 * a key outside the prefix, or before the limit). An unreadable row makes the read incomplete: it could be
 * this spelling's own row, or a second candidate.
 *
 * THE LOOP BODY DOES NOT AWAIT, so the cursor is released before anything else happens (util/scan.js).
 */
export const readEntityRows = async ({ table, prefix, url, limit = ENTITY_READ_LIMIT }) => {
	let own = false;
	let read = 0;
	let unreadable = false;
	let ended = false;
	const keys = [];
	for await (const row of table.search(
		{
			conditions: [{ attribute: 'url', comparator: 'greater_than_equal', value: prefix }],
			sort: { attribute: 'url' },
			select: [...SIBLING_SELECT],
			limit,
		},
		{ replicateFrom: false }
	)) {
		read++;
		const key = row?.url;
		if (typeof key !== 'string') {
			unreadable = true;
			continue;
		}
		// Ascending order: the first key outside the prefix proves every later key is outside it too.
		if (!key.startsWith(prefix)) {
			ended = true;
			break;
		}
		if (key === url) own = true;
		else if (inRotation(row)) keys.push(key);
	}
	return { own, inRotation: keys, complete: !unreadable && (ended || read < limit) };
};

// The anchor moves once a day and resolving it costs two Intl calls: re-read at most once a minute per
// worker, as the serve-time check does.
let anchorMemo = { at: -Infinity, value: NaN };
const anchorAt = (nowMs, anchor) => {
	if (nowMs - anchorMemo.at >= 60_000) anchorMemo = { at: nowMs, value: anchor() };
	return anchorMemo.value;
};

/**
 * The instant a candidate must have been rendered or confirmed at or after: the later of the last anchor
 * (anchored mode) and `now - maxConfirmAge` (when set). NaN when neither applies — then nothing is
 * confirmed, and nothing is served.
 */
export const confirmThreshold = (nowMs, maxConfirmAge, anchor = lastAnchorAt) => {
	const anchored = anchorAt(nowMs, anchor);
	const aged = maxConfirmAge > 0 ? nowMs - maxConfirmAge : NaN;
	if (Number.isFinite(anchored) && Number.isFinite(aged)) return Math.max(anchored, aged);
	return Number.isFinite(anchored) ? anchored : aged;
};

/**
 * Was the canonical of a page whose own `lastCached` is `lastCachedMs` confirmed at `thresholdMs`? Rendered
 * then or since — the render itself read the origin's canonical and found it named the page — or covered by
 * a check then or since that compared the page's canonical with the origin's and found them the same
 * (`canonicalAgreed`). Not `pageCheck.coveredAt`, which counts any decided check, and not the outcome: an
 * 'agree' is "nothing compared disagreed", and says nothing about a canonical the check never compared. A
 * 'mismatch' confirms nothing even when its canonical agreed: the page is being expired.
 * NaN-safe: every unreadable value reads as unconfirmed.
 */
export const confirmedAt = (thresholdMs, lastCachedMs, check) =>
	lastCachedMs >= thresholdMs ||
	(check?.canonicalAgreed === true &&
		check.outcome !== 'mismatch' &&
		check.checkedAtMs >= thresholdMs &&
		lastCachedMs >= check.basisAtMs);

// How close a refused page came to serving, so an entity whose only page fails says why. Higher wins.
const REFUSAL_RANK = Object.freeze({
	[EntityServeOutcome.NO_PAGE]: 0,
	[EntityServeOutcome.NOT_INDEXABLE]: 1,
	[EntityServeOutcome.STALE]: 2,
	[EntityServeOutcome.INVALIDATED]: 3,
});

/** Why a page cannot be a candidate, or null when it can. */
const refusalOf = (page, nowMs, epoch) => {
	if (!page) return EntityServeOutcome.NO_PAGE;
	if (page.statusCode !== 200 || page.isIndexable !== true) return EntityServeOutcome.NOT_INDEXABLE;
	// No verification pair: a verified page is exempted from an invalidation at its OWN URL, on evidence
	// about its own claims; carrying that exemption to other spellings is not something it proved.
	const { status } = resolveServeStatus({
		expiresAtMs: dateColumnMs(page.expiresAt),
		lastCachedMs: dateColumnMs(page.lastCached),
		swrTtl: config.page.swrTtl,
		now: nowMs,
		epoch,
	});
	if (status === 'hit') return null;
	return status === 'invalidated' ? EntityServeOutcome.INVALIDATED : EntityServeOutcome.STALE;
};

/** Does the page in `bytes` declare `url` as its canonical? Off its head only, and never a guess. */
export const namesItself = (bytes, headers, url) => {
	const { facts } = documentFactsOf(bytes, {
		contentEncoding: headers['content-encoding'] ?? null,
		contentType: headers['content-type'] ?? null,
		want: ['canonical'],
	});
	const canonical = facts?.canonical;
	if (typeof canonical !== 'string' || canonical === '') return false;
	try {
		return canonicalizeUrl(canonical, queryAllowlistFor(canonical)) === url;
	} catch {
		return false;
	}
};

const headersOf = (headers) => {
	try {
		return headersToObject(headers ?? {}) ?? {};
	} catch {
		return {};
	}
};

/**
 * Offer an unconfirmed candidate to the serve-time check (util/serveCheck.js), detached from the response.
 * The check decides for itself whether it is due, deduped and within budget; this only hands it the page.
 * The row is re-read here, outside the request, and its bytes are read only when the check would use them.
 */
const offerCheck = ({ url, cacheKey, deviceType, botName, route }) => {
	if (!serveChecksOn()) return;
	setImmediate(async () => {
		try {
			const page = await deps.readPage(cacheKey);
			if (!page) return;
			const body = serveChecksArmed() ? await deps.readBody(page) : null;
			considerServeCheck({
				kind: 'page',
				url,
				lastCachedMs: dateColumnMs(page.lastCached),
				body: body?.ok ? body.body : undefined,
				headers: page.headers ?? null,
				cacheKey,
				deviceType,
				botName,
				route,
			});
		} catch (e) {
			logger.warn?.(`[prerender] entity serve: offering ${url} to the serve-time check failed: ${e?.message ?? e}`);
		}
	});
};

/** Every effect, injectable for tests. */
const DEFAULTS = Object.freeze({
	targets: () => databases.render_service.Target,
	readPage: (cacheKey) => databases.page_cache.PrerenderedPage.get(cacheKey),
	readCheck: readPageCheck,
	readBody: (page) => materializeCachedBody(page, 'GET'),
	epochOf: (route) => resolveInvalidation(routeScopeForEntry(route)),
	anchor: lastAnchorAt,
	comparesCanonical: (url, route) => checkComparesFact(url, route, 'canonical'),
	offerCheck,
});
let deps = DEFAULTS;
/** Tests: replace effects (merged over the defaults); no argument restores them. */
export const __setEntityServeDepsForTest = (overrides = null) => {
	deps = overrides ? { ...DEFAULTS, ...overrides } : DEFAULTS;
	anchorMemo = { at: -Infinity, value: NaN };
};

/** Does an entity serve apply to a true miss on `route` at all? No I/O. */
export const entityServeApplies = (route, settings = config.ingress.entityServe) =>
	Boolean(settings?.enabled && route?.entityServe === true && route.entityPrefix instanceof RegExp);

/**
 * Evaluate the entity serve for a true miss of `cacheUrl` (a canonical URL-half) for `deviceType` on
 * `route`. Returns `{ outcome, serve }`: `serve` is `{ page, body, url, cacheKey }` — the canonical's page
 * row, its bytes, its URL and its key — only when outcome is `served`; anything else falls through.
 * Records exactly one `entity_serve` outcome. Callers check `entityServeApplies` first.
 */
export async function resolveEntityServe({
	cacheUrl,
	deviceType,
	route,
	botName = null,
	settings = config.ingress.entityServe,
	nowMs = Date.now(),
}) {
	const decided = (outcome, serve = null) => {
		metrics.entityServe(outcome, botName);
		return { outcome, serve };
	};
	try {
		const prefix = entityPrefixOf(cacheUrl, route);
		if (!prefix) return decided(EntityServeOutcome.NO_PREFIX);

		const rows = await readEntityRows({ table: deps.targets(), prefix, url: cacheUrl });
		if (rows.own) return decided(EntityServeOutcome.HAS_TARGET);
		if (!rows.complete) return decided(EntityServeOutcome.AMBIGUOUS);
		if (rows.inRotation.length === 0) return decided(EntityServeOutcome.NO_SIBLING);

		let candidate = null;
		let refusal = EntityServeOutcome.NO_PAGE;
		let epoch;
		for (const url of rows.inRotation) {
			const cacheKey = CacheKey.toCacheKey({ url, deviceType });
			const page = await deps.readPage(cacheKey);
			// The epoch is read once, and only once there is a page to judge.
			if (page && epoch === undefined) epoch = (await deps.epochOf(route)) ?? null;
			const refused = refusalOf(page, nowMs, epoch ?? null);
			if (refused) {
				if (REFUSAL_RANK[refused] > REFUSAL_RANK[refusal]) refusal = refused;
				continue;
			}
			if (candidate) return decided(EntityServeOutcome.AMBIGUOUS);
			candidate = { url, cacheKey, page };
		}
		if (!candidate) return decided(refusal);

		const { url, cacheKey, page } = candidate;
		const lastCachedMs = dateColumnMs(page.lastCached);
		const threshold = confirmThreshold(nowMs, settings.maxConfirmAge, deps.anchor);
		if (!(lastCachedMs >= threshold)) {
			// The render alone does not confirm it; a check of its canonical since the threshold can.
			const check = Number.isFinite(threshold) ? await deps.readCheck(url) : null;
			if (!confirmedAt(threshold, lastCachedMs, check)) {
				// Ask for one — only a check that compares the canonical can ever confirm it.
				if (check && deps.comparesCanonical(url, route)) deps.offerCheck({ url, cacheKey, deviceType, botName, route });
				return decided(EntityServeOutcome.UNCONFIRMED);
			}
		}

		const body = await deps.readBody(page);
		if (!body.ok || !body.body) {
			// The blob-health signal, emitted wherever a local blob fails, whatever answers the request.
			metrics.serveError(body.reason === 'timeout' ? 'blob-timeout' : 'blob-unreadable');
			return decided(EntityServeOutcome.UNREADABLE);
		}
		if (!namesItself(body.body, headersOf(page.headers), url)) return decided(EntityServeOutcome.NOT_SELF_CANONICAL);

		if (settings.dryRun) return decided(EntityServeOutcome.WOULD_SERVE);
		return decided(EntityServeOutcome.SERVED, { page, body: body.body, url, cacheKey });
	} catch (e) {
		logger.warn?.(`[prerender] entity serve: ${cacheUrl} fell through on an error: ${e?.message ?? String(e)}`);
		return decided(EntityServeOutcome.ERROR);
	}
}
