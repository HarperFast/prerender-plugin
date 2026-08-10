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
	const { expiresAtMs, lastCachedMs, swrTtl, now, epoch } = args;

	const base = expiresAtMs > now ? 'hit' : expiresAtMs + swrTtl > now ? 'swr' : null;

	if (epoch && !(lastCachedMs > epoch.at)) {
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
		};
	}

	// `epochConsulted` lets a caller that RENDERS a freshness verdict assert it actually asked, rather
	// than trusting that it did. The admin views' tests assert on it for that reason.
	return { status: base, servable: base !== null, base, epochConsulted: epoch !== null, invalidatedBy: null };
}
