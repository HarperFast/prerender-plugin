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
 * the trigger's guards read the lease table and the schedule row, both of which are only authoritative
 * on the owner (see util/invalidationReenqueue.js). Every node running the same sweep covers the
 * keyspace with no coordination.
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
import { epochMsOf, dateColumnMs, getNextTimeOfDay, DAY, MINUTE, SECOND } from './time.js';
import { getResidencyByUrl } from './residency.js';
import { resolveEffectiveInterval, routeScopeForUrl } from './routeClass.js';
import { fileDueNow } from './renderSchedule.js';
import { demandOf, warmDemand } from './demand.js';
import { createChangeActions } from './changeActions.js';
import { CLUSTER_SCOPE, recordInvalidation, isScopeResolvable, resolveInvalidation } from './invalidation.js';
import { dispatcherFor, configuredStagingIp } from './upstream.js';
import { cacheKeysOf } from '../resources/Target.js';
import { resolveVerification, writeVerification } from './pageVerification.js';
import { checkSparesProbe, readPageCheck, writePageCheck } from './pageCheck.js';
import { createCanonicalObserver, entitiesOn } from './entity.js';
import { walkUrlRange } from './urlWalk.js';
import { runDetached } from './detach.js';
import { getSab } from './coordination.js';
import { probeScopeFilter } from './probeScope.js';
import { batchPause, cycleRatePerSecond, pacedRate, stepBackoff } from './probePacer.js';
import { loopLagMonitorState, readLoopLagMs, startLoopLagMonitor, stopLoopLagMonitor } from './loopLag.js';
import { isPassRunning, probeStatePublished, publishProbeState, readProbeState } from './probeState.js';
import {
	compileProbeRules,
	buildProbeRequest,
	extractValues,
	extractJsonLdOffers,
	isSameProbeOrigin,
	signatureOf,
	signatureUnderPrefix,
	statusSignalFor,
	apiClaimOf,
	compareClaims,
	pageClaimFromOffers,
	changedSlots,
	compareField,
	fieldCaughtUp,
	parsePageFacts,
	serializePageFacts,
	signatureSlots,
	PAGE_FACTS_MAX_BYTES,
} from './changeProbeSpec.js';

const targetTable = () => databases.render_service.Target;
const pageTable = () => databases.page_cache.PrerenderedPage;
const invalidationTable = () => databases.invalidation.Invalidation;
const probeStateTable = () => databases.probe_state.ProbeState;

// Rows scanned between event-loop yields (util/reconcile.js's cadence).
const YIELD_EVERY = 200;

// What every probe read of the registry projects — what matching and the trigger need
// (writeSchedule wants fromSitemap + the cadence), plus `unlistedAt` for `changeProbe.scope`
// (util/probeScope.js). The stored signature is NOT here: it lives in the node-local ProbeState
// table (see schema.graphql), read per probed URL.
const TARGET_SELECT = ['url', 'sitemapUrl', 'renderInterval', 'demandInterval', 'state', 'unlistedAt'];

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
	walkedThrough: null, // URL of the last row whose batch has been fully probed — the resume cursor's basis
	owned: 0, // rows this node owns
	matched: 0, // owned rows a rule matched (suppressed and out-of-scope excluded)
	outOfScope: 0, // rule-matched rows `changeProbe.scope` left unprobed — the origin requests it saved; 0 under 'all'
	probed: 0, // probes attempted = seeded + rebaselined + unchanged + changed + failed
	seeded: 0, // first observation stored, nothing compared
	rebaselined: 0, // baseline was taken under a DIFFERENT rule fingerprint: observation stored, nothing compared or triggered (a rule edit, not a content change)
	extended: 0, // baseline was taken before extract paths were APPENDED: compared on the slots it has, baseline upgraded — OVERLAYS unchanged/changed like pageMismatch, never a bucket of its own
	unchanged: 0,
	changed: 0,
	triggered: 0, // changes acted on: page hard-expired, render filed ahead of rotation, baseline written
	covered: 0, // changes an active invalidation already answers (every page refused, or verified on proof): not counted `changed`, not acted on, baseline NOT moved
	healed: 0, // changes every page of which was re-rendered after the trip and shows: baselined, not acted on — OVERLAYS changed, counted in caughtUp
	rowErrors: 0, // ProbeState reads/writes that threw: the row is skipped (or its write lost) and the pass goes on
	failed: 0, // fetch/parse/extraction failures — signature untouched, nothing triggered
	errors: 0, // actions that threw — signature left stale, so the next probe of the URL acts again
	fresh: 0, // skipped: baseline written since this pass (or the pass it resumes) began — already probed
	checkedOnDemand: 0, // skipped: checked and agreed since the anchor (a serve-time check on any node, or this pass before a restart)
	pageMismatch: 0, // cached page disagreed with the origin (pageCheck: the claim pair, or an ARMED mapped field) — OVERLAYS the buckets above, which count by signature outcome alone
	caughtUp: 0, // origin changed, but every changed slot is a mapped slot the cached page ALREADY shows the new value for: baseline written, nothing triggered — OVERLAYS changed
	ignored: 0, // origin changed only in pageCheck.ignoreChanges slots: baseline written, nothing triggered, NOT a change for the canary — OVERLAYS unchanged
	slotChanges: {}, // { [rule]: { [slot]: n } } origin changes per extract slot ("signal" = a status-signal literal was involved, so no slot can be named) — decomposes changed, caughtUp and ignored
	fieldMismatch: {}, // { [rule]: { ["<slot>:<fact>"]: n } } page mismatches per mapped field, armed or not — a disarmed field still counts here, and only here
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
const probeRequest = ({ url, method, headers, body }, targetUrl) => {
	const urlObj = new URL(url);
	const timeout = config.changeProbe.requestTimeout;
	const sameOrigin = isSameProbeOrigin(targetUrl, url);
	return dispatcherFor(sameOrigin ? configuredStagingIp() : undefined).request({
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
};

const probeFetch = async (request, targetUrl) => {
	const response = await probeRequest(request, targetUrl);
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
/** Is this HTTP status the origin pushing back? The same set every probe request is judged by. */
export const isDistressStatus = (statusCode) => DISTRESS_STATUS.has(statusCode);
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
 * Act on one changed URL: hard-expire the cached pages and file the URL's render ahead of routine
 * rotation. Owner-scoped by the sweep, whose guards read owner-local state. See util/changeActions.js
 * for when this runs and why nothing detected is deferred.
 *
 * ONE SCHEDULE ROW, KEYED BY THE URL — not one per device. The PAGES are still expired per device,
 * because page content genuinely is per device; the SCHEDULE is not. This file was missed by the
 * v0.66.0 move to URL-keyed jobs (that change touched RenderQueue, Target and renderSchedule), and
 * the per-device rows it kept writing cost more than a stale spelling:
 *
 *   - `claim` gives a device-keyed row `deviceTypes: [thatDevice]` and a URL row the full default
 *     set, so two device rows became TWO ONE-DEVICE JOBS instead of one two-device job — and each
 *     job fetches the origin document for itself, which defeats the document reuse the browser
 *     gained in the same release. Probe-triggered renders were doubling origin document load.
 *   - The two jobs are claimed and rendered at different times, so desktop and mobile land
 *     different `lastCached` values: exactly the split-pair state URL-keyed jobs removed.
 *   - Two schedule writes per trigger instead of one, on a path that runs in-line with the sweep.
 *
 * Every other writer already files the URL row (`Target.put`, `Target.revalidate`, and `renderNow`
 * for a default device); a per-device row remains legitimate only for a deliberate one-device
 * render. Rows written before this fix convert themselves the first time they render.
 *
 * The expiry is backdated PAST the stale-while-revalidate window, not set to now. A trip means
 * the page's probed fields (price/availability) provably changed, so one more serve is a served
 * mismatch — the swr window exists to smooth over a LATE re-render of content that is presumed
 * still right, and a tripped page is the one case where it is known wrong. This matches the hard
 * stop the canary's bulk-invalidation epoch already applies (`resolveServeStatus` refuses an
 * invalidated page outright); `Target.revalidate` keeps the plain `Date.now()` expiry
 * deliberately — an operator asking for a re-render is not asserting the content is wrong.
 */
/**
 * One probe of `url` under `rule`, outside any pass — the serve-time check's request (util/serveCheck.js).
 * Same request, token scoping, extraction and status signals as the sweep's. Throws on fetch failure.
 */
export const probeRuleOnce = (rule, url) => probeOnce(rule, url);

/**
 * The page's own DOCUMENT, as the probe would fetch it (the origin token same-origin only, gzip), with
 * `deviceType`'s User-Agent (`origin.userAgents`, the miss proxy's) so a device-specific origin answers
 * with the document the served page was rendered from: `{ statusCode, headers, body }` with the body a
 * STREAM, so the caller reads only as far as it needs (util/documentFacts.js `documentFactsFromStream`)
 * and destroys the rest. Throws on fetch failure.
 */
export const probeDocument = (url, deviceType = null) =>
	probeRequest(
		{
			url,
			method: 'GET',
			headers: {
				'accept': 'text/html',
				'user-agent': config.origin.userAgents[deviceType] ?? config.origin.userAgents.desktop,
			},
		},
		url
	);

/** The most recent anchor (the nightly update) at or before now in anchored mode, else NaN. */
export const lastAnchorAt = () => (isAnchored() ? previousAnchorOccurrence() : NaN);

/** Is this mapped field armed on THIS WORKER (not disarmed by its mapping-defect guard)? */
export const isFieldArmed = (rule, field) => theMappingGuard().isArmed(rule, field);

/**
 * The labels of `rule`'s mapped fields disarmed ON THIS NODE: this worker's guard, plus what the node's
 * running pass last beat (`progress.fieldGuard`), else what its last pass published (`lastRun.fieldGuard`).
 * The guard lives with the sweep, on one worker, so a check running on any other worker must read the
 * published state, or it would compare a field the guard stopped trusting and re-render pages for it on
 * every window. Re-read at most every few seconds.
 */
export const disarmedFieldsOnNode = async (rule) => {
	const out = new Set();
	for (const field of rule.pageCheck?.fields ?? []) if (!isFieldArmed(rule, field)) out.add(field.label);
	try {
		const sweep = (await sweepStateForRenderCheck())?.sweep;
		// The running pass's beat is newer than the last pass's record.
		const guards = (sweep?.running === true && sweep.progress?.fieldGuard) || sweep?.lastRun?.fieldGuard;
		const published = guards?.[rule.label];
		for (const [label, state] of Object.entries(published ?? {})) if (state?.armed === false) out.add(label);
	} catch {
		// Unknown: this worker's own guard is what there is.
	}
	return out;
};

/**
 * Are serve-time checks running for real (enabled, and neither they nor the probe in dry run)? Then a pass
 * leaves them what they use of the node's budget (`outOfPassHeadroom`), and the sweep skips what they
 * observed since it began. The probe's own dry run governs them too: a probe that is only measuring must
 * not have its checks expiring pages.
 */
export const serveChecksArmed = () =>
	Boolean(
		config.changeProbe.enabled &&
			!config.changeProbe.dryRun &&
			config.changeProbe.serveCheck?.enabled &&
			!config.changeProbe.serveCheck.dryRun
	);

export const actOnChange = async (row) => {
	const nowMs = Date.now();
	await expireChangedPages(row.url, nowMs);
	// FILED AT THE CURRENT MINUTE, NEVER LATER THAN IT ALREADY WAS (`fileDueNow`). The current minute
	// PER ACTION, not captured once for a pass (a pass runs for hours, and a stale minute ranks the row
	// as if it had waited that long — the Target.revalidate lesson). A row already due keeps its due
	// time and a change found again before its render landed keeps its first `changedAt`: re-filing
	// either at "now" would move the page BACK in the queue on every pass that re-detected it. The probe
	// runs on the owner, so the read that makes this possible is local; a serve-time check runs anywhere,
	// and `fileDueNow` forwards it to the owner.
	//
	// THE PAGE'S DEMAND GOES WITH THE MARK (`demandPeriod`): how often bots ask for it, from the demand
	// tracker, so the queue can order changed pages by the origin visits their wait costs
	// (`queue.ready.changedDemand`, util/renderPriority.js). Stamped here, once, rather than looked up
	// by the keeper: the keeper holds rows by class and has no business reading a Bloom ring per row. An
	// unknown demand (tracker off, cold, saturated) stamps nothing and the row orders by cadence.
	const demand = demandOf(row.url, nowMs);
	await fileDueNow(row.url, {
		fromSitemap: !!row.sitemapUrl,
		effectiveInterval: resolveEffectiveInterval(row.url, row),
		changedAt: nowMs,
		demandPeriod: demand.known ? demand.periodMs : undefined,
	});
};

/**
 * Hard-expire every device page of `url` (past the stale-while-revalidate window, so none is served), the
 * first half of `actOnChange`. Alone for a page known wrong that has no Target to re-file.
 */
export const expireChangedPages = async (url, nowMs = Date.now()) => {
	const keys = cacheKeysOf(url);
	const hardExpiredAt = nowMs - config.page.swrTtl;
	const pages = await Promise.all(
		keys.map((cacheKey) => pageTable().get({ id: cacheKey, select: ['cacheKey', 'expiresAt'] }))
	);
	// EXPIRE FIRST (`actOnChange` files after this): if the filing fails, the page has at least stopped
	// serving known-wrong content, and the stale baseline makes the next probe act again. A page already expired this far (a change
	// found again before its render landed) is not patched again — one replicated write per device
	// page per change, not per detection. The key rides in the patch: a patch that races a delete (the
	// target retired on another node) would otherwise store a page stub with no key.
	await Promise.all(
		pages.map(async (page, index) => {
			if (!page) return;
			const expiresAt = dateColumnMs(page.expiresAt);
			if (Number.isFinite(expiresAt) && expiresAt <= hardExpiredAt) return;
			await pageTable().patch(keys[index], { cacheKey: keys[index], expiresAt: hardExpiredAt });
		})
	);
};

/**
 * What an active invalidation already does for the pages of a URL a pass would act on: 'covered',
 * 'healed' or null (act). `epochFor(url)` resolves the epoch the serve path applies (`at`, with the pad)
 * and the trip instant itself (`trippedAt`). Per page:
 *
 *   REFUSED   rendered at or before the epoch — `!(lastCached > at)`, the serve path's own NaN-safe
 *             test — and not exempted by a page verification (`resolveServeStatus`).
 *   VERIFIED  rendered before the epoch but served on proof: the render that wrote the stored claim
 *             (`lastCached >= pageClaimAt`, the verification basis rule) and that claim AGREES with this
 *             observation (`pageAgrees`: the claim pair compared and agreed, no armed mapped field
 *             disagreeing). While verification is armed for the rule, the verification is WRITTEN here —
 *             without it, a page rendered after the reprice but before the trip (the reprice-to-trip gap,
 *             up to one canary interval) could never be rescued: it is re-detected as changed every pass
 *             and never reaches the unchanged branch that writes verifications (review, round 3). An
 *             existing verification with an agreeing claim counts the same.
 *   HEALED    rendered after the epoch, by (or after) the render that wrote the agreeing claim, on a
 *             baseline taken before the trip, and every changed slot is one that page shows
 *             (`changeShown`) — so the change this probe sees is the trip's own, which the page was
 *             rendered after. Without the rule a pass during an invalidation expired every page the
 *             accelerator had already re-rendered correctly.
 *
 * Every page HEALED -> 'healed' (the pass moves the baseline); every page refused, verified or healed,
 * with at least one not healed -> 'covered' (nothing done, the baseline stays: a false trip leaves no
 * glitch value behind, and a true trip's page is still acted on once the invalidation is cleared); no page
 * at all -> 'covered'; anything else -> null, and the pass acts.
 */
const coverageOf = async (url, { pageAgrees, pageClaimAt, probedAt, changeShown, verify }, epochFor) => {
	const epoch = await epochFor(url);
	if (!epoch) return null;
	const keys = cacheKeysOf(url);
	const pages = await Promise.all(
		keys.map((cacheKey) => pageTable().get({ id: cacheKey, select: ['cacheKey', 'lastCached'] }))
	);
	const { verifiedAtMs, basisAtMs } = await resolveVerification(url);
	const claimAt = epochOf(pageClaimAt);
	const healedRender = changeShown === true && claimAt > epoch.at && probedAt < epoch.trippedAt;
	let others = 0;
	let verifyDue = false;
	for (const page of pages) {
		if (!page) continue;
		const lastCached = dateColumnMs(page.lastCached);
		const described = pageAgrees === true && lastCached >= claimAt;
		if (!(lastCached > epoch.at)) {
			if (verifiedAtMs > epoch.at && lastCached >= basisAtMs && !described) return null;
			if (described && verify) verifyDue = true;
			others++;
		} else if (!(healedRender && lastCached >= claimAt)) {
			return null;
		}
	}
	if (verifyDue) await verify(url, pageClaimAt);
	return others > 0 || !pages.some(Boolean) ? 'covered' : 'healed';
};

/**
 * The invalidation epoch per route scope for one pass, READ DIRECTLY from the table rather than from the
 * serve path's per-worker view. The view is rebuilt on a doorbell after each write, so a reseed chained
 * straight off a canary trip could resolve before this worker's view had the trip's own row — and a
 * pass that took that "nothing is invalidated" for its whole run acted on the entire scope. Off the hot
 * path (it runs per detected change), so two point reads on a tiny table are affordable.
 *
 * An epoch, once seen, is kept for the pass: a scope cleared mid-pass only means a covered URL is left to
 * the invalidation rather than expired, which is what clearing it asks for anyway. "Nothing invalidated"
 * is kept for only a few seconds, so an invalidation recorded mid-pass (here, or replicated in from
 * another node) is seen within that. A failed read is "nothing invalidated", not cached — the pass then
 * acts as it would with no invalidation, the freshness-safe direction.
 */
const EPOCH_NONE_TTL_MS = 5 * SECOND;
const epochResolver = () => {
	const epochs = new Map(); // scope -> epoch | { none: until }
	return async (url) => {
		const scope = routeScopeForUrl(url);
		const known = epochs.get(scope);
		if (known && !known.none) return known;
		if (known?.none > Date.now()) return null;
		let epoch = null;
		try {
			epoch = await readEpochDirect(scope);
		} catch {
			return null;
		}
		epochs.set(scope, epoch ?? { none: Date.now() + EPOCH_NONE_TTL_MS });
		return epoch;
	};
};

/** `resolveInvalidation`'s answer (max over `all` and the route's scope), from the rows themselves. */
const readEpochDirect = async (routeScope) => {
	if (!config.invalidation.enabled) return null;
	const scopes = routeScope && routeScope !== CLUSTER_SCOPE ? [CLUSTER_SCOPE, routeScope] : [CLUSTER_SCOPE];
	const rows = await Promise.all(
		scopes.map((scope) => invalidationTable().get({ id: scope, select: ['scope', 'invalidatedAt'] }))
	);
	let trippedAt = NaN;
	for (const row of rows) {
		// A row with no readable instant applies to nothing (`interpretRow`, which also logs it — the
		// serve path's view does that once per load; here it would log once per changed URL).
		const at = epochMsOf(row?.invalidatedAt);
		if (Number.isFinite(at) && !(at <= trippedAt)) trippedAt = at;
	}
	return Number.isFinite(trippedAt) ? { at: trippedAt + config.invalidation.pad, trippedAt } : null;
};

// ProbeState is node-local (`replicate: false`) and only ever touched by the owner's probe —
// a missing row (never probed, ownership moved, node rebuilt, target deleted) reads as null and
// the state machine SEEDS, which is the safe direction everywhere this can happen.
// Returns the whole baseline, not just the signature: `probedAt` is what lets a pass skip a URL it
// (or the pass it resumes) already probed — see `skipProbedSince` in runProbePass.
const readSignature = async (url) => {
	const row = await probeStateTable().get({
		id: url,
		select: ['url', 'signature', 'probedAt', 'pageSignature', 'pageClaimAt', 'pageFacts', 'ruleFingerprint'],
	});
	if (!row) return null;
	// A Date column can surface as a Date, an epoch number, a string, or — the trap this coercion
	// exists for — a BigInt, which `new Date()` REFUSES rather than coerces (TypeError, which here
	// would take down the whole sweep from a read). Same defence as resolveRenderInterval's, one
	// type earlier. Anything still unparseable reads as "age unknown", which probes rather than
	// skips: never skip a probe on a value we could not read.
	const stamp = typeof row.probedAt === 'bigint' ? Number(row.probedAt) : row.probedAt;
	const probedAt = stamp === undefined || stamp === null ? NaN : new Date(stamp).getTime();
	return {
		signature: row.signature ?? null,
		probedAt,
		pageSignature: row.pageSignature ?? null,
		pageClaimAt: row.pageClaimAt ?? null,
		// The page record (canonical JSON string), parsed lazily by processOne only for a rule that maps fields.
		pageFacts: row.pageFacts ?? null,
		// null for a row written before fingerprints existed — read as "the rule in force", see processOne.
		fingerprint: row.ruleFingerprint ?? null,
	};
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
export const writeSignature = (
	url,
	signature,
	{ rowExists = false, clearClaim = false, fingerprint = null, extra = null } = {}
) => {
	const fields = { signature, probedAt: new Date(), ...extra };
	// The rule that made this observation (changeProbeSpec.js ruleFingerprint), so the next pass
	// can tell a rule edit from a content change. Written with EVERY baseline, including the
	// one-time stamp of a pre-fingerprint row; a signature is never left beside a stale fingerprint.
	if (fingerprint !== null) fields.ruleFingerprint = fingerprint;
	// THE WHOLE RECORD, always. `pageClaimAt` is the render `pageSignature` and `pageFacts` came from,
	// and they are only meaningful together — a claim with no basis cannot be scoped to a device page,
	// and a basis with no claim describes nothing. Clearing one and leaving another is inert today
	// (the verification write requires `stored.pageSignature`), but it leaves a half-state a later
	// reader can pick up, which is the shape of bug this module's own comments keep closing. The page
	// record goes too: the trip hard-expired the page it described, so a surviving record would be
	// compared against the origin as though that page were still served — and, for a record that
	// disagrees, re-trigger the already-expired page on every pass until its re-render lands.
	if (clearClaim) {
		fields.pageSignature = null;
		fields.pageClaimAt = null;
		fields.pageFacts = null;
	}
	// The key rides in the patch too, so a patch that races the row's delete (the target retired) cannot
	// leave a keyless stub behind.
	return rowExists
		? probeStateTable().patch(url, { url, ...fields })
		: probeStateTable().put(url, { url, pageSignature: null, pageClaimAt: null, pageFacts: null, ...fields });
};

/**
 * Record what a freshly rendered page CLAIMS, for the probe to compare the origin against.
 * Called from the render result path (owner-scoped, like the sweep) and deliberately best-effort:
 * a render must never fail because a probe optimisation could not be recorded. Extraction that
 * yields nothing writes nothing — same rule as a failed probe, so a markup change cannot mass-
 * trigger by making every page look like a disagreement.
 *
 * TWO PARTS, ONE WRITE. The price/availability claim (`pageSignature`, from the renderer's
 * `structuredOffers`) for a rule with the claim pair, and the PAGE RECORD (`pageFacts`, from the
 * renderer's `pageFacts`) for a rule that maps fields. Both ride in the same patch as
 * `pageClaimAt`, so the record costs no extra read and no extra write.
 *
 * A RULE THAT MAPS FIELDS ALWAYS WRITES THE WHOLE RECORD, nulls included. The record's contract is
 * "what the page served right now claims", and `pageClaimAt` is the render it describes: leaving an
 * older render's facts (or claim) in place beside a newer stamp would compare a page that is no
 * longer served, and credit it to the wrong render. So a render whose facts are unknown — the
 * renderer predates them (ABSENT), the extraction found nothing (null), the record is oversized, or
 * the render did not store every default device (`complete: false`: a partial failure or a
 * one-device render, whose other device pages are older than this record would claim) — stores
 * null, which compares as no claim. A rule without fields keeps the original behaviour exactly: a
 * render that yields no claim writes nothing.
 *
 * AND IT CHECKS THE RENDER (`changeProbe.renderCheck`, v0.97.0). The row this reads to choose between
 * patch and put holds the probe's last observation of the origin, so the new claim is compared with it
 * right here — see `renderClaimVerdict`. Resolves `{ stale: true }` when the render disagrees and should
 * be expired and re-filed; the CALLER does that (`actOnStaleRender`), after its own page writes and its
 * reschedule, which would otherwise overwrite both the expiry and the re-file. Anything else resolves
 * undefined, and nothing here ever rejects.
 */
export const recordPageClaim = async (
	url,
	structuredOffers,
	cachedAt = Date.now(),
	{ pageFacts = undefined, complete = true } = {}
) => {
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
		const pageCheck = rule?.pageCheck;
		if (!pageCheck) return;
		const claimPair = pageCheck.priceFrom !== null && pageCheck.priceFrom !== undefined;
		const mapped = (pageCheck.fields?.length ?? 0) > 0;
		if (!claimPair && !mapped) return;
		let claim = null;
		if (claimPair) {
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
			} else {
				claim = pageClaimFromOffers(structuredOffers);
			}
		}
		// `pageClaimAt` rides in the SAME write — no extra read, no extra write — and is the render's
		// own `lastCached`, not the moment this ran. See the schema comment: it becomes the basis a
		// verification certifies, and a stamp taken milliseconds later would exclude the very page it
		// is certifying.
		const claimAt = new Date(cachedAt);
		let fields;
		if (mapped) {
			fields = { pageSignature: claim, pageFacts: pageRecordOf(url, pageFacts, complete), pageClaimAt: claimAt };
		} else {
			if (!claim) return;
			fields = { pageSignature: claim, pageClaimAt: claimAt };
		}
		// patch cannot create, and put would clobber the probe's own signature/probedAt — so read
		// first and choose. The read is a node-local point read on a small table, once per render
		// of a pageCheck-matched URL. It carries the probe's baseline too, for the render check.
		const existing = await probeStateTable().get({
			id: url,
			select: ['url', 'signature', 'probedAt', 'ruleFingerprint', 'renderRefiledAt'],
		});
		const verdict = existing && claim ? await renderClaimVerdict(url, rule, claim, existing) : null;
		// The bound (see `renderClaimVerdict`) rides in the claim's own write: no extra write. The claim's
		// own stamp is kept for the confirming re-probe, which must not act on (or clear) a newer claim.
		if (verdict?.stale) {
			fields.renderRefiledAt = new Date();
			noteSuspectClaim(url, claimAt.getTime());
		}
		if (existing) await probeStateTable().patch(url, { url, ...fields });
		// A record of nothing is not worth creating a row for; on an EXISTING row the nulls above are
		// the point (they retire an older render's record).
		else if (fields.pageSignature !== null || fields.pageFacts) await probeStateTable().put(url, { url, ...fields });
		if (verdict?.outcome) countProbe('render_mismatch', verdict.outcome);
		return verdict?.stale ? { stale: true } : undefined;
	} catch (e) {
		logger.warn?.(`[prerender] change-probe page claim not recorded for ${url}: ${e?.message ?? String(e)}`);
		return undefined;
	}
};

/**
 * THE RENDER CHECK: does a render that just landed disagree with the probe's last observation of the
 * origin? Null when nothing disagrees (or the check does not apply), else `{ outcome }`, with
 * `stale: true` when the render is SUSPECT and one confirming re-probe of the URL is due
 * (`actOnStaleRender`, which the render result path calls after its own writes).
 *
 * WHAT IT CATCHES. A render claimed BEFORE a probe found a change and landing AFTER it (the queue drops
 * most of those on the lease-vs-mark check; this catches the rest), and a render that captured a stale
 * copy of the page (a CDN or origin cache behind the one the probe's endpoint reads). Either way the probe
 * will not look at the URL again until its next pass, a day away in anchored mode, and the page serves
 * wrong until then.
 *
 * WHY A RE-PROBE, NOT THE BASELINE'S WORD. The stored signature is the probe's last observation and the
 * render is newer than it, so a disagreement means the render is stale OR the origin moved since the probe
 * looked — an intra-day availability change, an off-schedule reprice, a baseline left by a false trip's
 * glitch — and only the first is the render's fault. Acting on the baseline expired correct pages in every
 * one of those cases (review, round 2). So nothing is expired on a disagreement alone: ONE origin request
 * asks again (`confirmStaleRender`), and only an answer that also disagrees with the page acts.
 *
 * WHEN IT DOES NOT EVEN ASK. When the origin is KNOWN to have moved since the probe last observed the URL
 * (`mayBeStale`: the most recent anchor, in anchored mode, or an active invalidation's trip, came after
 * it), the render is likelier right than the baseline, and the pass reaching the URL will compare the
 * page's claim itself — counted `untrusted`, no request. On a reprice night that is nearly every
 * disagreement, so the re-probes stay a trickle.
 *
 * WHY IT CANNOT LOOP. A page whose origin genuinely disagrees with the endpoint on every render would
 * re-probe and re-render forever. `renderRefiledAt` bounds it to ONE confirmation per stored observation:
 * a later disagreeing render against the same baseline counts `bounded` and is left to the pass.
 *
 * Only the price/availability claim pair — the fields a served mismatch costs most on — and only in an
 * armed probe (`dry_run` is counted otherwise, and asks nothing). The mapped `pageCheck.fields` are not
 * checked here: the mapping-defect guard that protects them lives in the sweep's process.
 */
const renderClaimVerdict = async (url, rule, claim, stored) => {
	if (!config.changeProbe.renderCheck) return null;
	const fingerprint = stored.ruleFingerprint ?? null;
	if (!stored.signature || (fingerprint !== null && fingerprint !== rule.fingerprint)) return null;
	const slots = signatureSlots(stored.signature);
	if (!slots) return null; // a status-signal literal carries no price/availability to compare
	if (compareClaims(claim, apiClaimOf(slots, rule.pageCheck)) !== false) return null;
	const probedAt = epochOf(stored.probedAt);
	const refiledAt = epochOf(stored.renderRefiledAt);
	if (Number.isFinite(refiledAt) && !(probedAt > refiledAt)) return { outcome: 'bounded' };
	if (!(await mayBeStale(url, probedAt))) return { outcome: 'untrusted' };
	if (config.changeProbe.dryRun) return { outcome: 'dry_run' };
	return { stale: true };
};

/**
 * Could the render, rather than the origin, be what changed? False when the origin is known to have moved
 * since the probe last observed the URL:
 *
 *   an active invalidation's trip came after the BASELINE (`probedAt`). Not after a walk-past: a pass
 *     during an invalidation leaves a covered page's baseline where it was (`coverageOf`), so "the reseed
 *     walked past it" says nothing about what the origin said — and counting it made every covered page
 *     that later healed cost a re-probe, for the whole invalidation (review, round 3).
 *   in anchored mode, the most recent anchor came after the latest observation (`observedSince`, or the
 *     baseline's own write).
 *
 * True otherwise — including when nothing is known (interval or continuous mode, no invalidation), which
 * is a question to ASK the origin, never a reason to trust a baseline of any age.
 */
const mayBeStale = async (url, probedAt) => {
	const baselineAt = Number.isFinite(probedAt) ? probedAt : -Infinity;
	try {
		const epoch = await resolveInvalidation(routeScopeForUrl(url));
		// The epoch carries the serve path's pad; the trip itself is the instant that matters here.
		if (epoch && baselineAt < epoch.at - config.invalidation.pad) return false;
	} catch {
		// Unknown: judge on the anchor alone.
	}
	if (!isAnchored()) return true;
	const anchor = previousAnchorOccurrence();
	if (!Number.isFinite(anchor)) return true;
	const since = observedSince((await sweepStateForRenderCheck())?.sweep, url);
	return Math.max(baselineAt, Number.isFinite(since) ? since : -Infinity) >= anchor;
};

/**
 * When the probe last OBSERVED `url` at the latest, from this node's published pass state (the probe
 * writes nothing on an unchanged observation, so this is the only record there is): the start of the
 * running pass once its cursor is past the URL, else the start of the last pass if it covered the URL
 * (it finished, or it stopped past it). NaN when unknown. A pass's start is its ORIGIN — a resume and
 * the pass it continues walk one key range between them.
 */
const observedSince = (sweep, url) => {
	if (!sweep) return NaN;
	if (sweep.running === true && typeof sweep.progress?.cursor === 'string' && url < sweep.progress.cursor) {
		return epochMsOf(sweep.originStartedAt ?? sweep.startedAt);
	}
	const last = sweep.lastRun;
	if (!last || last.error) return NaN;
	if (last.aborted && !(typeof last.walkedThrough === 'string' && url <= last.walkedThrough)) return NaN;
	return epochMsOf(last.resumedFrom ?? last.startedAt);
};

// The pass state for the render check, re-read at most every few seconds per worker: it only runs on a
// disagreement, but a change wave can make that thousands of renders an hour.
const RENDER_CHECK_STATE_TTL_MS = 10 * SECOND;
let renderCheckState = { at: 0, row: null };
const sweepStateForRenderCheck = async () => {
	if (Date.now() - renderCheckState.at < RENDER_CHECK_STATE_TTL_MS) return renderCheckState.row;
	renderCheckState = { at: Date.now(), row: await readProbeState() };
	return renderCheckState.row;
};

/**
 * Confirm a render the render check found suspect (`recordPageClaim` resolved `{ stale }`): queue ONE
 * re-probe of the URL, and act only on its answer (`confirmStaleRender`). Called by the render result path
 * AFTER its page writes and its reschedule, so an expiry and re-file it leads to cannot be overwritten by
 * them. Returns at once — the request runs DETACHED from the render result's request context (whose
 * transaction Harper closes after the response, `util/detach.js`) — and never rejects.
 */
const rechecksInFlight = new Set();
export const actOnStaleRender = (url, target = null) => {
	const claimAtMs = suspectClaims.get(url) ?? NaN;
	suspectClaims.delete(url);
	if (rechecksInFlight.size >= RECHECK_MAX_PENDING) {
		countProbe('render_mismatch', 'shed');
		return Promise.resolve();
	}
	const running = runDetached(() => confirmStaleRender(url, target, claimAtMs)).catch((e) => {
		countProbe('render_mismatch', 'error');
		logger.warn?.(`[prerender] change-probe: render recheck of ${url} failed: ${e?.message ?? String(e)}`);
	});
	rechecksInFlight.add(running);
	running.finally(() => rechecksInFlight.delete(running));
	return Promise.resolve();
};

// The claim stamp (`pageClaimAt`, epoch ms) of each suspect render, from `recordPageClaim` to the
// `actOnStaleRender` the same result path calls a moment later on the same worker. Bounded: a result
// path that never makes the call (no target) must not grow it.
const suspectClaims = new Map();
const noteSuspectClaim = (url, claimAtMs) => {
	suspectClaims.delete(url);
	suspectClaims.set(url, claimAtMs);
	if (suspectClaims.size > RECHECK_MAX_PENDING) suspectClaims.delete(suspectClaims.keys().next().value);
};

// Per worker: re-probes waiting for a pacing slot. Past this, a suspect render is left to the pass.
const RECHECK_MAX_PENDING = 256;
// The longest a re-probe waits for its node-wide slot before it is shed (counted `shed`).
const RECHECK_MAX_WAIT_MS = MINUTE;

/**
 * THE OUT-OF-PASS REQUESTS' PACE: NODE-WIDE, AND OUT OF THE SWEEP'S BUDGET, NOT BESIDE IT.
 *
 * Node-wide because a render lands on whichever worker the fleet's POST reached, and a bot on whichever
 * worker Harper picked, so a per-worker pace would let sixteen workers send sixteen times the rate. Out of
 * the sweep's budget because `ratePerSecond` is the number agreed with whoever runs the origin: a re-probe
 * paced at it beside a sweep running at it is twice the agreed rate (review, round 3). So a running pass
 * (the sweep or the canary) publishes the HEADROOM it leaves (`publishSweepHeadroom`: the ceiling minus the
 * rate it is paced at, divided by whatever backoff the origin or the node has imposed on it), and the
 * out-of-pass requests (the render re-check, the serve-time checks) share only that — the whole ceiling
 * when no pass runs.
 *
 * WHAT A PASS LEAVES, while serve-time checks are armed: what they are USING, not what they might
 * (`outOfPassHeadroom`). Twice the out-of-pass rate of the last few seconds, at least a floor and at most
 * `serveCheck.share` of the ceiling — so the total never exceeds `ratePerSecond`, the checks can double
 * their allowance every few seconds when a burst of due pages arrives (the anchor), and a quiet afternoon
 * costs the pass a tenth of its rate, not `share` of it. Unarmed, a pass runs at the ceiling and leaves
 * nothing, as before.
 *
 * PUSHBACK STOPS THEM. A serve-time check the origin answers 429/5xx, or that times out, pauses every
 * out-of-pass request on the node (`noteOriginPushback`): twice as long per consecutive pushback, at
 * least its `Retry-After`, at most five minutes, cleared by the next healthy answer. A pass backs off on its
 * own (`stepBackoff`), and its published headroom shrinks with it.
 *
 * One shared cell, epoch ms: `[nextSlot, headroom in milli-requests/s, when a pass last published it,
 * usage window start, requests in it, requests in the window before, paused until, pushback level]`.
 * Each request takes the next slot `1000 / rate` ms on, by compare-and-swap, and waits for it — or is shed
 * (the pass will get to the URL) when that slot is more than its `maxWaitMs` away. A pass that stops
 * publishing (it ended, or its worker died) stops counting after `SWEEP_PACE_FRESH_MS`.
 */
const SWEEP_PACE_FRESH_MS = 2 * MINUTE;
const USAGE_WINDOW_MS = 5 * SECOND;
const PUSHBACK_PAUSE_MAX_MS = 5 * MINUTE;
let originPace = null;
const originPaceCell = () => (originPace ??= new BigInt64Array(getSab('change_probe_origin_pace_v2', 64)));

/** A running pass's share of the node's probe budget: what it leaves out-of-pass. Null = done. */
const publishSweepHeadroom = (headroom) => {
	const cell = originPaceCell();
	Atomics.store(cell, 1, BigInt(Math.max(0, Math.round((headroom ?? 0) * 1000))));
	Atomics.store(cell, 2, headroom === null ? 0n : BigInt(Date.now()));
};

const recheckRate = () => {
	const ceiling = Math.max(1, config.changeProbe.ratePerSecond);
	const cell = originPaceCell();
	const publishedAt = Number(Atomics.load(cell, 2));
	if (!(publishedAt > 0 && Date.now() - publishedAt < SWEEP_PACE_FRESH_MS)) return ceiling;
	return Math.min(ceiling, Number(Atomics.load(cell, 1)) / 1000);
};

/** Count one out-of-pass request in the usage window (approximate under a race; it only steers a rate). */
const noteOutOfPassRequest = (cell, nowMs) => {
	const start = Atomics.load(cell, 3);
	if (nowMs - Number(start) >= USAGE_WINDOW_MS && Atomics.compareExchange(cell, 3, start, BigInt(nowMs)) === start) {
		const finished = Atomics.exchange(cell, 4, 0n);
		Atomics.store(cell, 5, nowMs - Number(start) >= 2 * USAGE_WINDOW_MS ? 0n : finished);
	}
	Atomics.add(cell, 4, 1n);
};

/** Out-of-pass requests per second over the last one to two usage windows. */
export const outOfPassRate = (nowMs = Date.now()) => {
	const cell = originPaceCell();
	const elapsed = nowMs - Number(Atomics.load(cell, 3));
	if (!(elapsed >= 0) || elapsed >= 2 * USAGE_WINDOW_MS) return 0;
	const current = Number(Atomics.load(cell, 4));
	if (elapsed >= USAGE_WINDOW_MS) return (current / elapsed) * 1000;
	return ((Number(Atomics.load(cell, 5)) + current) / (USAGE_WINDOW_MS + elapsed)) * 1000;
};

/** What a pass leaves out-of-pass while serve-time checks are armed (see above), in requests per second. */
export const outOfPassHeadroom = (nowMs = Date.now()) => {
	const ceiling = Math.max(0, config.changeProbe.ratePerSecond);
	const most = ceiling * (config.changeProbe.serveCheck?.share ?? 0);
	const floor = Math.min(most, Math.max(0.1, ceiling * 0.1));
	return Math.min(most, Math.max(floor, 2 * outOfPassRate(nowMs)));
};

/**
 * The origin pushed back on an out-of-pass request (a 429/5xx, a timeout): pause them all on this node,
 * twice as long per consecutive pushback, at least `retryAfterMs`. See above.
 */
export const noteOriginPushback = (retryAfterMs = null) => {
	const cell = originPaceCell();
	const level = Math.min(16, Number(Atomics.add(cell, 7, 1n)) + 1);
	const pause = Math.min(PUSHBACK_PAUSE_MAX_MS, Math.max(retryAfterMs ?? 0, SECOND * 2 ** (level - 1)));
	const until = BigInt(Date.now() + pause);
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = Atomics.load(cell, 6);
		if (current >= until || Atomics.compareExchange(cell, 6, current, until) === current) break;
	}
};

/** An out-of-pass request was answered normally: the pushback level starts over. */
export const noteOriginHealthy = () => {
	const cell = originPaceCell();
	if (Atomics.load(cell, 7) !== 0n) Atomics.store(cell, 7, 0n);
};

const reserveRecheckSlot = () => reserveOriginSlot(RECHECK_MAX_WAIT_MS);

/**
 * A slot in the node's probe budget for an out-of-pass request, at most `maxWaitMs` away, or null (shed).
 * The render re-check and the serve-time checks share it: only the headroom a running pass leaves, the
 * whole ceiling when none runs, nothing while the origin's pushback pauses them.
 */
export const reserveOriginSlot = (maxWaitMs) => {
	const cell = originPaceCell();
	const nowMs = Date.now();
	if (Number(Atomics.load(cell, 6)) > nowMs) return null;
	const rate = recheckRate();
	if (!(rate > 0)) return null;
	const step = BigInt(Math.max(1, Math.ceil(1000 / rate)));
	for (let attempt = 0; attempt < 32; attempt++) {
		const now = BigInt(Date.now());
		const next = Atomics.load(cell, 0);
		const slot = next > now ? next : now;
		if (slot - now > BigInt(maxWaitMs)) return null;
		if (Atomics.compareExchange(cell, 0, next, slot + step) === next) {
			noteOutOfPassRequest(cell, Number(now));
			return Number(slot);
		}
	}
	return null;
};

/**
 * The confirming re-probe. The page's claim is re-read (a newer render, or an action, may have replaced
 * or cleared it meanwhile) and compared with the fresh observation:
 *
 *   disagrees    the page is stale: hard-expired and re-filed as a change (`actOnChange`), counted
 *                `confirmed`. The fresh observation becomes the baseline only if it differs from the
 *                stored one (the origin moved too); an unchanged origin keeps its baseline, so the bound
 *                in `renderClaimVerdict` holds until the pass writes a new one.
 *   agrees       the origin moved since the probe last looked and the page shows it: the fresh
 *                observation becomes the baseline, nothing is expired — `cleared`.
 *   neither      nothing comparable, a failed probe, the claim gone: nothing is done.
 */
const confirmStaleRender = async (url, target, claimAtMs = NaN) => {
	const slot = reserveRecheckSlot();
	if (slot === null) {
		countProbe('render_mismatch', 'shed');
		return;
	}
	if (slot > Date.now()) await waitUnref(slot - Date.now());
	if (!config.changeProbe.enabled || !config.changeProbe.renderCheck) return;
	const pathname = URL.parse(url)?.pathname;
	const rule = pathname ? probeRules().find((candidate) => candidate.pathPattern.test(pathname)) : null;
	if (!rule?.pageCheck) return;
	countProbe('render_mismatch', 'rechecked');
	let fresh = null;
	try {
		fresh = await probeOnce(rule, url);
	} catch {
		fresh = null;
	}
	const values = fresh ? signatureSlots(fresh) : null;
	if (!values) {
		countProbe('render_mismatch', 'recheck_failed');
		return;
	}
	const stored = await probeStateTable().get({
		id: url,
		select: ['url', 'signature', 'pageSignature', 'pageClaimAt', 'ruleFingerprint'],
	});
	// A NEWER RENDER LANDED while this waited for its slot: its claim is what describes the cached page now,
	// and it had its own render check. This one has nothing left to judge.
	const newerThan = (value) => Number.isFinite(claimAtMs) && epochOf(value) > claimAtMs;
	if (stored && newerThan(stored.pageClaimAt)) {
		countProbe('render_mismatch', 'superseded');
		return;
	}
	const verdict = stored?.pageSignature
		? compareClaims(stored.pageSignature, apiClaimOf(values, rule.pageCheck))
		: null;
	if (verdict === null) {
		countProbe('render_mismatch', 'recheck_inconclusive');
		return;
	}
	if (verdict === true) {
		if (fresh !== stored.signature) {
			await writeSignature(url, fresh, { rowExists: true, fingerprint: rule.fingerprint });
		}
		countProbe('render_mismatch', 'cleared');
		return;
	}
	await actOnChange({
		url,
		sitemapUrl: target?.sitemapUrl ?? null,
		renderInterval: target?.renderInterval ?? null,
		demandInterval: target?.demandInterval ?? null,
	});
	if (fresh !== stored.signature) {
		// The bound re-armed in the same write: `renderRefiledAt` at or after the new `probedAt`. The claim
		// is cleared only if it is still the one judged here — a render that landed during the action wrote
		// a newer claim describing a newer page, and wiping it would blind the next comparison.
		const current = await probeStateTable().get({ id: url, select: ['url', 'pageClaimAt'] });
		await writeSignature(url, fresh, {
			rowExists: true,
			clearClaim: !newerThan(current?.pageClaimAt),
			fingerprint: rule.fingerprint,
			extra: { renderRefiledAt: new Date() },
		});
	}
	countProbe('render_mismatch', 'confirmed');
	logger.info?.(
		`[prerender] change-probe: the render of ${url} disagrees with the origin, asked again — expired and re-filed`
	);
};

/** The page record to store for one render, or null — see recordPageClaim for when and why. */
const pageRecordOf = (url, pageFacts, complete) => {
	if (pageFacts === undefined) {
		warnPageFactsUnsupported();
		return null;
	}
	if (!complete) return null;
	const { json, bytes, refused } = serializePageFacts(pageFacts);
	if (refused) warnPageFactsRefused(url, bytes);
	return json;
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

// Same shape and cadence as the claim warning above, for the page record's own field.
let lastFactsUnsupportedWarnAt = 0;
const warnPageFactsUnsupported = () => {
	const now = Date.now();
	if (now - lastFactsUnsupportedWarnAt < 3600000) return;
	lastFactsUnsupportedWarnAt = now;
	logger.warn?.(
		`[prerender] changeProbe.pageCheck.fields are mapped but the render result carried no pageFacts — the ` +
			`renderer is older than @harperfast/prerender-browser 1.37.0, so page records are stored empty and the ` +
			`mapped fields detect nothing (and never suppress a trigger). Upgrade the render fleet or remove the mapping.`
	);
};

// Hourly too: an oversized record is a property of a page TEMPLATE, so one bad template would
// otherwise log on every render of every page built from it.
let lastFactsRefusedWarnAt = 0;
const warnPageFactsRefused = (url, bytes) => {
	const now = Date.now();
	if (now - lastFactsRefusedWarnAt < 3600000) return;
	lastFactsRefusedWarnAt = now;
	logger.warn?.(
		`[prerender] change-probe page record for ${url} is ${bytes} bytes, over the ${PAGE_FACTS_MAX_BYTES}-byte ` +
			`bound — not stored, so that page's mapped fields compare as no claim. (Logged at most hourly.)`
	);
};

/**
 * Probe a stream of target rows and act on what changed. ALL I/O is injected, so the decision
 * logic — ownership, matching, the seed/changed/failed state machine, pacing, the action
 * pipeline's backpressure, dry-run — is testable without Harper globals (the reconcileSchedules pattern).
 *
 * `rows` must never hold an open read cursor while this runs: the sweep feeds it from
 * already-collected chunks and the canary from point reads, so probe latency and schedule writes
 * happen with every cursor closed (see util/scan.js for why that discipline is structural).
 */
/**
 * Is a per-page exemption worth recording for this scope right now?
 *
 * Only while an invalidation is actually active for it. A verification is ONLY ever consulted against
 * an epoch (`resolveServeStatus`), so rows written when nothing is invalidated buy nothing and would
 * add ~200k writes per node per cycle to a converged corpus — the exact per-probe write the
 * `ProbeState` design goes out of its way to avoid.
 *
 * Wired into the SWEEP only, never the canary: the canary samples a few hundred URLs to detect a
 * cliff, so it can neither cover the corpus nor be relied on for coverage, and letting it write
 * verifications would spread a sparse, misleading set of exemptions across the scope.
 */
export const verificationArmedFor = async (scope) => {
	if (!config.invalidation.verification.enabled) return false;
	return (await resolveInvalidation(scope)) !== null;
};

/**
 * THE MAPPING-DEFECT GUARD: disarm a mapped field that is evidently mapped wrong.
 *
 * A wrong mapping (a slot holding the regular price mapped to the sale price the page prints, a
 * list compared in the wrong shape) disagrees on nearly EVERY comparison, and every disagreement is
 * a re-render — so one bad mapping would re-render its whole corpus on every pass. A correct
 * mapping disagrees only when the page really is wrong, and on a page the probe has WITNESSED —
 * rendered after the stored baseline was taken, with the origin unchanged since — that takes a
 * genuine round trip (the value changed and changed back between two probes, and a render landed in
 * between): measured well under 1%.
 *
 * So the guard counts, per field, witnessed comparisons and witnessed disagreements, and DISARMS the
 * field once its disagreement rate reaches `threshold` over at least `minWitnessed` comparisons. A
 * disarmed field stops triggering (and stops counting toward caught-up and verification) but is
 * still compared and still counted in `fieldMismatch`, and it stays disarmed until its mapping
 * changes (a different entry, slot path or rule label is a different key) or the process restarts.
 *
 * AGGREGATE ONLY, BY DESIGN. It never suppresses an individual witnessed disagreement: a single one
 * is exactly the round trip the page check exists to catch, and it must re-render. Only the RATE
 * says "mapping defect", and only at a sample large enough that a correct mapping cannot reach it by
 * chance (at a 1% true rate, 20% of 200 is ~40 disagreements where ~2 are expected).
 *
 * BOUNDED MEMORY. Both counts are halved whenever the sample reaches GUARD_WINDOW x `minWitnessed`,
 * so the rate describes roughly the last few thousand comparisons rather than the process lifetime.
 * Without it, a mapping that was right for a week and then broke — the site redesigns its title
 * template, and every re-render still disagrees — would need hundreds of thousands of disagreements
 * to outweigh the week of agreement, re-rendering every page it matches on every pass until then.
 * The halved sample never drops below `minWitnessed`, so the threshold stays consultable.
 *
 * Per process, in memory: the sweep and canary run on worker 0, so that is where the evidence
 * accumulates. A pass started by hand on another worker starts with its own, empty guard.
 */
// The guard's memory, in multiples of `minWitnessed` (see BOUNDED MEMORY above).
const GUARD_WINDOW = 10;

export const createMappingGuard = ({ settings, onDisarm = () => {} }) => {
	const entries = new Map();
	// A field's key, cached per compiled field object (a config reload compiles new ones). The rule
	// label and the slot's extract PATH are in it, so re-pointing a slot or renaming the rule is a
	// new mapping with a clean record.
	const keys = new WeakMap();
	const keyOf = (rule, field) => {
		let key = keys.get(field);
		if (key === undefined) {
			key = JSON.stringify([
				rule.label,
				rule.extract?.[field.slot] ?? null,
				field.slot,
				field.fact,
				field.compare,
				field.options,
			]);
			keys.set(field, key);
		}
		return key;
	};
	return {
		isArmed: (rule, field) => entries.get(keyOf(rule, field))?.disarmed !== true,
		witness(rule, field, disagreed) {
			const key = keyOf(rule, field);
			let entry = entries.get(key);
			if (!entry) entries.set(key, (entry = { witnessed: 0, disagreed: 0, disarmed: false }));
			entry.witnessed++;
			if (disagreed) entry.disagreed++;
			if (entry.disarmed) return;
			const { threshold, minWitnessed } = settings();
			if (entry.witnessed >= minWitnessed && entry.disagreed / entry.witnessed >= threshold) {
				entry.disarmed = true;
				onDisarm(rule, field, entry);
				return;
			}
			if (entry.witnessed >= GUARD_WINDOW * minWitnessed) {
				entry.witnessed /= 2;
				entry.disagreed /= 2;
			}
		},
		/** `{ [rule]: { [field]: { witnessed, disagreed, armed } } }` for every mapped field of `rules`. */
		snapshot(rules) {
			const out = {};
			for (const rule of rules) {
				for (const field of rule.pageCheck?.fields ?? []) {
					const entry = entries.get(keyOf(rule, field));
					out[rule.label] ??= {};
					out[rule.label][field.label] = {
						witnessed: Math.round(entry?.witnessed ?? 0),
						disagreed: Math.round(entry?.disagreed ?? 0),
						armed: entry?.disarmed !== true,
					};
				}
			}
			return out;
		},
	};
};

const warnDisarmed = (rule, field, entry) => {
	logger.warn?.(
		`[prerender] change-probe ${rule.label}: pageCheck field ${field.label} (extract[${field.slot}] ` +
			`"${rule.extract?.[field.slot]}", compare ${field.compare}) is DISARMED — the cached page disagreed with ` +
			`the origin on ${Math.round(entry.disagreed)} of ${Math.round(entry.witnessed)} recent witnessed comparisons ` +
			`(${((entry.disagreed / entry.witnessed) * 100).toFixed(1)}%), where a correct mapping disagrees only on ` +
			`rare round trips. It no longer triggers re-renders (its mismatches are still counted in fieldMismatch) ` +
			`until the mapping is edited or the process restarts. Check that extract[${field.slot}] really holds what ` +
			`the page shows as ${field.fact}.`
	);
};

// The node's guard — one per process, shared by the sweep and the canary (see createMappingGuard).
let mappingGuard = null;
const theMappingGuard = () =>
	(mappingGuard ??= createMappingGuard({ settings: () => config.changeProbe.mappingGuard, onDisarm: warnDisarmed }));

// A Date column as epoch ms, BigInt-safe (see readSignature); NaN when unreadable.
const epochOf = (value) => {
	if (value === undefined || value === null) return NaN;
	const stamp = typeof value === 'bigint' ? Number(value) : value;
	const ms = new Date(stamp).getTime();
	return Number.isFinite(ms) ? ms : NaN;
};

// `stats[group][rule][key]++`, creating the levels on first use.
const bump = (table, rule, key) => {
	table[rule] ??= {};
	table[rule][key] = (table[rule][key] ?? 0) + 1;
};

// A rule's mapped `canonical` field (the first, when it maps several), memoized per compiled rule.
const canonicalFields = new WeakMap();
const canonicalFieldOf = (rule) => {
	if (!canonicalFields.has(rule)) {
		canonicalFields.set(rule, (rule.pageCheck?.fields ?? []).find((field) => field.fact === 'canonical') ?? null);
	}
	return canonicalFields.get(rule);
};

export const runProbePass = async ({
	rows,
	rules,
	ownerOf,
	hostname,
	probe,
	read,
	write,
	// Hands one detected change to the action pipeline (util/changeActions.js). It resolves once the
	// action has STARTED, not finished: the pass must not pay the action's latency inside the row
	// handler, because that is what made pass duration a function of the change rate. When every slot
	// is busy it waits for one — backpressure, never a refusal, so nothing detected is deferred.
	submitTrigger,
	// Injected like `write`/`trigger` so a pass can be exercised without Harper, and DEFAULTED INERT:
	// a caller that does not wire verification gets exactly the pre-feature behaviour. `isArmed` is
	// resolved once per rule per pass (see below), never per row.
	verify = null,
	isArmed = null,
	// The mapping-defect guard (createMappingGuard). Null = no guard: every mapped field is armed and
	// nothing is witnessed, which is what a caller that does not wire it gets.
	guard = null,
	dryRun,
	concurrency,
	ratePerSecond,
	pause = sleep,
	now = Date.now,
	isCanceled = () => false,
	collectCohort = null,
	// `changeProbe.scope` as a row predicate (util/probeScope.js), or null for 'all' — null never calls
	// anything per row, which is what keeps the default pass's counters exactly the pre-option ones.
	inScope = null,
	ownershipChecked = false,
	onYield = () => yieldNow(),
	// Skip a URL whose baseline was written at or after this instant (epoch ms): THIS pass, or the pass
	// it resumes, already probed it. Null never skips — the canary's setting. See `processOne`.
	skipProbedSince = null,
	// Serve-time checks (util/serveCheck.js): `readCheck(url)` resolves the URL's last check
	// (util/pageCheck.js `readPageCheck`), a row a check observed exactly as its baseline stands at or after
	// `skipCheckedSince` is skipped (`checkSparesProbe`), and `recordCheck(url, basisAtMs, { signature })`
	// records this pass's own agreeing comparisons. All null = the pre-feature pass.
	readCheck = null,
	skipCheckedSince = null,
	recordCheck = null,
	// Requests per second to leave out of `ratePerSecond` for out-of-pass requests, re-read every batch
	// (`outOfPassHeadroom`), or null to run at the ceiling.
	reserveHeadroom = null,
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
	// Observability hooks. `onStart` receives the pass's LIVE stats object as soon as it exists — the
	// caller cannot otherwise reach it while the pass runs (or after it throws), and its heartbeat and
	// metric emission both need to. `onBatch` fires after every probed batch, which is the cadence the
	// pass's metrics are emitted on (see `createPassEmitter`).
	onStart = () => {},
	onBatch = () => {},
	// Called with (rule, row) for every origin CHANGE the pass detects (the rows counted `changed`) —
	// what the detection-lag metric is emitted from.
	onChange = () => {},
	// What an active invalidation already does for a URL the pass would act on (`coverageOf`): 'covered',
	// 'healed' or null. Null = no such check (the canary, and every pass that does not wire it).
	coverageOf = null,
	// Told the rate each batch was paced at and the backoff on it (`(rate, originThrottle, loadThrottle)`),
	// so a sweep can publish the budget it leaves (`publishSweepHeadroom`).
	onPace = () => {},
	// The entity registry's observer (util/entity.js `createCanonicalObserver`), told `{ url, value }` — the
	// probed URL and its rule's mapped `canonical` slot — after every probe that answered. Null = none: the
	// registry is off, or this is the canary, which detects and adopts nothing.
	onCanonical = null,
} = {}) => {
	const stats = newStats();
	onStart(stats);
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

	// RESOLVED ONCE PER PASS, NOT PER URL. A pass runs for hours over hundreds of thousands of rows;
	// a point read per row to ask "is an invalidation still active" would cost more than the feature
	// saves. Resolving at the top instead means a scope invalidated MID-PASS is not verified until the
	// next pass — the safe direction, and the only one available without paying that per-row read.
	// (The opposite error would be worse: a scope CLEARED mid-pass leaves rows written for an epoch
	// nobody is enforcing, which is harmless — a verification is only ever consulted against an epoch.)
	const armedScopes = new Map();
	const isVerificationArmed = async (rule) => {
		if (!verify || !isArmed) return false;
		// A rule may only verify pages against the invalidation ITS OWN scope recorded. The rule that
		// trips an invalidation is the rule entitled to lift it, per URL, and only over the fields it
		// actually watches — otherwise one rule's price check could exempt pages from an invalidation
		// recorded for something it never looked at. No scope, no pageCheck, no verification.
		if (!rule?.pageCheck || !rule?.invalidateScope) return false;
		if (armedScopes.has(rule.invalidateScope)) return armedScopes.get(rule.invalidateScope);
		let armed = false;
		try {
			armed = await isArmed(rule.invalidateScope);
		} catch {
			// Fail closed: unknown means unverified means keep proxying.
			armed = false;
		}
		armedScopes.set(rule.invalidateScope, armed);
		return armed;
	};

	const processOne = async ({ row, rule }) => {
		// Read BEFORE the probe (it used to read after, to skip the read on a failed probe): the stored
		// baseline carries WHEN it was written, and one written since this pass began — by this pass
		// before a restart cut it short, by an in-flight action the resume cursor was held back for, or
		// by the canary — has already been probed by the pass this row belongs to. Trading a node-local
		// point read for an origin request is the right way round: the origin request is the scarce,
		// externally-visible resource.
		//
		// SINCE THE PASS BEGAN, NOT "YOUNGER THAN `reprobeAfter`" (the rule before v0.97.0). `probedAt`
		// moves only when a baseline is WRITTEN — a change, a seed, a re-baseline — never on an unchanged
		// observation, so an age test selected exactly the rows that had recently CHANGED and never the
		// quiet ones it was meant to spare. Measured on a live deployment: every change an off-schedule
		// daytime pass caught was skipped by the next night's anchored pass, because its baseline was
		// under 12h old — and that night's reprice of those pages waited a full day for the pass after.
		const stored = (await read(row.url)) ?? null;
		if (skipProbedSince !== null && Number.isFinite(stored?.probedAt) && stored.probedAt >= skipProbedSince) {
			stats.fresh++;
			return;
		}
		// OBSERVED SINCE THE PASS BEGAN, EXACTLY AS THE BASELINE STANDS — by a serve-time check on any node, or
		// by this pass before a restart: the probe this row would make has been made, and it would find the
		// row unchanged on every slot (`checkSparesProbe`). A local read of a replicated table instead of an
		// origin request. Not an agreement on the mapped fields alone: a slot the page does not show (a
		// regular price beside the sale price, a status flag) can move while every mapped field agrees, and
		// only this probe would see it. Not while a verification is armed for the rule's scope either: the
		// probe's quiet observation is what writes it (below), and a check cannot stand in for that proof.
		if (skipCheckedSince !== null && readCheck && stored?.signature && !(await isVerificationArmed(rule))) {
			if (checkSparesProbe(await readCheck(row.url), stored, rule, skipCheckedSince)) {
				stats.checkedOnDemand++;
				return;
			}
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

		// The observation's slot values, parsed at most once and only when something needs them.
		let values;
		const valuesOf = () => {
			if (values === undefined) values = signatureSlots(observed); // null for a status-signal literal
			return values;
		};

		// THE ENTITY'S CANONICAL, as the origin's endpoint names it now (util/entity.js). Before the baseline
		// logic, because it is a statement about the origin, not about this row's history: a re-baselined or a
		// changed row reports its product's canonical all the same. Only from an ARMED mapped field — one the
		// mapping guard disarmed is suspected of being mapped wrong, and must not file targets.
		if (onCanonical) {
			const field = canonicalFieldOf(rule);
			const slots = field && (!guard || guard.isArmed(rule, field)) ? valuesOf() : null;
			if (slots) await onCanonical({ url: row.url, value: slots[field.slot] });
		}

		// RULE CHANGED, NOT CONTENT. A baseline is only comparable to an observation made the same
		// way (changeProbeSpec.js ruleFingerprint). A stored fingerprint that is not this rule's
		// means the rule was edited since the baseline was taken: store the new observation, compare
		// nothing, trigger nothing (unless the edit only APPENDED extract paths — see below), and
		// keep the row out of the canary's verdict — a config edit must never read as a mass change.
		// Before this, every rule edit produced a differently-shaped signature for 100% of matched
		// URLs at once, and the only safe way to make one was a full dry-run cycle. Rows from before
		// fingerprints existed carry none and are compared as usual:
		// the rule that wrote them is the rule in force (a deploy that changed the rule would have
		// reseeded them the old way), and they are stamped on their next quiet probe below, so the
		// NEXT rule edit costs nothing either.
		const ruleChanged =
			Boolean(stored?.signature) &&
			stored.fingerprint !== null &&
			stored.fingerprint !== undefined &&
			stored.fingerprint !== rule.fingerprint;
		// What the stored signature is compared against: the observation itself, except for a
		// baseline taken before paths were appended (below).
		let comparable = observed;
		let extended = false;
		if (ruleChanged) {
			// APPENDED, NOT EDITED. A stored fingerprint that is the one this rule would have had with
			// only its first k extract paths means the edit since was appending the rest: slots 0..k-1
			// are observed exactly as they were, so the baseline is still comparable on them. Compare
			// those slots with the normal semantics — changed triggers, pageCheck overlays, the canary
			// counts the row as compared. Whichever write the outcome takes (the quiet stamp, the
			// dry-run write, the trigger's) stores the FULL observation and this fingerprint, so the
			// row is upgraded; a change whose action fails writes nothing and is compared the same way next pass.
			// Without this, adding one field cost a full pass of blindness on every field the rule
			// already watched. Anything that is not a clean append (or a baseline without the shape
			// the shorter rule writes) re-baselines as before.
			const k = rule.prefixFingerprints?.get(stored.fingerprint);
			const prefix = k === undefined ? null : signatureUnderPrefix(rule, k, stored.signature, observed);
			if (prefix === null) {
				stats.rebaselined++;
				await write(row.url, observed, { rowExists: true, fingerprint: rule.fingerprint });
				return;
			}
			comparable = prefix;
			extended = true;
			stats.extended++;
		}

		// ROUND-TRIP BLINDNESS. Everything below compares the origin to the origin, so a value
		// that changed and changed BACK between two passes is invisible — and a render that landed
		// inside that window left a page carrying the transient value. `pageSignature` is what the
		// cached page claims (written by the render, never here), so this asks the question the
		// signature comparison structurally cannot: does the page still agree with the origin?
		// Runs BEFORE the unchanged early-return, because "unchanged" is exactly the case it
		// exists to catch. Only for extracted responses — a status-signal literal carries no
		// price/availability to project (documented limitation).
		const verificationArmed = await isVerificationArmed(rule);
		const pageCheck = rule.pageCheck;
		const claimPair = pageCheck ? pageCheck.priceFrom !== null && pageCheck.priceFrom !== undefined : false;
		const mappedFields = pageCheck?.fields ?? [];

		// The claim pair's verdict: true compared-and-agreed, false disagreed, null nothing comparable.
		let claimVerdict = null;
		if (claimPair && stored?.pageSignature && valuesOf()) {
			claimVerdict = compareClaims(stored.pageSignature, apiClaimOf(values, pageCheck));
		}
		const pageDisagrees = claimVerdict === false;

		const signatureChanged = Boolean(stored?.signature) && stored.signature !== comparable;

		// THE PAGE RECORD: every mapped field compared against what the cached page claims — the same
		// question as the claim pair above, asked of every field the page visibly states. A
		// disagreement triggers exactly as `pageDisagrees` does; an agreement is what lets a CHANGE be
		// recognised as one the page has already caught up with (below).
		let verdicts = null;
		let facts = null;
		let mappedDisagrees = false;
		let mappedAgreed = 0;
		const armed = (field) => !guard || guard.isArmed(rule, field);
		if (mappedFields.length && stored?.pageFacts && valuesOf()) {
			facts = parsePageFacts(stored.pageFacts);
			if (facts) {
				const ctx = { pageUrl: row.url, vocabulary: pageCheck.vocabulary ?? null };
				verdicts = mappedFields.map((field) => ({
					field,
					verdict: compareField(field, values[field.slot], facts, ctx),
				}));
				// WITNESSED: the page was rendered after the baseline was taken, and the origin still says
				// exactly what it said then — so a correct mapping MUST agree unless the value made a
				// round trip in between. Only these comparisons feed the mapping-defect guard. An
				// appended-path row is excluded: its new slots have no baseline to be unchanged against.
				const witnessed =
					!extended && Boolean(stored.signature) && !signatureChanged && epochOf(stored.pageClaimAt) > stored.probedAt;
				for (const { field, verdict } of verdicts) {
					if (verdict === null) continue;
					if (witnessed) guard?.witness(rule, field, verdict === false);
					if (verdict === false) {
						bump(stats.fieldMismatch, rule.label, field.label);
						if (armed(field)) mappedDisagrees = true;
					} else if (armed(field)) {
						mappedAgreed++;
					}
				}
			}
		}
		if (pageDisagrees || mappedDisagrees) stats.pageMismatch++;

		// WHICH SLOTS CHANGED, and whether the change needs a render at all. Two ways it may not:
		//
		//   IGNORED   every changed slot is in `pageCheck.ignoreChanges` — fields the page cannot show.
		//             Baseline written, nothing triggered, and NOT a change for the canary: a site-wide
		//             edit of an ignored field (a badge, an inventory counter) must not read as a mass
		//             change and invalidate a route.
		//   CAUGHT UP every changed (non-ignored) slot is a mapped slot whose record ALREADY shows the
		//             new value — a cadence render landed after the change. Baseline written, nothing
		//             triggered; still a change for the canary (the rest of the corpus has not caught up).
		//
		// Anything else — an unmapped slot, a slot whose page record is unknown or disagrees, a
		// status-signal literal (a state, not slots) — is a change, exactly as before.
		//
		// A slot is caught up only on positive evidence: at least one ARMED mapped field on it compared,
		// and every armed field on it that compared shows the new value. A disarmed field is suspected of
		// being mapped wrong, so its agreement is no evidence either way.
		let storedValues = null;
		const slotCaughtUp = (slot) => {
			const onSlot = verdicts.filter(({ field, verdict }) => field.slot === slot && verdict !== null && armed(field));
			if (!onSlot.length) return false;
			storedValues ??= signatureSlots(stored.signature) ?? [];
			const ctx = { pageUrl: row.url, vocabulary: pageCheck.vocabulary ?? null };
			return onSlot.every(({ field }) => fieldCaughtUp(field, storedValues[slot], values[slot], facts, ctx));
		};
		let ignoredOnly = false;
		let caughtUp = false;
		// The changed slots that need the page to show them (ignored ones excluded), or null for a
		// status-signal literal — a state, not slots.
		let relevant = null;
		if (signatureChanged) {
			const slots = changedSlots(stored.signature, comparable);
			if (slots === null) {
				bump(stats.slotChanges, rule.label, 'signal');
			} else {
				for (const slot of slots) bump(stats.slotChanges, rule.label, String(slot));
				relevant = slots.filter((slot) => !(pageCheck?.ignoreChanges ?? []).includes(slot));
				if (!relevant.length) ignoredOnly = true;
				else if (verdicts) caughtUp = relevant.every((slot) => slotCaughtUp(slot));
			}
		}

		const needsRender = signatureChanged && !ignoredOnly && !caughtUp;

		// WHAT AN ACTIVE INVALIDATION ALREADY DOES FOR THE PAGE (`coverage`, the sweep only — see
		// `coverageOf`), decided here rather than in the action so a covered row is COUNTED as one: an
		// armed pass that would act asks first, and 'covered' (the invalidation refuses every page, or a
		// verification now serves it on proof) does nothing at all — no baseline, no action, no `changed`,
		// no detection lag, so a long invalidation does not re-report the same URLs as changes every pass —
		// while 'healed' (every page re-rendered after the trip, showing this change) moves the baseline
		// like a caught-up change. HEALED NEEDS EVERY CHANGED SLOT SHOWN: in the claim pair, which agreed,
		// or on an armed mapped field that agreed — an unmapped slot that moved could be a second change
		// after the heal render, which only a re-render resolves (review, round 3).
		const pageAgrees = claimVerdict === true && !mappedDisagrees;
		let coverage = null;
		if (coverageOf && !dryRun && stored?.signature && (needsRender || pageDisagrees || mappedDisagrees)) {
			const pairSlots = claimPair ? [pageCheck.priceFrom, pageCheck.availableFrom] : [];
			const shown = (slot) =>
				pairSlots.includes(slot) ||
				(verdicts ?? []).some(({ field, verdict }) => field.slot === slot && verdict === true && armed(field));
			coverage = await coverageOf(row.url, {
				pageAgrees,
				pageClaimAt: stored.pageClaimAt ?? null,
				probedAt: Number.isFinite(stored.probedAt) ? stored.probedAt : null,
				changeShown: pageAgrees && relevant !== null && relevant.every(shown),
				verify: verificationArmed ? verify : null,
			});
		}
		// Bucket by SIGNATURE outcome alone, BEFORE the page check influences control flow:
		// `probed = seeded + rebaselined + unchanged + changed + failed` is the documented invariant, and the
		// canary's denominator is changed + unchanged — a page-mismatch row that skipped both
		// would silently shrink the mass-change sample right when claims are most likely to be
		// stale. `pageMismatch`, `caughtUp` and `ignored` OVERLAY these buckets; they never replace
		// them. An IGNORED change is bucketed unchanged — for the canary it is not a change.
		// A COVERED change is its own bucket: the partition is `probed = seeded + rebaselined + unchanged +
		// changed + covered + failed`, and the canary (which never covers) keeps its denominator.
		if (coverage === 'covered' && signatureChanged && !ignoredOnly) {
			stats.covered++;
		} else if (signatureChanged && !ignoredOnly) {
			stats.changed++;
			onChange(rule, row);
		} else if (stored?.signature) stats.unchanged++;
		else stats.seeded++;
		if (ignoredOnly) stats.ignored++;
		if (caughtUp) stats.caughtUp++;
		if (coverage === 'covered') return;
		if (coverage === 'healed') {
			stats.caughtUp++;
			stats.healed++;
			await write(row.url, observed, { rowExists: true, fingerprint: rule.fingerprint });
			return;
		}
		if (!needsRender && !pageDisagrees && !mappedDisagrees) {
			if (!stored?.signature) {
				// First observation: baseline it, trigger nothing — the page's content is not known
				// to have changed, the probe just hadn't seen it before.
				await write(row.url, observed, { rowExists: stored !== null, fingerprint: rule.fingerprint });
				return;
			}
			// The new baseline of an ignored or caught-up change; or the one-time stamp of a
			// pre-fingerprint row (see the rule-changed block above), or one-time upgrade of a baseline
			// taken before paths were appended — the full observation replaces the shorter signature, so
			// the next pass compares every slot. One patch per such row, after which a converged corpus
			// is back to paying no write per probe.
			// Not an alternative to the verification below — both are due, neither stands in for the other.
			if (signatureChanged || extended || stored.fingerprint === null || stored.fingerprint === undefined) {
				await write(row.url, observed, { rowExists: true, fingerprint: rule.fingerprint });
			}
			// PROOF that something was compared AND agreed: for a rule with the claim pair, a claim
			// comparison that actually compared a dimension (`claimVerdict === true` — a stored claim
			// alone is not a comparison: an unrecognised availability word beside a null endpoint price
			// compares nothing and used to pass here); else at least one armed mapped field that agreed.
			// A caught-up row is not verified on this pass — its baseline just moved — and is on the next.
			const proof = claimPair ? claimVerdict === true : mappedAgreed > 0;
			if (verificationArmed && proof && !caughtUp && !mappedDisagrees) {
				// PROOF, not absence of news. Both conditions are load-bearing and neither is
				// redundant:
				//
				//   proof                 nothing disagreeing is not an agreement: a URL whose page claim
				//                         is unknown, or whose claim shares no comparable dimension with the
				//                         endpoint's, arrives here with nothing disagreeing — identical, at
				//                         this line, to a real agreement. Without this guard
				//                         we would stamp "verified" on a page nobody ever compared, and
				//                         serve it through an invalidation. That is the one failure this
				//                         feature must never produce.
				//
				//   verificationArmed     the exemption only means anything while an invalidation is
				//                         active for THIS RULE'S scope, and a converged corpus is
				//                         supposed to pay no write per probe (see the ProbeState
				//                         comment). Writing unconditionally would add ~200k writes per
				//                         node per cycle in the steady state to buy nothing.
				//
				// `!mappedDisagrees` is structurally true here (a disagreement leaves this branch), and is
				// stated anyway: no armed mapped field may disagree with a page this certifies.
				//
				// Awaited, not detached: it shares the pass's pacing budget, and a write storm that
				// outruns the probe is exactly what the paced sweep exists to prevent.
				await verify(row.url, stored.pageClaimAt);
			}
			// THE SAME PROOF, recorded as a CHECK (util/pageCheck.js) while serve-time checks are on: the serve
			// path then spares a request for a page the pass just compared, and a restarted pass skips what it
			// already checked since the anchor. Not a verification: it exempts nothing from an invalidation.
			// The observation goes with it: it is the baseline now (written above when it moved), which is what
			// lets a restarted pass skip the row (`checkSparesProbe`).
			if (recordCheck && proof && !caughtUp && !mappedDisagrees)
				await recordCheck(row.url, epochOf(stored.pageClaimAt), { signature: observed });
			return;
		}
		if (dryRun) {
			// Signature written in dry-run ON PURPOSE: each pass then reports fresh changes — the
			// true change rate — instead of re-reporting the same delta forever. Demand-ladder
			// precedent (its dry run persists rung moves for the same reason). The page claim is
			// the opposite case and is deliberately NOT cleared: nothing was expired, so the
			// disagreement still stands — in dry-run `pageMismatch` reads as a standing gauge of
			// disagreeing pages per pass, where armed it is a detection rate.
			await write(row.url, observed, { rowExists: stored !== null, fingerprint: rule.fingerprint });
			return;
		}
		// ACT ON EVERY CHANGE, NOW. No budget and no deferral (util/changeActions.js): a page the probe
		// knows is wrong is expired when it is found, and the render queue orders the re-renders. The
		// BASELINE WRITE GOES WITH THE ACTION, after it succeeds, because that ordering is the whole
		// retry story — an action that fails or never finishes leaves the signature stale.
		await submitTrigger({
			row,
			observed,
			rowExists: stored !== null,
			fingerprint: rule.fingerprint,
			detectedAt: now(),
			// The baseline this was detected against, for the retry's staleness test (`stillDue`).
			page: { probedAt: Number.isFinite(stored?.probedAt) ? stored.probedAt : null },
		});
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
		const probedBefore = stats.probed;
		// A ROW'S STORAGE FAULT IS THAT ROW'S, NOT THE PASS'S. The ProbeState read and the baseline writes
		// throw on a database under pressure (Harper answers 503 "outstanding write transactions" exactly on
		// a reprice night's write wave), and one such throw used to end the whole pass — the rest of the
		// night unprobed, and nothing resumed it. The row is counted (`rowErrors`, in `probe_errors`) and
		// the walk goes on; a baseline that was not read or not written is simply probed again next pass.
		await Promise.all(
			batch.map((item) =>
				processOne(item).catch((e) => {
					stats.rowErrors++;
					if (stats.failureSamples.length < 3) {
						stats.failureSamples.push({
							url: item.row.url,
							rule: item.rule.label,
							error: `storage: ${e?.message ?? String(e)}`,
						});
					}
				})
			)
		);
		// ONLY ROWS THAT MADE A REQUEST ARE PACED. A row skipped as fresh costs a node-local read and no
		// origin call, so charging it a slot of the rate window made a run of skips crawl at
		// `ratePerSecond` for nothing — the pacing exists for the origin, not for the table.
		const requested = stats.probed - probedBefore;
		// Every row up to here has been probed and its action (if any) started: the resume cursor may
		// move past them once their actions settle (see `resumeKeyOf`).
		stats.walkedThrough = batch[batch.length - 1].row.url;
		onBatch(stats);

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
		const ceiling = reserveHeadroom ? Math.max(0.1, ratePerSecond - reserveHeadroom()) : ratePerSecond;
		const { rate, behind } = pacedRate({ ratePerSecond: ceiling, cycleRate });
		if (behind && cycleTarget > 0 && sliceSize > 0) stats.behindBatches++;
		stats.pacedRate = rate;
		onPace(rate, throttle, loadThrottle);

		const elapsed = now() - started;
		batch.length = 0;
		const wait = batchPause({
			batchSize: requested,
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
		// discipline, same cadence as util/reconcile.js's walk. (The heartbeat does NOT ride this —
		// see `startHeartbeat` for why it is a timer.)
		if (stats.examined % YIELD_EVERY === 0) await onYield(stats);
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
		// AFTER the rule match, so `outOfScope` counts only rows that would otherwise have cost a probe,
		// and BEFORE `matched`, so the canary cohort and the continuous-mode slice size (both built from
		// matched rows) describe what is actually probed.
		if (inScope && !inScope(row)) {
			stats.outOfScope++;
			continue;
		}
		stats.matched++;
		collectCohort?.(rule, row.url);
		batch.push({ row, rule });
		if (batch.length >= Math.max(1, concurrency)) await flush();
	}
	await flush();

	// Where each mapped field's guard stands after this pass (cumulative for the process, not the
	// pass): how close a mapping is to being disarmed, and which ones are. Only for rules that map.
	if (guard && rules.some((rule) => rule.pageCheck?.fields?.length)) stats.fieldGuard = guard.snapshot(rules);

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
const walkTargets = (chunkSize, onUnreadable, startAt = '') =>
	walkUrlRange(targetTable(), { startAt, select: TARGET_SELECT, chunkSize, onUnreadable });

/**
 * Where a resumed pass must start: the last fully-probed row, held back to the lowest URL whose action
 * is still in flight — a crash between probing a row and finishing its action leaves that row's
 * baseline stale, and a resume that started past it would skip it until the next day's pass. The
 * start is INCLUSIVE, so at most the last batch and the in-flight rows are probed twice. URLs compare
 * as strings, which is the walk's order for the ASCII keys URLs are.
 */
const resumeKeyOf = (walkedThrough, lowestInFlight) => {
	if (lowestInFlight !== null && lowestInFlight !== undefined) {
		return walkedThrough === null || walkedThrough === undefined || lowestInFlight < walkedThrough
			? lowestInFlight
			: walkedThrough;
	}
	return walkedThrough ?? null;
};

/** The canary cohort, re-read fresh: membership is remembered, rows are not. */
async function* readCohortRows(urls) {
	for (const url of urls) {
		const row = await targetTable().get({ id: url, select: TARGET_SELECT });
		if (row) yield row;
	}
}

/**
 * Before an after-walk retry (util/changeActions.js): does the detection still stand? Not when the
 * baseline has moved since (another pass, the canary or the render check wrote one — acting now would
 * write the walk's older observation over it), nor when a page of the URL was rendered after the change
 * was found (expiring it would throw away a render that may well show the change; the next probe
 * decides). A read that fails says "yes": the retry then fails or succeeds on its own terms.
 */
const detectionStillCurrent = async (item) => {
	try {
		const current = await readSignature(item.row.url);
		const probedNow = Number.isFinite(current?.probedAt) ? current.probedAt : null;
		if (probedNow !== (item.page?.probedAt ?? null)) return false;
		const pages = await Promise.all(
			cacheKeysOf(item.row.url).map((cacheKey) => pageTable().get({ id: cacheKey, select: ['cacheKey', 'lastCached'] }))
		);
		return !pages.some((page) => dateColumnMs(page?.lastCached) > item.detectedAt);
	} catch {
		return true;
	}
};

// One log line per failed action: the first attempt, and the after-walk retry (util/changeActions.js).
const logActionError = (e, item, { retry = false } = {}) =>
	logger.error(
		e,
		retry
			? `[prerender] change-probe action retry failed for ${item.row.url} — left for the next probe of it`
			: `[prerender] change-probe action failed for ${item.row.url} (retried once when the walk ends)`
	);

// Metric emission must never cost the pass or the trip action its outcome.
const countProbe = (series, detail = null, value = 1, context = null) => {
	try {
		metrics.changeProbe(value, series, detail, context);
	} catch (e) {
		logger.warn(`[prerender] change-probe ${series} not recorded: ${e?.message ?? String(e)}`);
	}
};

/**
 * DETECTION LAG, as two upper bounds per detected change — there is no per-URL record of when the probe
 * last saw a URL UNCHANGED (an unchanged probe writes nothing, by design), so the true lag cannot be
 * measured, only bounded:
 *
 *   `pass`           now minus the start of the pass that found it — for an anchored pass, the ANCHOR
 *                    instant it serves (it may start later: chained, or caught up), so for a change that
 *                    landed at the origin's scheduled time this is the lag itself.
 *   `previous_pass`  now minus the start of the pass before it. That pass observed the URL at some point
 *                    after its start, so if it covered the URL, the change happened after this — a true
 *                    upper bound, not an estimate.
 *
 * `probe_detection_lag`, detail = the bound, context = the rule label, value = ms: read its percentiles.
 */
const detectionLagEmitter =
	({ passStart, previousStart }) =>
	(rule) => {
		const now = Date.now();
		if (Number.isFinite(passStart) && now >= passStart)
			countProbe('detection_lag', 'pass', now - passStart, rule.label);
		if (Number.isFinite(previousStart) && now >= previousStart) {
			countProbe('detection_lag', 'previous_pass', now - previousStart, rule.label);
		}
	};

/**
 * A pass's counters as `probe_*` series, emitted AS THE PASS GOES: each call sends what each counter
 * gained since the previous call, and a counter that gained nothing sends nothing.
 *
 * WHY NOT ONCE, AT THE END. That was the shape until v0.97.0, and it made a nine-hour pass ONE
 * analytics row per series: recorded whole or lost whole (Harper 5.2 aggregates two thirds of every
 * 90s and drops the rest, so a single row lands in a dropped window about a third of the time), lost
 * entirely when the pass threw or a restart cut it short (the emit sat after the walk), and — read over
 * a window that truncated the pass — attributed to whichever window the pass happened to END in. Per
 * batch, a pass's counts spread over its whole duration like every per-request series, so ratios
 * against those stay unbiased, and a crashed pass has already reported everything up to its last batch.
 * `total` is the meaningful number; `count` is emits, not passes.
 */
const PASS_SERIES = [
	['probed', 'probed'],
	['seeded', 'seeded'],
	['rebaselined', 'rebaselined'],
	['changed', 'changed'],
	['triggered', 'triggered'],
	['errors', 'errors'],
	['failed', 'failed'],
	['fresh', 'fresh'],
	['throttled', 'throttled'],
	['pageMismatch', 'page_mismatch'],
	['caughtUp', 'caught_up'],
	['covered', 'covered'],
	['ignored', 'ignored'],
	['behindBatches', 'cycle_behind'],
];

export const createPassEmitter = (kind, emit = (value, series) => metrics.changeProbe(value, series)) => {
	const sent = {};
	return (counts) => {
		try {
			for (const [key, series] of PASS_SERIES) {
				const value = counts?.[key];
				if (!Number.isFinite(value)) continue;
				const delta = value - (sent[key] ?? 0);
				if (delta <= 0) continue;
				sent[key] = value;
				emit(delta, series);
			}
		} catch (e) {
			logger.warn(`[prerender] change-probe ${kind} metrics not recorded: ${e?.message ?? String(e)}`);
		}
	};
};

const logPass = (stats, kind, dryRun) => {
	const line = { kind, dryRun, ...stats };
	if (stats.rowErrors > 0) {
		logger.warn(
			`[prerender] change-probe ${kind}: ${stats.rowErrors} rows skipped on a ProbeState read or write that ` +
				`threw (samples in the pass record); they are probed again next pass`
		);
	}
	// A scope that keeps less than it skips is either a site whose corpus really is mostly unlisted (and
	// then `scope: listed` is the wrong setting for it) or sitemaps that stopped listing what they used
	// to. Neither should be discovered from the origin-request savings looking good.
	if (stats.outOfScope > stats.matched) {
		logger.warn(
			`[prerender] change-probe ${kind}: changeProbe.scope left ${stats.outOfScope} rule-matched targets ` +
				`unprobed and probed only ${stats.matched} — most of the watched corpus is not in any sitemap. ` +
				`Check the sitemap walks (sitemap_removed, the departure tally) before trusting this scope.`
		);
	}
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
const claimPass = async (
	kind,
	{
		startedBy = null,
		dryRun = null,
		label = null,
		reseed = false,
		originStartedAt = null,
		anchorAt = null,
		cursor = null,
	} = {}
) => {
	const row = await readProbeState();
	if (isPassRunning(row, kind, PASS_STALE_MS)) {
		return {
			ok: false,
			reason: `a probe ${kind} is already running on this node`,
			lastRun: row?.[kind]?.lastRun ?? null,
		};
	}
	const startedAt = Date.now();
	const previous = row?.[kind]?.lastRun ?? null;
	// Claim first, keeping the previous result readable while the new pass runs — the backlog
	// snapshotter's shape, for the same reason: an operator looking mid-pass should see the last
	// finished one, not a hole.
	//
	// WHAT THE PASS IS, published with the claim, so a reader can tell THIS pass from the one in
	// `lastRun` without guessing from timestamps: who started it (an operator's manual dry run and the
	// scheduled pass look identical otherwise), whether it acts, and the slice it is expected to cover
	// — the denominator an ETA needs. `progress: null` so a claim never inherits the previous pass's
	// last heartbeat reading (the merge is one level deep; omission would keep it).
	await publishProbeState({
		[kind]: {
			running: true,
			startedAt,
			heartbeatAt: startedAt,
			lastRun: previous,
			// A RESUME's cursor is seeded here, not left for the first heartbeat (30s on): a process that dies
			// inside that window would otherwise leave a claim with no cursor, and the next boot's resume
			// would start the walk over from the top.
			progress: cursor ? { cursor } : null,
			startedBy,
			dryRun,
			label,
			// What a resume needs to continue THIS pass as it was: its reseed semantics, and the start of
			// the pass it belongs to (itself, or the one a resume is continuing) — see `checkResume`.
			reseed,
			originStartedAt: originStartedAt ?? startedAt,
			// The anchor instant an anchored pass serves (it can start later: chained behind another pass,
			// or caught up at boot) — kept so a resume serves the same one. Null for every other pass.
			anchorAt,
			// A request to stand down is addressed to the pass that holds the claim NOW, so a new claim
			// starts with none (see `requestSweepInterrupt`).
			interruptRequestedAt: null,
			interruptRequestedBy: null,
			interruptForAnchorAt: null,
			sliceEstimate: kind === 'sweep' ? sliceEstimateFrom(previous) : null,
		},
	});
	return { ok: true, startedAt, previous };
};

/**
 * How many rows a new sweep is expected to probe: the slice this process measured on its last
 * completed pass, else the previous pass's own `matched` if that pass ran to completion (a restart
 * clears the module figure, and the row outlives the restart). Null when neither is trustworthy —
 * an aborted or errored pass walked only part of the key range, and an ETA computed from its
 * `matched` would promise an early finish that never comes.
 */
const sliceEstimateFrom = (previous) => {
	if (Number.isFinite(measuredSliceSize)) return measuredSliceSize;
	if (!previous || previous.aborted || previous.error) return null;
	return Number.isFinite(previous.matched) ? previous.matched : null;
};

/**
 * Keep a pass's heartbeat alive ON A TIMER for as long as the pass runs: `onTick` fires every third of
 * a heartbeat interval (the heartbeat itself throttles to one write per interval) until the returned
 * stop function is called, and never after.
 *
 * WHY A TIMER, NOT THE WALK. The heartbeat used to ride the walk's yields — one every 200 rows
 * examined — and a pass can sit inside ONE await for longer than the claim's staleness window: an
 * origin's `Retry-After` (honoured up to 5 minutes, which IS `PASS_STALE_MS`), a long wait for an
 * action slot while the database is slow, a slow chunk read. The claim then read as dead while the pass
 * was alive, and the console's "Run sweep" (or a resume check) started a second full-rate pass beside
 * it — the origin taking `ratePerSecond` twice over, the one number agreed with whoever runs it. A timer
 * beats through all of those. Unref'd, so it never holds a process open, and the caller stops it before
 * releasing the claim: a beat after the release would publish `running: true` over a finished pass.
 */
const startHeartbeat = (onTick) => {
	const timer = setInterval(() => void onTick(), HEARTBEAT_MS / 3);
	timer.unref?.();
	return () => clearInterval(timer);
};

/**
 * The running pass's partial counters, as the heartbeat publishes them.
 *
 * WHY THE HEARTBEAT CARRIES THEM. Before this, a sweep in flight published only `examinedApprox` —
 * rows walked — so for the ~9 hours an anchored pass runs, every NUMBER on the admin surface was
 * the PREVIOUS pass's, sitting next to `running: true`. That is the confusion this exists to end:
 * the console could not show the current pass at all, so it showed the last one, and an operator
 * once read a pre-deploy pass's failures as the new release's. A few dozen integers every 30s on a
 * node-local row is the whole cost.
 *
 * Counters only: the per-slot and per-field maps stay on the finished pass record, where they are
 * complete.
 */
const PROGRESS_COUNTERS = [
	'examined',
	'owned',
	'matched',
	'outOfScope',
	'probed',
	'seeded',
	'rebaselined',
	'extended',
	'unchanged',
	'changed',
	'caughtUp',
	'ignored',
	'pageMismatch',
	'failed',
	'throttled',
	'fresh',
	'behindBatches',
];

const passProgress = (live, extra) => ({
	...Object.fromEntries(PROGRESS_COUNTERS.map((key) => [key, Number.isFinite(live?.[key]) ? live[key] : 0])),
	throttleLevel: live?.throttleLevel ?? 1,
	loadThrottleLevel: live?.loadThrottleLevel ?? 1,
	pacedRate: live?.pacedRate ?? null,
	...extra,
});

/**
 * Release the claim and publish the finished record.
 *
 * `progress: null` is EXPLICIT because the merge is one level deep and omission means "leave
 * alone" — without it a finished pass would carry the last mid-pass progress reading forever.
 */
const releasePass = async (kind, startedAt, lastRun, extra = {}) => {
	await publishProbeState({
		[kind]: { running: false, startedAt, heartbeatAt: Date.now(), lastRun, progress: null, ...extra },
	});
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
	// `progress` may be a function of the heartbeat's instant, so a caller can hand over a snapshot
	// builder that runs only when a beat is actually due — not on every one of the thousands of
	// yields a pass makes between two beats.
	return async (progress) => {
		const now = Date.now();
		if (now - last < HEARTBEAT_MS) return;
		last = now;
		const value = typeof progress === 'function' ? progress(now) : progress;
		await publishProbeState({ [kind]: { running: true, startedAt, heartbeatAt: now, progress: value ?? null } });
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
const isAnchored = () => config.changeProbe.mode === 'anchored';
// The armed-sweep marker for anchored mode carries the anchor itself, so editing the time or the
// zone reads as a mode change to `syncProbeTimers` (which compares markers) and re-arms the timer.
const anchorKey = () => `anchored:${config.changeProbe.anchorTime}|${config.changeProbe.anchorTimezone}`;

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
	concurrency: config.changeProbe.concurrency,
	ratePerSecond: config.changeProbe.ratePerSecond,
	// While serve-time checks are armed the pass runs below the ceiling by what they are using
	// (`outOfPassHeadroom`, re-read every batch), so its published headroom covers them and demand is
	// checked during the pass, not after.
	reserveHeadroom: serveChecksArmed() ? outOfPassHeadroom : null,
	backoffMax: config.changeProbe.backoffMax,
	abortAfterDistress: config.changeProbe.abortAfterDistress,
	// Continuous pacing, or zeroes — and zeroes are what make interval mode bit-identical: with
	// no cycle target `cycleRatePerSecond` is never consulted and the window is the one
	// `ratePerSecond` has always implied.
	// Continuous paces to its cycle; an anchored pass paces to its window (0 = the ceiling, the
	// default: a daily pass exists to finish, not to spread); an interval pass is never paced.
	cycleTarget: !paced
		? 0
		: isContinuous()
			? config.changeProbe.cycleTarget
			: isAnchored()
				? config.changeProbe.anchorWindow
				: 0,
	// The denominator the cycle target is honoured against. Anchored mode needs it as much as
	// continuous does: without it `cycleRatePerSecond` has nothing to divide and returns Infinity,
	// so `anchorWindow` would be read, reported, and then silently ignored — the pass would burst at
	// the ceiling however the window was set, and `probe_cycle_behind` (which also requires a slice)
	// would stay quiet about it. `measuredSliceSize` is maintained after every completed pass
	// regardless of mode, so the first anchored pass paces at the ceiling and measures, and every
	// pass after it honours the window.
	sliceSize: paced && (isContinuous() || isAnchored()) ? (measuredSliceSize ?? 0) : 0,
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
 *
 * `startedBy` says what started the pass — 'anchor', 'interval', 'continuous', 'startup',
 * 'manual' (the admin POST), 'reseed' (a canary trip's chained pass) or 'resume' (boot, finishing a
 * pass a restart cut short) — and rides on both the claim and the finished record, so an operator's
 * manual dry run can never be read as the scheduled pass it looks exactly like.
 *
 * `resume` (a resume) is `{ cursor, originStartedAt }`: the walk starts at the interrupted pass's
 * cursor, and the pass records the start of the pass it continues.
 */
export const runProbeSweepOnce = async ({
	dryRun,
	label = null,
	reseed = false,
	startedBy = null,
	resume = null,
	anchorAt = null,
} = {}) => {
	// Worker-local guard, and it is SET SYNCHRONOUSLY on purpose. The node-wide claim below is an
	// await, so setting the flag after it would leave a window in which two concurrent calls on
	// this worker both pass this check before either marks itself running — a re-entrancy race
	// that the local flag exists precisely to prevent, and which a test caught.
	if (sweepRunning) return { skipped: true, reason: 'a probe sweep is already running', lastRun: lastSweep };
	sweepRunning = true;

	// Then the NODE-WIDE claim. The local flag alone was the whole guard, which meant a manual run
	// on any worker but 0 could not see the scheduled sweep and started a second one at full rate
	// against the origin. See util/probeState.js.
	// The limits are read BEFORE the claim (they are pure config) so the claim can say whether this
	// pass acts or only measures.
	const limits = passLimits(dryRun, { paced: true });
	const passStartedBy = startedBy ?? (reseed ? 'reseed' : null);
	const claim = await claimPass('sweep', {
		startedBy: passStartedBy,
		dryRun: limits.dryRun,
		label,
		reseed,
		originStartedAt: resume?.originStartedAt ?? null,
		anchorAt,
		cursor: resume?.cursor ?? null,
	});
	if (!claim.ok) {
		// Release the local flag we optimistically took — the `finally` below is not reached from
		// here, so failing to reset it would wedge this worker's sweep for the life of the process.
		sweepRunning = false;
		return { skipped: true, reason: claim.reason, lastRun: claim.lastRun ?? lastSweep };
	}
	const startedAt = claim.startedAt;
	// The start of the pass this one belongs to: itself, or the one a resume continues.
	const passOrigin = resume?.originStartedAt ?? startedAt;
	const beat = makeHeartbeat('sweep', startedAt);
	// The pass's live counters and its action pipeline, held OUTSIDE the try so the error path can still
	// emit what the pass did before it threw (see `createPassEmitter`).
	let live = null;
	let triggers = null;
	let phase = 'walking';
	let stopHeartbeat = () => {};
	// Stands down when an anchored pass asks it to (see `requestSweepInterrupt`) if its work is a subset of
	// what that pass will do: a dry run acts on nothing; a reseed probes every matched URL and acts on what
	// changed, as the anchored pass does; and a pass serving an OLDER anchor (a catch-up, or a pass that
	// outran its day) has nothing left to do that the newer one will not. Any other pass is never
	// interrupted; the anchor waits for it.
	let interruptedBy = null;
	const checkInterrupt = async () => {
		if (interruptedBy !== null) return;
		const pass = (await readProbeState())?.sweep;
		const at = epochMsOf(pass?.interruptRequestedAt);
		if (!(Number.isFinite(at) && at >= startedAt)) return;
		const forAnchor = epochMsOf(pass.interruptForAnchorAt);
		const subsumed =
			limits.dryRun === true ||
			reseed === true ||
			(anchorAt !== null && Number.isFinite(forAnchor) && forAnchor > anchorAt);
		if (subsumed) interruptedBy = pass.interruptRequestedBy ?? 'request';
	};
	const emit = createPassEmitter('sweep');
	const detectionLag = detectionLagEmitter({
		passStart: anchorAt ?? resume?.originStartedAt ?? startedAt,
		previousStart: epochMsOf(claim.previous?.resumedFrom ?? claim.previous?.startedAt),
	});
	const counts = () => ({
		...live,
		triggered: triggers?.stats.triggered ?? 0,
		errors: (triggers?.stats.errors ?? 0) + (live?.rowErrors ?? 0),
	});
	try {
		const rules = probeRules();
		const count = Math.max(1, config.changeProbe.canary.count | 0);
		const collectors = new Map(rules.map((rule) => [rule.label, cohortCollector(count)]));
		let unreadable = 0;
		// Changes are acted on BESIDE the walk, not inside it: `submit` returns once the action has
		// started, so the pass runs at its probe-rate floor whatever the change rate, and only waits
		// when every action slot is busy — see util/changeActions.js. The demand union is loaded first,
		// so the first changes of the pass are not stamped as unknown for want of it.
		await warmDemand();
		// EVERY sweep acts on a change only where an active invalidation does not already cover its pages
		// (`coverageOf`) — the reseed a trip chains, and just as much the anchored pass that interrupts that
		// reseed, or any pass that runs while the scope is invalidated. The canary is the exception (it
		// acts on its cohort and baselines it, or it would re-detect, and re-trip on, the same change).
		const epochFor = epochResolver();
		triggers = createChangeActions({
			act: actOnChange,
			write: writeSignature,
			concurrency: config.changeProbe.trigger.concurrency,
			onError: logActionError,
			stillDue: detectionStillCurrent,
		});
		// The heartbeat's payload, built only when a beat is due (see makeHeartbeat). `recentRate` is
		// probes per second since the PREVIOUS beat — the rate the pass is running at now, which an
		// average from the start of a nine-hour pass cannot show (a backoff an hour ago drags it down
		// long after it cleared). `examinedApprox` stays for consoles that predate the counters.
		let lastBeat = { at: startedAt, probed: 0 };
		const progressOf = (live, phase) => (now) => {
			const seconds = (now - lastBeat.at) / 1000;
			const probed = Number.isFinite(live?.probed) ? live.probed : 0;
			const recentRate = seconds > 0 ? Math.round(((probed - lastBeat.probed) / seconds) * 100) / 100 : null;
			lastBeat = { at: now, probed };
			return {
				examinedApprox: Number.isFinite(live?.examined) ? live.examined : 0,
				// Where each mapped field's guard stands NOW, for the checks on every other worker
				// (`disarmedFieldsOnNode`): a field disarmed mid-pass stops being compared within a beat, not
				// when the pass ends — or never, for a pass that dies.
				...(rules.some((rule) => rule.pageCheck?.fields?.length)
					? { fieldGuard: theMappingGuard().snapshot(rules) }
					: {}),
				...passProgress(live, {
					phase,
					recentRate,
					triggered: triggers.stats.triggered,
					errors: triggers.stats.errors,
					actionsInFlight: triggers.inFlight,
					actionWaitMs: triggers.stats.waitMs,
					// Where a resume would start if this process died now (inclusive).
					cursor: resumeKeyOf(live?.walkedThrough ?? null, triggers.lowestInFlight),
					unreadable,
				}),
			};
		};
		// The liveness signal for the node-wide claim, for the WHOLE pass — walk, drain and retries (see
		// `startHeartbeat`). Its failure is swallowed by `publishProbeState`: a pass must never die of
		// bookkeeping.
		stopHeartbeat = startHeartbeat(async () => {
			await beat(progressOf(live, phase));
			await checkInterrupt();
		});
		const stats = await runProbePass({
			rows: walkTargets(
				config.changeProbe.chunkSize,
				() => {
					unreadable++;
					countProbe('unreadable');
				},
				resume?.cursor ?? ''
			),
			rules,
			ownerOf: getResidencyByUrl,
			hostname: server.hostname,
			probe: probeOnce,
			read: readSignature,
			write: writeSignature,
			submitTrigger: triggers.submit,
			verify: writeVerification,
			isArmed: verificationArmedFor,
			// Serve-time checks: the pass records its own agreeing comparisons (dry run included — they are
			// observations), and, once the checks are armed, skips what was checked since this pass began.
			readCheck: config.changeProbe.serveCheck?.enabled ? readPageCheck : null,
			skipCheckedSince: serveChecksArmed() ? (resume?.originStartedAt ?? startedAt) : null,
			recordCheck: config.changeProbe.serveCheck?.enabled ? writePageCheck : null,
			// One observer per pass, counting adoptions by the pass's origin (a resume shares its cap), and
			// filing nothing when THIS pass is a dry run — an operator's measure-only sweep included.
			onCanonical: entitiesOn() ? createCanonicalObserver({ probeDryRun: limits.dryRun, passId: passOrigin }) : null,
			guard: theMappingGuard(),
			...limits,
			// Rows this pass (or the pass it resumes) already probed — see `processOne`. The same for a
			// reseed: a row it re-baselined before a restart cut it short is re-baselined already.
			skipProbedSince: resume?.originStartedAt ?? startedAt,
			// A pending reseed cancels too: the pass that must stand down for it is this one. So does an
			// anchored pass's request, when this is a dry run or a reseed.
			isCanceled: () => !config.changeProbe.enabled || sweepInterrupt !== null || interruptedBy !== null,
			collectCohort: (rule, url) => collectors.get(rule.label).add(url),
			inScope: probeScopeFilter(config.changeProbe),
			onStart: (running) => (live = running),
			onBatch: () => emit(counts()),
			onChange: detectionLag,
			coverageOf: (url, evidence) => coverageOf(url, evidence, epochFor),
			onPace: (rate, originThrottle, loadThrottle) =>
				publishSweepHeadroom(
					Math.max(0, config.changeProbe.ratePerSecond - rate) / Math.max(1, originThrottle * loadThrottle)
				),
		});
		// A cancelled pass starts nothing more; what is in flight finishes. Either way wait for the
		// actions in flight — the pass is not finished while pages it decided to expire are unexpired,
		// and `triggered` would under-report. There are at most `trigger.concurrency` of them.
		if (stats.aborted) triggers.stop();
		phase = 'draining';
		await triggers.drain();
		// The actions that failed, once more (util/changeActions.js) — the cursor has moved past them, so
		// otherwise each is a known-wrong page until the next pass. Not when the probe was switched off.
		if (config.changeProbe.enabled) {
			phase = 'retrying';
			await triggers.retryFailed();
		}
		stats.triggered = triggers.stats.triggered;
		stats.retryStale = triggers.stats.retryStale;
		stats.errors = triggers.stats.errors;
		stats.retried = triggers.stats.retried;
		stats.recovered = triggers.stats.recovered;
		stats.retrySkipped = triggers.stats.retrySkipped;
		// Changes this pass detected and did not act on: the next probe of each URL finds it again.
		stats.unacted = triggers.stats.errors - triggers.stats.recovered;
		stats.maxActionsInFlight = triggers.stats.maxInFlight;
		stats.actionWaitMs = triggers.stats.waitMs;
		stats.unreadable = unreadable;
		// A RESUMED pass walked only the tail of the key range, so like an aborted one it keeps the old
		// cohorts and publishes no slice size: its `matched` is a fraction of the slice.
		const partialWalk = stats.aborted || resume !== null;
		// An interrupted pass keeps the OLD cohorts — a partial walk's sample covers only the key
		// range it reached, and the chained reseed rebuilds them properly.
		if (!partialWalk) cohorts = new Map(rules.map((rule) => [rule.label, collectors.get(rule.label).list()]));
		// Publish the denominator for the NEXT cycle's pacing, from completed passes only. A pass
		// that aborted (cancelled, or the distress breaker) covered part of the key range, so its
		// `matched` is a fraction — pacing the next cycle against it would derive a rate for a
		// corpus several times smaller than the real one and coast through the budget having
		// covered a slice of it.
		if (!partialWalk) measuredSliceSize = stats.matched;
		// The slice estimate and the cohorts both moved; republish so a reader sees what the NEXT
		// cycle will pace against rather than the previous cycle's denominator.
		// AWAITED, unlike the config-path publishes: `releasePass` below is a read-modify-write of the
		// same row, and letting the two interleave could write back the scheduler branch it read
		// before this landed.
		if (!partialWalk) await publishScheduler();
		emit(counts());
		logPass(stats, 'sweep', limits.dryRun);
		lastSweep = {
			...stats,
			dryRun: limits.dryRun,
			startedBy: passStartedBy,
			resumedFrom: resume?.originStartedAt ?? null,
			resumeCursor: resume?.cursor ?? null,
			anchorAt,
			interruptedBy,
			label,
			node: server.hostname,
			startedAt,
			finishedAt: Date.now(),
			error: null,
		};
		stopHeartbeat();
		// WHAT THIS PASS SERVED, in fields no other kind of pass overwrites: the origin of the last pass
		// that ran to completion, armed and dry apart. `lastRun` is the last pass that ENDED, whatever it
		// was — a console dry run after the anchored pass replaced it, and the boot check then read the
		// night as unserved and ran a whole catch-up pass (review, round 2). See `anchorServedSince`.
		const served = stats.aborted
			? {}
			: limits.dryRun
				? { completedDryOrigin: passOrigin }
				: { completedArmedOrigin: passOrigin };
		await releasePass('sweep', startedAt, lastSweep, served);
		return lastSweep;
	} catch (e) {
		// What the pass did before it threw is real work the origin saw; report it.
		if (live) emit(counts());
		lastSweep = {
			node: server.hostname,
			startedAt,
			finishedAt: Date.now(),
			startedBy: passStartedBy,
			dryRun: limits.dryRun,
			error: e?.message ?? String(e),
			// Enough to RESUME it: an anchored pass that throws is picked up from here (`runAnchoredPass`),
			// and a thrown pass never counts as having served its anchor (`anchorServedSince`).
			resumedFrom: resume?.originStartedAt ?? null,
			anchorAt,
			reseed,
			cursor: live
				? resumeKeyOf(live.walkedThrough ?? null, triggers?.lowestInFlight ?? null)
				: (resume?.cursor ?? null),
		};
		// A THROWN pass must release too, and must publish the error: leaving the claim held would
		// wedge the probe until the heartbeat went stale, and dropping the error would make a
		// crashed pass indistinguishable from one that never ran.
		stopHeartbeat();
		await releasePass('sweep', startedAt, lastSweep);
		throw e;
	} finally {
		stopHeartbeat();
		sweepRunning = false;
		try {
			publishSweepHeadroom(null);
		} catch {
			// A coordination buffer that cannot be reached: the re-probes' pace ages the last value out.
		}
		// The trip's reseed, chained after this pass stood down for it. Cleared BEFORE the chained
		// pass starts so the reseed does not cancel itself.
		const chained = sweepInterrupt;
		sweepInterrupt = null;
		if (chained) {
			void runSweepResilient({ dryRun: chained.dryRun, label: chained.label, reseed: true, startedBy: 'reseed' });
		}
	}
};

// The reseed waiting for the running sweep to stand down (`{ label, dryRun }`), or null. See
// `requestSweepReseed` — a plain "skip if running" here was the wrong shape, because a canary
// trip lands DURING a sweep in exactly the scenario the canary exists for.
let sweepInterrupt = null;

/**
 * Run a signature RESEED sweep as soon as possible: immediately when no sweep is running, otherwise by
 * interrupting the running pass — which notices via its cancellation check within a batch — and
 * chaining the reseed when it exits. A reseed probes EVERY matched URL (a mass change has just been
 * absorbed, so every baseline is known-stale) and re-baselines what changed.
 *
 * ARMED, EXCEPT WHERE THE INVALIDATION ALREADY COVERS THE PAGE (v0.97.0; it was a dry run before). The
 * trip invalidated the scope, but the epoch only refuses pages rendered BEFORE it — so a page
 * re-rendered after the trip that then changed, and a page-claim mismatch on one, were baselined by the
 * dry-run reseed and never expired: known-wrong pages served for the rest of the night, and the
 * baseline no longer disagreed, so the next pass did not act either. The reseed now acts on a change as
 * any pass does — expire, file the render — unless every page of the URL predates the epoch and no
 * verification exempts it (`isCoveredByInvalidation`). Those it baselines without acting, which keeps
 * what the dry run was for: clearing a FALSE trip's invalidation still restores serving for exactly
 * those pages, and a per-URL expiry does not pile the whole scope ahead of the accelerator's
 * demand-driven heals. `dryRun` is the tripping canary's: a trip only acts on an armed canary pass.
 */
export const requestSweepReseed = (label, { dryRun = false } = {}) => {
	if (sweepRunning) {
		sweepInterrupt = { label, dryRun };
		logger.warn(`[prerender] change-probe: interrupting the running sweep to reseed (${label})`);
		return { chained: true };
	}
	void runSweepResilient({ dryRun, label, reseed: true, startedBy: 'reseed' });
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
	// The sweep's selection, so a bootstrap cohort samples what the sweep probes.
	const inScope = probeScopeFilter(config.changeProbe);
	for await (const row of walkTargets(config.changeProbe.chunkSize, () => countProbe('unreadable'))) {
		if (!config.changeProbe.enabled) break;
		if (getResidencyByUrl(row.url) !== server.hostname) continue;
		if (row.state === 'suppressed' || !isCanaryCandidate(row.url)) continue;
		if (inScope && !inScope(row)) continue;
		const match = rules.find((rule) => buildProbeRequest(rule, row.url));
		if (!match) continue;
		const cohort = next.get(match.label);
		if (cohort.length < count) cohort.push(row.url);
		if ([...next.values()].every((urls) => urls.length >= count)) break;
	}
	cohorts = next;
	// The cohort sizes are published scheduler state, and until now only arming and a finished sweep
	// republished them — so after every restart the admin surface read `cohortSizes: {}` (the sizes at
	// boot, before this build ran) for the hours until the first sweep ended, while the canary was
	// probing a full cohort. Measured on a live deployment: every node reported `{}` beside a canary
	// pass over 500 URLs.
	await publishScheduler();
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
const actOnTrip = async (rule, fraction, { dryRun = false } = {}) => {
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
	// A mass change makes the whole stored diff stale, so re-baseline NOW rather than waiting out the
	// next pass — as a RESEED, which acts only where the invalidation does not cover (see
	// `requestSweepReseed`).
	const { chained } = requestSweepReseed(`reseed after invalidating ${scope}`, { dryRun });
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
export const runProbeCanaryOnce = async ({ dryRun, startedBy = null } = {}) => {
	if (canaryRunning) {
		return { skipped: true, reason: 'a canary pass is already running' };
	}
	// Synchronous, for the re-entrancy reason documented on the sweep above.
	canaryRunning = true;
	const limits = passLimits(dryRun);
	const claim = await claimPass('canary', { startedBy, dryRun: limits.dryRun });
	if (!claim.ok) {
		canaryRunning = false;
		return { skipped: true, reason: claim.reason, lastRun: claim.lastRun ?? lastCanary };
	}
	const startedAt = claim.startedAt;
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
			await warmDemand();
			const canaryTriggers = createChangeActions({
				act: actOnChange,
				write: writeSignature,
				concurrency: config.changeProbe.trigger.concurrency,
				onError: logActionError,
				stillDue: detectionStillCurrent,
			});
			const emit = createPassEmitter('canary');
			let canaryLive = null;
			const canaryCounts = () => ({
				...canaryLive,
				triggered: canaryTriggers.stats.triggered,
				errors: canaryTriggers.stats.errors + (canaryLive?.rowErrors ?? 0),
			});
			const stats = await runProbePass({
				rows: readCohortRows(urls),
				rules: [rule],
				// Membership was owner-filtered when the cohort was built; ownership is stable for a
				// URL, so re-hashing every member per pass buys nothing.
				ownershipChecked: true,
				probe: probeOnce,
				read: readSignature,
				write: writeSignature,
				// The same pipeline as the sweep: every change acted on as it is found.
				submitTrigger: canaryTriggers.submit,
				// The SAME guard as the sweep, reading AND witnessing: the canary re-probes its cohort
				// every few minutes, so a broken mapping would otherwise re-render the whole cohort on
				// every canary pass until the (possibly daily) sweep got round to disarming it. Repeat
				// witnesses of one cohort do not skew the rate — they repeat its agreements and its
				// disagreements alike.
				guard: theMappingGuard(),
				...limits,
				// NEVER skips. The cohort is small and re-probed on a deliberately fast cadence, and a
				// skip here would silence the mass-change detector between sweeps — the one thing it
				// exists for.
				skipProbedSince: null,
				isCanceled: () => !config.changeProbe.enabled,
				// Re-checked per pass, not only when the cohort was built: a member whose grace ran out
				// since then is skipped (and counted) exactly as the sweep would skip it.
				inScope: probeScopeFilter(config.changeProbe),
				onStart: (running) => (canaryLive = running),
				onBatch: () => emit(canaryCounts()),
				// The canary's requests count against the node's budget like the sweep's, so it publishes the
				// headroom it leaves too — otherwise out-of-pass requests take the whole ceiling beside it. A
				// sweep running on this worker publishes already, and its number stands.
				onPace: (rate, originThrottle, loadThrottle) => {
					if (sweepRunning) return;
					publishSweepHeadroom(
						Math.max(0, config.changeProbe.ratePerSecond - rate) / Math.max(1, originThrottle * loadThrottle)
					);
				},
			});
			if (!sweepRunning) publishSweepHeadroom(null);
			await canaryTriggers.drain();
			if (config.changeProbe.enabled) await canaryTriggers.retryFailed();
			stats.triggered = canaryTriggers.stats.triggered;
			stats.errors = canaryTriggers.stats.errors;
			stats.retried = canaryTriggers.stats.retried;
			stats.recovered = canaryTriggers.stats.recovered;
			stats.unacted = canaryTriggers.stats.errors - canaryTriggers.stats.recovered;
			emit(canaryCounts());
			const verdict = canaryVerdict(stats, { threshold: canary.threshold, minSample: canary.minSample });
			let action = null;
			if (verdict.tripped) {
				countProbe('canary_trip');
				action = limits.dryRun
					? { acted: false, reason: 'dry-run' }
					: await actOnTrip(rule, verdict.fraction, { dryRun: limits.dryRun });
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
			startedBy,
			node: server.hostname,
			startedAt,
			finishedAt: Date.now(),
			error: null,
		};
		await releasePass('canary', startedAt, lastCanary);
		return lastCanary;
	} catch (e) {
		lastCanary = {
			node: server.hostname,
			startedAt,
			finishedAt: Date.now(),
			startedBy,
			dryRun: limits.dryRun,
			error: e?.message ?? String(e),
		};
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
 * The shape version of `changeProbeStatus`. 1 is everything before plugin v0.91.0 (no field says so);
 * 2 added the running pass (`current` + counters in `progress`), `nextRunAt`, `settings`, rule
 * fingerprints and `serverTime`. The console reads it to tell a field this plugin does not report
 * from a field that is zero — a blank rendered as 0 is how a missing signal reads as a healthy one.
 */
const STATUS_VERSION = 2;

/** Epoch ms from a row timestamp (number, Date or ISO string), or null. */
const msOrNull = (value) => {
	const ms = epochMsOf(value);
	return Number.isFinite(ms) ? ms : null;
};

/**
 * The pass the row CLAIMS is running, or null — including one whose heartbeat has stopped.
 *
 * `running` (beside this) is the claim filtered by heartbeat staleness, which is right for the run
 * guard and wrong for an operator: a pass whose worker died reads `running: false` exactly like an
 * idle node, beside a `lastRun` that is hours old. `stale: true` here is what separates "stalled"
 * from "idle".
 */
const currentPass = (row, kind) => {
	const pass = row?.[kind];
	if (!pass?.running) return null;
	return {
		startedAt: msOrNull(pass.startedAt),
		heartbeatAt: msOrNull(pass.heartbeatAt ?? pass.startedAt),
		stale: !isPassRunning(row, kind, PASS_STALE_MS),
		startedBy: pass.startedBy ?? null,
		dryRun: typeof pass.dryRun === 'boolean' ? pass.dryRun : null,
		label: pass.label ?? null,
		...(kind === 'sweep'
			? {
					reseed: pass.reseed === true,
					// the start of the pass this one continues — equal to `startedAt` unless it is a resume
					originStartedAt: msOrNull(pass.originStartedAt ?? pass.startedAt),
					phase: pass.progress?.phase ?? 'walking',
					sliceEstimate: Number.isFinite(pass.sliceEstimate) ? pass.sliceEstimate : null,
				}
			: {}),
	};
};

/** The first tick of a `setInterval` armed at `armedAt` that is still ahead of `now`. */
const nextTick = (armedAt, every, now) => armedAt + Math.max(1, Math.ceil((now - armedAt) / every)) * every;

/**
 * When the next scheduled sweep starts, and why then — read from what the scheduler PUBLISHED, so
 * every worker gives worker 0's answer.
 *
 * The basis follows what is ARMED (the published marker), not this worker's config: the two differ
 * only for the instant between a config apply and worker 0 re-arming, and in that instant the armed
 * driver is the one that will actually fire.
 *
 *   startup     a first arming's boot sweep is still pending (interval and continuous modes)
 *   anchor      the next anchored run; null `at` means the anchor could not be computed — broken
 *               `anchorTime`/`anchorTimezone`, which the plugin log names
 *   continuous  no gap to schedule: the next cycle starts when the running one ends
 *   interval    the next tick of the sweep timer (a tick that lands mid-pass is skipped)
 */
const nextSweepRun = (scheduler, now) => {
	const armed = scheduler?.armedSweep ?? null;
	if (!config.changeProbe.enabled || armed === null) return { at: null, basis: null };
	const bootAt = msOrNull(scheduler.bootAt);
	if (bootAt !== null && bootAt > now) return { at: bootAt, basis: 'startup' };
	if (typeof armed === 'string' && armed.startsWith('anchored:')) {
		return { at: msOrNull(scheduler.nextAnchorAt), basis: 'anchor' };
	}
	if (armed === 'continuous') return { at: null, basis: 'continuous' };
	const armedAt = msOrNull(scheduler.intervalArmedAt);
	const every = Number(armed);
	if (armedAt === null || !(every > 0)) return { at: null, basis: 'interval' };
	return { at: nextTick(armedAt, every, now), basis: 'interval' };
};

/** A rule as the admin surface reports it. */
const ruleStatus = (rule) => ({
	label: rule.label,
	pathPattern: rule.patternSource,
	source: rule.source,
	invalidateScope: rule.invalidateScope,
	// Only when present, so a rule without them reads exactly as it did.
	...(rule.pageCheck?.fields?.length
		? {
				// A scoped field says where it compares, or "never compares on these pages" reads as a bug.
				pageFields: rule.pageCheck.fields.map(
					(field) => `${field.label}:${field.compare}${field.pathPattern ? ` (only ${field.pathPattern.source})` : ''}`
				),
			}
		: {}),
	...(rule.pageCheck?.ignoreChanges?.length ? { ignoreChanges: rule.pageCheck.ignoreChanges } : {}),
	// WHAT MAKES TWO NODES' RULES THE SAME RULE. The console used to compare the objects above across
	// nodes, which cannot see an edited extract path or header — exactly the edits that re-baseline a
	// corpus. The fingerprint is what the probe itself compares a baseline against.
	fingerprint: rule.fingerprint,
	// The slot index -> path table `slotChanges` and `fieldMismatch` are keyed by, so a count can be
	// read as a field rather than as a number.
	extract: Array.isArray(rule.extract) ? rule.extract : [],
	// The probed endpoint's method and PATH — the host and query are config, and the full template
	// (headers included) is on the config endpoint. Null for `source: document`, which fetches the page.
	endpoint: rule.request?.urlTemplate
		? { method: rule.request.method, path: URL.parse(rule.request.urlTemplate)?.pathname ?? null }
		: null,
});

/** The settings that decide when and how fast the probe runs — config, identical on every worker. */
const probeSettings = () => {
	const c = config.changeProbe;
	return {
		mode: c.mode,
		anchorTime: c.anchorTime,
		anchorTimezone: c.anchorTimezone,
		anchorWindow: c.anchorWindow,
		sweepInterval: c.sweepInterval,
		cycleTarget: c.cycleTarget,
		ratePerSecond: c.ratePerSecond,
		concurrency: c.concurrency,
		scope: c.scope,
		abortAfterDistress: c.abortAfterDistress,
		backoffMax: c.backoffMax,
		trigger: {
			concurrency: c.trigger.concurrency,
		},
		canary: {
			interval: c.canary.interval,
			schedule: canarySchedule().map(scheduleWindowStatus),
			count: c.canary.count,
			threshold: c.canary.threshold,
			minSample: c.canary.minSample,
		},
	};
};

/**
 * What this NODE's probe is doing — readable from any worker.
 *
 * Everything scheduler- or pass-shaped comes from the shared row rather than module state, for
 * the reason util/probeState.js documents: the scheduler arms on worker 0 and this endpoint is
 * served by all sixteen, so module state made the answer a coin flip that reported a healthy
 * probe as switched off ~95% of the time. `nextAnchoredRunAt` was the last field still read from
 * module state — so it was null on every worker but 0, which is why it read null on all four nodes
 * of a live deployment right after arming (#176) — and it is now published like the rest.
 *
 * `enabled`, `dryRun`, `rules`, `mode`, `settings` and the `load` SETTINGS stay config-derived on
 * purpose — config is identical on every worker, so reading them locally is correct and costs no
 * round trip. `load.monitor` is the exception inside that block: it is the histogram's own
 * liveness, which only exists on the worker that armed it, so it is published like the rest.
 *
 * CHEAP BY CONSTRUCTION: one node-local row read and config reads. The console polls this.
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
	// The NODE's clock, so a reader computes ages and ETAs against the clock that wrote the
	// timestamps rather than against its own.
	const now = Date.now();
	const nextSweep = nextSweepRun(scheduler, now);
	const canaryArmedAt = msOrNull(scheduler?.canaryArmedAt);
	const canaryEvery = Number(scheduler?.armedCanary);

	return {
		statusVersion: STATUS_VERSION,
		serverTime: now,
		enabled: config.changeProbe.enabled,
		dryRun: config.changeProbe.dryRun,
		node: server.hostname,
		workerIndex: server.workerIndex ?? null,
		ownerScopeNote: 'Probes only the URLs this node owns; every node sweeps its own slice.',
		rules: probeRules().map(ruleStatus),
		mode: config.changeProbe.mode,
		settings: probeSettings(),
		// What "alive" means for a running pass, so a reader need not hard-code it: a healthy pass
		// touches the row about every `intervalMs`, and one silent for `staleAfterMs` is presumed dead.
		heartbeat: { intervalMs: HEARTBEAT_MS, staleAfterMs: PASS_STALE_MS },
		// False only when the row could not be read at all. Distinguishes "the probe has not run
		// here" from "this answer is not trustworthy", which the old shape could not express.
		stateAvailable: row !== null,
		stateUpdatedAt: row?.updatedAt ?? null,
		sweep: {
			running: isPassRunning(row, 'sweep', PASS_STALE_MS),
			// The pass in flight, apart from `lastRun` — which is the last pass that ENDED and stays
			// the previous one for the whole of a running pass.
			current: currentPass(row, 'sweep'),
			lastRun: sweep?.lastRun ?? null,
			// The running pass's own partial counters (plugin v0.91.0; before it, only
			// `examinedApprox`). Null when no pass holds the row.
			progress: sweep?.running ? (sweep.progress ?? null) : null,
			// In continuous mode this reads 'continuous' rather than a number: there is no gap
			// between passes to arm, and reporting a stale `sweepInterval` here would describe a
			// schedule that is not running.
			armedInterval: scheduler?.armedSweep ?? null,
			// What continuous pacing is working against. `sliceSize: null` means no completed cycle
			// has measured it yet, which is precisely when the pass runs at the ceiling — worth
			// being able to see, because "at the ceiling" otherwise looks identical to "behind".
			cycleTarget: isContinuous() ? config.changeProbe.cycleTarget : null,
			nextAnchoredRunAt:
				isAnchored() && msOrNull(scheduler?.nextAnchorAt) !== null
					? new Date(msOrNull(scheduler.nextAnchorAt)).toISOString()
					: null,
			nextRunAt: nextSweep.at,
			nextRunBasis: nextSweep.basis,
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
			current: currentPass(row, 'canary'),
			lastRun: canary?.lastRun ?? null,
			armedInterval: scheduler?.armedCanary ?? null,
			// The time-of-day schedule, when one is set (`canary.schedule`); null = the fixed interval.
			schedule: scheduler?.armedCanarySchedule ? canarySchedule().map(scheduleWindowStatus) : null,
			nextRunAt: !config.changeProbe.enabled
				? null
				: scheduler?.armedCanarySchedule
					? msOrNull(scheduler.nextCanaryAt)
					: canaryArmedAt !== null && canaryEvery > 0
						? nextTick(canaryArmedAt, canaryEvery, now)
						: null,
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
// The armed canary SCHEDULE's identity (windows + timezone), or null when the fixed interval runs.
let armedCanarySchedule = null;
// When a scheduled canary fires next — published, because a chain of timeouts has no `armedAt + k*every`.
let nextCanaryAt = null;
// When each driver was armed, so ANY worker can say when it fires next: the timers themselves live
// on worker 0, and a timer cannot be asked for its next tick.
let bootAt = null;
let intervalArmedAt = null;
let canaryArmedAt = null;

/**
 * Publish the scheduler's own view: what is armed and when each driver fires next, the cohort
 * sizes, the measured slice, and the lag monitor's liveness. Every other worker reads the result.
 *
 * ONLY THE SCHEDULER'S WORKER PUBLISHES. A pass can run on any worker — the admin POST starts one
 * wherever the request landed — and that worker's module state has nothing armed, so its publish
 * wrote `armedSweep: null` over worker 0's: after one manual sweep the admin surface reported the
 * probe as not armed until worker 0 next republished, which in anchored mode is a day later.
 *
 * CALL IT AFTER THE STATE CHANGES, never before (#176): the snapshot is taken at the call, so a
 * publish ahead of the arming it describes reports the previous arming.
 *
 * Returns the publish's promise. Config-path callers `void` it; a pass awaits it before its own
 * write of the row.
 */
const publishScheduler = () => {
	if (!schedulerStarted) return Promise.resolve(false);
	// The ARGUMENT is built synchronously, so a throw while building it escapes before there is a
	// promise to reject — and the config-path call sites use `void`, which would turn that into an
	// unhandled exception on the config-apply path. Nothing in here should throw today; the guard is
	// what keeps `publishProbeState`'s "observability can never fail a pass" promise true of the
	// whole call rather than only of its async half.
	try {
		return publishProbeState({
			scheduler: {
				armedSweep,
				armedCanary,
				armedCanarySchedule,
				nextCanaryAt,
				nextAnchorAt,
				bootAt,
				intervalArmedAt,
				canaryArmedAt,
				sliceSize: measuredSliceSize,
				cohortSizes: Object.fromEntries([...cohorts].map(([label, urls]) => [label, urls.length])),
				loadMonitor: loopLagMonitorState(),
			},
		});
	} catch (e) {
		logger.warn(`[prerender] could not publish change-probe scheduler state: ${e?.message ?? String(e)}`);
		return Promise.resolve(false);
	}
};

const clearProbeTimers = () => {
	if (bootTimer) clearTimeout(bootTimer);
	if (sweepTimer) clearInterval(sweepTimer);
	if (canaryTimer) clearInterval(canaryTimer);
	if (anchorTimer) clearTimeout(anchorTimer);
	if (resumeTimer) clearTimeout(resumeTimer);
	bootTimer = sweepTimer = canaryTimer = anchorTimer = resumeTimer = null;
	nextAnchorAt = bootAt = intervalArmedAt = canaryArmedAt = nextCanaryAt = null;
	timerGeneration++;
	stopContinuousLoop();
};

/**
 * ANCHORED MODE's driver: one pass a day, starting at `anchorTime` in `anchorTimezone`, then
 * re-armed for the next occurrence once the pass has finished.
 *
 * This is the mode for an origin whose content moves on a schedule — a retailer whose prices
 * change only at its own midnight, say. Continuous mode would spread the same probes evenly
 * over 24h and so notice a midnight change anywhere from minutes to a day later; anchored mode
 * starts the pass right after the change and (at the default window of 0, the rate ceiling)
 * finishes it as fast as the agreed ceiling allows, so the corpus is current for the day by the
 * time the pass ends. The canary keeps its own cadence in this mode, so a change that lands OFF
 * the schedule is still caught as a mass change; only the full walk is anchored.
 *
 * The re-arm is computed AFTER the pass, against the clock: a pass that outran the day (longer
 * than 24h at the ceiling) simply lands on the next anchor and skips none by accident, and a
 * DST shift is absorbed by `getNextTimeOfDay` recomputing the offset at the target instant.
 * `getNextTimeOfDay` is never more than a day out, so the delay fits setTimeout's signed 32-bit
 * range without the clamp `sweepInterval` needs.
 */
let anchorTimer = null;
let nextAnchorAt = null;

/**
 * RESUMING A PASS A RESTART CUT SHORT. Anchored mode runs nothing until the next anchor, so a
 * restart mid-pass (a deploy, a crash) used to leave the rest of the corpus unprobed for up to a
 * day — every change there served as it was until the next morning's pass. So the first arming
 * after boot looks at this node's claim: a sweep that was `running` and has stopped heart-beating
 * belonged to a process that is gone, and a pass is started FROM ITS CURSOR (the heartbeat publishes
 * where the walk had got to, held back to any action still in flight — `resumeKeyOf`), with the
 * interrupted pass's own dry-run and reseed semantics, recording the pass it continues. One that
 * still beats may be a manual run on another worker, or simply not aged out yet since the restart, so
 * it is looked at again once it would have. A pass (or a chain of resumes) that started before the most
 * recent anchor, or more than a day ago, is not resumed: that anchor's pass is due instead, and the same
 * check catches it up (see `checkResume`).
 */
const RESUME_WITHIN_MS = DAY;
let resumeTimer = null;
// Set when the scheduler boots in anchored mode and cleared once `checkResume` has decided, so a
// config apply that re-arms the timers in the meantime re-arms the check instead of dropping it.
let resumePending = false;

const armResumeCheck = (delay = null) => {
	if (resumeTimer) clearTimeout(resumeTimer);
	const stagger = fnv1a32(server.hostname) % Math.max(1, config.changeProbe.startJitter | 0);
	resumeTimer = setTimeout(
		() => {
			resumeTimer = null;
			checkResume().catch((e) => logger.error(e));
		},
		delay ?? config.changeProbe.startDelay + stagger
	);
	resumeTimer.unref?.();
};

/**
 * Has a pass that SERVES the anchor started on this node at or after `since` and run to completion? What
 * serves it is a pass matching the configured mode: an armed pass when the probe is armed; a dry run too
 * when the probe is configured dry (commissioning) — otherwise every restart of a dry-run deployment ran
 * a whole catch-up pass. A pass that threw or was cut short did not serve it (a restart at least runs it
 * again). A pass's start is its ORIGIN, because a resume walks only the tail of a pass whose head may
 * predate `since`.
 *
 * The evidence is `completedArmedOrigin` / `completedDryOrigin`, which only a completed pass of that
 * kind writes (`runProbeSweepOnce`): a console dry run after the anchored pass no longer hides it. A row
 * from before those fields existed falls back to the last pass that ended — so on the FIRST boot after the
 * upgrade, a node whose last pre-upgrade pass was a console dry run catches the night up once even though
 * its anchored pass ran (review, round 3: accepted; the fields exist from then on).
 */
const anchorServedSince = (sweep, since) => {
	const armed = epochMsOf(sweep?.completedArmedOrigin);
	const dry = epochMsOf(sweep?.completedDryOrigin);
	const dryServes = config.changeProbe.dryRun === true;
	if (Number.isFinite(armed) || Number.isFinite(dry)) return armed >= since || (dryServes && dry >= since);
	const last = sweep?.lastRun;
	if (!last || last.error || last.aborted) return false;
	if (last.dryRun === true && !dryServes) return false;
	return epochMsOf(last.resumedFrom ?? last.startedAt) >= since;
};

/**
 * The boot-time decision for anchored mode: resume the pass a restart cut short, or CATCH UP the pass a
 * restart made this node miss, or neither.
 *
 * CATCHING UP. The anchor timer only ever looks forward (`nextAnchorOccurrence`), so a process that was
 * down when its anchor came — a deploy at 00:03 for a 00:05 anchor, a crash overnight — used to skip
 * that night's pass entirely, and nothing said so: the next pass was the following night, and every
 * page the reprice moved served its old price for a day. Now, if no pass that serves the anchor has
 * completed since the most recent one (`anchorServedSince`), that anchor's pass is started
 * (`probe_anchor` outcome `caught_up`). It serves an older anchor than the next one, so it stands down
 * if it is still running when the next anchor fires.
 *
 * WHICH WINS. A stale claim that belongs to the current anchor period (its origin is at or after the
 * most recent anchor) is today's pass: it is resumed from its cursor. A dry run or a reseed is not
 * resumed when a catch-up is due — the anchored pass would interrupt it the moment it started. One
 * whose origin predates the most recent anchor is yesterday's pass: finishing its tail would leave the
 * head unprobed since before the anchor, so the catch-up runs a whole pass instead.
 */
const checkResume = async () => {
	const decided = (result) => {
		resumePending = false;
		return result;
	};
	if (!schedulerStarted || !config.changeProbe.enabled || !isAnchored())
		return decided({ resumed: false, reason: 'not armed' });
	const row = await readProbeState();
	const sweep = row?.sweep;
	const lastAnchor = previousAnchorOccurrence();
	const catchUpDue = Number.isFinite(lastAnchor) && !anchorServedSince(sweep, lastAnchor);
	const startedAt = epochMsOf(sweep?.startedAt);
	let reason = 'nothing interrupted';
	if (sweep?.running && Number.isFinite(startedAt)) {
		if (isPassRunning(row, 'sweep', PASS_STALE_MS)) {
			armResumeCheck(PASS_STALE_MS);
			return { resumed: false, reason: 'claim still live' };
		}
		// An unusable origin falls back to this claim's own start (validated above): `NaN` would pass the age
		// test below as "recent" and then throw formatting the log line, silently cancelling the resume.
		const recordedOrigin = epochMsOf(sweep.originStartedAt);
		const originStartedAt = Number.isFinite(recordedOrigin) ? recordedOrigin : startedAt;
		const interruptible =
			sweep.dryRun === true ||
			sweep.reseed === true ||
			sweep.startedBy === 'reseed' ||
			(Number.isFinite(epochMsOf(sweep.anchorAt)) && epochMsOf(sweep.anchorAt) < lastAnchor);
		if (!(Date.now() - originStartedAt < RESUME_WITHIN_MS)) reason = 'older than a day';
		else if (Number.isFinite(lastAnchor) && originStartedAt < lastAnchor) reason = 'predates the last anchor';
		else if (catchUpDue && interruptible) reason = 'a dry run or reseed, and the anchored pass is due';
		else {
			const cursor = typeof sweep.progress?.cursor === 'string' ? sweep.progress.cursor : '';
			logger.warn(
				`[prerender] change-probe: resuming the sweep a restart interrupted (started ${new Date(originStartedAt).toISOString()}) ` +
					`from ${cursor ? JSON.stringify(cursor) : 'the start (no cursor was published)'}`
			);
			const anchorAt = epochMsOf(sweep.anchorAt);
			void runSweepResilient({
				startedBy: 'resume',
				resume: { cursor, originStartedAt },
				reseed: sweep.reseed === true || sweep.startedBy === 'reseed',
				// The interrupted pass's own mode — a manual dry run must not resume armed, nor the reverse.
				dryRun: typeof sweep.dryRun === 'boolean' ? sweep.dryRun : undefined,
				label: sweep.label ?? null,
				anchorAt: Number.isFinite(anchorAt) ? anchorAt : null,
			});
			return decided({ resumed: true, from: originStartedAt, cursor });
		}
	}
	if (catchUpDue) {
		logger.warn(
			`[prerender] change-probe: no pass has run since the ${new Date(lastAnchor).toISOString()} anchor (the ` +
				`process was down when it came) — running that anchor's pass now`
		);
		void runAnchoredPass(lastAnchor, { outcome: 'caught_up' });
		return decided({ resumed: false, reason, caughtUp: true, anchorAt: lastAnchor });
	}
	return decided({ resumed: false, reason });
};

/**
 * The next occurrence of the anchor, strictly in the future, or NaN when it cannot be computed.
 *
 * A NEXT RUN MUST BE IN THE FUTURE. On the spring-forward day the anchor's wall-clock time can be
 * one that never occurs — 02:30 where 02:00 jumps to 03:00 — and `getNextTimeOfDay` resolves it to
 * an instant that has already passed. Left alone that fires the pass an hour early and, worse, the
 * re-arm at the end of the pass computes the same past instant again: the whole corpus is walked
 * back to back at the ceiling rate until the hour is over. Pushing a stale anchor on by a day lands
 * on the next real occurrence, because the offset is applied to the resolved instant rather than to
 * the wall clock.
 */
const nextAnchorOccurrence = () => {
	let at;
	try {
		at = getNextTimeOfDay(config.changeProbe.anchorTime, config.changeProbe.anchorTimezone);
	} catch (e) {
		logger.warn(
			`[prerender] change-probe: anchorTimezone "${config.changeProbe.anchorTimezone}" is not usable (${e?.message ?? String(e)})`
		);
		return NaN;
	}
	if (!Number.isFinite(at)) return NaN;
	return at <= Date.now() ? at + DAY : at;
};

/** Minutes past local midnight of `ms` in `timezone` (DST-correct: Intl resolves the offset at `ms`). */
const localFormatters = new Map();
export const localMinutesOf = (ms, timezone) => {
	let format = localFormatters.get(timezone);
	if (!format) {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		});
		localFormatters.set(timezone, format);
	}
	let hours = 0;
	let minutes = 0;
	for (const part of format.formatToParts(new Date(ms))) {
		if (part.type === 'hour') hours = Number(part.value);
		else if (part.type === 'minute') minutes = Number(part.value);
	}
	return hours * 60 + minutes;
};

/** "HH:MM" as minutes past midnight, the way `getNextTimeOfDay` reads it (unparseable parts are 0). */
export const minutesOfTimeOfDay = (timeStr) => {
	const [h, m] = String(timeStr).split(':');
	const hours = Number.parseInt(h, 10);
	const minutes = Number.parseInt(m ?? '0', 10);
	return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
};

/**
 * The most recent occurrence of the anchor at or before now, or NaN when it cannot be computed.
 *
 * The day before the next one, CORRECTED FOR A DST SHIFT between them: `next - 24h` lands an hour off
 * the anchor's wall-clock time when a transition falls in between, so the difference between the
 * anchor's minutes and the candidate's local minutes (as Intl resolves them at that instant) is
 * applied. An anchor that does not exist that day (inside the spring-forward hour) resolves within
 * the hour, which is all a "did a pass start since" test needs.
 */
const previousAnchorOccurrence = () => {
	const next = nextAnchorOccurrence();
	if (!Number.isFinite(next)) return NaN;
	let at = next - DAY;
	try {
		let delta =
			minutesOfTimeOfDay(config.changeProbe.anchorTime) - localMinutesOf(at, config.changeProbe.anchorTimezone);
		if (delta > 720) delta -= 1440;
		if (delta < -720) delta += 1440;
		at += delta * MINUTE;
	} catch {
		return NaN;
	}
	return at <= Date.now() ? at : at - DAY;
};

/**
 * Ask whatever sweep holds this node's claim to stand down — honoured only by a dry run or a reseed
 * (the passes an anchored pass subsumes), within one heartbeat tick, on whichever worker it runs.
 * Addressed through the claim row because the pass may be on another worker (a console-started dry
 * run), where no module state reaches it; a new claim clears it (`claimPass`).
 */
export const requestSweepInterrupt = (by, forAnchorAt = null) =>
	publishProbeState({
		sweep: { interruptRequestedAt: Date.now(), interruptRequestedBy: by, interruptForAnchorAt: forAnchorAt },
	});

// How often an anchored pass that is waiting for another sweep tries again.
const ANCHOR_RETRY_MS = 15 * SECOND;
// Bumped by every re-arm, so an anchor that fired knows whether re-arming after its pass is still its job.
let timerGeneration = 0;

/**
 * Run the anchored pass for the anchor at `anchorAt` — now if the sweep is free, otherwise as soon as it
 * is. Resolves when the pass has run, or when the wait was abandoned. Never rejects.
 *
 * AN ANCHOR IS NEVER SILENTLY LOST. It used to await `runProbeSweepOnce`, which returns `{ skipped }`
 * whenever any sweep is running on the node — a reseed after a canary trip, a manual pass from the
 * console, a resume — and the timer re-armed for TOMORROW with no log line and no metric: the pass the
 * whole mode exists for simply did not happen that night. Now:
 *
 *   - a dry run or a reseed is asked to stand down (`requestSweepInterrupt`), and the anchored pass
 *     takes the sweep as soon as it has — outcome `interrupted`. A dry run acts on nothing, and a
 *     reseed's work (every matched URL probed, what changed acted on) is what the anchored pass does.
 *   - any other pass (it ACTS, and is not the anchored pass's to cut short) is left to finish, and the
 *     anchored pass runs after it — outcome `chained`.
 *   - an anchor that comes round while this wait is still going (the other pass outran a whole day) is
 *     served by the same pass, and the one it replaces is counted `skipped`.
 *   - a re-arm (a mode or anchor edit, a disable) abandons the wait — counted `skipped` too.
 *
 * Every anchor is one `probe_anchor` emit, detail = outcome; `on_time` is the plain case and
 * `caught_up` the boot catch-up (`checkResume`).
 */
const runAnchoredPass = async (anchorAt, { outcome = 'on_time' } = {}) => {
	// The schedule this pass belongs to. A re-arm that keeps it (a canary edit, say) leaves the wait
	// alone; one that changes the anchor, the mode, or disables the probe abandons it.
	const key = anchorKey();
	let served = anchorAt;
	let result = outcome;
	let asked = false;
	let waitedFor = null;
	// A pass that THREW is picked up from its cursor, a bounded number of times (`ANCHOR_RESUMES`): one
	// storage fault on a reprice night must not cost the rest of the night.
	let resume = null;
	let resumes = 0;
	for (;;) {
		if (!schedulerStarted || !config.changeProbe.enabled || !isAnchored() || armedSweep !== key) {
			countProbe('anchor', 'skipped');
			logger.warn(
				`[prerender] change-probe: the anchored pass for ${new Date(served).toISOString()} was abandoned — the ` +
					`schedule changed while it waited`
			);
			return null;
		}
		let pass;
		try {
			// Attempt only when the claim looks free: every attempt briefly holds this worker's re-entrancy
			// flag, and a reseed requested inside that instant would be parked for a pass that never starts.
			pass =
				sweepRunning || (await isPassRunningOnNode('sweep'))
					? { skipped: true }
					: await runProbeSweepOnce(
							resume ? { startedBy: 'resume', resume, anchorAt: served } : { startedBy: 'anchor', anchorAt: served }
						);
		} catch (e) {
			logger.error(e);
			const failed = (await readProbeState())?.sweep?.lastRun;
			if (resumes < ANCHOR_RESUMES && failed?.error) {
				resumes++;
				resume = {
					cursor: typeof failed.cursor === 'string' ? failed.cursor : '',
					originStartedAt: epochMsOf(failed.resumedFrom ?? failed.startedAt),
				};
				logger.warn(
					`[prerender] change-probe: the anchored pass for ${new Date(served).toISOString()} threw (${e?.message ?? e}) — ` +
						`resuming it from ${resume.cursor ? JSON.stringify(resume.cursor) : 'the start'} in ` +
						`${ANCHOR_RESUME_DELAY_MS / 1000}s (attempt ${resumes} of ${ANCHOR_RESUMES})`
				);
				await waitUnref(ANCHOR_RESUME_DELAY_MS);
				continue;
			}
			countProbe('anchor', result);
			return null;
		}
		if (!pass?.skipped) {
			countProbe('anchor', result);
			if (result !== 'on_time') {
				logger.warn(
					`[prerender] change-probe: the anchored pass for ${new Date(served).toISOString()} ran ` +
						(result === 'caught_up' ? 'as a catch-up' : `after ${waitedFor ?? 'another sweep'} (${result})`)
				);
			}
			return pass;
		}
		const holder = (await readProbeState())?.sweep;
		const holderAnchor = epochMsOf(holder?.anchorAt);
		// What `checkInterrupt` in the holder will honour: a dry run, a reseed, or a pass for an older anchor.
		const interruptible =
			holder?.dryRun === true || holder?.reseed === true || (Number.isFinite(holderAnchor) && holderAnchor < served);
		waitedFor = holder?.startedBy ? `a ${holder.dryRun ? 'dry-run ' : ''}${holder.startedBy} pass` : waitedFor;
		if (interruptible) {
			if (!asked) {
				asked = true;
				if (result === 'on_time') result = 'interrupted';
				logger.warn(
					`[prerender] change-probe: the anchor found ${waitedFor ?? 'a pass it subsumes'} running — asking it to stand down`
				);
			}
			// RE-ASSERTED ON EVERY TRY, not once: the request is one field of a row every worker rewrites whole
			// (`publishProbeState` is a read-modify-write serialized only per worker), so the holder's own
			// heartbeat, landing between our read and write, can erase it.
			await requestSweepInterrupt('anchor', served);
		} else if (result === 'on_time') {
			result = 'chained';
			logger.warn(
				`[prerender] change-probe: the anchor found ${waitedFor ?? 'a sweep'} running — its pass runs when that one ends`
			);
		}
		// A LATER anchor while this one waits: one pass serves both, and the older is the one skipped.
		const latest = previousAnchorOccurrence();
		if (Number.isFinite(latest) && latest > served) {
			countProbe('anchor', 'skipped');
			served = latest;
		}
		await waitUnref(ANCHOR_RETRY_MS);
	}
};

// How often, and how soon, a thrown pass is resumed before it is given up on.
const ANCHOR_RESUMES = 3;
const ANCHOR_RESUME_DELAY_MS = MINUTE;

/**
 * Run a detached sweep — the reseed a trip chains, the boot resume — and, if it THROWS, resume it from the
 * cursor its error record carries, up to `ANCHOR_RESUMES` times, `ANCHOR_RESUME_DELAY_MS` apart: the same
 * bounded recovery `runAnchoredPass` gives the anchored pass, so one storage fault does not cost the rest
 * of the slice. Never rejects; resolves with the last attempt's record, or null once it gives up.
 */
const runSweepResilient = async (options) => {
	let run = options;
	for (let attempt = 0; ; attempt++) {
		try {
			return await runProbeSweepOnce(run);
		} catch (e) {
			logger.error(e);
			const failed = (await readProbeState())?.sweep?.lastRun;
			if (attempt >= ANCHOR_RESUMES || !failed?.error || !config.changeProbe.enabled) return null;
			const resume = {
				cursor: typeof failed.cursor === 'string' ? failed.cursor : '',
				originStartedAt: epochMsOf(failed.resumedFrom ?? failed.startedAt),
			};
			logger.warn(
				`[prerender] change-probe: a ${options.startedBy ?? 'detached'} pass threw (${e?.message ?? e}) — resuming it ` +
					`from ${resume.cursor ? JSON.stringify(resume.cursor) : 'the start'} in ${ANCHOR_RESUME_DELAY_MS / 1000}s ` +
					`(attempt ${attempt + 1} of ${ANCHOR_RESUMES})`
			);
			await waitUnref(ANCHOR_RESUME_DELAY_MS);
			run = { ...options, startedBy: 'resume', resume };
		}
	}
};

// A wait that never holds the process open (the global timer, which is also what tests can drive).
const waitUnref = (ms) =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});

const armAnchorTimer = () => {
	if (anchorTimer) clearTimeout(anchorTimer);
	anchorTimer = null;
	const at = nextAnchorOccurrence();
	// An unusable anchor arms NOTHING. `setTimeout(fn, NaN)` fires at once, which would turn a typo
	// in the timezone into a full-rate pass on every config apply; a warning and a null
	// `nextAnchoredRunAt` on the admin surface is the failure mode that gets noticed and fixed — so
	// the null is PUBLISHED, and since #176 null means only this.
	if (!Number.isFinite(at)) {
		nextAnchorAt = null;
		logger.warn(
			`[prerender] change-probe: anchored mode has no next run — fix anchorTime/anchorTimezone (the canary keeps running)`
		);
		void publishScheduler();
		return;
	}
	nextAnchorAt = at;
	anchorTimer = setTimeout(
		async () => {
			anchorTimer = null;
			// While this pass runs, the next run is the FOLLOWING occurrence — the one the re-arm below
			// lands on if the pass ends before it. Publishing it now, rather than leaving the fired
			// instant or a null up for the nine hours a pass takes, is what lets a reader see a pass
			// that is on course to overrun its next anchor (and so skip it) before it does.
			const upcoming = nextAnchorOccurrence();
			nextAnchorAt = Number.isFinite(upcoming) ? upcoming : null;
			// Awaited so the scheduler write lands before the pass claims the row.
			await publishScheduler();
			const generation = timerGeneration;
			await runAnchoredPass(at);
			// Config is re-read here rather than captured: this is the boundary a live change acts on. A
			// mode or anchor edit while the pass ran (or waited) has already re-armed through
			// syncProbeTimers — the generation moved — and that arming stands.
			if (generation === timerGeneration && config.changeProbe.enabled && isAnchored() && armedSweep === anchorKey()) {
				armAnchorTimer();
			}
		},
		Math.max(0, at - Date.now())
	);
	anchorTimer.unref?.();
	// EVERY (re-)arm publishes — the first arm, an edit, and the re-arm after each pass. Publishing
	// only from the paths that happened to call it is how the published anchor went stale (#176).
	void publishScheduler();
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
			const result = await runProbeSweepOnce({ startedBy: 'continuous' });
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

/**
 * THE CANARY'S TIME-OF-DAY SCHEDULE (`changeProbe.canary.schedule`) — optional; empty (the default) is
 * the fixed `canary.interval`, exactly as before.
 *
 * WHY. The canary exists to catch a mass change fast, and on a site that reprices on a schedule the
 * change comes at one time of day: a 500-URL cohort every 30 minutes all day is ~24k origin calls per
 * node per day, nearly all of them confirming that nothing happened. A schedule makes the canary dense
 * where a change is expected and sparse elsewhere: windows `{ from, to, interval }` ("HH:MM", in
 * `anchorTimezone`, the anchor's own zone and DST handling), each with its own interval; outside every
 * window `canary.interval` applies (0 = no canary there). A window may wrap midnight (`to` < `from`);
 * the first window containing an instant is the one that applies.
 *
 * WHEN IT RUNS. At each window's start, then every `interval` inside it; a run whose next interval would
 * cross the window's end hands over to the outside cadence, counted from that run. A chain of timeouts,
 * re-armed at each FIRE (not after the pass, so the cadence does not drift by the pass's duration), and
 * every next instant is computed afresh from the wall clock — a DST shift moves the windows with the
 * local time rather than accumulating an hour of error, and a start inside a spring-forward hole is
 * pushed to its next real occurrence rather than resolving into the past.
 */
let compiledSchedule = null;
let compiledScheduleFrom;
const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export const canarySchedule = () => {
	const raw = config.changeProbe.canary.schedule;
	if (raw === compiledScheduleFrom) return compiledSchedule;
	compiledScheduleFrom = raw;
	compiledSchedule = [];
	for (const [index, entry] of (Array.isArray(raw) ? raw : []).entries()) {
		const interval = Number(entry?.interval);
		const valid =
			TIME_OF_DAY.test(String(entry?.from ?? '')) &&
			TIME_OF_DAY.test(String(entry?.to ?? '')) &&
			entry.from !== entry.to &&
			Number.isFinite(interval) &&
			interval >= MINUTE &&
			interval <= MAX_TIMER_DELAY;
		if (!valid) {
			logger.warn?.(
				`[prerender] changeProbe.canary.schedule[${index}] is not { from: "HH:MM", to: "HH:MM" (different), ` +
					`interval: >= 60000 ms } — ignored: ${JSON.stringify(entry)}`
			);
			continue;
		}
		compiledSchedule.push({
			fromTime: entry.from,
			toTime: entry.to,
			from: minutesOfTimeOfDay(entry.from),
			to: minutesOfTimeOfDay(entry.to),
			interval,
		});
	}
	return compiledSchedule;
};
const MAX_TIMER_DELAY = 2147483647;
const canaryScheduleKey = (schedule) =>
	`${config.changeProbe.anchorTimezone}|${schedule.map((w) => `${w.fromTime}-${w.toTime}/${w.interval}`).join(',')}`;
const scheduleWindowStatus = (window) => ({ from: window.fromTime, to: window.toTime, interval: window.interval });

/** The next occurrence of "HH:MM" in `timezone`, strictly after now (the spring-forward guard). */
const nextOccurrenceOf = (timeStr, timezone) => {
	const at = getNextTimeOfDay(timeStr, timezone);
	if (!Number.isFinite(at)) return NaN;
	return at <= Date.now() ? at + DAY : at;
};

/** When the scheduled canary should next run, seen from `now` (just after a run, or at arming). */
export const nextScheduledCanary = (now, { schedule, interval, timezone }) => {
	const minutes = localMinutesOf(now, timezone);
	const inside = (w) => (w.from < w.to ? minutes >= w.from && minutes < w.to : minutes >= w.from || minutes < w.to);
	const current = schedule.find(inside);
	const outside = interval > 0 ? now + interval : Infinity;
	let next = outside;
	if (current) {
		const end = nextOccurrenceOf(current.toTime, timezone);
		next = Number.isFinite(end) && now + current.interval > end ? outside : now + current.interval;
	}
	for (const window of schedule) {
		const start = nextOccurrenceOf(window.fromTime, timezone);
		if (Number.isFinite(start) && start < next) next = start;
	}
	return next;
};

const armCanarySchedule = () => {
	if (canaryTimer) clearTimeout(canaryTimer);
	canaryTimer = null;
	let at;
	try {
		at = nextScheduledCanary(Date.now(), {
			schedule: canarySchedule(),
			interval: config.changeProbe.canary.interval,
			timezone: config.changeProbe.anchorTimezone,
		});
	} catch (e) {
		logger.warn(
			`[prerender] change-probe: canary.schedule cannot be evaluated in anchorTimezone ` +
				`"${config.changeProbe.anchorTimezone}" (${e?.message ?? String(e)}) — the scheduled canary is not armed`
		);
		at = NaN;
	}
	nextCanaryAt = Number.isFinite(at) ? at : null;
	if (nextCanaryAt !== null) {
		canaryTimer = setTimeout(
			() => {
				canaryTimer = null;
				armCanarySchedule();
				runProbeCanaryOnce({ startedBy: 'interval' }).catch((e) => logger.error(e));
			},
			Math.min(Math.max(0, nextCanaryAt - Date.now()), MAX_TIMER_DELAY)
		);
		canaryTimer.unref?.();
	}
	void publishScheduler();
};

const armIntervals = () => {
	// The SWEEP is what the mode changes. The CANARY is orthogonal to it — a fixed cohort on a
	// fast fixed cadence, whose whole job is to notice a mass change between sweeps — so it arms
	// identically either way. An early return here would have silently disabled the mass-change
	// detector for anyone who turned continuous mode on.
	if (isContinuous()) void runContinuousLoop();
	else if (isAnchored()) armAnchorTimer();
	else {
		sweepTimer = setInterval(
			() => runProbeSweepOnce({ startedBy: 'interval' }).catch((e) => logger.error(e)),
			armedSweep
		);
		sweepTimer.unref?.();
		intervalArmedAt = Date.now();
	}
	if (armedCanarySchedule !== null) armCanarySchedule();
	else if (armedCanary) {
		canaryTimer = setInterval(
			() => runProbeCanaryOnce({ startedBy: 'interval' }).catch((e) => logger.error(e)),
			armedCanary
		);
		canaryTimer.unref?.();
		canaryArmedAt = Date.now();
	}
	// After arming, so the published state describes the timers that now exist.
	void publishScheduler();
};

// (Re)arm to match config; enable/disable and both intervals are live (reconcile's shape).
const syncProbeTimers = () => {
	// Only the scheduler's worker arms anything. The config listener that calls this is registered by
	// `startChangeProbeScheduler`, so in a process this is always true — but a listener that outlives a
	// stopped scheduler must not arm timers whose state it will never publish.
	if (!schedulerStarted) return;
	const enabled = config.changeProbe.enabled && probeRules().length > 0;
	// In continuous mode there is no interval to arm, but the armed value still has to CHANGE when
	// the mode does, or `syncProbeTimers` sees no difference and leaves an interval timer running
	// after a switch to continuous (and vice versa). Tagging the mode into the key is what makes
	// the mode itself live.
	const desiredSweep = !enabled
		? null
		: isContinuous()
			? 'continuous'
			: isAnchored()
				? anchorKey()
				: config.changeProbe.sweepInterval;
	const schedule = canarySchedule();
	const desiredCanarySchedule = enabled && schedule.length ? canaryScheduleKey(schedule) : null;
	const desiredCanary =
		enabled && config.changeProbe.canary.interval > 0
			? config.changeProbe.canary.interval
			: desiredCanarySchedule !== null
				? 0
				: null;
	if (desiredSweep === armedSweep && desiredCanary === armedCanary && desiredCanarySchedule === armedCanarySchedule) {
		return;
	}

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
	armedCanarySchedule = desiredCanarySchedule;

	// EVERY BRANCH BELOW PUBLISHES, AND ONLY AFTER IT HAS ARMED (#176). This used to publish once,
	// here, before anything was armed — so the snapshot carried the anchor as null, and null is the
	// admin surface's "your anchor is broken" signal. Without a publish at all the endpoint answers
	// `armedInterval: null` from 15 of 16 workers, which reads as "disarmed" rather than as "asked
	// the wrong worker". Deliberately not awaited: `syncProbeTimers` runs on the config apply path and
	// must not become async for a write whose failure is already logged.
	if (desiredSweep === null) {
		// A disarm is exactly what the published state has to say.
		void publishScheduler();
		return;
	}

	// Anchored mode never runs a boot sweep: the whole point is that the pass starts at the anchor,
	// and a restart at 15:00 must not walk the corpus at 15:05. Baselines persist across restarts
	// (ProbeState), so nothing is lost by waiting for the anchor; the canary is armed right away.
	if (wasEnabled || isAnchored()) {
		armIntervals();
		// The one thing a restart must not cost: the rest of an interrupted pass (see `checkResume`).
		// Re-armed after any re-arm until it has decided, so an early config apply cannot drop it.
		if (!wasEnabled && isAnchored()) resumePending = true;
		if (resumePending && isAnchored()) armResumeCheck();
		return;
	}

	// First arming is boot-shaped: delay + per-node stagger, so a rolling restart or a cluster-wide
	// config apply doesn't start every node's registry walk (and origin probes) at the same moment.
	const stagger = fnv1a32(server.hostname) % Math.max(1, config.changeProbe.startJitter | 0);
	const delay = config.changeProbe.startDelay + stagger;
	bootAt = Date.now() + delay;
	bootTimer = setTimeout(() => {
		bootTimer = null;
		bootAt = null;
		runProbeSweepOnce({ startedBy: 'startup' }).catch((e) => logger.error(e));
		armIntervals();
	}, delay);
	bootTimer.unref?.();
	void publishScheduler();
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
/** Tests only — resolves once every state write this worker issued has landed. */
export const probeStatePublishedForTest = probeStatePublished;

/** Tests only — the pass's timer heartbeat, assertable without a pass that takes minutes. */
export const __startHeartbeatForTest = startHeartbeat;

/** Tests only — the node-wide pace of the render check's confirming re-probes. */
export const __reserveRecheckSlotForTest = () => reserveRecheckSlot();

/** Tests only — resolves once every render recheck this worker queued has settled. */
export const renderRechecksSettledForTest = () => Promise.all([...rechecksInFlight]);

/** Tests only — the per-pass invalidation-epoch resolver the sweep's actions consult. */
export const __epochResolverForTest = epochResolver;

/** Tests only — where a resume starts, from the walk position and the actions in flight. */
export const __resumeKeyOfForTest = resumeKeyOf;

/** Tests only — the boot-time resume decision, without waiting out its timer. */
export const __checkResumeForTest = checkResume;

/** Tests only — the limits builder, so the sweep/canary split is assertable without a live pass. */
export const __passLimitsForTest = passLimits;
/** Tests only — a clean out-of-pass budget cell: no published headroom, no usage, no pause. */
export const __resetOriginPaceForTest = () => originPaceCell().fill(0n);

/** Tests only — the process's mapping guard, as the sweep and canary get it (live config, real warning). */
export const __mappingGuardForTest = theMappingGuard;

/** Tests only — module state that outlives a beforeEach. */
export const resetChangeProbeState = () => {
	clearProbeTimers();
	schedulerStarted = false;
	armedSweep = armedCanary = armedCanarySchedule = null;
	sweepRunning = canaryRunning = false;
	compiledSchedule = null;
	compiledScheduleFrom = undefined;
	sweepInterrupt = null;
	lastSweep = lastCanary = null;
	cohorts = new Map();
	cohortBuildDone = false;
	compiledRules = null;
	compiledFrom = undefined;
	lastUnsupportedWarnAt = 0;
	lastFactsUnsupportedWarnAt = 0;
	lastFactsRefusedWarnAt = 0;
	renderCheckState = { at: 0, row: null };
	originPace?.fill(0n);
	suspectClaims.clear();
	mappingGuard = null;
	measuredSliceSize = null;
	resumePending = false;
	stopLoopLagMonitor();
};
