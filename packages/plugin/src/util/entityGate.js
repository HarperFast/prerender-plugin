/**
 * The entity gate: traffic discovery does not mint a target for a URL whose ENTITY — the product,
 * say — is already in the render rotation under another URL.
 *
 * THE PROBLEM. `Target` is keyed by URL, so two spellings of one product are two unrelated rows.
 * Crawlers keep requesting old or invented slugs of products whose correct URL is already tracked
 * (`/product/prd-1/old-spelling.jsp` beside `/product/prd-1/new-spelling.jsp`, or a placeholder
 * `/product/prd-1/product.jsp`). Discovery mints each one; it renders; the render finds the
 * canonical pointing elsewhere and suppresses it (`canonical-mismatch`); it re-renders on the
 * suppression recheck; after `maxStrikes` it is deleted, and the next crawler hit mints it again.
 * Measured on one deployment: `canonical-mismatch` was 8.2% of all render outcomes, and in a sample
 * of 150 such targets EVERY ONE had another target for the same product id under the correct slug.
 * Each costs a render slot and an origin document fetch, and none of them produces a page.
 *
 * THE MECHANISM IS A PREFIX, NOT AN ID. A route declares `entityPrefix`: a regular expression,
 * anchored at the start of the URL PATH, whose match is the part of the URL that identifies one
 * entity (`^/product/prd-[^/]+/` on `/product/prd-`). The lookup prefix is the URL's origin plus
 * that match, and every Target row whose key starts with it is a SIBLING. Because `Target` is keyed
 * by the canonical URL, "rows sharing a prefix" is one bounded primary-key range read — no second
 * table, no index, nothing to keep in step with the registry (issue #166 discusses the id-keyed
 * table this deliberately is not).
 *
 * THE MATCH MUST END ON `/`, and this is enforced at runtime, not merely advised. A prefix that
 * stops mid-segment is a prefix of OTHER entities' URLs: `…/prd-123` is a string prefix of
 * `…/prd-1234/any.jsp`, so product 1234's target would gate product 123 — permanently, since
 * nothing about 1234 ever changes that. A match that does not end in `/` is therefore treated as
 * no match at all (outcome `no-prefix`, minted exactly as before), and compiling a pattern whose
 * source does not end in `/` warns. The warning is a heads-up rather than a rejection because a
 * pattern like `^/product/prd-\d+/?` is usable — its match ends in `/` whenever the URL continues
 * past the id — and the runtime rule already refuses the matches that do not. For the same reason a
 * match that does not extend past a `prefix` route's own path is refused: it names the whole route,
 * not one entity.
 *
 * THE DECISION. A sibling IN ROTATION (`state` not `suppressed`) means the entity already has a
 * target that will render, so this URL is not minted. A SUPPRESSED sibling does not gate, and that
 * is what keeps the gate from ever blocking an entity's correct URL for good:
 *
 *   - A genuine re-slug. The old slug's target is still active until its next render proves the
 *     canonical moved and suppresses it; until then the new slug is gated. Once it is suppressed,
 *     the next crawler hit on the new slug mints normally. The cost is a BOUNDED DELAY — one render
 *     cycle of the old target (up to its cadence; a freshly minted target's first render is jittered
 *     across a whole interval) — during which the new URL is served exactly as an unknown URL always
 *     has been: a miss proxies the origin.
 *   - A sitemap that lists a non-canonical URL. Its target is listed but suppressed, and the page it
 *     canonicalizes to must still be discoverable. Treating "listed" as gating on its own would block
 *     that correct URL forever — the listing re-creates the suppressed row on every refresh — which is
 *     why `sitemapUrl` plays no part in the decision. A listed target in rotation gates because it is
 *     in rotation, not because it is listed.
 *
 * DISCOVERY ONLY. Sitemap ingestion, redirect adoption, the REST API and suppression all create
 * targets without passing through here — the declared corpus is always created. The single call
 * site is `handlePageScheduling` in http_handlers/bot_request.js, which a test pins.
 *
 * THE READ IS OFF THE SERVE PATH AND CANNOT HANG. It runs inside the detached discovery step
 * (`setImmediate` after the response resolved), only for a URL that has NO target row at all, only
 * on a route that opted in. `Target` is not residency-pinned — only `RenderSchedule` is — so the
 * read is node-local; `replicateFrom: false` rides along anyway, as the second argument (Harper's
 * search path ignores unknown query fields, so inside the query it would look honoured and do
 * nothing), so that a future residency pin on `Target` cannot turn this into an untimed cross-node
 * fetch. The range is ONE-SIDED (`>= prefix`) with the upper bound enforced while consuming —
 * rows are key-ordered, so the first key outside the prefix ends the read — because a two-sided
 * primary-key range collapses to a filtered intersection rather than a seek (see
 * `PrerenderAdmin.listPagesInner`). It is `limit`-bounded, and the loop body never awaits, so the
 * cursor is closed before anything else happens (util/scan.js explains why that matters).
 *
 * EVERY FAILURE MINTS, i.e. behaves exactly as discovery did before this existed. A read that
 * throws, an unreadable row, a URL the pattern does not match: all fall through to the mint. The gate
 * can only ever SAVE work; it has no failure mode that takes a URL out of the rotation it would have
 * joined without it, other than the bounded re-slug delay above.
 */

import { config, getLogger } from '../config.js';
import { metrics } from '../metrics.js';

/** The delimiter an entity prefix must end on — see the module comment for why it is enforced. */
export const ENTITY_DELIMITER = '/';

/**
 * Every outcome of one evaluation, as recorded on `prerender_ops` / `entity_gate`. Exactly one per
 * evaluation, so the series sums to "discovery mints the gate looked at".
 */
export const EntityGateOutcome = Object.freeze({
	/** A sibling is in rotation and the gate is armed: not minted. Also counted as `discovery_gated`/`entity`. */
	GATED: 'gated',
	/** A sibling is in rotation but `dryRun` is on: minted anyway, and counted — the rollout number. */
	WOULD_GATE: 'would-gate',
	/** Siblings exist but every one is suppressed: minted (a re-slug's new URL, or a crawler's). */
	SUPPRESSED_ONLY: 'suppressed-only',
	/** No sibling at all: a genuinely new entity, minted. */
	NO_SIBLINGS: 'no-siblings',
	/** The route has an `entityPrefix` but this URL produced no usable prefix: minted. */
	NO_PREFIX: 'no-prefix',
	/** The sibling read threw: minted (fail open), and logged. */
	ERROR: 'error',
});

// The only fields the decision reads. `url` is the key (a row without a readable one is skipped);
// `state` is the verdict. An ARRAY, because a string `select` projects to the bare scalar.
export const SIBLING_SELECT = Object.freeze(['url', 'state']);

/**
 * Compile a route's `entityPrefix` source. STICKY (`y`), which anchors the match at the start of
 * the path whether or not the author wrote `^` — "anchored at the path root" is the contract, and a
 * pattern that could match mid-path would name an entity by something other than its prefix.
 * Throws on an invalid pattern; the route compiler catches it and drops the field.
 */
export const compileEntityPrefix = (source) => new RegExp(source, 'y');

/**
 * Whether a pattern's SOURCE ends on the delimiter. A compile-time heuristic only: the runtime rule
 * in `entityPrefixOf` checks the actual match, which is what makes it safe; this exists so an author
 * learns at config time that some (or all) of their matches will be refused.
 */
export const endsOnDelimiter = (source) => typeof source === 'string' && source.endsWith(ENTITY_DELIMITER);

/**
 * The sibling-lookup prefix for a canonical URL on a route, or `null` when there is none to use.
 *
 * `url` is a Target primary key (a canonical URL-half — see util/url.js), so its origin plus the
 * matched path text is a string prefix of every canonical URL under the same entity. The final
 * `startsWith` is a guard, not a formality: it proves the prefix really is a prefix of the key the
 * siblings are compared against, so a parse that disagreed with the canonical bytes could only ever
 * make the gate do nothing.
 */
export const entityPrefixOf = (url, route) => {
	const pattern = route?.entityPrefix;
	if (!(pattern instanceof RegExp) || typeof url !== 'string') return null;
	const parsed = URL.parse(url);
	if (!parsed) return null;
	pattern.lastIndex = 0;
	const match = pattern.exec(parsed.pathname);
	pattern.lastIndex = 0;
	const text = match?.[0];
	if (!text || !text.endsWith(ENTITY_DELIMITER)) return null;
	// A match no longer than a prefix route's own path covers the whole route, not one entity.
	if (route.match === 'prefix' && typeof route.path === 'string' && text.length <= route.path.length) return null;
	const prefix = parsed.origin + text;
	return url.startsWith(prefix) ? prefix : null;
};

/** A sibling in rotation keeps its entity rendering, so it gates. A suppressed one never does. */
export const inRotation = (row) => row?.state !== 'suppressed';

/**
 * Read up to `limit` siblings of `url` under `prefix`. Stops at the first sibling in rotation —
 * one is enough to decide — at the first key outside the prefix, or at the limit. `url` itself is
 * never its own sibling (it has no row when discovery gets here, but a concurrent mint may have
 * just written one).
 *
 * THE LOOP BODY DOES NOT AWAIT. Rows are collected and the cursor is released (by the `break`, or by
 * exhaustion) before the caller does anything else — the scan-then-write rule from util/scan.js.
 */
export const readSiblings = async ({ table, prefix, url, limit }) => {
	const siblings = [];
	for await (const row of table.search(
		{
			conditions: [{ attribute: 'url', comparator: 'greater_than_equal', value: prefix }],
			sort: { attribute: 'url' },
			select: [...SIBLING_SELECT],
			// +1 so that `url` itself, if a concurrent mint just wrote it, cannot cost a sibling slot.
			limit: limit + 1,
		},
		{ replicateFrom: false }
	)) {
		const key = row?.url;
		// An unreadable key can be neither compared nor trusted; skip it (the read stays bounded by
		// `limit`). If the store instead ENDS the iterator at such a row, fewer siblings are seen and
		// the gate mints — the fail-open direction.
		if (typeof key !== 'string') continue;
		// BREAK, never `continue`: ascending order means one key outside the prefix proves every
		// later key is outside it too.
		if (!key.startsWith(prefix)) break;
		if (key === url) continue;
		siblings.push(row);
		if (inRotation(row) || siblings.length >= limit) break;
	}
	return siblings;
};

/**
 * Evaluate the gate for a discovery mint of `url` on `route`. Returns `{ mint, outcome, prefix,
 * blocker }`: `mint` is the only field the caller must act on; `outcome` is null when the gate did
 * not evaluate at all (switched off, or the route has no `entityPrefix`), which records nothing.
 *
 * All I/O is injectable (`table`, `gate`), so every decision is testable without a live Harper.
 */
export async function evaluateEntityGate({
	url,
	route,
	botName = null,
	table = globalThis.databases?.render_service?.Target,
	gate = config.ingress.entityGate,
}) {
	if (!gate?.enabled || !(route?.entityPrefix instanceof RegExp)) {
		return { mint: true, outcome: null, prefix: null, blocker: null };
	}

	const decided = (outcome, mint, prefix = null, blocker = null) => {
		metrics.entityGate(outcome, botName);
		return { mint, outcome, prefix, blocker };
	};

	const prefix = entityPrefixOf(url, route);
	if (!prefix) return decided(EntityGateOutcome.NO_PREFIX, true);

	let siblings;
	try {
		// The schema floors it at 1; this only keeps a hand-built `gate` from reading zero rows.
		const limit = Math.max(1, Math.floor(Number(gate.siblingLimit) || 5));
		siblings = await readSiblings({ table, prefix, url, limit });
	} catch (e) {
		getLogger().warn?.(
			`[prerender] entity gate: sibling read under ${prefix} failed (${e?.message ?? String(e)}); minting ${url} as before`
		);
		return decided(EntityGateOutcome.ERROR, true, prefix);
	}

	if (!siblings.length) return decided(EntityGateOutcome.NO_SIBLINGS, true, prefix);
	const blocker = siblings.find(inRotation);
	if (!blocker) return decided(EntityGateOutcome.SUPPRESSED_ONLY, true, prefix);
	if (gate.dryRun) return decided(EntityGateOutcome.WOULD_GATE, true, prefix, blocker.url);

	// Armed and refused. Counted on `discovery_gated` too, beside the route and bot gates, so every
	// view of "what the gates held out of the rotation" includes it without learning a new series.
	metrics.discoveryGated('entity', botName);
	return decided(EntityGateOutcome.GATED, false, prefix, blocker.url);
}
