/**
 * RENDER LANES — priority as a range of the `nextRenderTime` index, not as a second index.
 *
 * `claim` is strictly `nextRenderTime`-ascending, so under any capacity deficit the queue serves
 * whatever is oldest-due. Two measurements say that is the wrong order, and prerender-plugin#80
 * carries both:
 *
 *   PROVENANCE. During a multi-hour production backlog, 239,090 of 521,929 overdue rows (~46%)
 *   were bot-discovered rather than sitemap-submitted. Half the render capacity was going to pages
 *   the site owner never submitted while submitted pages aged out of their SWR window.
 *
 *   TTL-BLINDNESS, which is the sharper one. Absolute due time treats a 1h-TTL homepage 3h overdue
 *   exactly like a 48h-TTL product page 3h overdue. The first is 300% stale, the second 6%. So the
 *   shortest-TTL route is structurally the most damaged, and it is damaged EVEN AT FULL CAPACITY:
 *   simulated over the real corpus, home sits at 4.78x its own TTL at 100% capacity and 48.83x at
 *   50%, against 1.08x / 2.00x for product.
 *
 * ── WHY NOT RANK BY RELATIVE LATENESS, WHICH IS THE OBVIOUS FIX ─────────────────────────────────
 *
 * Because it cannot be an ORDER. `relativeLateness(t) = (t - dueAt) / interval` is linear in `t`
 * with slope `1/interval`, so two rows with different intervals have different slopes and cross
 * exactly once. No stored key can express an order that changes with the clock, which means no
 * index can serve it.
 *
 * Re-ranking inside the claim window does not rescue it either, and this is the part that looks
 * like it should work. The pass reads a bounded window from the claim floor — ~140 rows in
 * production — and that window is ALREADY an EDF prefix. A 1h page sitting 600 minutes down the
 * queue never appears in it to be re-ranked at all. Widening the window does not help either: the
 * window is anchored at the OLDEST due time, and under a deep backlog every row in it is ancient.
 * A homepage that is two of its own cadences late is numerically nowhere near the head of an index
 * whose head is three days overdue.
 *
 * So relative lateness is the RATIONALE for which lane a row belongs in, and never the comparator.
 * Lanes are cut so that intervals inside one are similar by construction; EDF on `dueAt` within a
 * lane is then both index-backable and a good approximation of relative lateness — and EDF is
 * provably optimal for maximum lateness, so any deviation inside a lane only ever costs.
 *
 * ── THE ENCODING ────────────────────────────────────────────────────────────────────────────────
 *
 *     nextRenderTime = lane * STRIDE + dueAtMs
 *
 * One column, the existing index, no schema change and no second index. Measured (#80,
 * `21-duerank.mjs`, 200k rows): three lanes interleaved in ONE index, each with its own watermark,
 * read in 0.29-0.32 ms per lane — interleaving costs nothing. The same lane with its watermark
 * reset to zero costs 3.46 ms, so THE WATERMARK IS THE ENTIRE WIN, not the separation. And a
 * second index is not free: the existing secondary index is already 39-48% of reschedule wall
 * clock, so a per-lane index or table roughly doubles the hot write.
 *
 * Lower value is claimed first, so lane order IS priority order and `urgent` needs no encoding at
 * all — the hottest thing an operator can ask for is the cheapest to express.
 *
 * `STRIDE = 2^42` ms is ~139 years, comfortably above any real timestamp (now ~1.79e12), and
 * Harper's `Long` is 52-bit-safe (9.007e15), so it yields 2,048 lanes. This module uses at most a
 * couple of dozen. Lanes are effectively free, which is why the taxonomy below can afford to band
 * by TTL rather than economizing.
 *
 * ── WHY NOT THE OTHER ENCODINGS ─────────────────────────────────────────────────────────────────
 *
 *   An additive OFFSET on the due time is too weak: a backlog deeper than the offset absorbs it and
 *   the lane goes invisible once everything is overdue — which is the steady state this exists for.
 *
 *   LOW-ORDER bits are free (due times are minute-floored, so ~59,999 ms per minute are unused) and
 *   useless: they only break ties within a single minute, and a 600-minute backlog ignores them.
 *
 *   TIME-BUCKETING (bucket-major, lane-minor) works and keeps values valid timestamps, but it
 *   spends due-time precision — so it breaks exactly the 1h route this exists to fix — and the
 *   bucket must be no larger than `swrTtl`.
 *
 * ── AND WHY LANE 0 IS NOT THE DEFAULT ───────────────────────────────────────────────────────────
 *
 * Every row written before this existed is unencoded, i.e. numerically in lane 0. That is what
 * makes the encoding migration-free, and it is also a trap: lane 0 is `urgent`, so on the first
 * deploy the ENTIRE corpus reads as urgent, and `lanes.urgentMaxShare` would then ration the whole
 * queue down to a fifth of capacity. The rollout is therefore two steps and the switch ships off —
 * see `queue.lanes.enabled`. While it is off, nothing here is consulted and the claim pass is
 * byte-for-byte what it was.
 */

import { config } from '../config.js';
import { numberOf } from './time.js';

/**
 * The lane multiplier. 2^42 ms ~= 139 years: high enough that no real `dueAt` can reach into the
 * next lane, low enough that 2,048 lanes fit inside Harper's 52-bit-safe `Long`.
 *
 * A power of two rather than a round decimal so `Math.floor(v / STRIDE)` and `v % STRIDE` are exact
 * at every magnitude a `Long` can hold — a decimal stride makes the modulo drift in the last bits
 * once values pass 2^53, and a due time recovered one millisecond wrong is a due time.
 */
export const LANE_STRIDE = 2 ** 42;

/** Ceiling on lane count implied by `LANE_STRIDE` against a 52-bit-safe `Long`. */
export const MAX_LANES = Math.floor(Number.MAX_SAFE_INTEGER / LANE_STRIDE);

/**
 * The COARSE classes, in priority order. These are the names an operator reasons about, the names
 * that appear in logs and on the console, and the keys `queue.lanes.minShare` is written against.
 *
 * Named and ordered rather than a free-form integer on purpose: self-documenting in a log line,
 * reviewable in a diff, and it cannot drift into arbitrary magic numbers the way a priority int
 * does.
 */
export const URGENT = 'urgent';
export const SUBMITTED = 'submitted';
export const DISCOVERED = 'discovered';
export const COLD = 'cold';

/** Coarse classes in priority order — index into this is the class's rank, not its lane. */
export const LANE_CLASSES = [URGENT, SUBMITTED, DISCOVERED, COLD];

/**
 * TTL bands, ascending, from config. A row's band is the first entry its interval does not exceed;
 * an interval past every entry lands in the overflow band, so `bands.length + 1` bands exist.
 *
 * WHY BAND AT ALL, given the coarse classes above already fix provenance: because a class whose
 * intervals are NOT similar reproduces TTL-blindness inside itself. `submitted` at this deployment
 * spans 1h to 48h, so EDF within it is precisely the order we are trying to leave behind, and the
 * homepage would go on losing — to sitemap-submitted product pages instead of discovered ones.
 * Banding is what makes "EDF within a lane approximates relative lateness" true rather than
 * aspirational.
 *
 * `discovered` is banded too, which is a deliberate DEVIATION from the simulation in #80 — that
 * modelled discovery as a single lane. Banding it can only reduce within-lane lateness and it does
 * not touch the inter-lane floors the simulation actually measured, so the measured tail numbers
 * still bound this. It costs nothing: lanes are effectively free.
 */
const bands = () => {
	const raw = config.queue.lanes.ttlBands ?? [];
	// Sorted, de-duplicated and filtered here rather than trusted from config: the band index IS
	// part of the stored key, so an unsorted list would assign a shorter interval to a later lane
	// and quietly invert the ordering it exists to create.
	return [...new Set(raw.filter((ms) => Number.isFinite(ms) && ms > 0))].sort((a, b) => a - b);
};

/** How many bands each banded class occupies (the configured cuts, plus the overflow band). */
export const bandCount = () => bands().length + 1;

/** Which band an interval falls in: 0 for the fastest, `bandCount() - 1` for the overflow. */
export const bandOf = (intervalMs) => {
	const cuts = bands();
	const ms = Number(intervalMs);
	// A missing or unusable interval takes the SLOWEST band, not the fastest. It is the only safe
	// direction: an absent interval is an absent claim to urgency, and defaulting to band 0 would
	// let any row that lost its cadence jump ahead of the homepage.
	if (!Number.isFinite(ms) || ms <= 0) return cuts.length;
	for (let i = 0; i < cuts.length; i++) if (ms <= cuts[i]) return i;
	return cuts.length;
};

/**
 * The lane layout, which is entirely determined by `bandCount()`:
 *
 *     0                       urgent          (unbanded — operator intent has no cadence argument)
 *     1 .. B                  submitted,  band 0 .. B-1
 *     B+1 .. 2B               discovered, band 0 .. B-1
 *     2B+1                    cold            (unbanded — a failing row's cadence is not the point)
 *
 * `urgent` and `cold` are deliberately unbanded. Urgent is an operator statement that outranks
 * every cadence argument by construction, and banding it would let a slow-route urgent request lose
 * to a fast-route one — which is not a thing an operator asked for. Cold is the opposite: a row that
 * has failed repeatedly has no credible cadence to be judged against, and banding it would let a
 * broken 1h route consume the floor reserved for the whole failing tail.
 */
export const laneCount = () => 2 * bandCount() + 2;

const COLD_LANE = () => laneCount() - 1;

/**
 * The lane for a row, from the same stable inputs `resolveRenderInterval` uses.
 *
 * DERIVED, NEVER STORED — that is load-bearing. Resolving at write time from `sitemapUrl` presence,
 * the route-resolved interval and the failure count means a config change (a new band cut, a route
 * moved to a different cadence) is retroactive on each key's next render with NO sweep of the
 * corpus. Storing a lane column would mean every such change needed one.
 *
 * @param {object} row
 * @param {boolean} row.fromSitemap  the target carries a `sitemapUrl`
 * @param {number}  row.renderInterval  the EFFECTIVE cadence in ms (route > stored > default,
 *   demand rung applied) — the same number the due time was computed from
 * @param {boolean} [row.urgent]  operator intent; outranks everything
 * @param {boolean} [row.cold]  repeatedly failing, or never successfully rendered
 */
export const laneFor = ({ fromSitemap, renderInterval, urgent = false, cold = false } = {}) => {
	if (urgent) return 0;
	if (cold) return COLD_LANE();
	const band = bandOf(renderInterval);
	return (fromSitemap ? 1 : 1 + bandCount()) + band;
};

/** The coarse class a lane belongs to — for logs, metrics dimensions and `minShare` lookup. */
export const classOfLane = (lane) => {
	const B = bandCount();
	if (lane <= 0) return URGENT;
	if (lane >= COLD_LANE()) return COLD;
	return lane <= B ? SUBMITTED : DISCOVERED;
};

/** A stable, readable label for one lane: `submitted/b0`, `discovered/b2`, `urgent`, `cold`. */
export const laneLabel = (lane) => {
	const klass = classOfLane(lane);
	if (klass === URGENT || klass === COLD) return klass;
	const B = bandCount();
	return `${klass}/b${(lane - 1) % B}`;
};

/**
 * Encode a due time into a lane. The inverse of `dueAtOf`/`laneOf`.
 *
 * Clamped rather than throwing: a lane past the layout can only come from a config edit racing a
 * write, and a row filed one lane too low still renders — whereas throwing here would fail a
 * schedule write, which is the one outcome that loses a page.
 */
export const encodeDueAt = (dueAtMs, lane) => {
	// `numberOf`, NOT `Number`: `Number(null)` is 0, and 0 is finite — so a bare coercion would turn
	// an ABSENT due time into a real due time of 0, and a floor of zero means NO FLOOR — which puts
	// the claim scan back to seeking the absolute index minimum. The value is returned UNCHANGED
	// rather than normalized, so absence stays absence all the way to the row and every existing
	// guard downstream still recognizes it. (A real 0 still encodes, and still unbounds the floor —
	// that is the documented `nextRenderTime = 1` shape and it must keep working.)
	const at = numberOf(dueAtMs);
	if (!Number.isFinite(at)) return dueAtMs;
	const bounded = Math.min(Math.max(0, lane | 0), MAX_LANES - 1);
	return bounded * LANE_STRIDE + at;
};

/** The lane an encoded value sits in. An unencoded (pre-lanes) value reads as lane 0. */
export const laneOf = (encoded) => {
	const v = numberOf(encoded);
	return Number.isFinite(v) && v > 0 ? Math.floor(v / LANE_STRIDE) : 0;
};

/**
 * The due time inside an encoded value — what every caller that wants a TIMESTAMP must use.
 *
 * This is the one function whose absence at a call site is silent and expensive: an encoded value
 * used as a date is a date ~139 years per lane in the future, so a served page's `expiresAt`, a
 * console's "next render" column and the invalidation accelerator's `nextRenderTime - interval`
 * arithmetic all read as plausible-but-wrong rather than as an error. The funnel decodes on the way
 * out (`getScheduleRow`, the claim projection) so that in-plugin readers cannot forget; anything
 * reading the exported REST surface directly has to call this itself.
 */
export const dueAtOf = (encoded) => {
	const v = numberOf(encoded);
	// Same rule as `encodeDueAt`: an unusable value is handed back exactly as it arrived, so a null
	// stays a null rather than becoming a due time of zero somewhere downstream.
	if (!Number.isFinite(v)) return encoded;
	return v > 0 ? v % LANE_STRIDE : v;
};

/** Inclusive lower / exclusive upper bound of one lane's slice of the index. */
export const laneRange = (lane) => ({ from: lane * LANE_STRIDE, to: (lane + 1) * LANE_STRIDE });

/**
 * THE FAIRNESS ALLOCATOR — how one claim batch is divided between lanes.
 *
 * This is scheduler policy and it is deliberately NOT part of the ordering key. Keeping it out
 * means it is tunable live with no rewriting of stored rows; any scheme that bakes fairness into
 * the encoding needs the whole corpus re-encoded to change a bound. That is the strongest single
 * argument for keeping ordering and fairness separate, and #80 makes it explicitly.
 *
 * Two findings from the simulation drive the shape, and both are load-bearing:
 *
 *   STRICT PRIORITY STARVES THE TAIL AT EVERY CAPACITY LEVEL, INCLUDING 100%. Its lag numbers look
 *   excellent precisely BECAUSE it drops work — starvation is invisible in a lag metric. So lane
 *   order alone is not the policy.
 *
 *   FLOORS BEAT FIXED SHARES. Fixed shares summing to 1.0 leave nothing for the priority order to
 *   spend, and since EDF is optimal for maximum lateness, deviating from it costs. Reserving a
 *   MINIMUM for the classes that need protecting and letting the rest compete in lane order is far
 *   better in the tail: discovery reaches 71 h instead of 133 h at 50% capacity, 29 h instead of
 *   40 h at 75%.
 *
 * So: lanes are visited in priority order, `urgent` is capped by its DRAIN SHARE rather than by
 * admission (a hard structural bound that needs no token bucket and no admission bookkeeping — lanes
 * below it always get at least `1 - urgentMaxShare` of every batch), and the protected classes are
 * guaranteed a floor that earlier lanes may not spend.
 *
 * A reservation that goes unclaimed is not lost: `topUp()` releases it back to lane order once every
 * lane has had its turn, so a floor for a class with nothing due costs nothing.
 */
export const createLaneBudget = ({ grantLimit, urgentMaxShare = 0, minShare = {} } = {}) => {
	const total = Math.max(0, grantLimit | 0);
	// `Math.max(1, ...)` so a share small enough to floor to zero still admits one job: a cap of 0
	// would silently make the lane unreachable, which for `urgent` means an operator's force-render
	// never runs and nothing says why.
	const urgentCap = urgentMaxShare > 0 ? Math.max(1, Math.floor(total * urgentMaxShare)) : 0;

	const reserve = new Map();
	for (const [klass, share] of Object.entries(minShare)) {
		const n = Math.floor(total * (Number(share) || 0));
		if (n > 0) reserve.set(klass, n);
	}

	let spent = 0;
	let releaseReservations = false;
	const spentByClass = new Map();
	const spentIn = (klass) => spentByClass.get(klass) ?? 0;

	return {
		get remaining() {
			return Math.max(0, total - spent);
		},

		/** How many jobs `lane` may be granted right now. */
		allowanceFor(lane) {
			const remaining = Math.max(0, total - spent);
			if (remaining === 0) return 0;
			const klass = classOfLane(lane);

			let allowance = remaining;
			if (!releaseReservations) {
				// Hold back whatever is still owed to the OTHER protected classes...
				let heldBack = 0;
				for (const [c, n] of reserve) {
					if (c === klass) continue;
					heldBack += Math.max(0, n - spentIn(c));
				}
				// ...but never below this class's own outstanding reservation, or a class whose floor is
				// the last thing left could be held back by its own siblings' floors and starve on the
				// mechanism meant to protect it.
				const own = Math.max(0, (reserve.get(klass) ?? 0) - spentIn(klass));
				allowance = Math.max(remaining - heldBack, Math.min(remaining, own));
			}

			if (klass === URGENT) allowance = Math.min(allowance, Math.max(0, urgentCap - spentIn(URGENT)));
			return Math.max(0, Math.min(allowance, remaining));
		},

		record(lane, granted) {
			if (granted <= 0) return;
			spent += granted;
			const klass = classOfLane(lane);
			spentByClass.set(klass, spentIn(klass) + granted);
		},

		/**
		 * Release every unclaimed reservation, for a second sweep in lane order.
		 *
		 * Needed because a floor is a MINIMUM, not an entitlement: a class with fewer due rows than
		 * its floor would otherwise leave that slice of the batch unspent while lanes above it had
		 * work. `urgentMaxShare` is deliberately NOT released — it is a cap, not a reservation, and
		 * the whole point of capping a drain share is that it holds even when nothing else wants the
		 * capacity.
		 */
		topUp() {
			releaseReservations = true;
		},
	};
};
