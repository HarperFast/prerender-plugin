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
 *     tens of µs) and a queue entry. The request itself waits for a slot in the NODE-WIDE probe budget,
 *     shared with the sweep (which leaves `share` of it while checks are armed) and the render re-check.
 *   - COMPARED WITH WHAT WAS SERVED. The facts come from the bytes this node just served, not from the
 *     owner's node-local `ProbeState`, so any node can check any page and the comparison is about the
 *     page a crawler actually received. For a URL a `pageCheck` rule matches, the rule's endpoint is
 *     probed and its MAPPED FIELDS are compared with the served page's facts by the sweep's own
 *     comparators. The price/availability claim pair is not used here: it is built from the renderer's
 *     `structuredOffers` (every Product in the document), which a head scan cannot reproduce, and a
 *     subset compared asymmetrically could disagree forever. On a `documentCheck` route the origin's
 *     document itself is read (only as far as its head) and compared fact by fact.
 *   - ONE CHECK PER PAGE PER WINDOW, cluster-wide. An agreeing check is written to `PageCheck`
 *     (replicated), so every node sees it; the sweep skips it too. A disagreement expires the page and
 *     re-files its render exactly as a detected change does (`actOnChange`, forwarded to the owner).
 *   - FAILS TOWARD ASKING NOTHING. A full queue, no budget slot in time, a failed request, nothing
 *     comparable: the page is served as before and the next request asks again. Nothing here can serve a
 *     page that would otherwise be refused, and nothing here blocks a response.
 */

import { config } from '../config.js';
import { metrics } from '../metrics.js';
import { fnv1a32 } from './hash.js';
import { documentFactsFromStream, documentFactsOf, HEAD_FACTS } from './documentFacts.js';
import { compareField, parsePageFacts, signatureSlots } from './changeProbeSpec.js';
import {
	actOnChange,
	disarmedFieldsOnNode,
	lastAnchorAt,
	probeDocument,
	probeRuleOnce,
	probeRules,
	reserveOriginSlot,
} from './changeProbe.js';
import { coveredAt, readPageCheck, writePageCheck } from './pageCheck.js';
import { recordMissBreadth } from './crawlStats.js';
import { deleteRawPage } from './rawCache.js';

const targetTable = () => databases.render_service.Target;

/**
 * Every effect, injectable for tests (the runProbePass pattern): the probe and document requests, the
 * PageCheck reads and writes, the budget slot, the node's disarmed fields, the anchor, the breadth sketch,
 * and the two actions.
 */
const DEFAULTS = Object.freeze({
	probe: probeRuleOnce,
	fetchDocument: probeDocument,
	readCheck: readPageCheck,
	writeCheck: writePageCheck,
	reserveSlot: reserveOriginSlot,
	disarmed: disarmedFieldsOnNode,
	anchor: lastAnchorAt,
	recordBreadth: recordMissBreadth,
	expire: actOnChange,
	deleteRaw: deleteRawPage,
	readTarget: (url) =>
		targetTable().get({ id: url, select: ['url', 'sitemapUrl', 'renderInterval', 'demandInterval'] }),
});
let deps = DEFAULTS;
/** Tests: replace effects (merged over the defaults); no argument restores them. */
export const __setServeCheckDepsForTest = (overrides = null) => {
	deps = overrides ? { ...DEFAULTS, ...overrides } : DEFAULTS;
	anchorMemo = { at: -Infinity, value: NaN };
};

const settings = () => config.changeProbe.serveCheck;
const isOn = () => Boolean(config.changeProbe.enabled && settings()?.enabled);

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
 * response. `kind` is 'page' (a rendered snapshot: `body` is the served bytes, `contentEncoding` /
 * `contentType` its stored headers) or 'raw' (a stored origin document: `facts` is its stored JSON,
 * `rawKey` its row). `lastCachedMs` is when that page was rendered or that document captured.
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
	const plan = planFor(served.kind, served.url, served.route);
	if (!plan) return;
	const nowMs = Date.now();
	const threshold = checkThreshold(served.url, nowMs);
	// Not due: never (no anchor and no maxAge for it), or its own render/capture is recent enough.
	if (!Number.isFinite(threshold) || served.lastCachedMs >= threshold) return;
	if (recentlyAsked(served.url, nowMs)) return;
	const check = await deps.readCheck(served.url);
	remember(served.url, nowMs);
	if (coveredAt(threshold, served.lastCachedMs, check)) return;
	if (settings().dryRun) {
		metrics.serveCheck('would-check', plan.source);
		// Distinct URLs, cluster-wide, beside the per-cause miss breadth (`/prerender_admin/crawl-breadth`).
		deps.recordBreadth('would-check', served.url);
		return;
	}
	const facts = served.kind === 'raw' ? parsePageFacts(served.facts) : servedFacts(served, plan.want);
	if (!facts) {
		metrics.serveCheck('no-facts', plan.source);
		return;
	}
	if (queue.length >= settings().maxPending) {
		metrics.serveCheck('busy', plan.source);
		return;
	}
	queue.push({
		...plan,
		url: served.url,
		kind: served.kind,
		rawKey: served.rawKey ?? null,
		facts,
		threshold,
		lastCachedMs: served.lastCachedMs,
	});
	metrics.serveCheck('queued', plan.source);
	pump();
};

/** The served snapshot's facts, read off the bytes the bot was just sent. */
const servedFacts = (served, want) => {
	const body = served.body;
	if (!body || typeof body.length !== 'number' || body.length === 0) return null;
	const bytes = Buffer.isBuffer(body)
		? body
		: typeof body === 'string'
			? Buffer.from(body)
			: Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	return documentFactsOf(bytes, { contentEncoding: served.contentEncoding, contentType: served.contentType, want })
		.facts;
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

const runCheck = async (item, gen = generation) => {
	const slot = deps.reserveSlot(settings().maxWait);
	if (slot === null) {
		metrics.serveCheck('shed', item.source);
		recent.delete(item.url); // the next request may queue it again
		return;
	}
	if (slot > Date.now()) await waitUnref(slot - Date.now());
	if (gen !== generation || !isOn() || settings().dryRun) return;
	// Checked by another worker or node while this one waited: one check per page per window, cluster-wide.
	if (coveredAt(item.threshold, item.lastCachedMs, await deps.readCheck(item.url))) {
		metrics.serveCheck('deduped', item.source);
		return;
	}
	let verdict;
	try {
		verdict = item.source === 'document' ? await checkDocument(item) : await checkEndpoint(item);
	} catch {
		verdict = { result: 'failed' };
	}
	if (verdict.result === 'agree') {
		await deps.writeCheck(item.url, item.lastCachedMs);
		metrics.serveCheck('agree', item.source);
	} else if (verdict.result === 'mismatch') {
		await act(item);
		metrics.serveCheck(item.kind === 'raw' ? 'raw-mismatch' : 'mismatch', item.source);
		logger.debug?.(
			`[prerender] serve check: ${item.url} disagrees with the origin on ${verdict.field} — ${item.kind === 'raw' ? 'stored document deleted' : 'expired and re-filed'}`
		);
	} else {
		metrics.serveCheck(verdict.result, item.source);
	}
};

const checkEndpoint = async (item) => {
	// A signature, a status-signal literal (no slots: a state, not values — nothing to compare it with
	// here), or null (the response yielded nothing). Throws on a failed request.
	const observed = await deps.probe(item.rule, item.url);
	const values = observed ? signatureSlots(observed) : null;
	if (!values) return { result: observed ? 'inconclusive' : 'failed' };
	const disarmed = await deps.disarmed(item.rule);
	return compareWithEndpoint(item.rule, values, item.facts, {
		pageUrl: item.url,
		isArmed: (_rule, field) => !disarmed.has(field.label),
	});
};

/**
 * The served page's facts against the rule's endpoint: 'mismatch' when any ARMED mapped field disagrees
 * (naming the first), 'agree' when at least one compared and agreed and none disagreed, else
 * 'inconclusive'. The same comparators, and the same armed set, as the sweep.
 */
export const compareWithEndpoint = (rule, values, facts, { pageUrl = null, isArmed = () => true } = {}) => {
	const ctx = { pageUrl, vocabulary: rule.pageCheck?.vocabulary ?? null };
	let disagreed = null;
	let agreed = 0;
	for (const field of rule.pageCheck?.fields ?? []) {
		if (!isArmed(rule, field)) continue;
		const verdict = compareField(field, values[field.slot], facts, ctx);
		if (verdict === false) disagreed ??= field.label ?? `${field.slot}:${field.fact}`;
		else if (verdict === true) agreed++;
	}
	if (disagreed) return { result: 'mismatch', field: disagreed };
	return agreed > 0 ? { result: 'agree' } : { result: 'inconclusive' };
};

const checkDocument = async (item) => {
	const response = await deps.fetchDocument(item.url);
	if (response.statusCode !== 200) {
		response.body?.destroy?.();
		return { result: 'failed' };
	}
	const { facts, outcome } = await documentFactsFromStream(response.body, {
		contentEncoding: response.headers['content-encoding'],
		contentType: response.headers['content-type'],
		want: item.want,
	});
	if (!facts) return { result: outcome === 'ok' ? 'inconclusive' : 'failed' };
	return compareDocuments(item.facts, facts, item.want);
};

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Two documents' facts, read by the same reader (the served page and the origin's document now), fact by
 * fact for every fact in `want` both state. `itemList` compares the products listed in BOTH, by price and
 * availability: membership and order are not a change (a listing re-ranks through the day, and a product
 * that left it is still correct on its own page).
 */
export const compareDocuments = (page, origin, want) => {
	let disagreed = null;
	let agreed = 0;
	for (const name of want) {
		const a = page?.[name] ?? null;
		const b = origin?.[name] ?? null;
		if (a === null || b === null) continue;
		if (name !== 'itemList') {
			if (sameValue(a, b)) agreed++;
			else disagreed ??= name;
			continue;
		}
		const byUrl = new Map(b.filter((entry) => entry?.[0]).map((entry) => [entry[0], entry]));
		for (const entry of a) {
			const other = entry?.[0] ? byUrl.get(entry[0]) : undefined;
			if (!other) continue;
			for (const slot of [1, 3]) {
				if (entry[slot] === null || other[slot] === null) continue;
				if (entry[slot] === other[slot]) agreed++;
				else disagreed ??= 'itemList';
			}
		}
	}
	if (disagreed) return { result: 'mismatch', field: disagreed };
	return agreed > 0 ? { result: 'agree' } : { result: 'inconclusive' };
};

/** A disagreeing page: expired and re-filed as a change; a disagreeing raw document: deleted. */
const act = async (item) => {
	if (item.kind === 'raw') {
		await deps.deleteRaw(item.rawKey ?? item.url);
		return;
	}
	let target = null;
	try {
		target = await deps.readTarget(item.url);
	} catch {
		target = null;
	}
	await deps.expire({
		url: item.url,
		sitemapUrl: target?.sitemapUrl ?? null,
		renderInterval: target?.renderInterval ?? null,
		demandInterval: target?.demandInterval ?? null,
	});
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
