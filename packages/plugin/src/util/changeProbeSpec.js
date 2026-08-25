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
// No HEAD: extraction parses the response body, and a HEAD probe has none — it would validate
// here and then fail on every single probe, which is the config shape this compiler exists to refuse.
const VALID_METHODS = new Set(['GET', 'POST']);

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
			warn(`change-probe ${label}: request.method must be GET or POST, got ${String(raw.request.method)}`);
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

	// Statuses this endpoint uses to SAY something, rather than to fail. Compiled in declared
	// order; the first whose status matches (and whose `contains` guard, if given, is present in
	// the body) supplies the signature. Dropped individually so one malformed entry does not cost
	// the rule its whole probe.
	const statusSignals = [];
	if (raw.statusSignals !== undefined && raw.statusSignals !== null) {
		if (!Array.isArray(raw.statusSignals)) {
			warn(`change-probe ${label}: statusSignals must be an array of { status, signature, contains? }`);
			return null;
		}
		for (const [i, sig] of raw.statusSignals.entries()) {
			const status = Number(sig?.status);
			if (!Number.isInteger(status) || status < 100 || status > 599) {
				warn(`change-probe ${label}: statusSignals[${i}].status must be an HTTP status 100-599`);
				continue;
			}
			// A 2xx already runs normal extraction; letting a signal shadow it would silently
			// replace real values with a constant and hide a broken extract path.
			if (status >= 200 && status < 300) {
				warn(
					`change-probe ${label}: statusSignals[${i}] declares a 2xx status — 2xx responses are extracted ` +
						`normally, so this signal is ignored`
				);
				continue;
			}
			if (typeof sig.signature !== 'string' || sig.signature === '') {
				warn(`change-probe ${label}: statusSignals[${i}].signature must be a non-empty string`);
				continue;
			}
			if (sig.contains !== undefined && sig.contains !== null && typeof sig.contains !== 'string') {
				warn(`change-probe ${label}: statusSignals[${i}].contains must be a string`);
				continue;
			}
			statusSignals.push({
				status,
				contains: sig.contains === undefined || sig.contains === null || sig.contains === '' ? null : sig.contains,
				signature: sig.signature,
			});
		}
	}

	// Which extracted values correspond to what the PAGE renders, so the probe can ask "does the
	// cached page still agree with the origin" as well as "did the origin change". Site-specific
	// by nature: only the operator knows which field of their endpoint is the price the page
	// prints. Indices into `extract`, so nothing new is fetched. Dropped whole (not per-field) —
	// a half-configured mapping would compare the wrong column.
	let pageCheck = null;
	if (raw.pageCheck !== undefined && raw.pageCheck !== null) {
		const pc = raw.pageCheck;
		if (typeof pc !== 'object' || Array.isArray(pc)) {
			warn(`change-probe ${label}: pageCheck must be an object { enabled, priceFrom, availableFrom }`);
		} else if (pc.enabled === true) {
			if (source !== 'request') {
				// In document mode the stored signature IS the page's own offers, so the page can
				// never disagree with itself and the comparison is meaningless.
				warn(`change-probe ${label}: pageCheck applies to source "request" only — ignored`);
			} else {
				const inBounds = (v) => Number.isInteger(v) && v >= 0 && v < extract.length;
				if (!inBounds(pc.priceFrom) || !inBounds(pc.availableFrom)) {
					warn(
						`change-probe ${label}: pageCheck.priceFrom and .availableFrom must be integer indices into ` +
							`extract (0-${extract.length - 1}) — pageCheck ignored`
					);
				} else {
					pageCheck = { priceFrom: pc.priceFrom, availableFrom: pc.availableFrom };
				}
			}
		}
	}

	return {
		label,
		pathPattern,
		patternSource: raw.pathPattern,
		source,
		request,
		extract,
		invalidateScope,
		statusSignals,
		pageCheck,
	};
};

/**
 * A price as a canonical string, so `35.99` (JSON number, from the endpoint) and `"35.99"`
 * (JSON-LD string, from the page) compare equal. Anything unparseable is null and never matches,
 * which keeps a garbled value from reading as agreement.
 */
const canonicalPrice = (value) => {
	// The empty cases are rejected BEFORE Number(): `Number(null)`, `Number('')` and `Number([])`
	// are all 0, which would turn "this field is absent" into a confident price of 0.00 and make
	// an absent value compare equal to a genuine zero.
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const n = typeof value === 'string' ? Number(value.trim()) : value;
	return Number.isFinite(n) ? n.toFixed(2) : null;
};

/**
 * What the CACHED PAGE claims, as a comparable claim: the set of offer prices it prints and
 * whether ANY of its offers is in stock.
 *
 * "Any offer in stock" is the right reduction because that is what a reader concludes from the
 * page: a product whose every SKU reads OutOfStock presents as unavailable, and one with a single
 * available SKU presents as available. Returns null when the page carries no Product offers —
 * the caller must then leave the stored claim alone, exactly as a failed probe does.
 */
export const pageClaimOf = (html) => {
	const flat = extractJsonLdOffers(html);
	if (!flat) return null;
	const prices = new Set();
	let anyInStock = false;
	// extractJsonLdOffers flattens [price, currency, availability] triples.
	for (let i = 0; i + 3 <= flat.length; i += 3) {
		const price = canonicalPrice(flat[i]);
		if (price !== null) prices.add(price);
		if (typeof flat[i + 2] === 'string' && flat[i + 2].toLowerCase() === 'instock') anyInStock = true;
	}
	if (!prices.size && !anyInStock) return null;
	return JSON.stringify([[...prices].sort(), anyInStock]);
};

/**
 * The same claim shape, projected from the values the probe just extracted from the endpoint.
 * Null when the mapped fields are absent — no claim, so nothing to disagree with.
 */
export const apiClaimOf = (values, pageCheck) => {
	if (!pageCheck || !Array.isArray(values)) return null;
	const price = canonicalPrice(values[pageCheck.priceFrom]);
	const availableRaw = values[pageCheck.availableFrom];
	if (price === null && (availableRaw === null || availableRaw === undefined)) return null;
	return JSON.stringify([price === null ? [] : [price], availableRaw === true || availableRaw === 'true']);
};

/**
 * Do the page's claim and the endpoint's claim disagree?
 *
 * Asymmetric on price BY DESIGN: the page may legitimately print several offer prices (variants)
 * while the endpoint reports one, so the test is whether the endpoint's price is ABSENT from the
 * page's set — not whether the sets are equal. Availability compares directly. Either side being
 * null means "no claim", which is never a disagreement.
 */
export const claimsDisagree = (pageClaim, apiClaim) => {
	if (!pageClaim || !apiClaim) return false;
	let page, api;
	try {
		page = JSON.parse(pageClaim);
		api = JSON.parse(apiClaim);
	} catch {
		return false;
	}
	const [pagePrices, pageInStock] = page;
	const [apiPrices, apiInStock] = api;
	if (apiInStock !== pageInStock) return true;
	if (apiPrices.length && !apiPrices.every((p) => pagePrices.includes(p))) return true;
	return false;
};

/**
 * The signature a declared status signal assigns to this response, or null when none applies.
 *
 * WHY THIS EXISTS. An endpoint's non-2xx is not always a failure: some APIs answer a legitimate
 * state with an error status — most usefully "this product is sold out" as a 4xx with an error
 * code in the body. Without this the probe reads that as a failed probe, leaves the signature
 * untouched and triggers nothing, so the one transition that most needs detecting (available ->
 * unavailable) is exactly the one it cannot see.
 *
 * The signature is an OPAQUE LITERAL, compared for equality like any other. That is what makes the
 * transition detectable in both directions: an in-stock product's extracted values differ from the
 * literal, so selling out changes the signature, and restocking changes it back.
 */
export const statusSignalFor = (rule, statusCode, body) => {
	for (const signal of rule?.statusSignals ?? []) {
		if (signal.status !== statusCode) continue;
		if (signal.contains !== null && !String(body ?? '').includes(signal.contains)) continue;
		return signal.signature;
	}
	return null;
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
	const labels = new Set();
	for (const [index, raw] of (Array.isArray(rules) ? rules : []).entries()) {
		const rule = compileRule(raw, index, warn);
		if (!rule) continue;
		// Labels key everything downstream — canary cohorts, pass records, log lines — so a
		// collision would silently merge two rules' cohorts and mis-attribute their passes.
		// Uniquified rather than dropped: losing probe coverage over a naming clash is the worse trade.
		if (labels.has(rule.label)) {
			const unique = `${rule.label}#${index}`;
			warn(`change-probe ${rule.label}: duplicate label — this rule is reported as "${unique}"`);
			rule.label = unique;
		}
		labels.add(rule.label);
		compiled.push(rule);
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
 * Whether a probe request targets the SAME ORIGIN as the page it is probing for. This gates the
 * origin security token and the staging-IP DNS pin: both belong to the served origin and MUST NOT
 * reach a third-party host a rule happens to name — the same scoping rule the renderer applies to
 * its bypass token (see the repo guide's origin-bypass lesson). Unparseable input reads as
 * cross-origin, the fail-safe direction.
 */
export const isSameProbeOrigin = (targetUrl, probeUrl) => {
	const target = URL.parse(targetUrl);
	const probe = URL.parse(probeUrl);
	return !!target && !!probe && target.origin === probe.origin;
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
