import { config } from '../config.js';

// Lightweight LRU cache for bot-heavy traffic.
function createLRU(capacity = 1000) {
	const map = new Map();
	return {
		get(k) {
			const v = map.get(k);
			if (v === undefined) return undefined;
			map.delete(k);
			map.set(k, v);
			return v;
		},
		set(k, v) {
			if (map.has(k)) map.delete(k);
			map.set(k, v);
			if (map.size > capacity) {
				const oldest = map.keys().next().value;
				map.delete(oldest);
			}
		},
	};
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile the configured bot registry into a single matcher. Matches are sorted
 * longest-first so a specific name (e.g. `googlebot-image`) wins over a generic
 * prefix (`googlebot`). The trailing boundary avoids matching a bot name embedded
 * in a longer token.
 */
function compile(bots) {
	const valid = Array.isArray(bots)
		? bots.filter((b) => b && typeof b.name === 'string' && typeof b.match === 'string' && b.match.length > 0)
		: [];

	const sorted = [...valid].sort((a, b) => b.match.length - a.match.length);
	const byMatch = new Map(sorted.map((b) => [b.match.toLowerCase(), b.name]));
	const regex = sorted.length
		? new RegExp(`(${sorted.map((b) => escapeRegex(b.match)).join('|')})(?:[/;)\\s]|$)`, 'i')
		: null;

	// A fresh cache per compilation so registry changes never serve stale labels.
	return { regex, byMatch, cache: createLRU() };
}

let compiled = null;
let compiledFrom; // the bots array the current matcher was built from

// applyOptions replaces config with a fresh object (new `bots` array) on every
// change, so an identity check is enough to detect a registry change.
const matcher = () => {
	if (config.analytics.bots !== compiledFrom) {
		compiled = compile(config.analytics.bots);
		compiledFrom = config.analytics.bots;
	}
	return compiled;
};

export function getBotName(headers) {
	if (headers.get('harper') === 'pre-render') {
		return 'debug';
	}

	const ua = headers.get('user-agent');
	if (!ua) return 'other';

	const { regex, byMatch, cache } = matcher();

	const cached = cache.get(ua);
	if (cached !== undefined) return cached;

	let name = 'other';
	if (regex) {
		const m = regex.exec(ua);
		if (m) name = byMatch.get(m[1].toLowerCase()) ?? 'other';
	}

	// Registry miss: a well-behaved crawler still self-identifies, so label it with the
	// name its UA declares rather than collapsing to 'other'. The registry always wins
	// (stable display names); derivation only fills the gap until an entry is promoted.
	if (name === 'other' && config.analytics.deriveUnknownBots) {
		name = deriveBotName(ua) ?? 'other';
	}

	cache.set(ua, name);
	return name;
}

// Tokens that name a browser, engine, or platform — never a crawler identity. Anything
// reducing to only these is a browser-shaped UA, not a self-identification.
const GENERIC_TOKENS = new Set([
	...['mozilla', 'applewebkit', 'webkit', 'khtml', 'gecko', 'presto', 'like', 'compatible', 'version'],
	...['chrome', 'chromium', 'crios', 'headlesschrome', 'safari', 'firefox', 'fxios', 'opera', 'opr'],
	...['edg', 'edge', 'edga', 'edgios', 'msie', 'trident', 'samsungbrowser', 'ucbrowser'],
	...['windows', 'win64', 'wow64', 'x11', 'linux', 'ubuntu', 'android', 'iphone', 'ipad', 'ipod'],
	...['macintosh', 'mac', 'os', 'x', 'nt', 'cpu', 'u', 'wv', 'mobile', 'tablet', 'arm64', 'x86_64', 'intel'],
]);

// All patterns precompiled at module scope — deriveBotName runs on the bot serving path
// (once per distinct UA; the LRU absorbs repeats) and must not compile or allocate more
// than it has to.
//
// Cheap containment probe: only run the strip pass when the UA can actually contain a
// URL or email address. Most UAs — browser-shaped and many bots — skip the replace (and
// its string allocation) entirely.
const HAS_LINKISH = /:\/\/|@|www\./i;
// URLs and email addresses (contact info in UA comments) must not contribute tokens —
// e.g. `+http://www.google.com/bot.html` would otherwise derive "bot.html". One combined
// pass instead of one replace per shape.
const URL_OR_EMAIL = /\+?(?:https?:\/\/|www\.)\S+|\S+@\S+/gi;
const COMPAT_SLOT = /\bcompatible;\s*([^;()]+)/i;
const LEADING_HEAD = /^([A-Za-z][A-Za-z0-9 ._-]{0,49}?)\s*\//;
// A whole token (boundary enforced by the lookbehind) containing a crawler keyword.
// Sticky-global: reset lastIndex before every scan.
const KEYWORD_TOKEN = /(?<![A-Za-z0-9._-])[A-Za-z][A-Za-z0-9._-]*?(?:bot|crawler|spider|slurp)[A-Za-z0-9._-]*/gi;
// A plausible product name: starts with a letter, modest length, benign charset.
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9 ._-]{1,39}$/;
const TRAILING_VERSION = /\s+v?\d[\d.~_]*$/;
const BARE_KEYWORD = /^(?:bots?|robots?|crawlers?|spiders?|slurp)$/i;

/**
 * Reduce a raw candidate ("MJ12bot/v1.4.8", "MSIE 10.0", "Screaming Frog SEO Spider") to a
 * clean bot name, or null if it doesn't look like one. Strips a version suffix, then
 * rejects anything shaped wrong, too wordy, purely generic, or a bare keyword ("bot")
 * that would aggregate unrelated crawlers under one meaningless label.
 */
function cleanCandidate(raw) {
	const slash = raw.indexOf('/');
	let name = (slash === -1 ? raw : raw.slice(0, slash)).trim();
	name = name.replace(TRAILING_VERSION, '');
	if (!NAME_SHAPE.test(name)) return null;
	// /\s+/ so consecutive spaces can't mint empty words — an empty word is not in
	// GENERIC_TOKENS, so it would defeat the all-generic rejection below.
	const words = name.toLowerCase().split(/\s+/);
	if (words.length > 4) return null;
	if (words.every((w) => GENERIC_TOKENS.has(w))) return null;
	if (words.length === 1 && BARE_KEYWORD.test(name)) return null;
	return name;
}

/**
 * Derive a bot name from a self-identifying User-Agent the registry doesn't know.
 * Assumes cooperative crawlers (upstream bot management filters hostile traffic), so this
 * optimizes for coverage of the shapes well-behaved bots actually use, in order of how
 * reliable each shape is:
 *
 *   1. the `compatible; Name/1.0` slot — the conventional self-identification spot
 *   2. a leading product token — `CCBot/2.0 (…)`, incl. multiword heads like
 *      `Screaming Frog SEO Spider/21.4` (browser UAs lead with Mozilla/Opera, which
 *      cleanCandidate rejects as generic)
 *   3. any token containing a crawler keyword — catches names buried in an otherwise
 *      browser-shaped UA, e.g. `… Safari/605.1.15 (Applebot/0.1; +…)`
 *
 * Returns null when nothing self-identifies (the caller then falls back to 'other').
 */
export function deriveBotName(ua) {
	const cleaned = HAS_LINKISH.test(ua) ? ua.replace(URL_OR_EMAIL, ' ') : ua;

	const slot = COMPAT_SLOT.exec(cleaned);
	if (slot) {
		const name = cleanCandidate(slot[1]);
		if (name) return name;
	}

	const head = LEADING_HEAD.exec(cleaned);
	if (head) {
		const name = cleanCandidate(head[1]);
		if (name) return name;
	}

	KEYWORD_TOKEN.lastIndex = 0;
	for (let m; (m = KEYWORD_TOKEN.exec(cleaned)); ) {
		const name = cleanCandidate(m[0]);
		if (name) return name;
	}

	return null;
}

// ---- bot allowlists ------------------------------------------------------------------------

// Shared by the two allowlists below: `['*']` compiles to null, meaning "every bot", and
// anything else to a lowercase Set. Both cache on the IDENTITY of the config array they were
// built from — applyOptions replaces config with a fresh object on every change, so an identity
// check is enough to notice an edit and cheap enough for the request path.
const compileAllowlist = (bots) => {
	const names = (Array.isArray(bots) ? bots : []).filter((name) => typeof name === 'string' && name !== '');
	if (names.some((name) => name === '*')) return null;
	return new Set(names.map((name) => name.toLowerCase()));
};

let discoverySet = null; // lowercase Set, or null meaning "every bot" ('*' present)
let discoveryFrom; // the config array the current set was built from

/**
 * May a visit labeled `botName` create a NEW target (traffic discovery)?
 *
 * `ingress.discoveryBots` names the bots whose visits are trusted to mint corpus: `['*']`
 * (default) trusts every bot, `[]` trusts none (sitemap-only target creation site-wide), a
 * list trusts exactly those names. Names are the labels `getBotName` produces — registry
 * names, derived self-identifications, or the literal 'other' — compared case-insensitively
 * so a config spelling like 'googlebot' still matches the registry's 'Googlebot'.
 *
 * This gates CREATION only. Serving is untouched (an unminted URL still proxies to the
 * origin), and so are invalidation reenqueue and the sitemap pipeline (its targets are
 * declared, not discovered). The demand ladder's visit signal has its OWN allowlist —
 * `botCountsAsDemand` below — because the two questions are different: minting corpus is
 * permanent, while counting demand only reallocates cadence within a budget that already
 * exists, so a deployment can reasonably answer them differently.
 */
export const botMayDiscover = (botName) => {
	if (config.ingress.discoveryBots !== discoveryFrom) {
		discoverySet = compileAllowlist(config.ingress.discoveryBots);
		discoveryFrom = config.ingress.discoveryBots;
	}
	if (discoverySet === null) return true;
	return typeof botName === 'string' && discoverySet.has(botName.toLowerCase());
};

let demandSet = null; // lowercase Set, or null meaning "every bot" ('*' present)
let demandFrom; // the config array the current set was built from

/**
 * Does a visit labeled `botName` count as demand for the render ladder?
 *
 * `render.demand.bots` has the same shape and matching rules as `ingress.discoveryBots`:
 * `['*']` (default) counts every bot, `[]` counts none (every target rests at its route
 * cadence), a list counts exactly those, compared case-insensitively.
 *
 * Cadence is render budget, so whoever this counts decides where that budget goes: a scraper
 * walking the corpus breadth-first promotes pages no search engine asked for. It also bounds
 * what reaches the Bloom ring, whose false-positive rate rises with fill — see `recordDemand`
 * in http_handlers/bot_request.js for why that is a correctness concern and not just a cost.
 */
export const botCountsAsDemand = (botName) => {
	if (config.render.demand.bots !== demandFrom) {
		demandSet = compileAllowlist(config.render.demand.bots);
		demandFrom = config.render.demand.bots;
	}
	if (demandSet === null) return true;
	return typeof botName === 'string' && demandSet.has(botName.toLowerCase());
};
