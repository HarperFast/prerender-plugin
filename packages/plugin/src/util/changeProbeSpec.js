/**
 * Change-probe rules and content extraction — the PURE half of util/changeProbe.js.
 *
 * A change probe asks the origin "did the fields bots care about change?" far more cheaply than a
 * render can, so re-renders happen when content changes instead of on an interval guess. This
 * module owns everything about a probe that is a pure function of configuration and bytes: rule
 * validation, URL templating, and turning a response body into a comparable SIGNATURE. The sweep
 * that schedules probes, paces them, and acts on the answers lives in util/changeProbe.js.
 *
 * DELIBERATELY DEPENDENCY-FREE. config.js reports rule problems from `collectConfigWarnings`,
 * which is a pure function of config — it can import this module only because this module imports
 * nothing of the runtime (no config, no tables, no globals). Keep it that way.
 *
 * WHY A SIGNATURE AND NOT A DIFF. The probe never needs to know WHAT changed, only WHETHER the
 * watched fields changed — so the observation is reduced to a canonical string
 * (`signatureOf`) and compared to the one stored on the target. That makes the stored state one
 * short column, makes "changed" a string comparison, and means a probe endpoint may return any
 * amount of extra data without the noise mattering: only the extracted fields participate.
 *
 * THE ALL-NULL RULE IS THE SAFETY VALVE. A signature is only valid when at least one extracted
 * field yielded a value. An endpoint that changes shape (the exact failure a replatform produces)
 * extracts all-null — and all-null is treated as a FAILED probe, never as a new signature. Without
 * this rule a shape change would flip every signature in the corpus at once and mass-trigger
 * re-renders of pages that did not change.
 */

const VALID_SOURCES = new Set(['request', 'document']);
const VALID_METHODS = new Set(['GET', 'POST', 'HEAD']);

/**
 * Validate + normalize one raw rule. Returns null for a rule that can't be used, so a single typo
 * drops one rule rather than breaking the list — the same contract as `routeClass.js#compileEntry`,
 * and reported the same way (a warning naming the rule, and a `collectConfigWarnings` finding when
 * the drop leaves an enabled probe with nothing to do).
 */
const compileRule = (raw, index, warn) => {
	const label = typeof raw?.label === 'string' && raw.label !== '' ? raw.label : `rule[${index}]`;

	if (!raw || typeof raw.pathPattern !== 'string' || raw.pathPattern === '') {
		warn(`change-probe ${label}: pathPattern is required (a regular expression matched against the URL path)`);
		return null;
	}
	let pathPattern;
	try {
		pathPattern = new RegExp(raw.pathPattern);
	} catch (e) {
		warn(`change-probe ${label}: pathPattern does not compile as a regular expression (${e.message})`);
		return null;
	}

	const source = raw.source === undefined ? 'document' : raw.source;
	if (!VALID_SOURCES.has(source)) {
		warn(`change-probe ${label}: source must be "request" or "document", got ${String(raw.source)}`);
		return null;
	}

	// Headers apply to both sources (an API wants `accept: application/json`; a document probe
	// rarely needs any). Validated as string->string so a nested object can't reach the fetch.
	const headers = {};
	if (raw.request?.headers !== undefined && raw.request?.headers !== null) {
		if (typeof raw.request.headers !== 'object' || Array.isArray(raw.request.headers)) {
			warn(`change-probe ${label}: request.headers must be an object of header-name -> value`);
			return null;
		}
		for (const [name, value] of Object.entries(raw.request.headers)) {
			if (typeof value !== 'string') {
				warn(`change-probe ${label}: request.headers["${name}"] must be a string`);
				return null;
			}
			headers[String(name).toLowerCase()] = value;
		}
	}

	let request = null;
	let extract = null;

	if (source === 'request') {
		if (typeof raw.request?.urlTemplate !== 'string' || raw.request.urlTemplate === '') {
			warn(`change-probe ${label}: source "request" requires request.urlTemplate`);
			return null;
		}
		const method = raw.request.method === undefined ? 'GET' : String(raw.request.method).toUpperCase();
		if (!VALID_METHODS.has(method)) {
			warn(`change-probe ${label}: request.method must be GET, POST or HEAD, got ${String(raw.request.method)}`);
			return null;
		}
		const body = raw.request.body === undefined || raw.request.body === null ? null : raw.request.body;
		if (body !== null && typeof body !== 'string') {
			warn(`change-probe ${label}: request.body must be a string`);
			return null;
		}
		if (!Array.isArray(raw.extract) || raw.extract.length === 0 || raw.extract.some((p) => typeof p !== 'string')) {
			warn(`change-probe ${label}: source "request" requires extract — a non-empty array of value paths`);
			return null;
		}
		request = { urlTemplate: raw.request.urlTemplate, method, headers, body };
		extract = raw.extract.slice();
	} else {
		// Document mode extracts the schema.org Product offers (price + availability) from the
		// page's own JSON-LD — the generic contract, with nothing site-specific to configure.
		if (raw.extract !== undefined && raw.extract !== null) {
			warn(`change-probe ${label}: extract is ignored for source "document" (it reads the JSON-LD Product offers)`);
		}
		request = { urlTemplate: null, method: 'GET', headers, body: null };
	}

	// The invalidation scope the canary may record on a mass change. Not resolved against the
	// route list here (this module reads no config) — the runtime validates it before acting, and
	// collectConfigWarnings reports an obviously malformed one.
	let invalidateScope = null;
	if (raw.invalidateScope !== undefined && raw.invalidateScope !== null && raw.invalidateScope !== '') {
		if (typeof raw.invalidateScope !== 'string') {
			warn(`change-probe ${label}: invalidateScope must be a string ("all" or "route:<match>:<path>")`);
			return null;
		}
		invalidateScope = raw.invalidateScope;
	}

	return { label, pathPattern, patternSource: raw.pathPattern, source, request, extract, invalidateScope };
};

/**
 * Compile the configured rule list. Invalid rules are dropped individually with a warning —
 * `collect` (an array) receives the messages when provided, else they go to the global logger the
 * way route compilation's do.
 */
export const compileProbeRules = (rules, collect = null) => {
	const warn = collect
		? (message) => collect.push(message)
		: (message) => globalThis.logger?.warn?.(`[prerender] ${message}`);
	const compiled = [];
	for (const [index, raw] of (Array.isArray(rules) ? rules : []).entries()) {
		const rule = compileRule(raw, index, warn);
		if (rule) compiled.push(rule);
	}
	return compiled;
};

/** Compile a PROSPECTIVE rule list and report what it would produce, for config warnings. */
export const inspectProbeRules = (rules) => {
	const warnings = [];
	const compiled = compileProbeRules(rules, warnings);
	const declared = Array.isArray(rules) ? rules.length : 0;
	return { total: declared, usable: compiled.length, dropped: declared - compiled.length, warnings };
};

/**
 * First rule whose pathPattern matches the URL's path, with the match itself (for the template).
 * First match wins, like route matching — order rules most-specific first.
 */
export const ruleForUrl = (rules, url) => {
	const pathname = URL.parse(url)?.pathname;
	if (pathname === undefined) return null;
	for (const rule of rules) {
		const match = pathname.match(rule.pathPattern);
		if (match) return { rule, match };
	}
	return null;
};

/**
 * `$1`..`$9` in the template replaced by the pattern's capture groups, URI-component-encoded —
 * captures land inside path segments and query values, and an unencoded `/` or `&` in one would
 * silently change which resource the probe asks about. An unmatched group substitutes empty.
 */
export const substituteTemplate = (template, match) =>
	template.replace(/\$([1-9])/g, (_, n) => encodeURIComponent(match[Number(n)] ?? ''));

/**
 * The value at a dot/bracket path (`payload.products[0].prices[0].salePrice`) or undefined.
 * Tokens are plain property names and `[N]` numeric indexes; anything unreachable is undefined
 * rather than a throw, because a probe response missing a branch is data, not a bug.
 */
export const valueAtPath = (value, path) => {
	let current = value;
	for (const token of String(path).match(/[^.[\]]+|\[\d+\]/g) ?? []) {
		if (current === null || current === undefined) return undefined;
		const key = token.startsWith('[') ? Number(token.slice(1, -1)) : token;
		current = current[key];
	}
	return current;
};

/** Every configured path extracted from a parsed response, positionally (missing -> null). */
export const extractValues = (json, paths) =>
	paths.map((path) => {
		const value = valueAtPath(json, path);
		return value === undefined ? null : value;
	});

/**
 * The canonical signature for a set of extracted values, or NULL when every value is null —
 * the all-null rule from the module comment: a response that yielded nothing is a failed
 * observation, never a new signature.
 */
export const signatureOf = (values) => {
	if (!Array.isArray(values) || values.length === 0) return null;
	if (values.every((value) => value === null || value === undefined)) return null;
	return JSON.stringify(values.map((value) => (value === undefined ? null : value)));
};

// Matches each JSON-LD block's content. [\s\S] rather than the `s` flag so an attribute in the
// open tag (`<script type="application/ld+json" data-x>`) still matches via [^>]*.
const JSON_LD_BLOCK = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Every parseable JSON-LD node in a document, with `@graph` and top-level arrays flattened. */
const jsonLdNodes = (html) => {
	const nodes = [];
	for (const [, block] of String(html).matchAll(JSON_LD_BLOCK)) {
		let parsed;
		try {
			parsed = JSON.parse(block);
		} catch {
			continue; // one malformed block must not cost the others
		}
		for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
			if (!node || typeof node !== 'object') continue;
			nodes.push(node);
			if (Array.isArray(node['@graph'])) nodes.push(...node['@graph'].filter((n) => n && typeof n === 'object'));
		}
	}
	return nodes;
};

/**
 * Document mode's extraction: the schema.org Product offers, reduced to what drifts —
 * price, currency, and the availability state (the URL form's tail: `InStock`).
 *
 * Multiple offers are SORTED before signing: nothing guarantees the origin serializes offer
 * arrays in a stable order, and a reordering must not read as a content change.
 */
export const extractJsonLdOffers = (html) => {
	const offers = [];
	for (const node of jsonLdNodes(html)) {
		const type = node['@type'];
		const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
		if (!isProduct) continue;
		const list = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : [];
		for (const offer of list) {
			if (!offer || typeof offer !== 'object') continue;
			const availability = typeof offer.availability === 'string' ? offer.availability.split('/').pop() : null;
			offers.push([offer.price ?? null, offer.priceCurrency ?? null, availability]);
		}
	}
	if (!offers.length) return null;
	offers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return offers.flat();
};

/**
 * The HTTP request a rule makes for a URL, or null when the rule does not match it.
 * `request` mode probes the templated endpoint; `document` mode probes the URL itself.
 */
export const buildProbeRequest = (rule, url) => {
	const pathname = URL.parse(url)?.pathname;
	if (pathname === undefined) return null;
	const match = pathname.match(rule.pathPattern);
	if (!match) return null;

	if (rule.source === 'request') {
		return {
			url: substituteTemplate(rule.request.urlTemplate, match),
			method: rule.request.method,
			headers: rule.request.headers,
			body: rule.request.body,
		};
	}
	return { url, method: 'GET', headers: rule.request.headers, body: null };
};
