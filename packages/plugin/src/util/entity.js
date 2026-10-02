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
 * Two observers of the origin, and nothing else:
 *
 *   probe    the change probe's mapped `canonical` slot (the consumer's rule: the details endpoint's
 *            seoURL). The origin's own answer for the product id, so a junk spelling cannot invent a
 *            canonical — the reason "adopt the canonical" was unsafe on catalog facets does not apply.
 *   render   a stored render's `pageFacts.canonical`: what the page itself declared.
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
	/** A canonical outside the entity's own prefix: another entity's URL, ignored. */
	FOREIGN: 'foreign',
	/** A canonical that is not a URL this can key. */
	UNREADABLE: 'unreadable',
	/** A read or a write threw. Logged. */
	ERROR: 'error',
});

/** Every outcome of the probe's adoption check (`prerender_ops` / `canonical_adopt`). */
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
	/** Adopted within `retryAfter` already: a canonical that did not take is not re-filed every night. */
	RECENT: 'recent',
	/** Past `maxPerPass` this pass. */
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
 * Record that the origin, observed at `atMs` by `from` ('probe' | 'render'), names `canonical` as the
 * canonical of the entity `url` belongs to. Returns `{ outcome, key, canonical, row }`: `row` is the entity
 * as it stands after this observation (null when there is no entity). Never throws.
 */
export async function observeCanonical({ url, canonical, from, atMs }) {
	if (!entitiesOn()) return { outcome: null, key: null, canonical: null, row: null };
	const entity = entityOf(url);
	if (!entity) return { outcome: null, key: null, canonical: null, row: null };
	const decided = (outcome, extra = {}) => {
		metrics.entityCanonical(outcome, from);
		return { outcome, key: entity.key, canonical: null, row: null, ...extra };
	};
	const target = typeof canonical === 'string' && canonical !== '' ? canonicalFormOf(canonical) : null;
	if (!target) return decided(CanonicalOutcome.UNREADABLE);
	// The entity's own prefix, and nothing else: a canonical under another prefix names another entity.
	if (!target.startsWith(entity.key)) return decided(CanonicalOutcome.FOREIGN);
	try {
		const row = await table().get({ id: entity.key, select: [...ENTITY_SELECT] });
		if (!row) {
			const created = {
				id: entity.key,
				canonical: target,
				canonicalFrom: from,
				canonicalAt: new Date(atMs),
				firstSeenAt: new Date(),
			};
			await table().put(entity.key, created);
			return decided(CanonicalOutcome.NEW, { canonical: target, row: created });
		}
		if (row.canonical === target) return decided(CanonicalOutcome.SAME, { canonical: target, row });
		// An unreadable stored instant loses to any observation: there is nothing to be newer than.
		const storedAt = dateColumnMs(row.canonicalAt);
		if (Number.isFinite(storedAt) && !(atMs > storedAt)) return decided(CanonicalOutcome.OLDER, { row });
		const moved = { canonical: target, canonicalFrom: from, canonicalAt: new Date(atMs) };
		await table().patch(entity.key, moved);
		return decided(CanonicalOutcome.MOVED, { canonical: target, row: { ...row, ...moved } });
	} catch (e) {
		logger.warn?.(`[prerender] entity: recording ${target} for ${entity.key} failed: ${e?.message ?? String(e)}`);
		return decided(CanonicalOutcome.ERROR);
	}
}

/**
 * A stored render's observation (resources/RenderQueue.js): the page's own declared canonical, at the
 * instant the origin was read — the store time less the longest render of the result. Never rejects.
 */
export const observeRenderedCanonical = async (url, pageFacts, readAtMs) => {
	if (!entitiesOn() || typeof pageFacts?.canonical !== 'string') return;
	await observeCanonical({ url, canonical: pageFacts.canonical, from: 'render', atMs: readAtMs });
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

const targetFields = ['url', 'state', 'suppressedReason', 'sitemapUrl', 'renderInterval'];

/**
 * The change probe's observer for ONE pass (util/changeProbe.js `runProbePass`, `observeCanonical`): given
 * the probed row's URL and the rule's mapped `canonical` slot value, it records the observation and, when the
 * canonical is another URL that no target in rotation holds, ADOPTS it — files its target due now and
 * urgent, as redirect adoption does, so the entity's canonical renders tonight instead of whenever traffic
 * finds it and its jitter comes round.
 *
 * Bounded three ways: `maxPerPass` per pass on this node; `retryAfter` per entity, so a canonical that did
 * not take (it 404s, or its page names another canonical after all) is filed at most once per window rather
 * than every night; and a dry run (`adoptCanonical.dryRun`, or the probe's own) that counts and writes no
 * target. The observation itself is written in a dry run too: it is an observation, not an action.
 *
 * All I/O injectable for tests.
 */
export const createCanonicalObserver = ({
	settings = config.changeProbe.adoptCanonical,
	probeDryRun = config.changeProbe.dryRun,
	now = Date.now,
	observe = observeCanonical,
	readTarget = (url) => Target.get({ id: url, select: [...targetFields] }),
	fileTarget = (url, data) => Target.put(url, data),
	markAdopted = (key, data) => table().patch(key, data),
} = {}) => {
	let adopted = 0;
	return async ({ url, value }) => {
		if (!entitiesOn()) return null;
		// A path (the consumer's seoURL) resolves against the probed URL's origin; an absolute URL stands.
		let canonical = null;
		try {
			canonical = typeof value === 'string' && value !== '' ? new URL(value, url).href : null;
		} catch {
			canonical = null;
		}
		if (!canonical) return null;
		const observed = await observe({ url, canonical, from: 'probe', atMs: now() });
		// The probed row IS the canonical, or there is nothing to adopt: it has a target by definition.
		if (!observed.row || !observed.canonical || observed.canonical === url) return observed;
		if (!settings?.enabled) return observed;
		const decided = (outcome) => {
			metrics.canonicalAdopt(outcome);
			return { ...observed, adopt: outcome };
		};
		try {
			const target = await readTarget(observed.canonical);
			if (target && target.state !== 'suppressed') return decided(AdoptOutcome.EXISTS);
			if (target && !REOPENABLE.has(target.suppressedReason)) return decided(AdoptOutcome.SUPPRESSED);
			const nowMs = now();
			const last = dateColumnMs(observed.row.adoptedAt);
			if (observed.row.adoptedCanonical === observed.canonical && nowMs - last < settings.retryAfter) {
				return decided(AdoptOutcome.RECENT);
			}
			if (!adoptable(observed.canonical)) return decided(AdoptOutcome.REFUSED);
			if (adopted >= settings.maxPerPass) return decided(AdoptOutcome.CAPPED);
			adopted++;
			if (settings.dryRun || probeDryRun) return decided(AdoptOutcome.WOULD_ADOPT);
			// `put` REPLACES the row (and is the reactivation that clears a suppression), so a suppressed row's
			// own declarations ride along.
			await fileTarget(observed.canonical, {
				nextRenderTime: currentMinuteMs(nowMs),
				urgent: true,
				...(target?.sitemapUrl ? { sitemapUrl: target.sitemapUrl } : {}),
				...(Number.isFinite(target?.renderInterval) && target.renderInterval > 0
					? { renderInterval: target.renderInterval }
					: {}),
			});
			await markAdopted(observed.key, { adoptedCanonical: observed.canonical, adoptedAt: new Date(nowMs) });
			logger.info?.(
				`[prerender] entity: ${target ? 'reactivated' : 'adopted'} ${observed.canonical}, the canonical the change ` +
					`probe reports for ${observed.key} (probed at ${url})`
			);
			return decided(target ? AdoptOutcome.REACTIVATED : AdoptOutcome.ADOPTED);
		} catch (e) {
			logger.warn?.(`[prerender] entity: adopting ${observed.canonical} failed: ${e?.message ?? String(e)}`);
			return decided(AdoptOutcome.ERROR);
		}
	};
};
