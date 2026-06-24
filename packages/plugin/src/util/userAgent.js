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

	cache.set(ua, name);
	return name;
}
