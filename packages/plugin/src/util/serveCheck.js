/**
 * SERVE-TIME CHECKS: a cached page is checked against the origin when a bot asks for it, if it has not
 * been checked (or rendered) since the last anchor — or, for the `sample` of URLs, within `maxAge`.
 * Default off (`changeProbe.serveCheck`).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────────────────────
 *
 * The nightly pass checks the whole corpus in KEY order over hours, so a page changed at the nightly
 * update serves its old content until the pass reaches it, and a page changed during the day waits for
 * the next night. Bot traffic says which pages are being served right now: checking those first, when
 * they are asked for, moves detection to the first request after a change for every page anybody reads,
 * while the pass still covers the rest. Measured on one deployment, bot-proxied origin documents cannot
 * do this for free (an origin document passes through for a URL with a cached page almost only during an
 * invalidation), so a check is a request — the rule's endpoint, ~3 KB and ~67 ms of origin time against
 * ~250 KB and ~160 ms for the page's own document.
 *
 * ── HOW, AND WHAT IT COSTS WHOM ────────────────────────────────────────────────────────────────
 *
 *   - STALE-WHILE-REVALIDATE. The bot gets the cached page exactly as before; everything here happens
 *     after the response (`considerServeCheck` defers to `setImmediate`): one local read of the replicated
 *     `PageCheck` row, and — only when a check is due — a scan of the served bytes (util/documentFacts.js,
 *     tens of µs, yielding between rounds when it reads far) and a queue entry. The request itself waits
 *     for a slot in the NODE-WIDE probe budget, shared with the sweep (which leaves what the checks use)
 *     and the render re-check, and paused node-wide while the origin pushes back.
 *   - COMPARED WITH WHAT WAS SERVED. The facts come from the bytes this node just served, not from the
 *     owner's node-local `ProbeState`, so any node can check any page and the comparison is about the
 *     page a crawler actually received. For a URL a `pageCheck` rule matches, the rule's endpoint is
 *     probed and its MAPPED FIELDS are compared with the served page's facts by the sweep's own
 *     comparators. The price/availability claim pair is not used here: it is built from the renderer's
 *     `structuredOffers` (every Product in the document), which a head scan cannot reproduce, and a
 *     subset compared asymmetrically could disagree forever. On a `documentCheck` route the origin's
 *     document itself is read (only as far as its head, with the served device's User-Agent) and compared
 *     fact by fact.
 *   - ONE CHECK PER PAGE PER WINDOW, cluster-wide. Every decided check is written to `PageCheck`
 *     (replicated), so every node sees it, whatever the verdict. An agreeing endpoint check records the
 *     observation itself, and the sweep skips a row only when that equals its own baseline. A disagreement
 *     expires the page and re-files its render exactly as a detected change does (`actOnChange`, forwarded
 *     to the owner), or deletes a disagreeing raw document.
 *   - A DISAGREEMENT THAT SURVIVES A RE-RENDER IS NOT A CHANGE. When the same field disagrees again, on a
 *     page rendered after the last mismatch, while the origin says EXACTLY what it said then (`evidence`),
 *     the render was taken from that very origin state and still differs: the page and the origin differ
 *     systematically (a mapping, a device, what the client-side render does to a fact) and re-rendering
 *     cannot fix it. It is `held` — recorded, counted, not acted on — until a check agrees or the origin
 *     moves. One wasted render per URL, not one per window; an origin that moved again (a sale that began
 *     and then ended) is a new change and is acted on.
 *   - FAILS TOWARD ASKING NOTHING. A full queue, no budget slot in time, a failed request, a served copy
 *     replaced while the check waited, nothing comparable: the page is served as before. Nothing here can
 *     serve a page that would otherwise be refused, and nothing here blocks a response.
 */

import { config } from '../config.js';
import { metrics } from '../metrics.js';
import { fnv1a32 } from './hash.js';
import { documentFactsFromStream, documentFactsOfYielding, HEAD_FACTS } from './documentFacts.js';
import { compareField, parsePageFacts, signatureSlots } from './changeProbeSpec.js';
import {
	actOnChange,
	canonicalFieldOf,
	disarmedFieldsOnNode,
	expireChangedPages,
	isDistress,
	isDistressStatus,
	lastAnchorAt,
	noteOriginHealthy,
	noteOriginPushback,
	probeDocument,
	probeRuleOnce,
	probeRules,
	reserveOriginSlot,
} from './changeProbe.js';
import { coveredAt, readPageCheck, writePageCheck } from './pageCheck.js';
import { resolveCanonical } from './entity.js';
import { recordMissBreadth } from './crawlStats.js';
import { deleteRawPage } from './rawCache.js';
import { dateColumnMs } from './time.js';

const targetTable = () => databases.render_service.Target;

/**
 * The `lastCached` of the copy a check was queued for, as it stands now (ms), NaN when the row is gone.
 * Both tables replicate to every node, so the read is local.
 */
const readBasis = async (kind, key) => {
	const row =
		kind === 'raw'
			? await databases.raw_cache.RawPage.get({ id: key, select: ['cacheKey', 'lastCached'] })
			: await databases.page_cache.PrerenderedPage.get({ id: key, select: ['cacheKey', 'lastCached'] });
	return row ? dateColumnMs(row.lastCached) : NaN;
};

/**
 * Every effect, injectable for tests (the runProbePass pattern): the probe and document requests, the
 * PageCheck reads and writes, the served copy's current basis, the budget slot and the origin's pushback,
 * the node's disarmed fields, the anchor, the breadth sketch, and the actions.
 */
const DEFAULTS = Object.freeze({
	probe: probeRuleOnce,
	fetchDocument: probeDocument,
	readCheck: readPageCheck,
	writeCheck: writePageCheck,
	readBasis,
	reserveSlot: reserveOriginSlot,
	pushback: noteOriginPushback,
	healthy: noteOriginHealthy,
	disarmed: disarmedFieldsOnNode,
	anchor: lastAnchorAt,
	recordBreadth: recordMissBreadth,
	expire: actOnChange,
	expireOnly: expireChangedPages,
	deleteRaw: deleteRawPage,
	readTarget: (url) =>
		targetTable().get({ id: url, select: ['url', 'state', 'sitemapUrl', 'renderInterval', 'demandInterval'] }),
	resolveCanonical,
});
let deps = DEFAULTS;
/** Tests: replace effects (merged over the defaults); no argument restores them. */
export const __setServeCheckDepsForTest = (overrides = null) => {
	deps = overrides ? { ...DEFAULTS, ...overrides } : DEFAULTS;
	anchorMemo = { at: -Infinity, value: NaN };
};

const settings = () => config.changeProbe.serveCheck;
const isOn = () => Boolean(config.changeProbe.enabled && settings()?.enabled);
// The probe's own dry run governs its checks too: a probe that is only measuring expires nothing.
const isDryRun = () => Boolean(settings().dryRun || config.changeProbe.dryRun);

// ---- who and when ---------------------------------------------------------------------------------

let botSet = null; // lowercase Set, or null meaning every bot
let botsFrom;
/** May a request from `botName` trigger a check? `bots` uses `ingress.discoveryBots`' names and rules. */
const botTriggers = (botName) => {
	const list = settings().bots;
	if (list !== botsFrom) {
		botsFrom = list;
		botSet = !Array.isArray(list) || list.includes('*') ? null : new Set(list.map((b) => String(b).toLowerCase()));
	}
	return botSet === null || (typeof botName === 'string' && botSet.has(botName.toLowerCase()));
};

/** Is `url` in the `maxAge` re-check cohort? Stable by hash, so a URL is in or out for good. */
const sampled = (url) => {
	const sample = settings().sample;
	if (!(sample < 1)) return true;
	if (!(sample > 0)) return false;
	return fnv1a32(`serve-check|${url}`) / 0x100000000 < sample;
};

/**
 * The instant a page must have been rendered or checked at or after to need no check now: the later of
 * the last anchor and `now - maxAge` (the latter for the sampled cohort only). NaN = never due (no anchor
 * outside anchored mode, and no `maxAge` for this URL).
 */
// The anchor moves once a day and resolving it costs two Intl calls, so it is re-read at most once a minute
// per worker: a check due at the anchor waits up to a minute for it, which nothing notices.
let anchorMemo = { at: -Infinity, value: NaN };
const anchorAt = (nowMs) => {
	if (nowMs - anchorMemo.at >= 60_000) anchorMemo = { at: nowMs, value: deps.anchor() };
	return anchorMemo.value;
};

export const checkThreshold = (url, nowMs = Date.now()) => {
	const anchor = anchorAt(nowMs);
	const maxAge = settings().maxAge;
	const age = maxAge > 0 && sampled(url) ? nowMs - maxAge : NaN;
	if (Number.isFinite(anchor) && Number.isFinite(age)) return Math.max(anchor, age);
	return Number.isFinite(anchor) ? anchor : age;
};

// ---- what to compare ---------------------------------------------------------------------------

const HEAD_FACT_SET = new Set(HEAD_FACTS);
const wantByRule = new WeakMap();
/** The head facts a rule's mapped fields read (`product.offers` → product), or null when none can be. */
const wantForRule = (rule) => {
	if (wantByRule.has(rule)) return wantByRule.get(rule);
	const names = new Set();
	for (const field of rule.pageCheck?.fields ?? []) {
		const top = String(field.fact ?? '').split('.')[0];
		if (HEAD_FACT_SET.has(top)) names.add(top);
	}
	const want = names.size ? [...names] : null;
	wantByRule.set(rule, want);
	return want;
};

/**
 * How a page served as `kind` ('page' a rendered snapshot, 'raw' a stored origin document) is checked, or
 * null: a rule matching it with mapped fields (its endpoint), else the route's `documentCheck`. The rule
 * is selected EXACTLY as the sweep selects it — first match of all rules.
 */
const planFor = (kind, url, route) => {
	const pathname = URL.parse(url)?.pathname;
	const rule = pathname ? probeRules().find((candidate) => candidate.pathPattern.test(pathname)) : null;
	if (rule?.source === 'request' && rule.pageCheck) {
		const want = wantForRule(rule);
		if (want) return { source: kind === 'raw' ? 'raw' : 'api', rule, want };
	}
	if (kind === 'page' && route?.documentCheck) return { source: 'document', rule: null, want: route.documentCheck };
	return null;
};

/** Are serve-time checks on (they may still be in dry run)? `serveChecksArmed` (util/changeProbe.js) is "and acting". */
export const serveChecksOn = isOn;

/**
 * Does a check of the page at `url` on `route` compare `fact` (a page-facts name: 'canonical', 'title', …)?
 * The serve-time check's plan for it maps that fact (its rule's endpoint fields, else the route's
 * `documentCheck`), and the sweep, which records its agreements as checks too, compares the same rule's
 * fields. False when no check covers the URL at all. A caller that treats an agreeing check as evidence
 * about ONE fact needs this: an agreement is "nothing compared disagreed", and says nothing about a fact
 * the check never compares.
 */
export const checkComparesFact = (url, route, fact) => {
	const plan = planFor('page', url, route);
	if (!plan) return false;
	if (plan.source === 'document') return plan.want.includes(fact);
	return (plan.rule.pageCheck?.fields ?? []).some((field) => field.fact === fact);
};

// ---- the gate, on the serve path (after the response) ---------------------------------------------

const DEDUPE_MS = 5 * 60_000;
const DEDUPE_MAX = 20_000;
const recent = new Map(); // url -> until (ms): asked, or found covered, recently on this worker
const recentlyAsked = (url, nowMs) => {
	const until = recent.get(url);
	if (until === undefined) return false;
	if (until > nowMs) return true;
	recent.delete(url);
	return false;
};
const remember = (url, nowMs) => {
	recent.delete(url);
	recent.set(url, nowMs + DEDUPE_MS);
	if (recent.size > DEDUPE_MAX) recent.delete(recent.keys().next().value);
};

/**
 * Consider a check of a page that was just served from cache. Returns at once; the work runs after the
 * response. `kind` is 'page' (a rendered snapshot: `body` is the served bytes, `headers` its stored headers
 * as stored, `cacheKey` its row) or 'raw' (a stored origin document: `facts` is its stored JSON, `rawKey`
 * its row). `lastCachedMs` is when that page was rendered or that document captured; `deviceType` the
 * device it was served for.
 *
 * For a page offered rather than served (util/entityServe.js), `body` may be a function resolving to the
 * bytes: it is called only once the check is due, past every cheap refusal, so an offer the dedupe or a
 * covering check turns away costs no blob read. `dueSince` raises the threshold to the caller's own (the
 * later of the two wins), so a page the caller needs checked since an instant is not taken as covered by a
 * check before it.
 */
export const considerServeCheck = (served) => {
	if (!isOn()) return;
	setImmediate(() => {
		gate(served).catch((e) => {
			metrics.serveCheck('error', null);
			logger.warn?.(`[prerender] serve check of ${served?.url} failed: ${e?.message ?? String(e)}`);
		});
	});
};

const gate = async (served) => {
	if (!isOn() || !botTriggers(served.botName)) return;
	// A copy with no render time can never be shown covered, so it would be asked about on every window.
	if (!Number.isFinite(served.lastCachedMs)) return;
	const plan = planFor(served.kind, served.url, served.route);
	if (!plan) return;
	const nowMs = Date.now();
	const own = checkThreshold(served.url, nowMs);
	const threshold = Number.isFinite(served.dueSince) && !(own >= served.dueSince) ? served.dueSince : own;
	// Not due: never (no anchor and no maxAge for it), or its own render/capture is recent enough.
	if (!Number.isFinite(threshold) || served.lastCachedMs >= threshold) return;
	// Remembered BEFORE the read: two requests for one URL on one worker would otherwise both pass here
	// while the first one's read is in flight.
	if (recentlyAsked(served.url, nowMs)) return;
	remember(served.url, nowMs);
	if (coveredAt(threshold, served.lastCachedMs, await deps.readCheck(served.url))) return;
	if (isDryRun()) {
		metrics.serveCheck('would-check', plan.source);
		// Distinct URLs, cluster-wide, beside the per-cause miss breadth (`/prerender_admin/crawl-breadth`).
		deps.recordBreadth('would-check', served.url);
		return;
	}
	if (queue.length >= settings().maxPending) {
		metrics.serveCheck('busy', plan.source);
		return;
	}
	const facts = served.kind === 'raw' ? parsePageFacts(served.facts) : await servedFacts(served, plan.want);
	if (!facts) {
		metrics.serveCheck('no-facts', plan.source);
		return;
	}
	queue.push({
		...plan,
		url: served.url,
		kind: served.kind,
		basisKey: served.kind === 'raw' ? (served.rawKey ?? null) : (served.cacheKey ?? null),
		rawKey: served.rawKey ?? null,
		deviceType: served.deviceType ?? null,
		facts,
		threshold,
		lastCachedMs: served.lastCachedMs,
	});
	metrics.serveCheck('queued', plan.source);
	pump();
};

const headersOf = (headers) => {
	if (typeof headers !== 'string') return headers ?? {};
	try {
		return JSON.parse(headers) ?? {};
	} catch {
		return {};
	}
};

/** The served snapshot's facts, read off the bytes the bot was just sent. */
const servedFacts = async (served, want) => {
	const body = typeof served.body === 'function' ? await served.body() : served.body;
	if (!body || typeof body.length !== 'number' || body.length === 0) return null;
	const bytes = Buffer.isBuffer(body)
		? body
		: typeof body === 'string'
			? Buffer.from(body)
			: Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	const headers = headersOf(served.headers);
	const { facts } = await documentFactsOfYielding(bytes, {
		contentEncoding: headers['content-encoding'] ?? null,
		contentType: headers['content-type'] ?? null,
		want,
	});
	return facts;
};

// ---- the queue and the check -------------------------------------------------------------------

const CONCURRENCY = 4;
const queue = [];
let active = 0;
// Bumped by a reset: a check from an earlier generation stops where it is and frees nothing twice.
let generation = 0;

const pump = () => {
	while (active < CONCURRENCY && queue.length) {
		const item = queue.shift();
		const gen = generation;
		active++;
		runCheck(item, gen)
			.catch((e) => {
				metrics.serveCheck('error', item.source);
				logger.warn?.(`[prerender] serve check of ${item.url} failed: ${e?.message ?? String(e)}`);
			})
			.finally(() => {
				if (gen !== generation) return;
				active--;
				pump();
			});
	}
};

const waitUnref = (ms) =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});

/**
 * Has the copy the check was queued for been replaced (re-rendered, re-captured) or removed since it was
 * served? Its facts then describe a page nobody is served any more. Unknown (no key, a failed read) is
 * answered by the caller.
 */
const supersededNow = async (item) => {
	if (!item.basisKey) return false;
	const basis = await deps.readBasis(item.kind, item.basisKey);
	return !(basis <= item.lastCachedMs);
};

const runCheck = async (item, gen = generation) => {
	const slot = deps.reserveSlot(settings().maxWait);
	if (slot === null) {
		metrics.serveCheck('shed', item.source);
		recent.delete(item.url); // the next request may queue it again
		return;
	}
	if (slot > Date.now()) await waitUnref(slot - Date.now());
	if (gen !== generation) return;
	if (!isOn() || isDryRun()) {
		metrics.serveCheck('dropped', item.source);
		return;
	}
	// Checked by another worker or node while this one waited: one check per page per window, cluster-wide.
	const prior = await deps.readCheck(item.url);
	if (coveredAt(item.threshold, item.lastCachedMs, prior)) {
		metrics.serveCheck('deduped', item.source);
		return;
	}
	// Re-rendered (or re-captured, or removed) while the check waited — which can be long, behind a full
	// queue on a shared budget: comparing the old copy's facts now would expire the page that replaced it.
	try {
		if (await supersededNow(item)) {
			metrics.serveCheck('superseded', item.source);
			return;
		}
	} catch {
		metrics.serveCheck('read-error', item.source);
		return;
	}
	let verdict;
	try {
		verdict = item.source === 'document' ? await checkDocument(item) : await checkEndpoint(item);
	} catch (e) {
		verdict = { result: 'failed' };
		if (isDistress(e)) {
			deps.pushback(e?.retryAfterMs ?? null);
			verdict = { result: 'throttled' };
		}
	}
	if (verdict.answered) deps.healthy();
	// THE ENTITY REGISTRY (util/entity.js): the canonical the origin named for this page's entity, whatever the
	// comparison found — a check is a fetch from the origin, and a re-slug it sees moves the registry (and
	// adopts the new canonical) now, rather than at the next nightly pass. Never throws.
	if (typeof verdict.originCanonical === 'string' && verdict.originCanonical !== '') {
		try {
			await deps.resolveCanonical({ url: item.url, value: verdict.originCanonical, from: 'check' });
		} catch {
			// a registry fault never costs the check
		}
	}
	if (verdict.result === 'agree') {
		await deps.writeCheck(item.url, item.lastCachedMs, {
			outcome: 'agree',
			signature: verdict.signature ?? null,
			canonicalAgreed: verdict.canonicalAgreed === true,
		});
		metrics.serveCheck('agree', item.source);
	} else if (verdict.result === 'mismatch') {
		await settleMismatch(item, verdict, prior);
	} else if (verdict.result === 'inconclusive' || verdict.result === 'failed') {
		// Recorded too: asking again in five minutes would get the same nothing (or the same refusal, for an
		// endpoint that fails on this URL every time), on every worker of every node, for as long as bots ask
		// for the page. One ask per URL per window, whatever the answer; the nightly pass still probes it.
		// Not a pushback (`throttled`): that one pauses the node and is asked again once the pause lifts.
		await deps.writeCheck(item.url, item.lastCachedMs, { outcome: verdict.result });
		metrics.serveCheck(verdict.result, item.source);
	} else {
		metrics.serveCheck(verdict.result, item.source);
	}
};

/**
 * A disagreement: acted on, unless it is the same field the last check acted on, on a page rendered after
 * that (or already held) — then the render cannot fix it and it is held (see the module header). Recorded
 * either way, so no other worker or node asks about the same copy this window.
 */
const settleMismatch = async (item, verdict, prior) => {
	// The SAME disagreement: the same field, and the origin saying exactly what it said then. An origin that
	// moved since is a new change (a sale that began and then ended), and is acted on like any other.
	const same =
		prior.field !== null &&
		prior.field === verdict.field &&
		prior.evidence !== null &&
		prior.evidence === verdict.evidence;
	const held =
		same && (prior.outcome === 'held' || (prior.outcome === 'mismatch' && item.lastCachedMs > prior.basisAtMs));
	if (held) {
		await deps.writeCheck(item.url, item.lastCachedMs, {
			outcome: 'held',
			field: verdict.field,
			evidence: verdict.evidence,
			canonicalAgreed: verdict.canonicalAgreed === true,
		});
		metrics.serveCheck('held', item.source);
		return;
	}
	// Superseded while the request was out: the render that landed meanwhile is what bots get now.
	if (await supersededNow(item).catch(() => false)) {
		metrics.serveCheck('superseded', item.source);
		return;
	}
	const acted = await act(item);
	if (acted === null) return;
	await deps.writeCheck(item.url, item.lastCachedMs, {
		outcome: 'mismatch',
		field: verdict.field,
		evidence: verdict.evidence,
		canonicalAgreed: verdict.canonicalAgreed === true,
	});
	metrics.serveCheck(acted, item.source);
	logger.debug?.(
		`[prerender] serve check: ${item.url} disagrees with the origin on ${verdict.field} — ${
			item.kind === 'raw' ? 'stored document deleted' : acted === 'no-target' ? 'expired' : 'expired and re-filed'
		}`
	);
};

const checkEndpoint = async (item) => {
	// A signature, a status-signal literal (no slots: a state, not values — nothing to compare it with
	// here), or null (the response yielded nothing). Throws on a failed request.
	const observed = await deps.probe(item.rule, item.url);
	const values = observed ? signatureSlots(observed) : null;
	if (!values) return { result: observed ? 'inconclusive' : 'failed', answered: true };
	const disarmed = await deps.disarmed(item.rule);
	const verdict = compareWithEndpoint(item.rule, values, item.facts, {
		pageUrl: item.url,
		isArmed: (_rule, field) => !disarmed.has(field.label),
	});
	// The endpoint's canonical, only from a field the mapping guard has not disarmed (as the sweep reads it).
	const canonical = canonicalFieldOf(item.rule);
	const originCanonical = canonical && !disarmed.has(canonical.label) ? (values[canonical.slot] ?? null) : null;
	return { ...verdict, answered: true, signature: typeof observed === 'string' ? observed : null, originCanonical };
};

/** A short stable digest of what the origin said for a disagreeing field (`PageCheck.evidence`). */
const evidenceOf = (value) => fnv1a32(JSON.stringify(value ?? null)).toString(16);

/**
 * The served page's facts against the rule's endpoint: 'mismatch' when any ARMED mapped field disagrees
 * (naming the first, with a digest of the endpoint's value for it), 'agree' when at least one compared and
 * agreed and none disagreed, else 'inconclusive'. The same comparators, and the same armed set, as the sweep.
 * `canonicalAgreed`: an armed field on the page's `canonical` compared and agreed, and no armed field on the
 * canonical disagreed. Other fields may disagree: a mismatch elsewhere still says what the canonical did.
 */
export const compareWithEndpoint = (rule, values, facts, { pageUrl = null, isArmed = () => true } = {}) => {
	const ctx = { pageUrl, vocabulary: rule.pageCheck?.vocabulary ?? null };
	let disagreed = null;
	let agreed = 0;
	let canonical = null;
	for (const field of rule.pageCheck?.fields ?? []) {
		if (!isArmed(rule, field)) continue;
		const verdict = compareField(field, values[field.slot], facts, ctx);
		if (verdict === false) disagreed ??= field;
		else if (verdict === true) agreed++;
		if (field.fact === 'canonical' && verdict !== null) canonical = canonical !== false && verdict;
	}
	const canonicalAgreed = canonical === true;
	if (disagreed) {
		return {
			result: 'mismatch',
			field: disagreed.label ?? `${disagreed.slot}:${disagreed.fact}`,
			evidence: evidenceOf(values[disagreed.slot]),
			canonicalAgreed,
		};
	}
	return { result: agreed > 0 ? 'agree' : 'inconclusive', canonicalAgreed };
};

const checkDocument = async (item) => {
	const response = await deps.fetchDocument(item.url, item.deviceType);
	if (response.statusCode !== 200) {
		response.body?.destroy?.();
		if (isDistressStatus(response.statusCode)) {
			deps.pushback(null);
			return { result: 'throttled' };
		}
		return { result: 'failed', answered: true };
	}
	const { facts, outcome } = await documentFactsFromStream(response.body, {
		contentEncoding: response.headers['content-encoding'],
		contentType: response.headers['content-type'],
		want: item.want,
	});
	if (!facts) return { result: outcome === 'ok' ? 'inconclusive' : 'failed', answered: true };
	return {
		...compareDocuments(item.facts, facts, item.want),
		answered: true,
		originCanonical: facts.canonical ?? null,
	};
};

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A listing's entries by product URL, or null when a URL is listed twice (which entry is "the" one?). */
const listedByUrl = (list) => {
	const out = new Map();
	for (const entry of list) {
		const url = entry?.[0];
		if (!url) continue;
		if (out.has(url)) return null;
		out.set(url, entry);
	}
	return out;
};

/**
 * Two documents' facts, read by the same reader (the served page and the origin's document now), fact by
 * fact for every fact in `want` both state. `itemList` compares the products listed in BOTH, by price and
 * availability: membership and order are not a change (a listing re-ranks through the day, and a product
 * that left it is still correct on its own page). A listing that names one product twice on either side
 * compares nothing: pairing its entries would be a guess, and a wrong guess disagrees on every check.
 * `canonicalAgreed`: `canonical` was in `want`, both stated it, and it was the same.
 */
export const compareDocuments = (page, origin, want) => {
	let disagreed = null;
	let agreed = 0;
	let canonicalAgreed = false;
	for (const name of want) {
		const a = page?.[name] ?? null;
		const b = origin?.[name] ?? null;
		if (a === null || b === null) continue;
		if (name !== 'itemList') {
			const same = sameValue(a, b);
			if (same) agreed++;
			else disagreed ??= { field: name, evidence: evidenceOf(b) };
			if (name === 'canonical') canonicalAgreed = same;
			continue;
		}
		const ours = listedByUrl(a);
		const theirs = listedByUrl(b);
		if (!ours || !theirs) continue;
		// The origin's entries that disagree, in URL order: the evidence is what they say, so a re-rank of
		// the rest of the listing does not read as the origin having moved.
		const differing = [];
		for (const [url, entry] of ours) {
			const other = theirs.get(url);
			if (!other) continue;
			let differs = false;
			for (const slot of [1, 3]) {
				if (entry[slot] === null || other[slot] === null) continue;
				if (entry[slot] === other[slot]) agreed++;
				else differs = true;
			}
			if (differs) differing.push(other);
		}
		if (differing.length && !disagreed) {
			differing.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
			disagreed = { field: 'itemList', evidence: evidenceOf(differing) };
		}
	}
	if (disagreed) return { result: 'mismatch', ...disagreed, canonicalAgreed };
	return { result: agreed > 0 ? 'agree' : 'inconclusive', canonicalAgreed };
};

/**
 * A disagreeing raw document: deleted. A disagreeing page: expired and re-filed as a change, carrying its
 * Target's own fields. A page with NO Target (retired, never registered) is only expired — it is known
 * wrong, and there is nothing to re-file; a SUPPRESSED Target belongs to the suppression path, which this
 * leaves alone. Returns the outcome to count, or null when nothing was done (counted here).
 */
const act = async (item) => {
	if (item.kind === 'raw') {
		await deps.deleteRaw(item.rawKey ?? item.url);
		return 'raw-mismatch';
	}
	let target;
	try {
		target = await deps.readTarget(item.url);
	} catch {
		metrics.serveCheck('read-error', item.source);
		return null;
	}
	if (!target) {
		await deps.expireOnly(item.url);
		return 'no-target';
	}
	if (target.state === 'suppressed') {
		metrics.serveCheck('suppressed', item.source);
		return null;
	}
	await deps.expire({
		url: item.url,
		sitemapUrl: target.sitemapUrl ?? null,
		renderInterval: target.renderInterval ?? null,
		demandInterval: target.demandInterval ?? null,
	});
	return 'mismatch';
};

/** For tests: drop this worker's queue and memory. */
export const resetServeChecks = () => {
	anchorMemo = { at: -Infinity, value: NaN };
	generation++;
	active = 0;
	queue.length = 0;
	recent.clear();
	botsFrom = undefined;
};

/** For tests: resolves once the gate's deferred work and every queued check have settled. */
export const serveChecksSettledForTest = async () => {
	for (let i = 0; i < 400; i++) {
		await new Promise((resolve) => setImmediate(resolve));
		if (queue.length === 0 && active === 0) {
			await new Promise((resolve) => setTimeout(resolve, 2));
			if (queue.length === 0 && active === 0) return;
		}
	}
};
