import { metrics } from '../metrics.js';
import { CacheKey } from './cacheKey.js';

/**
 * What the last accepted render of a PAGE (one URL on one device) produced, and whether this render
 * fell short of it.
 *
 * ## The gap this closes
 *
 * A readiness contract bounds what it NAMES, and the most valuable thing on a commerce page cannot
 * usefully be named. Recommendation rails have no server-rendered placeholder — wrapper and content
 * appear in the same frame — so a contract can only assert "every rail that exists is filled", which
 * is true of a page that ended up with one rail instead of three. Measured: a render that satisfied
 * its contract stored 610 product links where the same URL normally stores 674, and every clause
 * held.
 *
 * The page's own history is the oracle that covers it. Nothing has to be written down and nothing
 * rots: the expectation is whatever this page last actually produced.
 *
 * ## Why the unit is the PAGE and not the URL
 *
 * One job renders every device variant of a URL, and the variants are different pages. Measured on
 * the live home page: 625 `img` on desktop, 256 on mobile — a 59% gap against a rule that fires at
 * 50%. A history keyed by URL alone and fed by whichever variant happened to store would report that
 * gap as content loss, and on the `shortfall` series a device artefact and a real regression look
 * identical. So the row is keyed by cache key, exactly as the page itself is.
 *
 * ## Why it converges instead of alarming forever
 *
 * The naive version is a trap. Compare against history, flag anything that dropped, and the first
 * legitimate change — a rail removed site-wide, a product delisted, a redesign — flags that URL on
 * every render from then on. So a shortfall is a VOTE, not a verdict: once the same shortfall has
 * been seen `rebaselineAfter` times in a row the expectation is re-learned and the counter resets.
 * Once is a lost rail; three times in a row is the new shape of the page.
 *
 * ## Where this runs, and what it deliberately does not do
 *
 * On the render-result path, owner-scoped and node-local, exactly like `recordPageClaim` — and
 * best-effort for the same reason: a render must never fail because a regression signal could not
 * be recorded.
 *
 * It does NOT hand the expectation to the renderer at claim time. That would mean a cross-database
 * point read per claimed job, or denormalizing onto RenderSchedule, which is residency-pinned and
 * rewritten on every render. The browser supports being given expectations (it can then hold a
 * render briefly while a shortfall recovers), and a consumer that wants that can plumb it; the
 * detection itself does not need it, because the comparison can happen where the data already is.
 *
 * NOTE: the same comparison exists in the browser package (`readiness.assessExpectations`) for that
 * in-render path. The rule is small but it is the same rule, and the two must agree — change both.
 */

const DEFAULTS = Object.freeze({
	/** Fractional drop that counts as a shortfall. Measured run-to-run churn on these pages is ~5%. */
	tolerance: 0.5,
	/** Consecutive shortfalls after which the expectation is stale and the page has simply changed. */
	rebaselineAfter: 3,
});

const table = () => databases.probe_state.RenderExpectation;

/**
 * Compare one render's observations against what this URL last produced, record what is worth
 * recording, and store the new expectation.
 *
 * Pure decision, impure edges: `assess` below is exported for the tests, because the interesting
 * cases (first render, churn, convergence) are all in the rule rather than in the storage.
 */
export const assess = (learned, stored, policy = DEFAULTS) => {
	const previous = stored?.counts ?? null;
	// A first render has nothing to regress from, and treating "unknown" as "zero" would make every
	// new URL look broken.
	if (!previous) return { shortfalls: [], rebaselined: false, next: { counts: learned, consecutive: 0 } };

	const shortfalls = [];
	for (const [name, count] of Object.entries(learned)) {
		const expected = previous[name];
		// No history for this observation, or the page never had any: nothing to fall short OF.
		if (typeof expected !== 'number' || expected <= 0) continue;
		if (count < expected * (1 - policy.tolerance)) shortfalls.push({ name, expected, got: count });
	}

	if (!shortfalls.length) return { shortfalls: [], rebaselined: false, next: { counts: learned, consecutive: 0 } };

	const consecutive = (stored.consecutiveShortfalls ?? 0) + 1;
	// Enough renders have agreed on the drop that it is the page, not the render. Accept it, re-learn
	// from this render, and reset — so the next real regression is judged against the page as it is.
	if (consecutive >= policy.rebaselineAfter) {
		return { shortfalls: [], rebaselined: true, next: { counts: learned, consecutive: 0 } };
	}
	// Still suspicious: report it, and KEEP the old expectation. Learning from a render we believe is
	// short would ratchet the expectation down to whatever the page just failed to produce, which is
	// exactly how a real regression would erase its own evidence.
	return { shortfalls, rebaselined: false, next: { counts: previous, consecutive } };
};

/**
 * Record one render's readiness observations against this page's history. Never throws.
 *
 * `readiness` is the report the browser posted for this device's variant (`VariantMetadata.readiness`);
 * `learned` on it is the observation counts. Called once per stored variant, from the render-result
 * path, with the URL the job was scheduled under and the variant's device.
 */
export const recordReadinessExpectation = async ({ url, deviceType }, readiness, policy = DEFAULTS) => {
	const cacheKey = CacheKey.toCacheKey({ url, deviceType });
	try {
		const learned = readiness?.learned;
		// Nothing observed means nothing to compare and nothing to store — a contract with no
		// `observe` clauses, or a renderer that predates the field.
		if (!hasObservations(learned)) return;

		const stored = await table().get({ id: cacheKey, select: ['counts', 'consecutiveShortfalls'] });
		const parsed = stored
			? { counts: safeParse(stored.counts), consecutiveShortfalls: stored.consecutiveShortfalls }
			: null;
		const verdict = assess(learned, parsed, policy);

		for (const shortfall of verdict.shortfalls) metrics.renderReadinessShortfall(readiness.contract, shortfall.name);
		if (verdict.rebaselined) metrics.renderReadinessRebaseline(readiness.contract);
		if (verdict.shortfalls.length) {
			logger.warn(
				`Prerender ${url} (${deviceType}): rendered fewer than this page last produced — ` +
					verdict.shortfalls.map((s) => `${s.name} ${s.got} vs ${s.expected}`).join(', ')
			);
		}

		// Written on EVERY governed render, even when `assess` kept the old counts: the write is what
		// refreshes the table's expiration, so a page still in rotation never has its history reclaimed.
		const fields = {
			counts: JSON.stringify(verdict.next.counts),
			consecutiveShortfalls: verdict.next.consecutive,
			updatedAt: new Date(),
		};
		// patch cannot create and put would clobber nothing else here, but the read already happened
		// for the comparison, so choosing costs nothing extra.
		if (stored) await table().patch(cacheKey, fields);
		else await table().put(cacheKey, { cacheKey, ...fields });
	} catch (error) {
		// Once, then every thousandth. If the table is missing on a node (a schema that did not load)
		// this path fails on EVERY governed render — thousands an hour per node — and a warn per render
		// is the flood, not the signal. The count says how long it has been going on.
		if (recordFailures++ % FAILURE_WARN_EVERY === 0) {
			logger.warn(
				error,
				`Prerender: could not record the readiness expectation for ${cacheKey} (${recordFailures} failure(s) on this node so far)`
			);
		}
	}
};

/** `learned` carries at least one observation — `{}` is what a contract with no `observe` clauses posts. */
export const hasObservations = (learned) => !!learned && typeof learned === 'object' && Object.keys(learned).length > 0;

const FAILURE_WARN_EVERY = 1000;
let recordFailures = 0;

const safeParse = (value) => {
	try {
		const parsed = JSON.parse(value ?? 'null');
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		// A row we cannot read is a row we re-learn from this render, which is the same self-healing
		// path as a first render.
		return null;
	}
};
