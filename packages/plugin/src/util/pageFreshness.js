/**
 * The ONE definition of whether a cached page is servable, and under which status. Every
 * consumer — the bot serve path, the admin explain/pages views — must call this rather than
 * re-deriving the comparison, so the admin can never disagree with what a bot actually gets,
 * and a future change (per-route swrTtl) lands everywhere at once.
 */

/**
 * Can this cached page be served, and under which status?
 *
 *   'hit'          within the page's own renderInterval (expiresAt is still ahead)
 *   'swr'          past expiresAt but inside the stale-while-revalidate window (the re-render is
 *                  late or still in flight)
 *   'invalidated'  it WOULD have been servable, but a bulk invalidation covers it and the page was
 *                  rendered before that epoch
 *   null           not servable from cache (stale/miss — fall through to the miss mode)
 *
 * The serve is identical for 'hit' and 'swr'; the split exists because folding both into 'hit' made
 * the headline hit rate unreadable as a freshness signal: at one measured point 71.9% "hit" quietly
 * included ~13% of the corpus being served past expiry. A NaN expiresAtMs fails both comparisons.
 *
 * ── `epoch` IS REQUIRED, AND THAT IS THE POINT ─────────────────────────────────────────────────
 *
 * This function was renamed from `cacheServeStatus` and given a required argument in the same
 * change, deliberately: any call site left on the old name is an IMPORT ERROR rather than a silently
 * epoch-blind freshness check. That second failure is the dangerous one — it makes the admin console
 * report a page as fresh while bots are being sent to the origin, which is precisely the class of
 * divergence this module was created to make impossible.
 *
 * So `epoch` has no default. A default value is a promise that every future call site will remember
 * to think about invalidation; a throw is a device that makes them. Pass `null` explicitly to mean
 * "I resolved the active set and nothing applies" — which is a claim the caller is making, not a
 * gap it is leaving.
 */
export function resolveServeStatus(args) {
	// BOTH checks, and the second is not redundant. `in` catches the call site that forgot the key.
	// The `undefined` check catches the one that passed a variable which happens to be undefined —
	// which is the more dangerous of the two, because it looks like the caller thought about
	// invalidation and it would otherwise report `epochConsulted: true` while consulting nothing.
	if (!args || !('epoch' in args) || args.epoch === undefined) {
		throw new TypeError('resolveServeStatus: `epoch` is required (pass null when none applies)');
	}
	const { expiresAtMs, lastCachedMs, swrTtl, now, epoch, verifiedAtMs = NaN, basisAtMs = NaN } = args;

	const base = expiresAtMs > now ? 'hit' : expiresAtMs + swrTtl > now ? 'swr' : null;

	// `verifiedAtMs` DEFAULTS, where `epoch` throws, and the asymmetry is deliberate. Forgetting the
	// epoch makes a caller silently epoch-blind — it reports a page as fresh while bots are proxied.
	// Forgetting a verification only keeps a page invalidated, which is what would have happened
	// anyway: the pre-feature answer, reached honestly. A default is safe exactly when omitting the
	// argument cannot produce a serve that would otherwise have been refused.
	// TWO conditions, and the second is what makes a PER-URL verification safe for PER-DEVICE pages.
	// `pageSignature` is written by whichever device rendered last, so the proof belongs to one
	// render; `basisAtMs` is that render's `lastCached`. Requiring this key to be at least that new
	// exempts the verified render and anything newer, and refuses a lagging sibling — the split-pair
	// case, which is normal here. Both NaN-safe: an absent basis exempts nothing.
	const verified = verifiedAtMs > epoch?.at && lastCachedMs >= basisAtMs;

	if (epoch && !(lastCachedMs > epoch.at) && !verified) {
		// `!(a > b)`, never `<=`. `lastCached` is nullable and an unreadable value yields NaN, and
		// every comparison against NaN is false — so `<=` would read a page with no usable
		// `lastCached` as NOT invalidated, i.e. servable. Negating `>` makes NaN count as INVALIDATED
		// instead, which is the safe direction and the same direction a NaN `expiresAtMs` already
		// takes (never servable).
		return {
			// 'invalidated' ONLY when the invalidation is what cost us the serve. A page already past
			// its SWR window stays 'stale', so the `invalidated` counter means exactly "cache serves
			// this invalidation is costing us" and can be read as a blast-radius number rather than as
			// an unbounded tally of every stale key in the scope.
			status: base === null ? null : 'invalidated',
			servable: false,
			base,
			epochConsulted: true,
			invalidatedBy: { scope: epoch.scope, at: epoch.at },
			exemptedBy: null,
		};
	}

	// `epochConsulted` lets a caller that RENDERS a freshness verdict assert it actually asked, rather
	// than trusting that it did. The admin views' tests assert on it for that reason.
	//
	// `exemptedBy` is set ONLY when a verification is what saved this serve — i.e. an epoch applied,
	// the page predates it, and proof of currency overrode that. It is not merely "a verification
	// exists": an exemption that never changed an outcome must not be counted as one, or the metric
	// stops answering "how much is this feature buying" and starts answering "how many rows exist".
	//
	// `base !== null` is load-bearing, and is the same guard the invalidated branch above applies for
	// the same reason: a page already past its SWR window was never going to be served, so a
	// verification did not rescue anything. Without it, every stale-but-verified page in the scope
	// reports as an exemption and the metric measures row count instead of benefit.
	const exemptedBy =
		base !== null && epoch && !(lastCachedMs > epoch.at) && verified ? { scope: epoch.scope, at: verifiedAtMs } : null;
	return {
		status: base,
		servable: base !== null,
		base,
		epochConsulted: epoch !== null,
		invalidatedBy: null,
		exemptedBy,
	};
}
