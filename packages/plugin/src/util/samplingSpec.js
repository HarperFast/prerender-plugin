/**
 * Request samplers — the PURE half of util/sampling.js: what a sampler entry may say, and turning the
 * configured list into compiled samplers the request path can run without allocating.
 *
 * DELIBERATELY DEPENDENCY-FREE, like util/changeProbeSpec.js: config.js reports sampler problems from
 * `collectConfigWarnings` and the override dry run refuses entries the compiler would drop, and both can
 * import this module only because it imports nothing of the runtime (no config, no tables, no globals).
 *
 * DECLARATIVE ONLY. A sampler matches on values the request path already holds and records fields from a
 * fixed catalog (`SAMPLE_FIELDS`) plus request headers by name. There is no custom code: a derived value
 * belongs in the offline analysis, which can change it after the fact without collecting again, and a
 * request-time value the catalog lacks is added to the catalog.
 *
 * AN INVALID ENTRY IS DROPPED, NOT THE LIST — the contract `routeClass.js#compileEntry` and the probe rules
 * have — and UNKNOWN KEYS INVALIDATE THE ENTRY. That second rule is stricter than it looks necessary, and
 * it has to be: every match key narrows, so a typo'd key (`bot:` for `bots:`) would not fail, it would
 * silently widen the sampler to every bot.
 */

import { fnv1a32 } from './hash.js';

/**
 * What a sampler can record, and what each one is. `ts` is always recorded; the rest are chosen per
 * sampler with `fields`. Every value is one the request path already holds when the response is
 * delivered — recording costs an assignment, never a lookup.
 */
export const SAMPLE_FIELDS = Object.freeze({
	ts: 'request time, epoch ms (always recorded)',
	url: 'the URL as the cache key spells it: canonical, device-free',
	cacheKey: 'the cache key, URL and device (null for a URL too long to key)',
	route: "the matched route's `path`, else the route class",
	routeClass: 'prerender | passthrough | unclassified',
	bot: 'the bot name the analytics registry resolved',
	device: 'the device type',
	method: 'the HTTP method',
	status: 'the status sent, a 304 included',
	cacheStatus: 'the cache status (hit, swr, verified, entity, raw, negative, miss, stale, ...)',
	source: 'what answered: cache, entity, raw, negative, origin or rendered',
	ageMs: 'age of the served copy, now minus its lastCached; null when the origin answered',
	entityUrl: 'for an entity serve, the canonical URL whose render answered',
	renderNow: 'the on-demand render outcome (hit or timeout), else null',
	conditional: 'whether the request carried If-None-Match or If-Modified-Since',
	node: "this node's hostname",
	worker: 'the worker thread index',
	target:
		"the URL's target as the batch was written: active, suppressed, or null for none (read at flush, " +
		'once per distinct URL in the batch, never on the request)',
	sitemap: 'whether the URL is sitemap-listed, from the same flush-time target read (false without a target)',
});

/**
 * Fields that need a read, so they are resolved when a batch is written rather than when the request is
 * served: one target read per distinct URL per batch, detached from every response.
 */
export const FLUSH_FIELDS = Object.freeze(['target', 'sitemap']);

export const DEFAULT_FIELDS = Object.freeze([
	'ts',
	'url',
	'route',
	'bot',
	'device',
	'method',
	'status',
	'cacheStatus',
	'source',
	'ageMs',
]);

export const SAMPLE_BY = Object.freeze(['url', 'request']);

// Names go into the chunk row's primary key ahead of a `/`, so they are restricted to characters that
// sort below nothing surprising and need no escaping in a query string.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isSamplerName = (name) => typeof name === 'string' && NAME_RE.test(name);
// An RFC 9110 field-name token, lowercased at compile time.
const HEADER_RE = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;

export const MAX_HEADERS = 8;
export const MAX_URLS = 10_000;
const MAX_PATTERN_LENGTH = 512;
const MAX_SALT_LENGTH = 128;
export const MIN_KEEP_MS = 3_600_000;
export const MAX_KEEP_MS = 90 * 86_400_000;
export const DEFAULT_KEEP_MS = 14 * 86_400_000;
export const DEFAULT_RATE = 0.01;
export const DEFAULT_MAX_PER_MINUTE = 120;
export const MAX_PER_MINUTE = 6000;

/**
 * REFUSED IN `headers`, ALWAYS. A sampler is configured by an operator but its records are read back by
 * anyone with admin access, and kept for days: credentials must never be in them. The configured origin
 * bypass-token header is refused by name (passed in, since this module reads no config), and every name
 * carrying one of these fragments is refused whatever it is called.
 */
const DENIED_HEADER_FRAGMENTS = ['cookie', 'auth', 'token', 'secret', 'password', 'api-key', 'apikey', 'session'];

export const isDeniedHeader = (name, deniedHeaders = []) => {
	const lower = String(name).toLowerCase();
	if (deniedHeaders.some((denied) => String(denied).toLowerCase() === lower)) return true;
	return DENIED_HEADER_FRAGMENTS.some((fragment) => lower.includes(fragment));
};

const ENTRY_KEYS = new Set(['name', 'enabled', 'match', 'sample', 'fields', 'headers', 'maxPerMinute', 'keep']);
const MATCH_STRING_LISTS = ['routes', 'bots', 'devices', 'methods', 'cacheStatuses', 'sources'];
const MATCH_KEYS = new Set([...MATCH_STRING_LISTS, 'statuses', 'urls', 'urlPattern']);
const SAMPLE_KEYS = new Set(['by', 'rate', 'salt']);

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * FNV-1a (the `fnv1a32` in util/hash.js) continued from `h` over `s`'s UTF-16 code units. `Math.imul` by
 * the FNV prime is the same multiply as `fnv1a32`'s shift-add form, so `continueFnv(saltState(salt), url)`
 * equals `fnv1a32(salt + '\n' + url)` — which is what lets an analysis recompute, offline, exactly which
 * URLs a sampler follows.
 */
export const continueFnv = (h, s) => {
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
};

const saltState = (salt) => continueFnv(0x811c9dc5, `${salt}\n`);

/**
 * Whether `url` is in the URL-stable sample: `fnv1a32(salt + '\n' + url) < rate * 2^32`. Exported for the
 * analysis side and the tests; the request path uses the compiled sampler's precomputed salt state.
 */
export const urlIsSampled = (url, { salt, rate }) => fnv1a32(`${salt}\n${url}`) < rate * 4294967296;

const stringList = (value, label, problems, { lower = false, max = 256 } = {}) => {
	if (value === undefined) return null;
	if (!Array.isArray(value)) {
		problems.push(`${label} must be a list`);
		return null;
	}
	if (value.length > max) {
		problems.push(`${label} has ${value.length} entries (at most ${max})`);
		return null;
	}
	const bad = value.filter((entry) => typeof entry !== 'string' || entry === '');
	if (bad.length) {
		problems.push(`${label} must hold non-empty strings`);
		return null;
	}
	// `*` anywhere means "any", so the list is no filter at all.
	if (value.includes('*')) return null;
	return value.map((entry) => (lower ? entry.toLowerCase() : entry));
};

/**
 * Validate and compile one entry. Returns `{ sampler }` or `{ problems }`. The compiled sampler holds only
 * what the request path reads: Sets (or null for "any"), a RegExp, the salt's FNV state and the pick
 * threshold, the field list and the header names.
 */
const compileOne = (raw, index, deniedHeaders) => {
	const problems = [];
	if (!isPlainObject(raw)) return { problems: ['must be an object'] };

	for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) problems.push(`unknown key '${key}'`);

	const name = raw.name;
	if (typeof name !== 'string' || !NAME_RE.test(name)) {
		problems.push('name must be 1-64 letters, digits, dots, dashes or underscores, starting with a letter or digit');
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') problems.push('enabled must be true or false');

	const match = raw.match ?? {};
	if (!isPlainObject(match)) problems.push('match must be an object');
	const lists = {};
	if (isPlainObject(match)) {
		for (const key of Object.keys(match)) if (!MATCH_KEYS.has(key)) problems.push(`unknown key 'match.${key}'`);
		for (const key of MATCH_STRING_LISTS) {
			lists[key] = stringList(match[key], `match.${key}`, problems, { lower: key === 'bots' });
		}
	}
	if (lists.methods) lists.methods = lists.methods.map((method) => method.toUpperCase());

	let statuses = null;
	if (isPlainObject(match) && match.statuses !== undefined) {
		if (
			!Array.isArray(match.statuses) ||
			match.statuses.some((code) => !Number.isInteger(code) || code < 100 || code > 599)
		) {
			problems.push('match.statuses must be a list of HTTP status codes');
		} else statuses = new Set(match.statuses);
	}

	let urls = null;
	if (isPlainObject(match) && match.urls !== undefined) {
		const list = stringList(match.urls, 'match.urls', problems, { max: MAX_URLS });
		// `*` is not a URL; a list that held it would otherwise read as "any URL".
		if (Array.isArray(match.urls) && match.urls.includes('*')) problems.push("match.urls cannot hold '*'");
		else if (list) urls = new Set(list);
	}

	let urlPattern = null;
	if (isPlainObject(match) && match.urlPattern !== undefined) {
		if (typeof match.urlPattern !== 'string' || match.urlPattern === '') {
			problems.push('match.urlPattern must be a non-empty string');
		} else if (match.urlPattern.length > MAX_PATTERN_LENGTH) {
			problems.push(`match.urlPattern is longer than ${MAX_PATTERN_LENGTH} characters`);
		} else {
			try {
				urlPattern = new RegExp(match.urlPattern);
			} catch (e) {
				problems.push(`match.urlPattern does not compile: ${e.message}`);
			}
		}
	}

	const sample = raw.sample ?? {};
	if (!isPlainObject(sample)) problems.push('sample must be an object');
	const by = isPlainObject(sample) ? (sample.by ?? 'url') : 'url';
	const rate = isPlainObject(sample) ? (sample.rate ?? DEFAULT_RATE) : DEFAULT_RATE;
	const salt = isPlainObject(sample) ? (sample.salt ?? name) : name;
	if (isPlainObject(sample)) {
		for (const key of Object.keys(sample)) if (!SAMPLE_KEYS.has(key)) problems.push(`unknown key 'sample.${key}'`);
		if (!SAMPLE_BY.includes(by)) problems.push(`sample.by must be one of ${SAMPLE_BY.join(' | ')}`);
		if (typeof rate !== 'number' || !(rate > 0 && rate <= 1))
			problems.push('sample.rate must be above 0 and at most 1');
		if (typeof salt !== 'string' || salt === '' || salt.length > MAX_SALT_LENGTH) {
			problems.push(`sample.salt must be a non-empty string of at most ${MAX_SALT_LENGTH} characters`);
		}
	}

	let fields = DEFAULT_FIELDS;
	if (raw.fields !== undefined) {
		if (!Array.isArray(raw.fields) || raw.fields.length === 0) problems.push('fields must be a non-empty list');
		else {
			const unknown = raw.fields.filter((field) => !Object.hasOwn(SAMPLE_FIELDS, field));
			if (unknown.length) problems.push(`unknown field(s) ${unknown.map((f) => `'${f}'`).join(', ')}`);
			// `ts` first and once, whatever the list says: every record is a point in time.
			else fields = ['ts', ...new Set(raw.fields.filter((field) => field !== 'ts'))];
		}
	}

	let headers = [];
	if (raw.headers !== undefined) {
		if (!Array.isArray(raw.headers)) problems.push('headers must be a list');
		else if (raw.headers.length > MAX_HEADERS) problems.push(`headers lists more than ${MAX_HEADERS} names`);
		else {
			const lowered = raw.headers.map((header) => (typeof header === 'string' ? header.toLowerCase() : header));
			const bad = lowered.filter((header) => typeof header !== 'string' || !HEADER_RE.test(header));
			const denied = lowered.filter((header) => typeof header === 'string' && isDeniedHeader(header, deniedHeaders));
			if (bad.length) problems.push('headers must be header names');
			else if (denied.length) {
				problems.push(`header(s) ${denied.map((h) => `'${h}'`).join(', ')} are never recorded (credentials)`);
			} else headers = [...new Set(lowered)];
		}
	}

	const maxPerMinute = raw.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;
	if (!Number.isInteger(maxPerMinute) || maxPerMinute < 1 || maxPerMinute > MAX_PER_MINUTE) {
		problems.push(`maxPerMinute must be a whole number from 1 to ${MAX_PER_MINUTE}`);
	}
	const keep = raw.keep ?? DEFAULT_KEEP_MS;
	if (!Number.isInteger(keep) || keep < MIN_KEEP_MS || keep > MAX_KEEP_MS) {
		problems.push(`keep must be whole milliseconds from ${MIN_KEEP_MS} (1h) to ${MAX_KEEP_MS} (90 days)`);
	}

	if (problems.length) return { problems };

	return {
		sampler: {
			index,
			name,
			enabled: raw.enabled !== false,
			routes: lists.routes ? new Set(lists.routes) : null,
			bots: lists.bots ? new Set(lists.bots) : null,
			devices: lists.devices ? new Set(lists.devices) : null,
			methods: lists.methods ? new Set(lists.methods) : null,
			cacheStatuses: lists.cacheStatuses ? new Set(lists.cacheStatuses) : null,
			sources: lists.sources ? new Set(lists.sources) : null,
			statuses,
			urls,
			urlPattern,
			by,
			rate,
			salt,
			saltState: saltState(salt),
			// `<` against this: rate 1 is 2^32, which no 32-bit hash reaches, so every URL is in.
			threshold: rate * 4294967296,
			fields,
			headers,
			wantsConditional: fields.includes('conditional'),
			wantsTarget: fields.some((field) => FLUSH_FIELDS.includes(field)),
			maxPerMinute,
			keep,
			// Runtime state, declared here so every compiled sampler has one shape from the start: the
			// request path reads these on every candidate, and a property added later would change it.
			stats: null,
			minute: -1,
			inMinute: 0,
		},
	};
};

const describeEntry = (raw, index) =>
	isPlainObject(raw) && typeof raw.name === 'string' && raw.name ? `sampler '${raw.name}'` : `sampler #${index}`;

/**
 * Compile the configured list. Invalid entries are dropped with a warning pushed to `warnings`; a second
 * entry with a name already taken is dropped too (the first one wins), because the name is the key the
 * records are stored and read under — two samplers sharing it would interleave into one stream.
 *
 * @param {unknown} list                `sampling.samplers`
 * @param {string[]} warnings           receives one line per dropped entry
 * @param {{ deniedHeaders?: string[] }} options  header names refused besides the built-in list
 */
export const compileSamplers = (list, warnings = [], { deniedHeaders = [] } = {}) => {
	if (!Array.isArray(list)) return [];
	const out = [];
	const names = new Set();
	list.forEach((raw, index) => {
		const { sampler, problems } = compileOne(raw, index, deniedHeaders);
		if (!sampler) {
			warnings.push(`${describeEntry(raw, index)} dropped: ${problems.join('; ')}`);
			return;
		}
		if (names.has(sampler.name)) {
			warnings.push(`${describeEntry(raw, index)} dropped: the name is already used by an earlier sampler`);
			return;
		}
		names.add(sampler.name);
		out.push(sampler);
	});
	return out;
};

/** Counts and warnings for a list, without keeping the compiled samplers — for config warnings and the dry run. */
export const inspectSamplers = (list, options) => {
	const warnings = [];
	const compiled = compileSamplers(list, warnings, options);
	const total = Array.isArray(list) ? list.length : 0;
	return {
		total,
		usable: compiled.length,
		enabled: compiled.filter((sampler) => sampler.enabled).length,
		dropped: total - compiled.length,
		warnings,
	};
};

/** Names that appear on more than one entry of `list` — the one drop a per-entry check cannot see. */
export const duplicateSamplerNames = (list) => {
	const seen = new Set();
	const dup = new Set();
	for (const raw of Array.isArray(list) ? list : []) {
		const name = isPlainObject(raw) ? raw.name : undefined;
		if (typeof name !== 'string') continue;
		if (seen.has(name)) dup.add(name);
		seen.add(name);
	}
	return [...dup];
};

/** A compiled sampler as the admin API shows it: plain data, the Sets and the pattern written back out. */
export const describeSampler = (sampler) => ({
	name: sampler.name,
	enabled: sampler.enabled,
	match: {
		routes: sampler.routes ? [...sampler.routes] : ['*'],
		bots: sampler.bots ? [...sampler.bots] : ['*'],
		devices: sampler.devices ? [...sampler.devices] : ['*'],
		methods: sampler.methods ? [...sampler.methods] : ['*'],
		cacheStatuses: sampler.cacheStatuses ? [...sampler.cacheStatuses] : ['*'],
		sources: sampler.sources ? [...sampler.sources] : ['*'],
		statuses: sampler.statuses ? [...sampler.statuses] : ['*'],
		urls: sampler.urls ? sampler.urls.size : null,
		urlPattern: sampler.urlPattern ? sampler.urlPattern.source : null,
	},
	sample: { by: sampler.by, rate: sampler.rate, salt: sampler.salt },
	fields: sampler.fields,
	headers: sampler.headers,
	maxPerMinute: sampler.maxPerMinute,
	keep: sampler.keep,
});
