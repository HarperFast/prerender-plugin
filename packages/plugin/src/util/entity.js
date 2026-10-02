/**
 * THE ENTITY REGISTRY: one `Entity` row per entity a route declares (a product), keyed by its entity prefix,
 * holding the entity's CURRENT CANONICAL URL. Issue #166.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────────────────────
 *
 * `Target` is keyed by URL, so two spellings of one product are two unrelated rows and nothing knows which
 * of them the origin calls canonical. Measured on one production deployment (2026-10-02): products re-slug
 * ~100 times a day; the product sitemap changes once a day; and a product that is out of stock is not in
 * the sitemap at all, so its new canonical never arrives from there. It arrived only by traffic discovery,
 * whose first render is jittered across the route's whole interval (96h), and both spellings missed until
 * then. This table is where "which URL is this product's canonical now" lives, and phase 1 of #166 uses it
 * to ADOPT a canonical the change probe sees and no target holds.
 *
 * ── THE KEY ───────────────────────────────────────────────────────────────────────────────────
 *
 * The entity prefix (util/entityGate.js `entityPrefixOf`): the URL origin plus the route's `entityPrefix`
 * match, `https://www.example.com/product/prd-123/`. Any spelling of the entity computes it, it works for
 * any site that declares an entity prefix, and it is the id a probe rule captures for its endpoint. A route
 * with no `entityPrefix` has no entities.
 *
 * ── WHO WRITES THE CANONICAL, AND WHY THE NEWEST WINS ─────────────────────────────────────────
 *
 * Every fetch from the origin that says which URL is the entity's canonical, and nothing else. On a site
 * whose every spelling of a product is one document (the reason a route sets `entityServe`), each of them is
 * the origin's own answer for the product id, so a junk spelling cannot invent a canonical — the reason
 * "adopt the canonical" was unsafe on catalog facets does not apply:
 *
 *   probe    the change probe's mapped `canonical` slot (the consumer's rule: the details endpoint's
 *            seoURL), every night for every product.
 *   render   a stored render's `pageFacts.canonical`, and the canonical a canonical VERDICT declared
 *            (browser >= 1.40.0 `declaredCanonical`): the render of an old spelling after a re-slug is
 *            often the first fetch to see it.
 *   check    a serve-time check: the endpoint's canonical slot, or the origin document's canonical.
 *   origin   a proxied origin document on an `entityServe` route (util/originCanonical.js): every miss
 *            that reaches the origin, read off its head as the crawler's bytes stream by.
 *
 * Either one moves the canonical only with an observation NEWER than the one that set it, so a render
 * claimed before a re-slug and landing after the probe saw it cannot move the canonical back. Its instant
 * is when the origin was READ, not when the result arrived: a render's is its store time less its longest
 * render. A canonical outside the entity's own prefix is refused (`foreign`): it names another entity.
 *
 * ── DERIVED, NEVER AUTHORITATIVE ──────────────────────────────────────────────────────────────
 *
 * `Target` stays the render registry. This says which target is the canonical. Not residency-pinned, and
 * replicated like `Target`: writes are rare (an entity's first observation, then only a MOVE — an
 * unchanged observation writes nothing), and every node answers a point read locally.
 *
 * Inert unless `entities.enabled`. Every failure is counted and swallowed: nothing here may cost a render
 * result or a probe.
 */

import { config } from '../config.js';
import { metrics } from '../metrics.js';
import { CacheKey } from './cacheKey.js';
import { entityPrefixOf } from './entityGate.js';
import { classifyPath, matchRoute, PRERENDER, queryAllowlistFor } from './routeClass.js';
import { canonicalizeUrl } from './url.js';
import { currentMinuteMs, dateColumnMs } from './time.js';
import { getSab } from './coordination.js';
import { createHourlyBudget, hourlyBudgetLength } from './hourlyBudget.js';
import { Target } from '../resources/Target.js';

const table = () => databases.render_service.Entity;

// What a write or a read touches. An ARRAY: a string `select` projects to a bare scalar.
const ENTITY_SELECT = Object.freeze([
	'id',
	'canonical',
	'canonicalFrom',
	'canonicalAt',
	'adoptedCanonical',
	'adoptedAt',
	'wouldAdoptCanonical',
	'wouldAdoptAt',
]);

/** Every outcome of observing a canonical (`prerender_ops` / `entity_canonical`). */
export const CanonicalOutcome = Object.freeze({
	/** The entity's first row. */
	NEW: 'new',
	/** The canonical moved: a re-slug, or a first observation correcting another. */
	MOVED: 'moved',
	/** The same canonical again: nothing written. */
	SAME: 'same',
	/** A different canonical, observed before the one stored: ignored. */
	OLDER: 'older',
	/**
	 * Not this entity's canonical to record: under another entity's prefix, or carrying a query string the route
	 * keys (one document per entity has no query to vary by). Ignored.
	 */
	FOREIGN: 'foreign',
	/**
	 * An `origin` observation (a crawler's proxied miss) of an entity the registry has no row for: not recorded,
	 * so a crawler asking for invented product ids cannot create rows. Every entity this plugin renders gets its
	 * row from the probe or a render.
	 */
	UNTRACKED: 'untracked',
	/** A canonical that is not a URL this can key. */
	UNREADABLE: 'unreadable',
	/** A read or a write threw. Logged. */
	ERROR: 'error',
});

/** Every outcome of an adoption check (`prerender_ops` / `canonical_adopt`). */
export const AdoptOutcome = Object.freeze({
	/** A target created for the canonical, due now. */
	ADOPTED: 'adopted',
	/** The canonical's target was suppressed as a canonical verdict; reactivated, due now. */
	REACTIVATED: 'reactivated',
	/** Either of the above under a dry run: counted, nothing written. */
	WOULD_ADOPT: 'would-adopt',
	/** The canonical already has a target in rotation — the ordinary case for a duplicate spelling. */
	EXISTS: 'exists',
	/** Its target is suppressed for a reason the origin's word does not overturn (a 404, a noindex). */
	SUPPRESSED: 'suppressed',
	/** The entity was adopted (or, in a dry run, would have been) within `retryAfter`, whichever canonical. */
	RECENT: 'recent',
	/** Past `entities.adopt.maxPerHour` on this node this hour. */
	CAPPED: 'capped',
	/** Too long to be a key, off the domain allowlist, or not on a prerender route. */
	REFUSED: 'refused',
	/** A read or a write threw. Logged. */
	ERROR: 'error',
});

/** Is the registry on at all? */
export const entitiesOn = () => config.entities?.enabled === true;

/** The entity a URL belongs to: `{ key, route }`, or null when its route declares no entity prefix. */
export const entityOf = (url) => {
	if (typeof url !== 'string') return null;
	const route = matchRoute(URL.parse(url)?.pathname ?? '');
	const key = route?.mode === PRERENDER ? entityPrefixOf(url, route) : null;
	return key ? { key, route } : null;
};

/** The canonical form of a URL, keyed exactly as its route keys it, or null. */
export const canonicalFormOf = (url) => {
	try {
		return canonicalizeUrl(url, queryAllowlistFor(url));
	} catch {
		return null;
	}
};

/** An entity's row, or null. Every failure reads as "no row". */
export const readEntity = async (key) => {
	try {
		return (await table().get({ id: key, select: [...ENTITY_SELECT] })) ?? null;
	} catch {
		return null;
	}
};

/**
 * Do two keyed URLs name the same document, however a sub-delimiter is spelled? `%27` and `'` (and the rest
 * `decodeURI` decodes: everything but the reserved delimiters) are one document at any origin that decodes
 * them, and the change probe's own canonical comparator (`path`) already treats them so. An endpoint that
 * spells a slug raw while the sitemap — and so the Target key — percent-encodes it must not read as a new
 * canonical: that would adopt a duplicate target on every pass and flap the row against every render.
 */
export const sameDocument = (a, b) => a === b || (safeDecodeURI(a) ?? a) === (safeDecodeURI(b) ?? b);
const safeDecodeURI = (value) => {
	try {
		return decodeURI(value);
	} catch {
		return null;
	}
};

/**
 * Record that the origin, observed at `atMs` by `from` ('probe' | 'render' | 'check' | 'origin'), names `canonical` as the
 * canonical of the entity `url` belongs to. Returns `{ outcome, key, canonical, row }`: `canonical` is the
 * keyed form the registry holds for it, `row` the entity as it stands after this observation (null when there
 * is no entity). Never throws.
 *
 * `canonicalAt` is when the CURRENT canonical was first observed, not when it was last confirmed: an
 * unchanged observation writes nothing, so a disagreeing observation wins when the origin was read after
 * the canonical it contradicts was established.
 *
 * Every write is a PATCH naming the key (a patch of a missing row creates it, holding only what it names):
 * two first observations racing — a render and a probe, or two nodes probing two spellings — then merge,
 * and neither can erase what the adoption recorded on the row.
 */
export async function observeCanonical({ url, canonical, from, atMs, createIfMissing = true }) {
	if (!entitiesOn()) return { outcome: null, key: null, canonical: null, row: null };
	const entity = entityOf(url);
	if (!entity) return { outcome: null, key: null, canonical: null, row: null };
	const decided = (outcome, extra = {}) => {
		metrics.entityCanonical(outcome, from);
		return { outcome, key: entity.key, canonical: null, row: null, ...extra };
	};
	const target = typeof canonical === 'string' && canonical !== '' ? canonicalFormOf(canonical) : null;
	if (!target) return decided(CanonicalOutcome.UNREADABLE);
	// The entity's own prefix, and nothing else: a canonical under another prefix names another entity. And no query
	// string: a param the route keys can change the document, and a crawler can choose its value.
	if (!target.startsWith(entity.key) || URL.parse(target)?.search) return decided(CanonicalOutcome.FOREIGN);
	try {
		const row = await table().get({ id: entity.key, select: [...ENTITY_SELECT] });
		if (!row && !createIfMissing) return decided(CanonicalOutcome.UNTRACKED);
		if (!row) {
			const created = {
				id: entity.key,
				canonical: target,
				canonicalFrom: from,
				canonicalAt: new Date(atMs),
				firstSeenAt: new Date(),
			};
			await table().patch(entity.key, created);
			return decided(CanonicalOutcome.NEW, { canonical: target, row: created });
		}
		// The same document, however spelled: the stored spelling stands, and nothing is written.
		if (typeof row.canonical === 'string' && sameDocument(row.canonical, target)) {
			return decided(CanonicalOutcome.SAME, { canonical: row.canonical, row });
		}
		// An unreadable stored instant loses to any observation: there is nothing to be newer than.
		const storedAt = dateColumnMs(row.canonicalAt);
		if (Number.isFinite(storedAt) && !(atMs > storedAt)) return decided(CanonicalOutcome.OLDER, { row });
		const moved = { id: entity.key, canonical: target, canonicalFrom: from, canonicalAt: new Date(atMs) };
		await table().patch(entity.key, moved);
		return decided(CanonicalOutcome.MOVED, { canonical: target, row: { ...row, ...moved } });
	} catch (e) {
		logger.warn?.(`[prerender] entity: recording ${target} for ${entity.key} failed: ${e?.message ?? String(e)}`);
		return decided(CanonicalOutcome.ERROR);
	}
}

/**
 * A render's observation (resources/RenderQueue.js): the canonical the page declared — a stored page's own
 * `pageFacts.canonical`, or the one a canonical verdict reported — at the instant the origin was read, which the
 * caller passes. Resolved like every other observation: recorded, and adopted when no target holds it. Never
 * rejects.
 */
export const observeRenderedCanonical = async (url, canonical, readAtMs) => {
	if (!entitiesOn() || typeof canonical !== 'string' || canonical === '') return;
	await resolveCanonical({ url, value: canonical, from: 'render', atMs: readAtMs });
};

// Suppression reasons the origin's own word overturns: each is a render's verdict that the page named its
// canonical ELSEWHERE, and the probe now says the origin names THIS URL. A 404, a noindex or a redirect is a
// statement about the URL itself, which a canonical claim from an endpoint does not contradict.
const REOPENABLE = new Set(['canonical-mismatch', 'canonical-variant']);

/** May the plugin file a target for `url` at all? Keyable, on the domain allowlist, on a prerender route. */
const adoptable = (url) => {
	if (!CacheKey.fitsKeyLimit(url)) return false;
	const parsed = URL.parse(url);
	if (!parsed) return false;
	if (config.domains.length && !config.domains.includes(parsed.hostname)) return false;
	return classifyPath(parsed.pathname).routeClass === PRERENDER;
};

const TARGET_FIELDS = Object.freeze(['url', 'state', 'suppressedReason', 'sitemapUrl', 'renderInterval', 'unlistedAt']);
const SIBLING_FIELDS = Object.freeze(['url', 'state']);

/**
 * Rows the sibling read covers. An entity measured with at most 4 targets; past this the read cannot see
 * every spelling, and the canonical is adopted as if none matched — at most one duplicate a `retryAfter`.
 */
export const SIBLING_READ_LIMIT = 8;

/**
 * Does a target IN ROTATION under the entity's prefix name the same document as `canonical` in another
 * spelling? One bounded, one-sided, node-local range read (`Target` is not residency-pinned), made only when
 * the exact key has no target in rotation. The loop body never awaits, so the cursor closes before anything
 * else runs (util/scan.js).
 */
const spelledOtherwise = async (key, canonical) => {
	for await (const row of databases.render_service.Target.search(
		{
			conditions: [{ attribute: 'url', comparator: 'greater_than_equal', value: key }],
			sort: { attribute: 'url' },
			select: [...SIBLING_FIELDS],
			limit: SIBLING_READ_LIMIT,
		},
		{ replicateFrom: false }
	)) {
		const url = row?.url;
		if (typeof url !== 'string') continue;
		if (!url.startsWith(key)) break;
		if (url !== canonical && row.state !== 'suppressed' && sameDocument(url, canonical)) return true;
	}
	return false;
};

/**
 * A canonical as an endpoint states it: an absolute URL, or a path rooted at `/` resolved against the probed
 * URL's origin. Anything else — a relative path would resolve against the probed URL's DIRECTORY and invent
 * a URL under the entity's own prefix — is no canonical at all.
 */
const canonicalFromValue = (value, probedUrl) => {
	if (typeof value !== 'string' || value === '') return null;
	if (!value.startsWith('/') && !URL.canParse(value)) return null;
	try {
		return new URL(value, probedUrl).href;
	} catch {
		return null;
	}
};

// THE ADOPTION BUDGET: adoptions this hour on this node, shared by every worker thread (util/hourlyBudget.js, over
// a shared buffer). Every source can adopt (the probe on its worker, renders and serve-time checks and proxied
// documents on any worker), so a per-thread counter would multiply the cap by the thread count. Two lanes: real
// adoptions, and dry-run ones, so a dry run measures what the cap would do without spending the slots an armed
// node's real adoptions need (an operator's measure-only sweep on an armed node, for one).
const BUDGET_SAB_KEY = 'entity_adopt_budget_v2';
const REAL = 0;
const DRY = 1;
let budgetCell = null;
const budgetI32 = () =>
	(budgetCell ??= new Int32Array(getSab(BUDGET_SAB_KEY, hourlyBudgetLength(2) * Int32Array.BYTES_PER_ELEMENT)));

/** The node's adoption budget (util/hourlyBudget.js): lane 0 real adoptions, lane 1 dry-run ones. */
export const adoptionBudget = createHourlyBudget(budgetI32);
/** Tests: an empty budget. */
export const resetAdoptionCountsForTest = () => adoptionBudget.reset();

/**
 * RESOLVE A CANONICAL: record an observation of the origin naming `value` as the canonical of the entity `url`
 * belongs to, and — when that is ANOTHER document than `url` and no target in rotation holds it in any spelling —
 * ADOPT it: file its target due now and urgent, as redirect adoption does, so the entity's canonical renders now
 * instead of whenever traffic finds it and its jitter comes round. A target suppressed as a canonical verdict is
 * reactivated the same way; one suppressed for any other reason is left alone.
 *
 * `value` is the canonical as the observer states it: an absolute URL, or a path rooted at `/` resolved against
 * `url`'s origin. `from` names the observer (the `entity_canonical` context). Returns the observation's result
 * plus `adopt`, the adoption outcome when one was decided. Never throws.
 *
 * Bounded three ways:
 *   - `entities.adopt.maxPerHour` per node, across every worker and every source (`adoptionBudget`). A put that
 *     fails gives its slot back.
 *   - `retryAfter` per ENTITY, whichever canonical: an entity adopted within it is `recent`. So a canonical that
 *     did not take (it 404s and is retired, or its page names another canonical and is suppressed) costs one
 *     render a window for as long as the origin keeps naming it, and two spellings that name each other (an
 *     origin re-slugging back, or serving two inconsistent copies) cannot reactivate each other in turn.
 *   - a dry run — `entities.adopt.dryRun`, or the caller's own (`dryRun`: the change probe passes its pass's
 *     effective dry run, which an operator's measure-only sweep sets) — that counts and files nothing. A dry run
 *     REMEMBERS what it would have filed (`wouldAdoptAt`), so a repeat observation within `retryAfter` reads
 *     `recent` exactly as it would armed, and spends its own lane of the budget, so `would-adopt + capped` is
 *     what arming files and a dry run never spends an armed node's slots. The OBSERVATION is written in a dry
 *     run too: it is an observation, not an action.
 *
 * All I/O injectable for tests (`createCanonicalResolver`).
 */
export const createCanonicalResolver = ({
	settings = () => config.entities.adopt,
	now = Date.now,
	observe = observeCanonical,
	readTarget = (url) => Target.get({ id: url, select: [...TARGET_FIELDS] }),
	otherSpelling = spelledOtherwise,
	fileTarget = (url, data) => Target.put(url, data),
	markAdopted = (key, data) => table().patch(key, { id: key, ...data }),
	budget = adoptionBudget,
} = {}) => {
	return async ({ url, value, from, dryRun = false, atMs = undefined }) => {
		if (!entitiesOn()) return null;
		const canonical = canonicalFromValue(value, url);
		if (!canonical) return null;
		// A crawler's proxied miss moves a row the registry already holds, and creates none (`untracked`).
		const observed = await observe({ url, canonical, from, atMs: atMs ?? now(), createIfMissing: from !== 'origin' });
		// The observed URL IS the canonical (in any spelling), or there is nothing to adopt.
		if (!observed.row || !observed.canonical || sameDocument(observed.canonical, url)) return observed;
		const adopt = typeof settings === 'function' ? settings() : settings;
		if (!adopt?.enabled) return observed;
		const decided = (outcome) => {
			metrics.canonicalAdopt(outcome, from ?? null);
			return { ...observed, adopt: outcome };
		};
		let target;
		try {
			target = await readTarget(observed.canonical);
			if (target && target.state !== 'suppressed') return decided(AdoptOutcome.EXISTS);
			if (await otherSpelling(observed.key, observed.canonical)) return decided(AdoptOutcome.EXISTS);
			if (target && !REOPENABLE.has(target.suppressedReason)) return decided(AdoptOutcome.SUPPRESSED);
		} catch (e) {
			logger.warn?.(`[prerender] entity: reading ${observed.canonical} failed: ${e?.message ?? String(e)}`);
			return decided(AdoptOutcome.ERROR);
		}
		const nowMs = now();
		const dry = Boolean(adopt.dryRun || dryRun);
		// Per entity, whichever canonical: the last real adoption, or — in a dry run — the last one it would have made.
		const last = dateColumnMs(dry ? observed.row.wouldAdoptAt : observed.row.adoptedAt);
		if (nowMs - last < adopt.retryAfter) return decided(AdoptOutcome.RECENT);
		if (!adoptable(observed.canonical)) return decided(AdoptOutcome.REFUSED);
		if (!budget.reserve(adopt.maxPerHour, nowMs, dry ? DRY : REAL)) return decided(AdoptOutcome.CAPPED);
		if (dry) {
			// Remembered, so the dry-run number counts entities, not observations. Best-effort, like the real memory.
			try {
				await markAdopted(observed.key, { wouldAdoptCanonical: observed.canonical, wouldAdoptAt: new Date(nowMs) });
			} catch (e) {
				logger.warn?.(
					`[prerender] entity: recording a would-adopt of ${observed.canonical} failed: ${e?.message ?? e}`
				);
			}
			return decided(AdoptOutcome.WOULD_ADOPT);
		}
		// `put` REPLACES the row (and is the reactivation that clears a suppression and its strikes), so a
		// suppressed row's own declarations ride along.
		const interval = Number(target?.renderInterval);
		try {
			await fileTarget(observed.canonical, {
				nextRenderTime: currentMinuteMs(nowMs),
				urgent: true,
				...(target?.sitemapUrl ? { sitemapUrl: target.sitemapUrl } : {}),
				...(target?.unlistedAt ? { unlistedAt: target.unlistedAt } : {}),
				...(Number.isFinite(interval) && interval > 0 ? { renderInterval: interval } : {}),
			});
		} catch (e) {
			budget.release(REAL);
			logger.warn?.(`[prerender] entity: adopting ${observed.canonical} failed: ${e?.message ?? String(e)}`);
			return decided(AdoptOutcome.ERROR);
		}
		// Filed. The memory of it is best-effort: losing it costs at most one more filing, which then finds the
		// target and reads `exists`.
		try {
			await markAdopted(observed.key, { adoptedCanonical: observed.canonical, adoptedAt: new Date(nowMs) });
		} catch (e) {
			logger.warn?.(`[prerender] entity: recording the adoption of ${observed.canonical} failed: ${e?.message ?? e}`);
		}
		logger.info?.(
			`[prerender] entity: ${target ? 'reactivated' : 'adopted'} ${observed.canonical}, the canonical the ` +
				`${from} reports for ${observed.key} (observed at ${url})`
		);
		return decided(target ? AdoptOutcome.REACTIVATED : AdoptOutcome.ADOPTED);
	};
};

/** The resolver every caller shares. Never throws. */
export const resolveCanonical = createCanonicalResolver();
