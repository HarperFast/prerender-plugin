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
 *   0. NO QUERY STRING (`has-query`). A route that keys a query param says it can change the document.
 *   1. THE SPELLING HAS NO TARGET THE RENDER PATH KEEPS (`has-target`): none of its own, or one suppressed
 *      as a CANONICAL VERDICT (`canonical-mismatch`, `canonical-variant`) — its own render found that the
 *      page names its canonical elsewhere, which is exactly the case this answers (measured on one
 *      deployment, one crawler made ~11k such misses a day). A row in rotation (a new canonical arriving
 *      from the sitemap) or suppressed about the URL itself (a 404, a noindex) is the render path's.
 *   2. ONE CANDIDATE. Among the entity's targets in rotation, one has a page for this device that is a
 *      200, indexable, inside its own expiry (`hit` — not SWR) and not covered by an invalidation it
 *      predates. None: `no-sibling` / `no-page` / `not-indexable` / `stale` / `invalidated`. More than one
 *      is decided by the ENTITY REGISTRY (util/entity.js) when it names one of them — a re-slug whose new
 *      canonical has rendered while the old spelling has not yet been suppressed — and is `ambiguous`
 *      otherwise, as is more rows than the read covers. A choice is never guessed: measured, the entity had
 *      exactly one servable spelling in 199 of 199 cases, and it was the canonical the variant's own
 *      document declared.
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
 *   3b. THE REGISTRY HAS NOT HEARD OTHERWISE SINCE (`moved`). With the registry on, its canonical is the
 *      origin's most recent word on where the entity lives, from whichever fetch saw it first — the probe, a
 *      render (a canonical verdict's declared canonical included), a serve-time check, or a miss proxied to
 *      the origin (util/originCanonical.js). When it names ANOTHER document, first heard after the candidate
 *      was last confirmed (rendered, or checked and agreed), the candidate predates a re-slug: its page still
 *      names the old slug, and it is not handed to other spellings. This is what closes the window between a
 *      daytime re-slug and the next check of the old page: the first origin fetch to see it vetoes, and the
 *      same observation adopted the new canonical (filed due now), which serves once it renders. An
 *      unreadable instant vetoes.
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
 * read per target in rotation under the prefix (almost always one), one `Entity` point read once there is a
 * page to serve (registry on; node-local, replicated), a `PageCheck` read only when the render alone does
 * not confirm, the body read, and a head scan that stops at the canonical (~0.5% into a product page). The
 * range read also answers guard 1: the spelling's own row, if it has one, is under the same prefix. Each
 * evaluation's duration is `prerender_ops` / `entity_serve_ms`.
 *
 * ── WHAT IT NEEDS BESIDE IT ───────────────────────────────────────────────────────────────────
 *
 * The entity discovery gate, ARMED. A spelling this does not answer — every one, in a dry run — goes to
 * the origin, and that miss mints it for a crawler allowed to mint (`handlePageScheduling`); from then on
 * guard 1 refuses it. Armed, the gate does not mint a spelling whose entity is in rotation. A served
 * spelling is never minted either way: it was not a miss. So with the gate in dry run, `would-serve`
 * counts only each spelling's first request, and its repeats read `has-target`.
 *
 * `held` CONFIRMS. A held row is a disagreement on some other field that re-rendering cannot fix, and its
 * page is served with it at its own URL anyway; the canonical, the only thing this guard is about, agreed.
 *
 * A DRY RUN STILL OFFERS. An unconfirmed candidate is offered to the serve-time check in a dry run too,
 * which then asks the origin and acts on what it finds under its own switches: confirming a page is that
 * check's ordinary job, and the dry-run number would otherwise undercount what arming confirms.
 *
 * Every failure falls through: an error, an unreadable row or body, a scan that cannot read the canonical.
 * Nothing here can serve a page the guards did not pass, and nothing here can fail a request.
 */

import { config } from '../config.js';
import { metrics } from '../metrics.js';
import { CacheKey } from './cacheKey.js';
import { entityPrefixOf, inRotation } from './entityGate.js';
import { canonicalFormOf, entitiesOn, readEntity, sameDocument } from './entity.js';
import { resolveServeStatus } from './pageFreshness.js';
import { resolveInvalidation } from './invalidation.js';
import { queryAllowlistFor, routeScopeForEntry } from './routeClass.js';
import { readPageCheck } from './pageCheck.js';
import { lastAnchorAt } from './changeProbe.js';
import { checkComparesFact, considerServeCheck, serveChecksOn } from './serveCheck.js';
import { materializeCachedBody } from './cachedBody.js';
import { documentFactsOf } from './documentFacts.js';
import { headersToObject } from './headers.js';
import { canonicalizeUrl } from './url.js';
import { dateColumnMs, MINUTE } from './time.js';

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
	/** The spelling carries a query string: on a route that keys one, it may be another document. */
	HAS_QUERY: 'has-query',
	/**
	 * This spelling has a Target of its own that the render path keeps: in rotation, or suppressed for a
	 * reason that is about this URL (a 404, a noindex). One suppressed as a canonical verdict is answered.
	 */
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
	/**
	 * The entity registry heard the origin name ANOTHER canonical after the candidate was last confirmed: a
	 * re-slug the candidate predates. Its page still names the old slug, so it is not handed to other spellings.
	 */
	MOVED: 'moved',
	/** The candidate's own canonical does not name it (or could not be read off its head). */
	NOT_SELF_CANONICAL: 'not-self-canonical',
	/** The candidate's body could not be read. Also counted on `serve_error`. */
	UNREADABLE: 'unreadable',
	/** A read threw. Logged. */
	ERROR: 'error',
});

/**
 * How long before its store or its check a candidate's confirmation READ the origin, at most. The registry stamps
 * every observation with when the origin was read (a render's store time less its renders, a check's request),
 * but a page row carries only its store time and a check its write time. So a confirmation is taken as made this
 * much earlier, and an observation of another canonical in that gap vetoes it: the safe direction, since the gap
 * is where a re-slug can land between the candidate's read and its store. Renders run seconds; this covers a slow
 * one and its result post.
 */
export const CONFIRMATION_READ_SLACK_MS = 2 * MINUTE;

/**
 * Rows one evaluation reads under the prefix — every target of the entity, its spellings suppressed or
 * not, and this spelling's own row if it has one. Larger than the discovery gate's 3 because this read
 * must prove a NEGATIVE (no second candidate, no row of its own), and only a read that ends before the
 * limit proves it: measured, no entity on a production catalog had more than 4 targets. An entity with
 * more than this falls through as `ambiguous`. Fixed, for the gate's reason: a knob would only be a way to
 * get it wrong.
 */
export const ENTITY_READ_LIMIT = 8;

// What the read projects: each row's key and state, and — for this spelling's own row — why it was suppressed.
// An ARRAY: a string `select` projects to a bare scalar.
export const ENTITY_ROW_SELECT = Object.freeze([
	'url',
	'state',
	'suppressedReason',
	'suppressedAt',
	'suppressedCanonical',
]);

// A spelling whose own target is suppressed as a CANONICAL VERDICT is answered: its own render found that the
// page names its canonical elsewhere, which is exactly the case this serve exists for. Measured on one
// deployment, one crawler made ~11k such misses a day. Any other suppression is a statement about this URL
// (it 404s, it is noindex) and the render path keeps it.
const ANSWERED_SUPPRESSIONS = new Set(['canonical-mismatch', 'canonical-variant']);
const keptByRenderPath = (own) =>
	own !== null && !(own.state === 'suppressed' && ANSWERED_SUPPRESSIONS.has(own.suppressedReason));

/**
 * The entity's rows under `prefix`: `{ own, inRotation, complete }` — `url`'s own row (`{ state,
 * suppressedReason }`, or null when it has none),
 * the keys of the OTHER rows in rotation, and whether the read saw every row under the prefix (it ended on
 * a key outside the prefix, or before the limit). An unreadable row makes the read incomplete: it could be
 * this spelling's own row, or a second candidate.
 *
 * THE LOOP BODY DOES NOT AWAIT, so the cursor is released before anything else happens (util/scan.js).
 */
export const readEntityRows = async ({ table, prefix, url, limit = ENTITY_READ_LIMIT }) => {
	let own = null;
	let read = 0;
	let unreadable = false;
	let ended = false;
	const keys = [];
	for await (const row of table.search(
		{
			conditions: [{ attribute: 'url', comparator: 'greater_than_equal', value: prefix }],
			sort: { attribute: 'url' },
			select: [...ENTITY_ROW_SELECT],
			// ONE PAST THE LIMIT: the extra row is what tells an entity with exactly `limit` rows (the next key is
			// outside the prefix, so the read is complete) from one with more (it is not).
			limit: limit + 1,
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
		if (key === url) {
			own = {
				state: row.state ?? null,
				suppressedReason: row.suppressedReason ?? null,
				suppressedAt: row.suppressedAt ?? null,
				suppressedCanonical: row.suppressedCanonical ?? null,
			};
		} else if (inRotation(row)) keys.push(key);
	}
	return { own, inRotation: keys, complete: !unreadable && (ended || read <= limit) };
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
 * Offer an unconfirmed candidate to the serve-time check (util/serveCheck.js). The check decides for itself
 * whether it is due, deduped and within budget, against THIS threshold as well as its own, so a check the
 * entity serve cannot use (before `maxConfirmAge`) is not taken as covering it. The bytes are a loader the
 * check calls only once it is due — most offers are turned away by its dedupe first, and a blob read for
 * each would be the expensive half of the offer — and it re-reads the row as it stands then.
 */
const offerCheck = ({ url, cacheKey, page, threshold, deviceType, botName, route }) => {
	if (!serveChecksOn()) return;
	considerServeCheck({
		kind: 'page',
		url,
		lastCachedMs: dateColumnMs(page.lastCached),
		body: async () => {
			const row = await deps.readPage(cacheKey);
			const read = row ? await deps.readBody(row) : null;
			return read?.ok ? read.body : null;
		},
		headers: page.headers ?? null,
		cacheKey,
		dueSince: threshold,
		deviceType,
		botName,
		route,
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
	registryOn: entitiesOn,
	readEntity,
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
	const startedAt = performance.now();
	const decided = (outcome, serve = null) => {
		metrics.entityServe(outcome, botName);
		metrics.entityServeMs(performance.now() - startedAt);
		return { outcome, serve };
	};
	try {
		const prefix = entityPrefixOf(cacheUrl, route);
		if (!prefix) return decided(EntityServeOutcome.NO_PREFIX);
		// A route that keys a query param says the param can change the document; the canonical's render is
		// one document. (A route whose key drops the query never gets here with one.)
		if (URL.parse(cacheUrl)?.search) return decided(EntityServeOutcome.HAS_QUERY);

		const rows = await readEntityRows({ table: deps.targets(), prefix, url: cacheUrl });
		if (keptByRenderPath(rows.own)) return decided(EntityServeOutcome.HAS_TARGET);
		if (!rows.complete) return decided(EntityServeOutcome.AMBIGUOUS);
		if (rows.inRotation.length === 0) return decided(EntityServeOutcome.NO_SIBLING);

		let refusal = EntityServeOutcome.NO_PAGE;
		let epoch;
		const servable = [];
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
			servable.push({ url, cacheKey, page });
		}
		if (servable.length === 0) return decided(refusal);

		// THE ENTITY REGISTRY (util/entity.js): the canonical the origin named most recently, by any observer — a
		// probe, a render, a serve-time check, a proxied origin document. One node-local point read, only once
		// there is something to serve. It breaks a tie between two servable spellings (a re-slug whose new
		// canonical has rendered while the old one has not yet been suppressed), and it vetoes below.
		const registry = deps.registryOn() ? await deps.readEntity(prefix) : null;
		const named = typeof registry?.canonical === 'string' ? registry.canonical : null;
		let candidate = servable[0];
		if (servable.length > 1) {
			candidate = named ? servable.find((option) => sameDocument(option.url, named)) : null;
			if (!candidate) return decided(EntityServeOutcome.AMBIGUOUS);
		}

		const { url, cacheKey, page } = candidate;
		const lastCachedMs = dateColumnMs(page.lastCached);
		const threshold = confirmThreshold(nowMs, settings.maxConfirmAge, deps.anchor);
		// When the canonical was last confirmed: the render, or a check of the canonical since it.
		let confirmedAtMs = lastCachedMs;
		if (!(lastCachedMs >= threshold)) {
			// The render alone does not confirm it; a check of its canonical since the threshold can.
			const check = Number.isFinite(threshold) ? await deps.readCheck(url) : null;
			if (!confirmedAt(threshold, lastCachedMs, check)) {
				// Ask for one — only a check that compares the canonical can ever confirm it.
				if (check && deps.comparesCanonical(url, route)) {
					deps.offerCheck({ url, cacheKey, page, threshold, deviceType, botName, route });
				}
				return decided(EntityServeOutcome.UNCONFIRMED);
			}
			confirmedAtMs = Math.max(lastCachedMs, check.checkedAtMs);
		}
		// When the origin was last READ in confirming it (see CONFIRMATION_READ_SLACK_MS).
		const confirmedReadAt = confirmedAtMs - CONFIRMATION_READ_SLACK_MS;
		// THE SPELLING'S OWN VERDICT, when it is suppressed as one: its render said the product lives elsewhere. If
		// that verdict is newer than the candidate's confirmation, it is the newest word on the entity, and the
		// candidate is answered only when the verdict NAMED it (`suppressedCanonical`, browser >= 1.40.0). A verdict
		// that named another URL, or that predates the field, falls through as `moved` until the candidate is
		// confirmed again — which the nightly pass and the serve-time check do. Independent of the registry.
		if (rows.own) {
			const disownedAt = dateColumnMs(rows.own.suppressedAt);
			const verdictNamed =
				typeof rows.own.suppressedCanonical === 'string'
					? (canonicalFormOf(rows.own.suppressedCanonical) ?? rows.own.suppressedCanonical)
					: null;
			if (!(disownedAt <= confirmedReadAt) && !(verdictNamed && sameDocument(verdictNamed, url))) {
				return decided(EntityServeOutcome.MOVED);
			}
		}
		// THE REGISTRY'S VETO. The origin named another canonical AFTER this page was last confirmed: a re-slug it
		// predates, seen by whichever observer got there first. Until the page re-renders (and is suppressed) or
		// a check confirms it again, it is not handed to other spellings. An unreadable instant vetoes: there is
		// no telling which came first.
		if (named && !sameDocument(named, url) && !(dateColumnMs(registry.canonicalAt) <= confirmedReadAt)) {
			return decided(EntityServeOutcome.MOVED);
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
