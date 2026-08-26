/**
 * CHANGE PROBE — re-render when the origin says the page changed, instead of guessing with an
 * interval. See util/changeProbeSpec.js for the pure half (rules, templating, extraction).
 *
 * WHY THIS EXISTS. A render interval bounds staleness blind: it costs a full headless-Chrome
 * render (~seconds of CPU) per page per interval whether or not anything changed, and it still
 * misses every change that lands mid-interval. For the fields that actually invalidate a snapshot
 * — price and availability on a commerce PDP — the origin can answer "did it change?" thousands of
 * times cheaper: one small fetch of an endpoint the page itself consults (`source: request`), or
 * of the document's own JSON-LD Product offers (`source: document`, the generic contract). The
 * probe reduces that answer to a signature stored on the target and re-renders ONLY on change —
 * which also keeps the byte-change signal crawlers schedule recrawls on aligned with reality.
 *
 * TWO CADENCES, TWO CHANGE MODES:
 *
 *   THE SWEEP walks the whole registry every `sweepInterval`, probing owned, rule-matched targets
 *   at a capped rate. It catches CONTINUOUS drift — sell-through availability, item-level price
 *   moves — where per-URL detection is the only detection there is.
 *
 *   THE CANARY probes a small fixed cohort every `canary.interval`. It exists because commerce
 *   price does NOT drift continuously — it steps at promotional events, most of a catalog at once
 *   (measured: 81% of PDPs repriced in one event) — and a mass change is visible in a sample of
 *   hundreds within minutes, at negligible cost. On a trip it can record a BULK INVALIDATION
 *   (`invalidateScope`), which stops serving every pre-change snapshot in the scope immediately —
 *   bots get origin content, which carries the correct fields by definition — while re-renders
 *   refill the cache on their own machinery (cadence + the invalidation accelerator). Detection
 *   and response are deliberately different mechanisms: re-rendering an entire corpus takes the
 *   fleet the better part of a day; invalidating it takes one 102-byte row.
 *
 * OWNER-SCOPED, LIKE EVERY SWEEP HERE. Each node probes only the URLs residency assigns to it:
 * the trigger writes due-now schedule rows, and a due-now row is only claimable where the writing
 * node's own claim floor covers it (see util/invalidationReenqueue.js for the measured failure of
 * non-owner lowering). Every node running the same sweep covers the keyspace with no coordination.
 *
 * WHAT A PROBE FAILURE MEANS: NOTHING. A fetch error, a non-2xx, an unparseable body, or an
 * extraction that yields no values leaves the stored signature untouched and triggers nothing —
 * the probe is an ACCELERATOR on top of the baseline render cadence, never a gate on it. The
 * failure the design must survive is the origin replatforming under the rule (the exact event
 * that motivated this feature twice over): that surfaces as a high failure share, which is
 * counted, logged loudly at >50%, and changes no schedule.
 *
 * DRY RUN measures before it acts, like render.demand: every probe runs, every decision is
 * counted and logged, signatures are written (so per-pass change counts converge to the true
 * change RATE rather than re-reporting the same changes forever — the demandInterval precedent),
 * but nothing is re-rendered and nothing is invalidated.
 */

import { setImmediate as yieldNow, setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { config, onConfigApplied } from '../config.js';
import { metrics } from '../metrics.js';
import { fnv1a32 } from './hash.js';
import { epochMsOf, currentMinuteMs, MINUTE, SECOND } from './time.js';
import { getResidencyByUrl } from './residency.js';
import { resolveEffectiveInterval } from './routeClass.js';
import { writeSchedules } from './renderSchedule.js';
import { recordInvalidation, isScopeResolvable } from './invalidation.js';
import { dispatcherFor, configuredStagingIp } from './upstream.js';
import { cacheKeysOf } from '../resources/Target.js';
import { walkUrlRange } from './urlWalk.js';
import { batchPause, cycleRatePerSecond, pacedRate, stepBackoff } from './probePacer.js';
import { loopLagMonitorState, readLoopLagMs, startLoopLagMonitor, stopLoopLagMonitor } from './loopLag.js';
import { isPassRunning, publishProbeState, readProbeState } from './probeState.js';
import {
	compileProbeRules,
	buildProbeRequest,
	extractValues,
	extractJsonLdOffers,
	isSameProbeOrigin,
	signatureOf,
	statusSignalFor,
	apiClaimOf,
	claimsDisagree,
	pageClaimFromOffers,
} from './changeProbeSpec.js';

const targetTable = () => databases.render_service.Target;
const pageTable = () => databases.page_cache.PrerenderedPage;
const invalidationTable = () => databases.invalidation.Invalidation;
const probeStateTable = () => databases.probe_state.ProbeState;

// Rows scanned between event-loop yields (util/reconcile.js's cadence).
const YIELD_EVERY = 200;

// What every probe read of the registry projects — what matching and the trigger need
// (writeSchedules wants fromSitemap + the cadence). The stored signature is NOT here: it lives
// in the node-local ProbeState table (see schema.graphql), read per probed URL.
const TARGET_SELECT = ['url', 'sitemapUrl', 'renderInterval', 'demandInterval', 'state'];

// Compile + memoize the rule list, keyed on config identity — applyOptions rebuilds config from
// defaults on every change, so a fresh array means a reload (the routeClass memo pattern).
let compiledRules = null;
let compiledFrom;
export const probeRules = () => {
	if (config.changeProbe.rules !== compiledFrom) {
		compiledRules = compileProbeRules(config.changeProbe.rules);
		compiledFrom = config.changeProbe.rules;
	}
	return compiledRules;
};

/**
 * One canary cohort per rule label. A sweep-built cohort is the `count` matched URLs with the
 * SMALLEST hashes — a deterministic, keyspace-uniform sample (taking the first `count` in key
 * order would sample the alphabetical head of the corpus instead, i.e. the oldest product IDs on
 * a commerce catalog). The bootstrap build (`ensureCohorts`) still uses a 1-in-16 hash stride so
 * it can stop after ~16x the cohort size instead of walking the whole registry — its key-order
 * bias is deliberate and temporary, replaced by the first sweep's sample.
 */
const CANARY_STRIDE = 16;
const isCanaryCandidate = (url) => fnv1a32(url) % CANARY_STRIDE === 0;
let cohorts = new Map(); // rule label -> urls this node owns

/** Bounded lowest-N-by-hash selection; prunes at 4x so an unbounded registry stays O(count) memory. */
export const cohortCollector = (count) => {
	const entries = [];
	const prune = () => {
		entries.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
		entries.length = Math.min(entries.length, count);
	};
	return {
		add(url) {
			entries.push([fnv1a32(url), url]);
			if (entries.length > count * 4) prune();
		},
		list() {
			prune();
			return entries.map(([, url]) => url);
		},
	};
};

const newStats = () => ({
	examined: 0, // rows scanned
	owned: 0, // rows this node owns
	matched: 0, // owned rows a rule matched (suppressed excluded)
	probed: 0, // probes attempted = seeded + unchanged + changed + failed
	seeded: 0, // first observation stored, nothing compared
	unchanged: 0,
	changed: 0,
	triggered: 0, // changes that scheduled a re-render
	deferred: 0, // changes past maxTriggersPerSweep — signature kept stale so the next pass retries
	failed: 0, // fetch/parse/extraction failures — signature untouched, nothing triggered
	errors: 0, // trigger writes that threw
	fresh: 0, // skipped: baseline younger than reprobeAfter (a pass already covered it)
	pageMismatch: 0, // cached page disagreed with the origin (pageCheck) — OVERLAYS the buckets above, which count by signature outcome alone
	throttled: 0, // probes the origin refused with a pushback status — what drives the backoff
	throttleLevel: 1, // ORIGIN pacing-window multiplier when the pass ended; 1 means never backed off
	loadThrottleLevel: 1, // LOCAL (event-loop) multiplier when the pass ended; 1 means never backed off
	loopLagMs: null, // last p95 loop-lag excess read, or null when the governor is off/blind
	pacedRate: null, // requests/sec the last batch was paced at (continuous mode's derived rate)
	behindBatches: 0, // batches that wanted more than ratePerSecond to hit the cycle target
	abortedOnDistress: false, // the pass gave up because the origin refused everything
	failureSamples: [], // first few failures, for the admin surface
});

const readBounded = async (stream, maxBytes) => {
	const chunks = [];
	let total = 0;
	for await (const chunk of stream) {
		total += chunk.length;
		if (total > maxBytes) {
			stream.destroy?.();
			throw new Error(`response exceeded changeProbe.maxResponseBytes (${maxBytes})`);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
};

/**
 * One probe HTTP request. The configured desktop User-Agent always rides along (probes are
 * per-URL, not per-device: the premise of watching these fields is that they are
 * device-invariant). The origin SECURITY TOKEN and the staging-IP DNS pin ride along ONLY for a
 * same-origin probe — both belong to the served origin, and a `request`-mode rule may name any
 * host, so sending them unconditionally would hand the bypass secret to (and mis-route DNS for) a
 * third party. Same scoping rule the renderer applies to its own bypass token.
 */
const probeFetch = async ({ url, method, headers, body }, targetUrl) => {
	const urlObj = new URL(url);
	const timeout = config.changeProbe.requestTimeout;
	const sameOrigin = isSameProbeOrigin(targetUrl, url);
	const response = await dispatcherFor(sameOrigin ? configuredStagingIp() : undefined).request({
		origin: urlObj.origin,
		path: urlObj.pathname + urlObj.search,
		method,
		headers: {
			'user-agent': config.origin.userAgents.desktop,
			...(sameOrigin ? { [config.origin.securityToken.header]: config.origin.securityToken.value } : {}),
			'accept-encoding': 'gzip',
			...headers,
		},
		body: body ?? undefined,
		headersTimeout: timeout,
		bodyTimeout: timeout,
	});
	const raw = await readBounded(response.body, config.changeProbe.maxResponseBytes);
	// maxOutputLength so a pathological gzip body cannot expand past what the raw cap allows.
	const buffer =
		response.headers['content-encoding'] === 'gzip'
			? gunzipSync(raw, { maxOutputLength: config.changeProbe.maxResponseBytes * 16 })
			: raw;
	return {
		statusCode: response.statusCode,
		body: buffer.toString('utf8'),
		retryAfterMs: parseRetryAfter(response.headers['retry-after']),
	};
};

/**
 * Probe one URL under one rule: fetch, extract, sign. Returns the signature, or null when the
 * response yielded no usable observation (the all-null rule); throws on fetch/HTTP failure.
 * A 404 is a failure like any other — target retirement is suppression's job, not the probe's.
 */
// Status codes that mean THE ORIGIN IS ASKING US TO STOP, as opposed to a bad rule or a dead
// product. 429 is explicit; 502/503/504 are an origin at or past its limit, and a probe sweep
// that keeps its rate through them is adding load to something already failing.
const DISTRESS_STATUS = new Set([429, 502, 503, 504]);
// undici's timeout/connection failures — the unstated version of the same signal.
const DISTRESS_CODES = new Set([
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET',
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
]);

/** Tag an error with whether it is the origin pushing back, and any Retry-After it named. */
const probeError = (message, statusCode, retryAfterMs) =>
	Object.assign(new Error(message), {
		statusCode,
		distress: DISTRESS_STATUS.has(statusCode),
		retryAfterMs: retryAfterMs ?? null,
	});

/** Is this thrown error the origin pushing back (vs. a rule/product problem)? */
export const isDistress = (e) =>
	Boolean(e?.distress) || DISTRESS_CODES.has(e?.code) || DISTRESS_CODES.has(e?.cause?.code);

// `Retry-After` is seconds or an HTTP date; anything else is ignored rather than guessed at.
const parseRetryAfter = (value) => {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
	const at = Date.parse(value);
	if (!Number.isFinite(at)) return null;
	return Math.max(0, Math.min(at - Date.now(), MAX_RETRY_AFTER_MS));
};
const MAX_RETRY_AFTER_MS = 5 * 60_000;

const probeOnce = async (rule, url) => {
	const request = buildProbeRequest(rule, url);
	if (!request) return null;
	const { statusCode, body, retryAfterMs } = await probeFetch(request, url);
	// A DECLARED status signal outranks every failure path below, including the distress
	// classification: the operator has said what this status means for THIS endpoint, so it is an
	// observation rather than a fault, and an endpoint that answers it routinely must not be read
	// as an origin in trouble. Only non-2xx statuses can carry a signal (the compiler rejects the
	// rest), so this can never shadow normal extraction.
	if (statusCode < 200 || statusCode >= 300) {
		const signaled = statusSignalFor(rule, statusCode, body);
		if (signaled !== null) return signaled;
	}
	if (statusCode >= 300 && statusCode < 400) {
		// Fail-closed rather than followed: a silently followed redirect can move the probe onto a
		// host the operator never named (and same-origin gating above would then be deciding about
		// the wrong URL). A redirecting endpoint is a rule to fix, and the failure metrics say so.
		throw probeError(
			`HTTP ${statusCode} (redirects are not followed — probe endpoints must answer directly)`,
			statusCode,
			retryAfterMs
		);
	}
	if (statusCode < 200 || statusCode >= 300) throw probeError(`HTTP ${statusCode}`, statusCode, retryAfterMs);
	if (rule.source === 'request') return signatureOf(extractValues(JSON.parse(body), rule.extract));
	const offers = extractJsonLdOffers(body);
	return offers ? signatureOf(offers) : null;
};

/**
 * Re-render one changed URL now: hard-expire the cached pages and file every device row at the
 * current minute. Owner-scoped by the sweep, so the funnel's floor lowering covers these keys on
 * the node whose claim scan reads them.
 *
 * The expiry is backdated PAST the stale-while-revalidate window, not set to now. A trip means
 * the page's probed fields (price/availability) provably changed, so one more serve is a served
 * mismatch — the swr window exists to smooth over a LATE re-render of content that is presumed
 * still right, and a tripped page is the one case where it is known wrong. This matches the hard
 * stop the canary's bulk-invalidation epoch already applies (`resolveServeStatus` refuses an
 * invalidated page outright); `Target.revalidate` keeps the plain `Date.now()` expiry
 * deliberately — an operator asking for a re-render is not asserting the content is wrong.
 */
export const triggerRevalidate = async (row) => {
	const keys = cacheKeysOf(row.url);
	const hardExpiredAt = Date.now() - config.page.swrTtl;
	await Promise.all(
		keys.map(async (cacheKey) => {
			const page = await pageTable().get({ id: cacheKey, select: ['cacheKey', 'expiresAt'] });
			if (page) await pageTable().patch(cacheKey, { expiresAt: hardExpiredAt });
		})
	);
	// The current minute PER TRIGGER, never captured once for a whole pass — a paced sweep runs for
	// hours, and a stale minute files rows below other nodes' claim-floor guard bands (the
	// Target.revalidate lesson).
	const nextRenderTime = currentMinuteMs();
	await writeSchedules(
		keys.map((cacheKey) => ({
			cacheKey,
			nextRenderTime,
			fromSitemap: !!row.sitemapUrl,
			effectiveInterval: resolveEffectiveInterval(row.url, row),
		}))
	);
};

// ProbeState is node-local (`replicate: false`) and only ever touched by the owner's probe —
// a missing row (never probed, ownership moved, node rebuilt, target deleted) reads as null and
// the state machine SEEDS, which is the safe direction everywhere this can happen.
// Returns the whole baseline, not just the signature: `probedAt` is what lets a pass skip a URL
// another pass already covered (see `reprobeAfter` in runProbePass).
const readSignature = async (url) => {
	const row = await probeStateTable().get({ id: url, select: ['url', 'signature', 'probedAt', 'pageSignature'] });
	if (!row) return null;
	// A Date column can surface as a Date, an epoch number, a string, or — the trap this coercion
	// exists for — a BigInt, which `new Date()` REFUSES rather than coerces (TypeError, which here
	// would take down the whole sweep from a read). Same defence as resolveRenderInterval's, one
	// type earlier. Anything still unparseable reads as "age unknown", which probes rather than
	// skips: never skip a probe on a value we could not read.
	const stamp = typeof row.probedAt === 'bigint' ? Number(row.probedAt) : row.probedAt;
	const probedAt = stamp === undefined || stamp === null ? NaN : new Date(stamp).getTime();
	return { signature: row.signature ?? null, probedAt, pageSignature: row.pageSignature ?? null };
};
// The probe's write must NEVER carry the page claim through a whole-row put: `pageSignature`
// belongs to the render path, and the value read at the top of processOne is a full probe request
// older than the row by the time this runs — a render landing in that window would have its fresh
// claim replaced by the stale copy. So an EXISTING row takes a patch naming only the probe's own
// columns (the claim survives structurally, not by being copied), with clearing the claim on an
// acted trip as the one explicit exception. Only a MISSING row takes a put — patch does NOT
// create a missing record (verified against the engine — "updated 0 of 1 records, skipped"), and
// the seeding write is by definition to a URL with no row yet; a patch there would make every
// first observation a silent no-op. A row the render path creates between the read and that put
// loses at most one baseline to the race and re-seeds on the next pass.
export const writeSignature = (url, signature, { rowExists = false, clearClaim = false } = {}) => {
	const fields = { signature, probedAt: new Date() };
	if (clearClaim) fields.pageSignature = null;
	return rowExists
		? probeStateTable().patch(url, fields)
		: probeStateTable().put(url, { url, pageSignature: null, ...fields });
};

/**
 * Record what a freshly rendered page CLAIMS, for the probe to compare the origin against.
 * Called from the render result path (owner-scoped, like the sweep) and deliberately best-effort:
 * a render must never fail because a probe optimisation could not be recorded. Extraction that
 * yields nothing writes nothing — same rule as a failed probe, so a markup change cannot mass-
 * trigger by making every page look like a disagreement.
 */
export const recordPageClaim = async (url, structuredOffers) => {
	try {
		// The master switch gates STORAGE too — "Off = no probes, no timers, nothing stored" is
		// the config contract, and this is the hottest write path to be skipping work on.
		if (!config.changeProbe.enabled) return;
		// Parse ONCE, outside the predicate: this runs per render, and `find` would otherwise
		// re-parse the same URL for every rule it tests. `URL.parse` over `new URL` is the repo
		// idiom (it returns null instead of throwing on a malformed value).
		const pathname = URL.parse(url)?.pathname;
		if (!pathname) return;
		// Select the rule EXACTLY as the sweep does — first match of ALL rules — then require
		// pageCheck on it. Searching for "first match WITH pageCheck" instead would let an earlier
		// pageCheck-less rule shadow this URL on the sweep side: claims written per render here,
		// never compared there, and nothing to say so.
		const rule = probeRules().find((r) => r.pathPattern.test(pathname));
		if (!rule?.pageCheck) return;
		if (structuredOffers === undefined) {
			// The renderer does not know the field at all — it predates 1.20.0. There is
			// deliberately NO fallback to parsing the stored HTML: recovering the offers here means
			// a regex scan and a JSON parse of a ~1MB document on the hottest write path in this
			// process, to reconstruct what the browser had structured in front of it. So pageCheck
			// is INERT against an older renderer — say so rather than failing silently, since a
			// config that looks enabled and protects nothing is the worst outcome. `null` is the
			// other case and is NOT this warn: a >=1.20.0 renderer ran the extraction and the page
			// declared no Product offers — nothing to record, same rule as a failed probe.
			warnPageClaimUnsupported();
			return;
		}
		const claim = pageClaimFromOffers(structuredOffers);
		if (!claim) return;
		// patch cannot create, and put would clobber the probe's own signature/probedAt — so read
		// first and choose. The read is a node-local point read on a small table, once per render
		// of a pageCheck-matched URL.
		const existing = await probeStateTable().get({ id: url, select: ['url'] });
		if (existing) await probeStateTable().patch(url, { pageSignature: claim });
		else await probeStateTable().put(url, { url, pageSignature: claim });
	} catch (e) {
		logger.warn?.(`[prerender] change-probe page claim not recorded for ${url}: ${e?.message ?? String(e)}`);
	}
};

// One line per hour per worker: this fires per RENDER, and a fleet mid-upgrade would otherwise
// log it thousands of times a minute.
let lastUnsupportedWarnAt = 0;
const warnPageClaimUnsupported = () => {
	const now = Date.now();
	if (now - lastUnsupportedWarnAt < 3600000) return;
	lastUnsupportedWarnAt = now;
	logger.warn?.(
		`[prerender] changeProbe.pageCheck is enabled but the render result carried no structuredOffers — ` +
			`the renderer is older than @harperfast/prerender-browser 1.20.0, so page claims are not being ` +
			`recorded and pageCheck cannot detect anything. Upgrade the render fleet or disable pageCheck.`
	);
};

/**
 * Probe a stream of target rows and act on what changed. ALL I/O is injected, so the decision
 * logic — ownership, matching, the seed/changed/deferred/failed state machine, pacing, the
 * trigger budget, dry-run — is testable without Harper globals (the reconcileSchedules pattern).
 *
 * `rows` must never hold an open read cursor while this runs: the sweep feeds it from
 * already-collected chunks and the canary from point reads, so probe latency and schedule writes
 * happen with every cursor closed (see util/scan.js for why that discipline is structural).
 */
export const runProbePass = async ({
	rows,
	rules,
	ownerOf,
	hostname,
	probe,
	read,
	write,
	trigger,
	dryRun,
	maxTriggers,
	concurrency,
	ratePerSecond,
	pause = sleep,
	now = Date.now,
	isCanceled = () => false,
	collectCohort = null,
	ownershipChecked = false,
	onYield = () => yieldNow(),
	reprobeAfter = 0,
	backoffMax = 1,
	abortAfterDistress = 0,
	// Continuous mode. `cycleTarget` is the wall-clock budget for covering `sliceSize` matched
	// rows; with either absent the pass paces at `ratePerSecond` exactly as it always has, which
	// is what makes interval mode bit-identical rather than merely equivalent.
	cycleTarget = 0,
	sliceSize = 0,
	// The local-load governor. `readLag` returns excess-over-floor ms or null (see util/loopLag.js);
	// the default reads nothing, so the governor is inert unless a caller wires it up.
	readLag = () => null,
	lagThreshold = 0,
	loadBackoffMax = 1,
} = {}) => {
	const stats = newStats();
	const batch = [];

	// The origin-pressure state. `throttle` multiplies the pacing window, so it divides the
	// effective request rate; `distressStreak` is what ends a pass against an origin that is
	// simply down. See `flush` for how they move.
	let throttle = 1;
	let distressStreak = 0;
	let batchDistress = 0;
	let retryAfterMs = 0;

	// The local-pressure state, tracked SEPARATELY from `throttle` even though the two multiply
	// into one window. The operator question when a pass is crawling is always which of the two
	// is responsible — an origin shedding load and a node losing its event loop to the serve path
	// share a symptom and nothing else — and a single merged multiplier cannot answer it.
	let loadThrottle = 1;
	const passStarted = now();

	const processOne = async ({ row, rule }) => {
		// Read BEFORE the probe now (it used to read after, to skip the read on a failed probe).
		// The stored baseline carries WHEN it was taken, and a baseline younger than
		// `reprobeAfter` means another pass already covered this URL — the common case after a
		// restart, which otherwise re-probes hours of already-seeded ground. Trading a node-local
		// point read for an origin request is the right way round: the origin request is the
		// scarce, externally-visible resource.
		const stored = (await read(row.url)) ?? null;
		if (reprobeAfter > 0 && Number.isFinite(stored?.probedAt) && now() - stored.probedAt < reprobeAfter) {
			stats.fresh++;
			return;
		}
		stats.probed++;
		let observed;
		try {
			observed = await probe(rule, row.url);
		} catch (e) {
			observed = null;
			if (isDistress(e)) {
				stats.throttled++;
				batchDistress++;
				distressStreak++;
				if (e?.retryAfterMs > retryAfterMs) retryAfterMs = e.retryAfterMs;
			}
			if (stats.failureSamples.length < 3) {
				stats.failureSamples.push({ url: row.url, rule: rule.label, error: e?.message ?? String(e) });
			}
		}
		if (observed === null || observed === undefined) {
			stats.failed++;
			return;
		}
		distressStreak = 0;

		// ROUND-TRIP BLINDNESS. Everything below compares the origin to the origin, so a value
		// that changed and changed BACK between two passes is invisible — and a render that landed
		// inside that window left a page carrying the transient value. `pageSignature` is what the
		// cached page claims (written by the render, never here), so this asks the question the
		// signature comparison structurally cannot: does the page still agree with the origin?
		// Runs BEFORE the unchanged early-return, because "unchanged" is exactly the case it
		// exists to catch. Only for extracted responses — a status-signal literal carries no
		// price/availability to project (documented limitation).
		let pageDisagrees = false;
		if (rule.pageCheck && stored?.pageSignature) {
			let values = null;
			try {
				const parsed = JSON.parse(observed);
				if (Array.isArray(parsed)) values = parsed;
			} catch {
				values = null; // a status-signal literal, not an extracted array
			}
			if (values) pageDisagrees = claimsDisagree(stored.pageSignature, apiClaimOf(values, rule.pageCheck));
			if (pageDisagrees) stats.pageMismatch++;
		}

		const signatureChanged = Boolean(stored?.signature) && stored.signature !== observed;
		// Bucket by SIGNATURE outcome alone, BEFORE the page check influences control flow:
		// `probed = seeded + unchanged + changed + failed` is the documented invariant, and the
		// canary's denominator is changed + unchanged — a page-mismatch row that skipped both
		// would silently shrink the mass-change sample right when claims are most likely to be
		// stale. `pageMismatch` OVERLAYS these buckets; it never replaces them.
		if (signatureChanged) stats.changed++;
		else if (stored?.signature) stats.unchanged++;
		else stats.seeded++;
		if (!signatureChanged && !pageDisagrees) {
			if (!stored?.signature) {
				// First observation: baseline it, trigger nothing — the page's content is not known
				// to have changed, the probe just hadn't seen it before.
				await write(row.url, observed, { rowExists: stored !== null });
			}
			return;
		}
		if (dryRun) {
			// Signature written in dry-run ON PURPOSE: each pass then reports fresh changes — the
			// true change rate — instead of re-reporting the same delta forever. Demand-ladder
			// precedent (its dry run persists rung moves for the same reason). The page claim is
			// the opposite case and is deliberately NOT cleared: nothing was expired, so the
			// disagreement still stands — in dry-run `pageMismatch` reads as a standing gauge of
			// disagreeing pages per pass, where armed it is a detection rate.
			await write(row.url, observed, { rowExists: stored !== null });
			return;
		}
		if (stats.triggered >= maxTriggers) {
			// Budget spent: leave the signature STALE so the next pass re-detects and retries.
			// Bounds how much queue injection one pass can do (a mass change is the canary's job).
			stats.deferred++;
			return;
		}
		try {
			await trigger(row);
			stats.triggered++;
			// The page's claim is CLEARED on EVERY acted trip, not just a page disagreement: the
			// trip hard-expired the page, so whatever the claim described is no longer served — and
			// a preserved claim would re-detect against the NEW baseline on the next pass (a price
			// drift's old claim disagrees with the new price by construction) and re-spend the
			// trigger budget on a page already expired and already filed. The next render writes a
			// fresh claim; until then there is nothing to compare, which is the correct "I don't
			// know" state. Folded into this write so it costs no second round trip.
			await write(row.url, observed, { rowExists: stored !== null, clearClaim: true });
		} catch (e) {
			stats.errors++;
			globalThis.logger?.error?.(e, `[prerender] change-probe trigger failed for ${row.url}`);
		}
	};

	// Pacing: batches of `concurrency`, each batch held to the window `ratePerSecond` implies for
	// its size — so the sustained request rate is capped whatever the origin's latency does.
	//
	// ON TOP OF THAT CAP, the window stretches when the origin pushes back. `ratePerSecond` is
	// sized with the origin's operator for a HEALTHY origin; it says nothing about an origin
	// having a bad afternoon, and a sweep that holds its configured rate through 429s and 503s is
	// adding load to something already failing. Halving the rate per distressed batch and
	// recovering by halves keeps the steady state at the configured rate while making the
	// response to pressure immediate and the recovery slow — the asymmetry a backoff needs.
	const flush = async () => {
		if (!batch.length) return;
		const batchSize = batch.length;
		const started = now();
		batchDistress = 0;
		retryAfterMs = 0;
		await Promise.all(batch.map(processOne));

		throttle = stepBackoff(throttle, batchDistress > 0, backoffMax);
		stats.throttleLevel = throttle;

		// The LOCAL governor, read once per batch — the same cadence the origin governor moves on,
		// so the two stay comparable, and cheap enough at that cadence to be unconditional when
		// armed (a histogram read plus a reset, no JS-side accumulation).
		//
		// An ABSENT reading is not a quiet reading. No monitor, or a window that caught no
		// samples, means the governor has nothing to say and must leave the multiplier where it
		// is; treating null as zero would let a probe that cannot measure the loop conclude the
		// loop is fine and accelerate into a node it is already hurting.
		if (lagThreshold > 0) {
			const lag = readLag();
			if (lag) {
				loadThrottle = stepBackoff(loadThrottle, lag.p95 > lagThreshold, loadBackoffMax);
				stats.loopLagMs = lag.p95;
			}
		}
		stats.loadThrottleLevel = loadThrottle;

		// CONTINUOUS MODE: the rate is derived, every batch, from how far behind the walk actually
		// is — remaining rows over remaining budget — instead of being a constant the operator
		// re-solves by hand whenever the corpus grows. `ratePerSecond` stays a hard ceiling, so a
		// target that cannot be met is simply not met and SAYS SO (`behind`), which is the
		// observable replacement for the interval model's silently-skipped pass.
		const cycleRate = cycleRatePerSecond({
			sliceSize,
			done: stats.matched,
			elapsed: now() - passStarted,
			cycleTarget,
		});
		const { rate, behind } = pacedRate({ ratePerSecond, cycleRate });
		if (behind && cycleTarget > 0 && sliceSize > 0) stats.behindBatches++;
		stats.pacedRate = rate;

		const elapsed = now() - started;
		batch.length = 0;
		const wait = batchPause({
			batchSize,
			rate,
			originThrottle: throttle,
			loadThrottle,
			elapsed,
			retryAfterMs,
		});
		if (wait > 0) await pause(wait);
	};

	for await (const row of rows) {
		if (isCanceled()) {
			stats.aborted = true;
			break;
		}
		// An origin that has refused every probe for this long is down, not busy. Backing off
		// further just crawls a doomed pass into the next one's window while holding the sweep
		// lock; the scheduled pass after this one is the retry, and it starts clean.
		if (abortAfterDistress > 0 && distressStreak >= abortAfterDistress) {
			stats.aborted = true;
			stats.abortedOnDistress = true;
			break;
		}
		stats.examined++;
		// Skipped rows (unowned, unmatched — most of a multi-node registry) never reach the paced
		// flush, so without this a chunk of pure skips runs as one synchronous burst. Same
		// discipline, same cadence as util/reconcile.js's walk.
		if (stats.examined % YIELD_EVERY === 0) await onYield();
		if (!ownershipChecked && ownerOf(row.url) !== hostname) continue;
		stats.owned++;
		if (row.state === 'suppressed') continue;
		let rule = null;
		for (const candidate of rules) {
			if (buildProbeRequest(candidate, row.url)) {
				rule = candidate;
				break;
			}
		}
		if (!rule) continue;
		stats.matched++;
		collectCohort?.(rule, row.url);
		batch.push({ row, rule });
		if (batch.length >= Math.max(1, concurrency)) await flush();
	}
	await flush();

	return stats;
};

/**
 * The registry, streamed in cursor-bounded chunks: each chunk's read transaction opens, fills an
 * array, and closes BEFORE any probe or write runs — a paced pass over a large registry takes
 * hours, and no cursor may live anywhere near that long. One-sided PK range, the only shape a
 * string-PK walk should take here (a two-sided range collapses to a filtered intersection).
 * Delegates to walkUrlRange so an unreadable row is skipped and counted rather than silently
 * ending the sweep as if the registry were exhausted (see util/urlWalk.js).
 */
const walkTargets = (chunkSize, onUnreadable) =>
	walkUrlRange(targetTable(), { startAt: '', select: TARGET_SELECT, chunkSize, onUnreadable });

/** The canary cohort, re-read fresh: membership is remembered, rows are not. */
async function* readCohortRows(urls) {
	for (const url of urls) {
		const row = await targetTable().get({ id: url, select: TARGET_SELECT });
		if (row) yield row;
	}
}

// Metric emission must never cost the pass or the trip action its outcome.
const countProbe = (series) => {
	try {
		metrics.changeProbe(1, series);
	} catch (e) {
		logger.warn(`[prerender] change-probe ${series} not recorded: ${e?.message ?? String(e)}`);
	}
};

const emitStats = (stats, kind) => {
	try {
		metrics.changeProbe(stats.probed, 'probed');
		metrics.changeProbe(stats.seeded, 'seeded');
		metrics.changeProbe(stats.changed, 'changed');
		metrics.changeProbe(stats.triggered, 'triggered');
		metrics.changeProbe(stats.deferred, 'deferred');
		metrics.changeProbe(stats.failed, 'failed');
		metrics.changeProbe(stats.fresh, 'fresh');
		metrics.changeProbe(stats.throttled, 'throttled');
		metrics.changeProbe(stats.pageMismatch, 'page_mismatch');
		metrics.changeProbe(stats.behindBatches, 'cycle_behind');
	} catch (e) {
		logger.warn(`[prerender] change-probe ${kind} metrics not recorded: ${e?.message ?? String(e)}`);
	}
};

const logPass = (stats, kind, dryRun) => {
	const line = { kind, dryRun, ...stats };
	// >50% failures is the replatform signature: the endpoint or markup this rule was written
	// against has probably changed shape, and every failed probe is a page silently back on
	// interval-only freshness.
	if (stats.probed > 0 && stats.failed / stats.probed > 0.5) {
		logger.warn(
			`[prerender] change-probe ${kind}: ${stats.failed} of ${stats.probed} probes failed — the probed ` +
				`endpoint or markup has likely changed shape; re-verify the rule (failures change nothing, so ` +
				`these pages are back to interval-only freshness until it is fixed)`,
			line
		);
	} else {
		(logger.notify ?? logger.info).call(logger, `[prerender] change-probe ${kind} ${JSON.stringify(line)}`);
	}
};

// A running pass is considered dead if its heartbeat stops for this long. Generous next to the
// heartbeat interval below (which is what a healthy pass writes), tight enough that a crashed
// worker does not disable the probe until the process restarts.
const PASS_STALE_MS = 5 * MINUTE;
// How often a running pass touches the row. Cheap — one node-local write — but not free, so it
// is throttled well below the flush cadence rather than written per batch.
const HEARTBEAT_MS = 30 * SECOND;

/**
 * Claim a pass for this node, or refuse because one is already live.
 *
 * NODE-WIDE, which is the whole point: the guard this replaces read module state on whichever
 * worker answered the request, so it was ~always false and the console's "Run sweep" could start
 * a second full-rate sweep alongside the scheduled one. See util/probeState.js.
 */
const claimPass = async (kind) => {
	const row = await readProbeState();
	if (isPassRunning(row, kind, PASS_STALE_MS)) {
		return {
			ok: false,
			reason: `a probe ${kind} is already running on this node`,
			lastRun: row?.[kind]?.lastRun ?? null,
		};
	}
	const startedAt = Date.now();
	// Claim first, keeping the previous result readable while the new pass runs — the backlog
	// snapshotter's shape, for the same reason: an operator looking mid-pass should see the last
	// finished one, not a hole.
	await publishProbeState({
		[kind]: { running: true, startedAt, heartbeatAt: startedAt, lastRun: row?.[kind]?.lastRun ?? null },
	});
	return { ok: true, startedAt };
};

/** Release the claim and publish the finished record. */
const releasePass = async (kind, startedAt, lastRun) => {
	await publishProbeState({ [kind]: { running: false, startedAt, heartbeatAt: Date.now(), lastRun } });
};

/**
 * A throttled heartbeat for a pass in flight.
 *
 * A sweep runs for hours, so its liveness cannot be inferred from `startedAt` — that is exactly
 * the case where a fixed staleness window has to choose between wedging on a crash and letting a
 * healthy pass be stolen from itself. Touching the row as it goes removes the choice.
 */
const makeHeartbeat = (kind, startedAt) => {
	let last = startedAt;
	return async (progress) => {
		const now = Date.now();
		if (now - last < HEARTBEAT_MS) return;
		last = now;
		await publishProbeState({ [kind]: { running: true, startedAt, heartbeatAt: now, progress: progress ?? null } });
	};
};

// ---- the two passes ----------------------------------------------------------------------------

let sweepRunning = false;
let canaryRunning = false;
let lastSweep = null;
let lastCanary = null;

/**
 * The slice size the last COMPLETED cycle measured, per node-process.
 *
 * Continuous pacing needs a denominator and nothing knows it up front: how many of this node's
 * rows a rule matches is discovered by walking. So a finished cycle publishes what it counted and
 * the next one paces against it. Only a cycle that ran to completion may update it — an aborted or
 * interrupted pass walked part of the key range, and its `matched` is a fraction that would make
 * the next cycle pace to a corpus several times smaller than the real one and finish far early.
 *
 * Reset to null (not to a guess) whenever the estimate could be stale for a reason other than
 * corpus drift, so the mode falls back to "run at the ceiling and measure" rather than to a
 * confident wrong number.
 */
let measuredSliceSize = null;

const isContinuous = () => config.changeProbe.mode === 'continuous';

/**
 * Shared pass limits.
 *
 * `paced` is NOT a convenience flag — CYCLE PACING BELONGS TO THE SWEEP ALONE. The sweep covers
 * this node's whole slice against a wall-clock budget; the canary re-probes a small fixed cohort
 * on a deliberately fast cadence and has no budget to spread anything across. Handing it the
 * sweep's `cycleTarget`/`sliceSize` would pace a 500-URL cohort as though it were 237k rows —
 * `remaining/left` computed from the sweep's denominator — so the mass-change detector would run
 * at whatever rate the SWEEP's schedule implied, slowing as the cycle target lengthened. The
 * canary's whole value is that it is fast, and nothing in its own numbers would have shown it
 * had stopped being so.
 */
const passLimits = (dryRunOverride, { paced = false } = {}) => ({
	dryRun: typeof dryRunOverride === 'boolean' ? dryRunOverride : config.changeProbe.dryRun,
	maxTriggers: config.changeProbe.maxTriggersPerSweep,
	concurrency: config.changeProbe.concurrency,
	ratePerSecond: config.changeProbe.ratePerSecond,
	backoffMax: config.changeProbe.backoffMax,
	abortAfterDistress: config.changeProbe.abortAfterDistress,
	// Continuous pacing, or zeroes — and zeroes are what make interval mode bit-identical: with
	// no cycle target `cycleRatePerSecond` is never consulted and the window is the one
	// `ratePerSecond` has always implied.
	cycleTarget: paced && isContinuous() ? config.changeProbe.cycleTarget : 0,
	sliceSize: paced && isContinuous() ? (measuredSliceSize ?? 0) : 0,
	// The local governor is opt-in and orthogonal to the mode, so it is read from config rather
	// than gated on `isContinuous()` — an operator who wants it in interval mode has been warned
	// by the option's own documentation and may have reasons. It applies to the canary too: a
	// congested node is congested whichever pass is running on it.
	lagThreshold: config.changeProbe.load.enabled ? config.changeProbe.load.lagThreshold : 0,
	loadBackoffMax: config.changeProbe.load.backoffMax,
	readLag: readLoopLagMs,
});

/**
 * One full registry pass on THIS node. Rebuilds the canary cohorts as it walks.
 *
 * `reseed` (set by the canary's chained pass) FORCES a probe of every matched URL: a mass change
 * has just been absorbed, so every baseline is known-stale and skipping the fresh-looking ones
 * would leave exactly the pages the trip was about carrying pre-change signatures.
 */
export const runProbeSweepOnce = async ({ dryRun, label = null, reseed = false } = {}) => {
	// Worker-local guard, and it is SET SYNCHRONOUSLY on purpose. The node-wide claim below is an
	// await, so setting the flag after it would leave a window in which two concurrent calls on
	// this worker both pass this check before either marks itself running — a re-entrancy race
	// that the local flag exists precisely to prevent, and which a test caught.
	if (sweepRunning) return { skipped: true, reason: 'a probe sweep is already running', lastRun: lastSweep };
	sweepRunning = true;

	// Then the NODE-WIDE claim. The local flag alone was the whole guard, which meant a manual run
	// on any worker but 0 could not see the scheduled sweep and started a second one at full rate
	// against the origin. See util/probeState.js.
	const claim = await claimPass('sweep');
	if (!claim.ok) {
		// Release the local flag we optimistically took — the `finally` below is not reached from
		// here, so failing to reset it would wedge this worker's sweep for the life of the process.
		sweepRunning = false;
		return { skipped: true, reason: claim.reason, lastRun: claim.lastRun ?? lastSweep };
	}
	const startedAt = claim.startedAt;
	const beat = makeHeartbeat('sweep', startedAt);
	const limits = passLimits(dryRun, { paced: true });
	try {
		const rules = probeRules();
		const count = Math.max(1, config.changeProbe.canary.count | 0);
		const collectors = new Map(rules.map((rule) => [rule.label, cohortCollector(count)]));
		let unreadable = 0;
		let yields = 0;
		const stats = await runProbePass({
			rows: walkTargets(config.changeProbe.chunkSize, () => {
				unreadable++;
				countProbe('unreadable');
			}),
			rules,
			ownerOf: getResidencyByUrl,
			hostname: server.hostname,
			probe: probeOnce,
			read: readSignature,
			write: writeSignature,
			trigger: triggerRevalidate,
			...limits,
			// The liveness signal for the node-wide claim, throttled inside `makeHeartbeat` — this
			// fires every YIELD_EVERY rows, the heartbeat writes at most every HEARTBEAT_MS. Its
			// failure is swallowed by `publishProbeState`: a pass must never die of bookkeeping.
			onYield: async () => {
				await yieldNow();
				// A LOCAL counter, not `stats` — `const stats = await runProbePass({...})` leaves
				// `stats` in the temporal dead zone while this callback runs, so touching it here
				// throws a ReferenceError rather than reading undefined.
				yields++;
				await beat({ examinedApprox: yields * YIELD_EVERY });
			},
			// A reseed re-baselines everything, so it must not skip fresh-looking rows.
			reprobeAfter: reseed ? 0 : config.changeProbe.reprobeAfter,
			// A pending reseed cancels too: the pass that must stand down for it is this one.
			isCanceled: () => !config.changeProbe.enabled || sweepInterrupt !== null,
			collectCohort: (rule, url) => collectors.get(rule.label).add(url),
		});
		stats.unreadable = unreadable;
		// An interrupted pass keeps the OLD cohorts — a partial walk's sample covers only the key
		// range it reached, and the chained reseed rebuilds them properly.
		if (!stats.aborted) cohorts = new Map(rules.map((rule) => [rule.label, collectors.get(rule.label).list()]));
		// Publish the denominator for the NEXT cycle's pacing, from completed passes only. A pass
		// that aborted (cancelled, or the distress breaker) covered part of the key range, so its
		// `matched` is a fraction — pacing the next cycle against it would derive a rate for a
		// corpus several times smaller than the real one and coast through the budget having
		// covered a slice of it.
		if (!stats.aborted) measuredSliceSize = stats.matched;
		// The slice estimate and the cohorts both moved; republish so a reader sees what the NEXT
		// cycle will pace against rather than the previous cycle's denominator.
		if (!stats.aborted) void publishScheduler();
		emitStats(stats, 'sweep');
		logPass(stats, 'sweep', limits.dryRun);
		lastSweep = {
			...stats,
			dryRun: limits.dryRun,
			label,
			node: server.hostname,
			startedAt,
			finishedAt: Date.now(),
			error: null,
		};
		await releasePass('sweep', startedAt, lastSweep);
		return lastSweep;
	} catch (e) {
		lastSweep = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e?.message ?? String(e) };
		// A THROWN pass must release too, and must publish the error: leaving the claim held would
		// wedge the probe until the heartbeat went stale, and dropping the error would make a
		// crashed pass indistinguishable from one that never ran.
		await releasePass('sweep', startedAt, lastSweep);
		throw e;
	} finally {
		sweepRunning = false;
		// The trip's reseed, chained after this pass stood down for it. Cleared BEFORE the chained
		// pass starts so the reseed does not cancel itself.
		const chained = sweepInterrupt;
		sweepInterrupt = null;
		if (chained) runProbeSweepOnce({ dryRun: true, label: chained, reseed: true }).catch((e) => logger.error(e));
	}
};

// The label of a reseed waiting for the running sweep to stand down, or null. See
// `requestSweepReseed` — a plain "skip if running" here was the wrong shape, because a canary
// trip lands DURING a sweep in exactly the scenario the canary exists for.
let sweepInterrupt = null;

/**
 * Run a signature RESEED sweep (dry-run semantics: probe + re-baseline, trigger nothing) as soon
 * as possible: immediately when no sweep is running, otherwise by interrupting the running pass —
 * which notices via its cancellation check within a batch — and chaining the reseed when it
 * exits. Without the interrupt, a trip mid-sweep silently kept the LIVE sweep dripping redundant
 * re-renders of pages the invalidation already covers, and no reseed ever ran.
 */
export const requestSweepReseed = (label) => {
	if (sweepRunning) {
		sweepInterrupt = label;
		logger.warn(`[prerender] change-probe: interrupting the running sweep to reseed (${label})`);
		return { chained: true };
	}
	runProbeSweepOnce({ dryRun: true, label, reseed: true }).catch((e) => logger.error(e));
	return { chained: false };
};

/**
 * Build the cohorts without probing — a read-only walk that stops as soon as every rule's cohort
 * is full. Runs once per process at most (the sweep rebuilds them properly): after a restart the
 * canary must not sit dark for the hours a full sweep takes.
 */
let cohortBuildDone = false;
const ensureCohorts = async () => {
	if (cohortBuildDone || [...cohorts.values()].some((urls) => urls.length)) return;
	cohortBuildDone = true;
	const rules = probeRules();
	const count = Math.max(1, config.changeProbe.canary.count | 0);
	const next = new Map(rules.map((rule) => [rule.label, []]));
	for await (const row of walkTargets(config.changeProbe.chunkSize, () => countProbe('unreadable'))) {
		if (!config.changeProbe.enabled) break;
		if (getResidencyByUrl(row.url) !== server.hostname) continue;
		if (row.state === 'suppressed' || !isCanaryCandidate(row.url)) continue;
		const match = rules.find((rule) => buildProbeRequest(rule, row.url));
		if (!match) continue;
		const cohort = next.get(match.label);
		if (cohort.length < count) cohort.push(row.url);
		if ([...next.values()].every((urls) => urls.length >= count)) break;
	}
	cohorts = next;
};

/**
 * The mass-change verdict for one rule's canary pass, pure so the threshold arithmetic is
 * testable: changed / (changed + unchanged), over at least `minSample` compared observations.
 * Seeds and failures are excluded from BOTH sides — a cold cohort or a broken endpoint must read
 * as "no verdict", never as "nothing changed".
 */
export const canaryVerdict = (stats, { threshold, minSample }) => {
	const compared = stats.changed + stats.unchanged;
	if (compared < Math.max(1, minSample)) return { tripped: false, compared, fraction: null };
	const fraction = stats.changed / compared;
	return { tripped: fraction >= threshold, compared, fraction };
};

/**
 * Act on a canary trip: record the rule's bulk invalidation, if everything about doing so is
 * sound — and say exactly why not otherwise, because a mass price change the operator configured
 * a response for is the one event this feature exists to catch.
 */
const actOnTrip = async (rule, fraction) => {
	const scope = rule.invalidateScope;
	if (!scope) {
		logger.warn(
			`[prerender] change-probe canary TRIPPED for ${rule.label} (${(fraction * 100).toFixed(1)}% changed) — ` +
				`no invalidateScope configured, so this is detection-only; pages heal per-URL as the sweep reaches them`
		);
		return { acted: false, reason: 'no-scope' };
	}
	if (!isScopeResolvable(scope)) {
		logger.error(
			`[prerender] change-probe canary tripped for ${rule.label} but invalidateScope "${scope}" names no ` +
				`configured prerender route — NOTHING was invalidated. Fix changeProbe.rules or ingress.routes.`
		);
		return { acted: false, reason: 'unresolvable-scope' };
	}
	if (!config.invalidation.enabled) {
		logger.error(
			`[prerender] change-probe canary tripped for ${rule.label} but invalidation.enabled is FALSE — ` +
				`NOTHING was invalidated and pre-change snapshots keep serving until pages re-render on cadence.`
		);
		return { acted: false, reason: 'invalidation-disabled' };
	}
	// The holdoff stops a slow refill from re-stamping the epoch every canary interval. A
	// re-stamp is not idempotent: it would re-invalidate every page rendered SINCE the trip —
	// exactly the pages that just healed.
	const existing = await invalidationTable().get({ id: scope, select: ['scope', 'invalidatedAt'] });
	const at = epochMsOf(existing?.invalidatedAt);
	if (Number.isFinite(at) && Date.now() - at < config.changeProbe.canary.holdoff) {
		logger.info(
			`[prerender] change-probe canary for ${rule.label} still trips but "${scope}" was invalidated ` +
				`${Math.round((Date.now() - at) / 60000)}m ago — inside canary.holdoff, not re-stamping`
		);
		return { acted: false, reason: 'holdoff' };
	}
	const reason = `change probe ${rule.label}: ${(fraction * 100).toFixed(1)}% of canary changed`.slice(0, 200);
	await recordInvalidation({ scope, reason, updatedBy: `change-probe@${server.hostname}` });
	countProbe('invalidated');
	logger.warn(
		`[prerender] change-probe canary for ${rule.label} invalidated "${scope}" (${reason}) — bots serve ` +
			`origin for that scope until pages re-render; a reseed sweep is re-baselining signatures now`
	);
	// A mass change makes the whole stored diff stale, so re-baseline NOW rather than waiting out
	// sweepInterval — as a RESEED (dry-run semantics: probe + write signatures, trigger nothing).
	// Per-URL triggers would be redundant with the invalidation just recorded — pages already heal
	// on cadence plus the invalidation accelerator — and worse than redundant: at corpus scale the
	// changed set dwarfs maxTriggersPerSweep, so a triggering sweep would leave most signatures
	// stale and then drip re-renders of ALREADY-HEALED pages (a render never updates the
	// signature; only a probe does) pass after pass until the baseline caught up.
	const { chained } = requestSweepReseed(`reseed after invalidating ${scope}`);
	return { acted: true, scope, reseedChained: chained };
};

/**
 * One canary pass over every rule's cohort on THIS node.
 *
 * DELIBERATELY NOT SKIPPED WHILE A SWEEP RUNS: a full sweep takes hours at production scale, and
 * the canary is the only fast detector for exactly the event most likely to land mid-sweep (a
 * scheduled promotion). The cost of overlap is one cohort's worth of probes at up to double the
 * configured rate for under a minute; both passes write the same observed signature for a shared
 * URL, so the race is value-idempotent.
 */
export const runProbeCanaryOnce = async ({ dryRun } = {}) => {
	if (canaryRunning) {
		return { skipped: true, reason: 'a canary pass is already running' };
	}
	// Synchronous, for the re-entrancy reason documented on the sweep above.
	canaryRunning = true;
	const claim = await claimPass('canary');
	if (!claim.ok) {
		canaryRunning = false;
		return { skipped: true, reason: claim.reason, lastRun: claim.lastRun ?? lastCanary };
	}
	const startedAt = claim.startedAt;
	const limits = passLimits(dryRun);
	const canary = config.changeProbe.canary;
	try {
		await ensureCohorts();
		const rules = probeRules();
		const perRule = [];
		for (const rule of rules) {
			const urls = cohorts.get(rule.label) ?? [];
			if (!urls.length) {
				perRule.push({ rule: rule.label, cohort: 0, skipped: 'empty cohort' });
				continue;
			}
			const stats = await runProbePass({
				rows: readCohortRows(urls),
				rules: [rule],
				// Membership was owner-filtered when the cohort was built; ownership is stable for a
				// URL, so re-hashing every member per pass buys nothing.
				ownershipChecked: true,
				probe: probeOnce,
				read: readSignature,
				write: writeSignature,
				trigger: triggerRevalidate,
				...limits,
				// NEVER skips on baseline age. The cohort is small and deliberately probed on a
				// cadence far tighter than `reprobeAfter` — freshness-skipping here would silence
				// the mass-change detector between sweeps, which is the one thing it exists for.
				reprobeAfter: 0,
				isCanceled: () => !config.changeProbe.enabled,
			});
			emitStats(stats, 'canary');
			const verdict = canaryVerdict(stats, { threshold: canary.threshold, minSample: canary.minSample });
			let action = null;
			if (verdict.tripped) {
				countProbe('canary_trip');
				action = limits.dryRun ? { acted: false, reason: 'dry-run' } : await actOnTrip(rule, verdict.fraction);
				if (limits.dryRun) {
					logger.warn(
						`[prerender] change-probe canary WOULD TRIP for ${rule.label} ` +
							`(${(verdict.fraction * 100).toFixed(1)}% of ${verdict.compared} changed) — dry run, nothing done`
					);
				}
			}
			perRule.push({ rule: rule.label, cohort: urls.length, ...stats, ...verdict, action });
		}
		lastCanary = {
			perRule,
			dryRun: limits.dryRun,
			node: server.hostname,
			startedAt,
			finishedAt: Date.now(),
			error: null,
		};
		await releasePass('canary', startedAt, lastCanary);
		return lastCanary;
	} catch (e) {
		lastCanary = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e?.message ?? String(e) };
		await releasePass('canary', startedAt, lastCanary);
		throw e;
	} finally {
		canaryRunning = false;
	}
};

// ---- scheduler + admin surface -------------------------------------------------------------

// Worker-local, and NOT the run guard — see `isPassRunningOnNode` for that. Kept because the
// re-entrancy check inside each pass is legitimately local: it stops one worker starting a
// second copy of its own pass, which is cheaper to answer than a table read.
export const isProbeSweepRunning = () => sweepRunning;
export const isProbeCanaryRunning = () => canaryRunning;

/**
 * What this NODE's probe is doing — readable from any worker.
 *
 * Everything scheduler- or pass-shaped comes from the shared row rather than module state, for
 * the reason util/probeState.js documents: the scheduler arms on worker 0 and this endpoint is
 * served by all sixteen, so module state made the answer a coin flip that reported a healthy
 * probe as switched off ~95% of the time.
 *
 * `enabled`, `dryRun`, `rules`, `mode` and the `load` SETTINGS stay config-derived on purpose —
 * config is identical on every worker, so reading them locally is correct and costs no round
 * trip. `load.monitor` is the exception inside that block: it is the histogram's own liveness,
 * which only exists on the worker that armed it, so it is published like the rest.
 *
 * A missing row reads as "nothing has run on this node yet", NOT as "disarmed": `armedInterval`
 * is null either way, but `stateAvailable: false` tells the console the difference between a
 * probe that has not started and a state read that failed.
 */
export const changeProbeStatus = async () => {
	const row = await readProbeState();
	const sweep = row?.sweep ?? null;
	const canary = row?.canary ?? null;
	const scheduler = row?.scheduler ?? null;

	return {
		enabled: config.changeProbe.enabled,
		dryRun: config.changeProbe.dryRun,
		node: server.hostname,
		ownerScopeNote: 'Probes only the URLs this node owns; every node sweeps its own slice.',
		rules: probeRules().map((rule) => ({
			label: rule.label,
			pathPattern: rule.patternSource,
			source: rule.source,
			invalidateScope: rule.invalidateScope,
		})),
		mode: config.changeProbe.mode,
		// False only when the row could not be read at all. Distinguishes "the probe has not run
		// here" from "this answer is not trustworthy", which the old shape could not express.
		stateAvailable: row !== null,
		stateUpdatedAt: row?.updatedAt ?? null,
		sweep: {
			running: isPassRunning(row, 'sweep', PASS_STALE_MS),
			lastRun: sweep?.lastRun ?? null,
			progress: sweep?.running ? (sweep.progress ?? null) : null,
			// In continuous mode this reads 'continuous' rather than a number: there is no gap
			// between passes to arm, and reporting a stale `sweepInterval` here would describe a
			// schedule that is not running.
			armedInterval: scheduler?.armedSweep ?? null,
			// What continuous pacing is working against. `sliceSize: null` means no completed cycle
			// has measured it yet, which is precisely when the pass runs at the ceiling — worth
			// being able to see, because "at the ceiling" otherwise looks identical to "behind".
			cycleTarget: isContinuous() ? config.changeProbe.cycleTarget : null,
			sliceSize: isContinuous() ? (scheduler?.sliceSize ?? null) : null,
		},
		load: {
			enabled: config.changeProbe.load.enabled,
			lagThreshold: config.changeProbe.load.lagThreshold,
			backoffMax: config.changeProbe.load.backoffMax,
			monitor: scheduler?.loadMonitor ?? { running: false, unavailable: false },
		},
		canary: {
			running: isPassRunning(row, 'canary', PASS_STALE_MS),
			lastRun: canary?.lastRun ?? null,
			armedInterval: scheduler?.armedCanary ?? null,
			cohortSizes: scheduler?.cohortSizes ?? {},
		},
	};
};

/** Node-wide, for the admin POST guard. Replaces the worker-local `isProbe*Running` pair. */
export const isPassRunningOnNode = async (kind) => isPassRunning(await readProbeState(), kind, PASS_STALE_MS);

let schedulerStarted = false;
let bootTimer = null;
let sweepTimer = null;
let canaryTimer = null;
let armedSweep = null;
let armedCanary = null;

/**
 * Publish the scheduler's own view: what is armed, the cohort sizes, the measured slice, and the
 * lag monitor's liveness. Only worker 0 ever calls this — it is the only worker that HAS these —
 * and every other worker reads the result.
 */
const publishScheduler = () =>
	publishProbeState({
		scheduler: {
			armedSweep,
			armedCanary,
			sliceSize: measuredSliceSize,
			cohortSizes: Object.fromEntries([...cohorts].map(([label, urls]) => [label, urls.length])),
			loadMonitor: loopLagMonitorState(),
		},
	});

const clearProbeTimers = () => {
	if (bootTimer) clearTimeout(bootTimer);
	if (sweepTimer) clearInterval(sweepTimer);
	if (canaryTimer) clearInterval(canaryTimer);
	bootTimer = sweepTimer = canaryTimer = null;
	stopContinuousLoop();
};

/**
 * CONTINUOUS MODE's driver: finish a cycle, start the next one, forever.
 *
 * A `setInterval` is the wrong instrument here and not merely an unused one. It fires on a fixed
 * clock regardless of whether the previous pass finished, which is exactly how the interval model
 * loses passes: the tick lands mid-walk, `runProbeSweepOnce` sees `sweepRunning` and returns
 * `{skipped: true}`, and the cadence halves with only a debug line to show for it. A loop that
 * awaits its own pass cannot overlap and cannot skip — the next cycle starts when there IS a next
 * cycle.
 *
 * `continuousStop` is the cancellation handle. The loop re-reads config every iteration, so a
 * mode change, a disable, or a rule change stops it at the next cycle boundary; the in-flight
 * pass finishes under the rules it started with, which is the same contract config changes have
 * everywhere else here.
 *
 * THE FLOOR IS NOT OPTIONAL. A cycle can complete almost instantly — an empty registry, a node
 * that owns nothing, every rule unmatched, or a `cycleTarget` already satisfied — and without a
 * floor those cases spin the loop as fast as the event loop allows, which is a busy-wait wearing
 * a scheduler's clothes. One second is far below any real cadence and far above a hot loop.
 */
const CONTINUOUS_FLOOR_MS = 1000;
// A cycle can also decline to start at all: a canary trip chains a RESEED sweep from
// `runProbeSweepOnce`'s finally block without awaiting it, so the loop's next call returns
// `{skipped: true}` immediately and keeps doing so for as long as that reseed runs — hours, on a
// large slice. Polling that at the 1s floor is thousands of pointless wake-ups; this is the
// interval for "something else holds the sweep", which is a wait, not a cycle boundary.
const CONTINUOUS_BUSY_MS = 30_000;
let continuousStop = null;

const runContinuousLoop = async () => {
	const stop = { cancelled: false };
	continuousStop = stop;
	while (!stop.cancelled) {
		const startedAt = Date.now();
		let skipped = false;
		try {
			// try/catch around `await` is correct and intentional: awaiting a rejected promise
			// throws into this frame. The alternative (`.catch()`) would swallow the rejection and
			// let the loop treat a crashed pass as a completed cycle.
			const result = await runProbeSweepOnce();
			skipped = result?.skipped === true;
		} catch (e) {
			logger.error(e);
		}
		if (stop.cancelled) break;
		// Config is re-read here rather than captured: this is the boundary a live change acts on.
		if (!config.changeProbe.enabled || !isContinuous() || probeRules().length === 0) break;
		const floor = skipped ? CONTINUOUS_BUSY_MS : CONTINUOUS_FLOOR_MS;
		const spent = Date.now() - startedAt;
		if (spent < floor) await sleep(floor - spent);
	}
	if (continuousStop === stop) continuousStop = null;
};

const stopContinuousLoop = () => {
	if (continuousStop) continuousStop.cancelled = true;
	continuousStop = null;
};

const armIntervals = () => {
	// The SWEEP is what the mode changes. The CANARY is orthogonal to it — a fixed cohort on a
	// fast fixed cadence, whose whole job is to notice a mass change between sweeps — so it arms
	// identically either way. An early return here would have silently disabled the mass-change
	// detector for anyone who turned continuous mode on.
	if (isContinuous()) void runContinuousLoop();
	else {
		sweepTimer = setInterval(() => runProbeSweepOnce().catch((e) => logger.error(e)), armedSweep);
		sweepTimer.unref?.();
	}
	if (armedCanary) {
		canaryTimer = setInterval(() => runProbeCanaryOnce().catch((e) => logger.error(e)), armedCanary);
		canaryTimer.unref?.();
	}
};

// (Re)arm to match config; enable/disable and both intervals are live (reconcile's shape).
const syncProbeTimers = () => {
	const enabled = config.changeProbe.enabled && probeRules().length > 0;
	// In continuous mode there is no interval to arm, but the armed value still has to CHANGE when
	// the mode does, or `syncProbeTimers` sees no difference and leaves an interval timer running
	// after a switch to continuous (and vice versa). Tagging the mode into the key is what makes
	// the mode itself live.
	const desiredSweep = !enabled ? null : isContinuous() ? 'continuous' : config.changeProbe.sweepInterval;
	const desiredCanary = enabled && config.changeProbe.canary.interval > 0 ? config.changeProbe.canary.interval : null;
	if (desiredSweep === armedSweep && desiredCanary === armedCanary) return;

	// A mode switch must re-measure. The slice estimate is not wrong across a switch, but it can
	// be arbitrarily stale (interval mode never maintains it), and pacing a fresh continuous cycle
	// against a stale denominator is exactly the confident-wrong-number case `measuredSliceSize`
	// is documented to avoid. Dropping it costs one ceiling-rate cycle and buys a correct one.
	if (desiredSweep !== armedSweep) measuredSliceSize = null;

	// The histogram follows the governor switch. Sampling costs nothing measurable, but a monitor
	// left enabled after the governor is turned off is a live handle nothing reads — and one left
	// UNSTARTED after it is turned on is a governor that silently never fires, which is the more
	// expensive mistake of the two.
	if (enabled && config.changeProbe.load.enabled) startLoopLagMonitor(config.changeProbe.load.resolution);
	else stopLoopLagMonitor();

	const wasEnabled = armedSweep !== null;
	clearProbeTimers();
	armedSweep = desiredSweep;
	armedCanary = desiredCanary;
	// Publish the arming so every worker can report it. Without this the endpoint answers
	// `armedInterval: null` from 15 of 16 workers, which reads as "disarmed" rather than as
	// "asked the wrong worker". Deliberately not awaited: `syncProbeTimers` runs on the config
	// apply path and must not become async for a write whose failure is already logged.
	void publishScheduler();
	if (desiredSweep === null) return;

	if (wasEnabled) {
		armIntervals();
		return;
	}

	// First arming is boot-shaped: delay + per-node stagger, so a rolling restart or a cluster-wide
	// config apply doesn't start every node's registry walk (and origin probes) at the same moment.
	const stagger = fnv1a32(server.hostname) % Math.max(1, config.changeProbe.startJitter | 0);
	bootTimer = setTimeout(() => {
		runProbeSweepOnce().catch((e) => logger.error(e));
		armIntervals();
	}, config.changeProbe.startDelay + stagger);
	bootTimer.unref?.();
};

export const probeTimerState = () => ({ started: schedulerStarted, armedSweep, armedCanary });

/**
 * Start the probe scheduler on worker 0 of EVERY node — owner-scoped like the reconciler, for the
 * same reason (each node can only act on the keys it owns). Idempotent; follows config live.
 */
export function startChangeProbeScheduler() {
	if (server.workerIndex !== 0 || schedulerStarted) return;
	schedulerStarted = true;
	syncProbeTimers();
	onConfigApplied(syncProbeTimers);
}

/** Tests only — the shared row, which is what a DIFFERENT worker would see. */
export const readProbeStateForTest = readProbeState;
export const publishProbeStateForTest = publishProbeState;

/** Tests only — the limits builder, so the sweep/canary split is assertable without a live pass. */
export const __passLimitsForTest = passLimits;

/** Tests only — module state that outlives a beforeEach. */
export const resetChangeProbeState = () => {
	clearProbeTimers();
	schedulerStarted = false;
	armedSweep = armedCanary = null;
	sweepRunning = canaryRunning = false;
	sweepInterrupt = null;
	lastSweep = lastCanary = null;
	cohorts = new Map();
	cohortBuildDone = false;
	compiledRules = null;
	compiledFrom = undefined;
	lastUnsupportedWarnAt = 0;
	measuredSliceSize = null;
	stopLoopLagMonitor();
};
