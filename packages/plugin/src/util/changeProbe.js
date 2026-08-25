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
import { epochMsOf, currentMinuteMs } from './time.js';
import { getResidencyByUrl } from './residency.js';
import { resolveEffectiveInterval } from './routeClass.js';
import { writeSchedules } from './renderSchedule.js';
import { recordInvalidation, isScopeResolvable } from './invalidation.js';
import { dispatcherFor, configuredStagingIp } from './upstream.js';
import { cacheKeysOf } from '../resources/Target.js';
import { walkUrlRange } from './urlWalk.js';
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
	pageMismatch: 0, // cached page disagreed with the origin (round-trip blindness; pageCheck rules)
	throttled: 0, // probes the origin refused with a pushback status — what drives the backoff
	throttleLevel: 1, // pacing-window multiplier when the pass ended; 1 means never backed off
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
// setTimeout stores its delay as a signed 32-bit int; past this it fires after 1ms instead.
const MAX_TIMER_MS = 2147483647;

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
// PATCH, not put: `put` on this sealed row would drop `pageSignature`, which only the render path
// writes — the probe must never clobber the page's own claim while recording its baseline.
const writeSignature = (url, signature) => probeStateTable().patch(url, { url, signature, probedAt: new Date() });
const clearPageSignature = (url) => probeStateTable().patch(url, { pageSignature: null });

/**
 * Record what a freshly rendered page CLAIMS, for the probe to compare the origin against.
 * Called from the render result path (owner-scoped, like the sweep) and deliberately best-effort:
 * a render must never fail because a probe optimisation could not be recorded. Extraction that
 * yields nothing writes nothing — same rule as a failed probe, so a markup change cannot mass-
 * trigger by making every page look like a disagreement.
 */
export const recordPageClaim = async (url, structuredOffers) => {
	try {
		// Parse ONCE, outside the predicate: this runs per render, and `find` would otherwise
		// re-parse the same URL for every rule it tests. `URL.parse` over `new URL` is the repo
		// idiom (it returns null instead of throwing on a malformed value).
		const pathname = URL.parse(url)?.pathname;
		if (!pathname) return;
		const rule = probeRules().find((r) => r.pageCheck && r.pathPattern.test(pathname));
		if (!rule) return;
		if (!structuredOffers) {
			// The renderer did not send the page's offers. There is deliberately NO fallback to
			// parsing the stored HTML: recovering them here means a regex scan and a JSON parse of a
			// ~1MB document on the hottest write path in this process, to reconstruct what the
			// browser had structured in front of it. So pageCheck is INERT against a renderer older
			// than 1.20.0 — say so rather than failing silently, since a config that looks enabled
			// and protects nothing is the worst outcome.
			warnPageClaimUnsupported();
			return;
		}
		const claim = pageClaimFromOffers(structuredOffers);
		if (!claim) return;
		await probeStateTable().patch(url, { url, pageSignature: claim });
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
	clearPageClaim = async () => {},
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
		if (!signatureChanged && !pageDisagrees) {
			if (!stored?.signature) {
				// First observation: baseline it, trigger nothing — the page's content is not known
				// to have changed, the probe just hadn't seen it before.
				stats.seeded++;
				await write(row.url, observed);
			} else {
				stats.unchanged++;
			}
			return;
		}
		if (signatureChanged) stats.changed++;
		if (dryRun) {
			// Signature written in dry-run ON PURPOSE: each pass then reports fresh changes — the
			// true change rate — instead of re-reporting the same delta forever. Demand-ladder
			// precedent (its dry run persists rung moves for the same reason).
			await write(row.url, observed);
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
			await write(row.url, observed);
			// Clear the page's claim after acting on a disagreement, or every subsequent pass
			// re-detects the same one and re-spends the trigger budget on a page that is already
			// expired and already filed. The next render writes a fresh claim; until then there is
			// simply nothing to compare, which is the correct "I don't know" state.
			if (pageDisagrees) await clearPageClaim(row.url);
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
		const started = now();
		batchDistress = 0;
		retryAfterMs = 0;
		await Promise.all(batch.map(processOne));

		if (batchDistress > 0) throttle = Math.min(throttle * 2, Math.max(1, backoffMax));
		else if (throttle > 1) throttle = Math.max(1, throttle / 2);
		stats.throttleLevel = throttle;

		const window = (batch.length / Math.max(1, ratePerSecond)) * 1000 * throttle;
		const elapsed = now() - started;
		batch.length = 0;
		// An explicit Retry-After outranks our own arithmetic: the origin named a number, and
		// guessing under it is exactly the disrespect the header exists to prevent.
		//
		// Clamped to setTimeout's signed-32-bit delay, which the schema caps individual options at
		// but cannot cap here: this window is the PRODUCT of `concurrency`, `1/ratePerSecond` and
		// `throttle`, so three separately-sane values can multiply past the limit — and past it
		// `setTimeout` fires after 1ms instead of waiting, turning the backoff into a hot loop
		// against an origin already asking for room.
		const wait = Math.min(Math.max(window - elapsed, retryAfterMs), MAX_TIMER_MS);
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

// ---- the two passes ----------------------------------------------------------------------------

let sweepRunning = false;
let canaryRunning = false;
let lastSweep = null;
let lastCanary = null;

const passLimits = (dryRunOverride) => ({
	dryRun: typeof dryRunOverride === 'boolean' ? dryRunOverride : config.changeProbe.dryRun,
	maxTriggers: config.changeProbe.maxTriggersPerSweep,
	concurrency: config.changeProbe.concurrency,
	ratePerSecond: config.changeProbe.ratePerSecond,
	backoffMax: config.changeProbe.backoffMax,
	abortAfterDistress: config.changeProbe.abortAfterDistress,
});

/**
 * One full registry pass on THIS node. Rebuilds the canary cohorts as it walks.
 *
 * `reseed` (set by the canary's chained pass) FORCES a probe of every matched URL: a mass change
 * has just been absorbed, so every baseline is known-stale and skipping the fresh-looking ones
 * would leave exactly the pages the trip was about carrying pre-change signatures.
 */
export const runProbeSweepOnce = async ({ dryRun, label = null, reseed = false } = {}) => {
	if (sweepRunning) return { skipped: true, reason: 'a probe sweep is already running', lastRun: lastSweep };
	sweepRunning = true;
	const startedAt = Date.now();
	const limits = passLimits(dryRun);
	try {
		const rules = probeRules();
		const count = Math.max(1, config.changeProbe.canary.count | 0);
		const collectors = new Map(rules.map((rule) => [rule.label, cohortCollector(count)]));
		let unreadable = 0;
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
			clearPageClaim: clearPageSignature,
			trigger: triggerRevalidate,
			...limits,
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
		return lastSweep;
	} catch (e) {
		lastSweep = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e?.message ?? String(e) };
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
	canaryRunning = true;
	const startedAt = Date.now();
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
				clearPageClaim: clearPageSignature,
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
		return lastCanary;
	} catch (e) {
		lastCanary = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e?.message ?? String(e) };
		throw e;
	} finally {
		canaryRunning = false;
	}
};

// ---- scheduler + admin surface -------------------------------------------------------------

export const isProbeSweepRunning = () => sweepRunning;
export const isProbeCanaryRunning = () => canaryRunning;

export const changeProbeStatus = () => ({
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
	sweep: { running: sweepRunning, lastRun: lastSweep, armedInterval: armedSweep },
	canary: {
		running: canaryRunning,
		lastRun: lastCanary,
		armedInterval: armedCanary,
		cohortSizes: Object.fromEntries([...cohorts].map(([label, urls]) => [label, urls.length])),
	},
});

let schedulerStarted = false;
let bootTimer = null;
let sweepTimer = null;
let canaryTimer = null;
let armedSweep = null;
let armedCanary = null;

const clearProbeTimers = () => {
	if (bootTimer) clearTimeout(bootTimer);
	if (sweepTimer) clearInterval(sweepTimer);
	if (canaryTimer) clearInterval(canaryTimer);
	bootTimer = sweepTimer = canaryTimer = null;
};

const armIntervals = () => {
	sweepTimer = setInterval(() => runProbeSweepOnce().catch((e) => logger.error(e)), armedSweep);
	sweepTimer.unref?.();
	if (armedCanary) {
		canaryTimer = setInterval(() => runProbeCanaryOnce().catch((e) => logger.error(e)), armedCanary);
		canaryTimer.unref?.();
	}
};

// (Re)arm to match config; enable/disable and both intervals are live (reconcile's shape).
const syncProbeTimers = () => {
	const enabled = config.changeProbe.enabled && probeRules().length > 0;
	const desiredSweep = enabled ? config.changeProbe.sweepInterval : null;
	const desiredCanary = enabled && config.changeProbe.canary.interval > 0 ? config.changeProbe.canary.interval : null;
	if (desiredSweep === armedSweep && desiredCanary === armedCanary) return;

	const wasEnabled = armedSweep !== null;
	clearProbeTimers();
	armedSweep = desiredSweep;
	armedCanary = desiredCanary;
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
};
