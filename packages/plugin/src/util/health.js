/**
 * THE HEALTH LINE — one `[prerender] health {json}` log line per node every `health.interval`: what the
 * bot path answered since the last line, and the state of the background work that keeps those answers
 * fresh.
 *
 * WHAT IT IS FOR. Alerting on what crawlers experience needs numbers a log pipeline can sum across nodes
 * and compare with last week, and it needs an ABSENCE to mean something. Analytics already carry most of
 * the traffic numbers, but they live in each node's `hdb_analytics` and are read on demand — nothing ships
 * them anywhere. A log line rides whatever already ships the node's log, and one that is written whether
 * or not anything is wrong turns its own silence into the signal that the plugin, or every worker on the
 * node, has stopped. So the line is unconditional and the judging is left to the alert rules, which hold
 * the history the plugin does not.
 *
 * NOT FROM ANALYTICS. The counts are kept here, in memory, rather than read back from `hdb_analytics`:
 * an analytics row lands a minute or more after its requests, on the main thread's aggregation cadence,
 * and that cadence has lost a third of every period before (harper#2692). Analytics are still recorded
 * exactly as before — the console reads them — and this module neither reads nor depends on them, nor on
 * `analytics.enabled`.
 *
 * ONE SHARED BLOCK, EXACT ACROSS WORKERS. The counters are one `Int32Array` over a node-wide shared
 * buffer (`getSab`, which HOLDS it: on Harper 5.2 an unheld shared buffer is freed and the next fetch
 * returns zeros). Every worker adds with `Atomics.add`. The worker that writes a line drains every
 * counter with `Atomics.exchange(…, 0)`, so a line carries exactly the requests counted since the line
 * before it — none twice, none lost to a worker that happened not to write — and nothing accumulates long
 * enough to overflow. Contention is not a concern at serve rates: a contended atomic add costs about what
 * the `recordAnalytics` call beside it does.
 *
 * WHO WRITES. Every worker arms a timer for the next interval boundary; the first to compare-and-swap that
 * boundary into the shared clock writes the line and the rest return. A busy or wedged worker therefore
 * cannot hold the line back, and a missing line means no worker on the node could run. The clock holds
 * the boundary in epoch milliseconds, so it only moves forward even when the interval is changed live.
 *
 * WHAT IT COSTS. A handful of atomic adds per bot request; once an interval, one worker drains a few
 * hundred cells, makes three small node-local reads for the state fields, and logs about 1 KB.
 *
 * LEVEL. `health.level` (default `notify`). Some hosts forward only `warn` and above from components to
 * their log shipper; set `warn` there, or the line never leaves the node.
 *
 * Process restarts zero the buffer, so up to one interval of counts is lost on a restart; `span` on the
 * first line after one says how long it covers. A worker restart loses nothing: the other workers hold
 * the buffer.
 */

import { createHash } from 'node:crypto';
import { config, getLogger, onConfigApplied } from '../config.js';
import { getSab, releaseSabs } from './coordination.js';
import { pluginVersion } from './hostInfo.js';
import { prerenderRoutePaths } from './routeClass.js';

const KEY_PREFIX = 'prerender_health_v1';
const COUNTS_PREFIX = `${KEY_PREFIX}/counts/`;
const CLOCK_KEY = `${KEY_PREFIX}/clock`;

/** The route bucket for everything that matched no prerender route (passthrough, unclassified, unrouted). */
export const OTHER_ROUTE = 'other';

// A route table longer than this folds its tail into `other` rather than growing the line without bound.
const MAX_ROUTES = 32;

// How long one state section may take before the line is written without it.
const STATE_TIMEOUT_MS = 5_000;

// Fire just after the boundary, so a timer that is a few milliseconds early still lands in the new interval.
const TICK_DELAY_MS = 250;

/**
 * Node totals, in buffer order. Every field is a count of bot requests (or responses) since the last line.
 *
 *   req                          bot requests that reached the handler
 *   cache … entity               what answered it (`bot_serve` source)
 *   s2xx … s5xx                  the status class sent
 *   own5xx                       5xx this plugin produced itself: the handler failed, it made the answer up (render-now's
 *                                timeout 504), or a stored or rendered answer carried a 5xx
 *   originUnreachable            the origin could not be reached at all (refused, reset, timed out before a status),
 *                                so the handler answered 500. Not own5xx: the origin is down, or this node's way to it.
 *                                s5xx − own5xx − originUnreachable is the origin's own 5xx, relayed live.
 *   truncated                    a committed 200 whose cached body failed while streaming
 *   over1s, over3s               response headers took longer than 1s / 3s
 *   ageOver1x, ageOver2x         a served snapshot older than 1× / 2× its route's render interval
 */
export const NODE_FIELDS = Object.freeze([
	'req',
	'cache',
	'rendered',
	'origin',
	'raw',
	'negative',
	'entity',
	's2xx',
	's3xx',
	's4xx',
	's5xx',
	'own5xx',
	'originUnreachable',
	'truncated',
	'over1s',
	'over3s',
	'ageOver1x',
	'ageOver2x',
]);

/** Per-route counts, as the node fields of the same name. A request's route is its `route_serve` label. */
export const ROUTE_FIELDS = Object.freeze([
	'req',
	'origin',
	's4xx',
	's5xx',
	'own5xx',
	'originUnreachable',
	'over3s',
	'ageOver1x',
	'ageOver2x',
]);

const N = Object.fromEntries(NODE_FIELDS.map((field, i) => [field, i]));
const R = Object.fromEntries(ROUTE_FIELDS.map((field, i) => [field, i]));
const SOURCES = new Set(['cache', 'rendered', 'origin', 'raw', 'negative', 'entity']);
// The node field for each status class, by `Math.floor(status / 100)`.
const STATUS_FIELD = [undefined, undefined, N.s2xx, N.s3xx, N.s4xx, N.s5xx];

// ---- the counters --------------------------------------------------------------------------------------

let layout = null;
// The layout a config apply replaced, until this worker builds the next one and folds it in.
let retired = null;

/**
 * The buffer layout for the current route table: node fields, then one block per prerender route, then
 * `other`. Keyed by a fingerprint of the layout, so a live route change starts a fresh buffer instead of
 * reading counts into the wrong routes.
 *
 * THE OLD BUFFER IS FOLDED IN, NOT ABANDONED. Each worker moves to the new key on its own next use, and
 * when it does it drains the old buffer into the new one — node fields as they are, each route block into
 * the route of the same name, else `other`. Abandoned, the old buffer would lose everything counted since
 * the last line while `span` still claimed the whole interval, and a route table changed back would find
 * it again, stale counts and all. Draining it is exact however the workers interleave: the first to switch
 * moves every count so far, each later one moves what it added since, and the last leaves it empty before
 * releasing it.
 */
const buildLayout = () => {
	const paths = prerenderRoutePaths().slice(0, MAX_ROUTES);
	const names = [...paths, OTHER_ROUTE];
	const cells = NODE_FIELDS.length + names.length * ROUTE_FIELDS.length;
	const fingerprint = createHash('sha256')
		.update(JSON.stringify([NODE_FIELDS, ROUTE_FIELDS, names]))
		.digest('hex')
		.slice(0, 16);
	const key = `${COUNTS_PREFIX}${fingerprint}`;
	const view = new Int32Array(getSab(key, cells * Int32Array.BYTES_PER_ELEMENT));
	const next = { key, names, slots: new Map(paths.map((path, slot) => [path, slot])), view };
	if (retired && retired.key !== key) foldInto(retired, next);
	retired = null;
	releaseSabs((held) => held.startsWith(COUNTS_PREFIX) && held !== key);
	return next;
};

/** Drain every count in `from` into `to`, route blocks by route name (`other` when `to` has no such route). */
const foldInto = (from, to) => {
	const move = (fromIndex, toIndex) => {
		const count = Atomics.exchange(from.view, fromIndex, 0);
		if (count !== 0) Atomics.add(to.view, toIndex, count);
	};
	for (let i = 0; i < NODE_FIELDS.length; i++) move(i, i);
	from.names.forEach((name, slot) => {
		const target = routeBase(to.slots.get(name) ?? to.names.length - 1);
		const source = routeBase(slot);
		for (let i = 0; i < ROUTE_FIELDS.length; i++) move(source + i, target + i);
	});
};

const currentLayout = () => (layout ??= buildLayout());

// The route table, and so the layout, can change on any config apply. Rebuilt on next use; a layout
// replaced before this worker used the one after it is still the one holding its counts.
onConfigApplied(() => {
	if (layout) retired = layout;
	layout = null;
});

const routeBase = (slot) => NODE_FIELDS.length + slot * ROUTE_FIELDS.length;

/**
 * Count one answered bot request. Called once per request, after the response is built; never throws.
 *
 * @param {object} serve
 * @param {string} serve.route        the `route_serve` label: the matched route's path, else a route class
 * @param {string|null} serve.source  `bot_serve` source, or null when the request never resolved
 * @param {number} serve.status       the status sent
 * @param {number} serve.ms           handler time to the response
 * @param {boolean} serve.failed      the handler itself failed (its 500)
 * @param {boolean} [serve.originUnreachable] …because the origin fetch failed before any status arrived
 * @param {boolean} [serve.madeHere]  the answer is one this plugin made up (render-now's timeout 504), whatever its source
 * @param {number} [serve.ageMs]      a served snapshot's age
 * @param {number} [serve.intervalMs] that snapshot's route render interval
 */
export const countServe = ({
	route,
	source,
	status,
	ms,
	failed = false,
	originUnreachable = false,
	madeHere = false,
	ageMs,
	intervalMs,
}) => {
	if (!config.health.enabled) return;
	try {
		const { view, slots, names } = currentLayout();
		const base = routeBase(slots.get(route) ?? names.length - 1);

		Atomics.add(view, N.req, 1);
		Atomics.add(view, base + R.req, 1);
		if (SOURCES.has(source)) Atomics.add(view, N[source], 1);
		if (source === 'origin') Atomics.add(view, base + R.origin, 1);

		const statusClass = Math.floor(Number(status) / 100);
		const statusField = STATUS_FIELD[statusClass];
		if (statusField !== undefined) Atomics.add(view, statusField, 1);
		if (statusClass === 4) Atomics.add(view, base + R.s4xx, 1);
		if (statusClass === 5) {
			Atomics.add(view, base + R.s5xx, 1);
			// Three causes, kept apart because they have different owners: the origin never answered (its
			// outage, or this node's path to it); the live origin answered a 5xx, relayed; or ours — a handler
			// failure, an answer this plugin made up, or a stored or rendered one that carried a 5xx.
			if (failed && originUnreachable) {
				Atomics.add(view, N.originUnreachable, 1);
				Atomics.add(view, base + R.originUnreachable, 1);
			} else if (failed || madeHere || source !== 'origin') {
				Atomics.add(view, N.own5xx, 1);
				Atomics.add(view, base + R.own5xx, 1);
			}
		}

		if (ms > 1_000) Atomics.add(view, N.over1s, 1);
		if (ms > 3_000) {
			Atomics.add(view, N.over3s, 1);
			Atomics.add(view, base + R.over3s, 1);
		}

		if (ageMs >= 0 && intervalMs > 0 && ageMs > intervalMs) {
			Atomics.add(view, N.ageOver1x, 1);
			Atomics.add(view, base + R.ageOver1x, 1);
			if (ageMs > 2 * intervalMs) {
				Atomics.add(view, N.ageOver2x, 1);
				Atomics.add(view, base + R.ageOver2x, 1);
			}
		}
	} catch {
		// Counting must never cost a crawler its response.
	}
};

/** Count a committed 200 whose cached body failed while streaming — the crawler got a truncated page. */
export const countTruncated = () => {
	if (!config.health.enabled) return;
	try {
		Atomics.add(currentLayout().view, N.truncated, 1);
	} catch {
		// As countServe.
	}
};

// ---- the line ------------------------------------------------------------------------------------------

let clock = null;
// [0] the last boundary a worker claimed, [1] when the counters were last drained (both epoch ms).
const clockView = () => (clock ??= new BigInt64Array(getSab(CLOCK_KEY, 2 * BigInt64Array.BYTES_PER_ELEMENT)));

// When this process started, for the `span` of its first line.
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/** Claim `boundaryMs` for this worker. True for exactly one worker per boundary across the node. */
const claimBoundary = (boundaryMs) => {
	const view = clockView();
	const wanted = BigInt(boundaryMs);
	for (;;) {
		const previous = Atomics.load(view, 0);
		if (previous >= wanted) return false;
		if (Atomics.compareExchange(view, 0, previous, wanted) === previous) return true;
	}
};

/** Read and zero every counter: what was counted since the last drain, and how long that covered. */
const drain = (nowMs) => {
	const { view, names } = currentLayout();
	const counts = Array.from(view, (_, i) => Atomics.exchange(view, i, 0));
	const last = Number(Atomics.exchange(clockView(), 1, BigInt(nowMs)));
	const span = Math.max(0, Math.round((nowMs - (last > 0 ? last : PROCESS_STARTED_AT)) / 1000));

	const bot = Object.fromEntries(NODE_FIELDS.map((field, i) => [field, counts[i]]));
	const routes = {};
	names.forEach((name, slot) => {
		const base = routeBase(slot);
		routes[name] = Object.fromEntries(ROUTE_FIELDS.map((field, i) => [field, counts[base + i]]));
	});
	return { span, bot, routes };
};

const withTimeout = (promise, ms) => {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

let stateProviders = {};

/**
 * Build the line for the interval ending `nowMs`: drain the counters, then read each state section. A
 * section that throws or outruns STATE_TIMEOUT_MS is written as null and named in `err`, so a broken
 * reader cannot hold the line back or pass for healthy.
 */
export const buildHealthLine = async (nowMs = Date.now()) => {
	const { span, bot, routes } = drain(nowMs);
	const line = { v: pluginVersion(), span, up: Math.round(process.uptime()), bot, routes };
	const errors = [];
	for (const [name, read] of Object.entries(stateProviders)) {
		try {
			const section = withTimeout(
				Promise.resolve().then(() => read(nowMs)),
				STATE_TIMEOUT_MS
			);
			line[name] = (await section) ?? null;
		} catch (e) {
			line[name] = null;
			errors.push(name);
			getLogger().debug?.(`[prerender] health: the ${name} section failed: ${e?.message ?? String(e)}`);
		}
	}
	if (errors.length > 0) line.err = errors;
	return line;
};

const emit = (line) => {
	const log = getLogger();
	const write = typeof log[config.health.level] === 'function' ? log[config.health.level] : log.info;
	write.call(log, `[prerender] health ${JSON.stringify(line)}`);
};

/** Write the line for `boundaryMs` if this worker is the one that claims it. */
const writeIfClaimed = async (boundaryMs) => {
	if (!config.health.enabled || !claimBoundary(boundaryMs)) return false;
	emit(await buildHealthLine(Date.now()));
	return true;
};

let started = false;
let timer = null;

const arm = () => {
	if (timer) clearTimeout(timer);
	timer = null;
	if (!config.health.enabled) return;
	const interval = config.health.interval;
	const now = Date.now();
	const boundary = (Math.floor(now / interval) + 1) * interval;
	timer = setTimeout(() => void tick(boundary), boundary - now + TICK_DELAY_MS);
	timer.unref?.();
};

const tick = async (boundaryMs) => {
	timer = null;
	// Re-armed first, so a slow line never pushes the next boundary back.
	arm();
	try {
		await writeIfClaimed(boundaryMs);
	} catch (e) {
		getLogger().error?.(`[prerender] health line not written: ${e?.message ?? String(e)}`);
	}
};

/**
 * Start the health line on this worker. Called on EVERY worker: whichever claims a boundary writes it.
 * `providers` maps a section name to `(nowMs) => object | null | Promise<…>`, read once per line by the
 * writer. Idempotent; `health.enabled` and `health.interval` are live.
 */
export const startHealthLine = (providers = {}) => {
	if (started) return;
	started = true;
	stateProviders = providers;
	arm();
	onConfigApplied(arm);
};

// ---- test seams ----------------------------------------------------------------------------------------

/** Tests only: claim and write as the timer would. */
export const writeIfClaimedForTest = writeIfClaimed;

/** Tests only: replace the state providers without starting a timer. */
export const setHealthProvidersForTest = (providers) => {
	stateProviders = providers;
};

/** Tests only: zero the shared clock, so a test's boundaries need not exceed an earlier test's. */
export const resetHealthClockForTest = () => {
	Atomics.store(clockView(), 0, 0n);
	Atomics.store(clockView(), 1, 0n);
};

/** Tests only: forget the layout and clock, as a new process would. */
export const resetHealthForTest = () => {
	layout = null;
	retired = null;
	clock = null;
	stateProviders = {};
	if (timer) clearTimeout(timer);
	timer = null;
	started = false;
};
