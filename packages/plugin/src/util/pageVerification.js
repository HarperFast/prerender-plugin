/**
 * PER-PAGE EXEMPTION FROM A BULK INVALIDATION — default off.
 *
 * A bulk invalidation refuses every page in its scope rendered before the epoch, because it cannot
 * tell which of them actually changed. Measured on a four-node deployment during a route-wide trip,
 * only 22-29% of the scope had genuinely moved; the other ~71-78% were origin-proxied for up to a
 * full render interval while being byte-for-byte correct.
 *
 * The change probe already answers the question the invalidation is guessing at. `pageCheck`
 * compares what the CACHED PAGE claims against what the origin's endpoint says right now
 * (`util/changeProbe.js`, `claimsDisagree`). When that comparison AGREES after the epoch, the page is
 * demonstrably current on the fields the invalidation was recorded for, and refusing it buys nothing.
 *
 * ── WHAT THIS DOES AND DOES NOT ASSERT ─────────────────────────────────────────────────────────
 *
 * A verification asserts exactly one thing: THE FIELDS THE RULE WATCHES still match. It does not
 * assert the page is fresh in any general sense — a promo flip also moves badges, banners and copy no
 * probe looks at. So this is opt-in per deployment, and the honest framing is "price and availability
 * are verified", never "the page is fine".
 *
 * That is also why the write is gated on `stored.pageSignature` EXISTING. `pageDisagrees` is computed
 * only `if (rule.pageCheck && stored?.pageSignature)`, so a URL whose page claim is unknown yields
 * `false` — indistinguishable, at the call site, from a real agreement. Writing a verification off
 * that would stamp "verified" on a page nobody ever compared, which is the one bug this feature
 * cannot survive: it would serve invalidated content while reporting success.
 *
 * ── EVERY FAILURE FAILS CLOSED ─────────────────────────────────────────────────────────────────
 *
 * Absent row, never probed, probe failed, read threw, unreadable timestamp, feature disabled — all of
 * them mean NOT VERIFIED, and the page stays invalidated. There is deliberately NO last-known-good
 * cache here, which is the opposite of `util/invalidation.js`: that module fails OPEN because its
 * table's normal state is empty and "unknown" almost certainly means "nothing is invalidated". Here
 * "unknown" means "I have no proof this page is current", and the safe answer to that is to keep
 * proxying to the origin — a slower correct answer, not a faster wrong one.
 *
 * ── COST ───────────────────────────────────────────────────────────────────────────────────────
 *
 * One point read, taken ONLY for a page an invalidation would otherwise refuse — a request already
 * committed to an origin round trip (measured 0.7-1.9 s TTFB on this corpus). A sub-millisecond local
 * read against that is free, and it stays sub-millisecond precisely because the table sits in its own
 * database (see the schema comment). Writes are paced by the probe: ~200k per node per 12h cycle,
 * i.e. ~4.6/s, queueing behind nothing but each other.
 */

import { config } from '../config.js';
import { metrics } from '../metrics.js';

const table = () => databases.verification.PageVerification;

/**
 * A `Date` column read robustly: a Date, a number, or a serialized string all compare correctly, and
 * anything unreadable yields NaN — which every caller treats as "not verified". Mirrors the coercion
 * the serve path already applies to `lastCached`/`expiresAt`.
 */
const verifiedAtMsOf = (row) => {
	if (!row || row.verifiedAt === undefined || row.verifiedAt === null) return NaN;
	return new Date(row.verifiedAt).getTime();
};

/**
 * When this URL's cached claims were last confirmed against the origin, in ms, or NaN.
 *
 * `select` MUST be an array. A string `select` projects to the bare scalar rather than a record —
 * the trap documented in `util/invalidation.js` and `util/queueControl.js`. Here it would make every
 * row read as absent, i.e. the feature would appear enabled and exempt nothing.
 */
export const resolveVerification = async (url) => {
	if (!config.invalidation.verification.enabled) return NaN;
	try {
		const row = await table().get({ id: url, select: ['url', 'verifiedAt'] });
		return verifiedAtMsOf(row);
	} catch (e) {
		// Counted and logged, never thrown: this runs on a request that already has an answer
		// available (the origin), so a storage fault here must degrade to "not verified", not to a 500.
		logger.error(e, `[prerender] page verification read failed for ${url}`);
		metrics.pageVerification('read-error');
		return NaN;
	}
};

/**
 * Record that this URL's cached page claims matched the origin.
 *
 * Callers must have established BOTH halves themselves: that a page claim actually existed to
 * compare, and that the comparison agreed. This helper deliberately takes no opinion on either — it
 * cannot re-derive them, and a helper that guessed would be the silent-verification bug above.
 */
export const writeVerification = async (url) => {
	try {
		await table().put(url, { url, verifiedAt: new Date() });
		metrics.pageVerification('written');
	} catch (e) {
		// A failed verification write costs a page one cycle of continued origin proxying — the
		// pre-feature behaviour. Never allowed to fail the probe pass around it.
		logger.warn?.(`[prerender] page verification write failed for ${url}: ${e?.message ?? String(e)}`);
		metrics.pageVerification('write-error');
	}
};
