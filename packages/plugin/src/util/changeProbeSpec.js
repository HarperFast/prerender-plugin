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
 * nothing of the runtime (no config, no tables, no globals). Keep it that way. (`./hash.js` is a
 * pure function too; that is the one import.)
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

import { fnv1a32 } from './hash.js';

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
		// A malformed tuple projection would extract null on every probe, forever — a slot that looks
		// configured and watches nothing. Refused here, where the operator sees it, like any other
		// rule defect.
		for (const [i, path] of raw.extract.entries()) {
			const problem = extractPathProblem(path);
			if (problem) {
				warn(`change-probe ${label}: extract[${i}] "${path}": ${problem}`);
				return null;
			}
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
	// prints. Indices into `extract`, so nothing new is fetched. See `compilePageCheck`.
	let pageCheck = null;
	if (raw.pageCheck !== undefined && raw.pageCheck !== null) {
		const pc = raw.pageCheck;
		if (typeof pc !== 'object' || Array.isArray(pc)) {
			warn(
				`change-probe ${label}: pageCheck must be an object { enabled, priceFrom, availableFrom, fields, ignoreChanges }`
			);
		} else if (pc.enabled === true) {
			if (source !== 'request') {
				// In document mode the stored signature IS the page's own offers, so the page can
				// never disagree with itself and the comparison is meaningless.
				warn(`change-probe ${label}: pageCheck applies to source "request" only — ignored`);
			} else {
				pageCheck = compilePageCheck(pc, extract, label, warn);
			}
		} else if (pc.enabled) {
			// `enabled: "true"` (a YAML/JSON string) must not silently disable: a config that LOOKS
			// enabled while protecting nothing is this feature's worst failure mode.
			warn(
				`change-probe ${label}: pageCheck.enabled must be boolean true (got ${JSON.stringify(pc.enabled)}) — pageCheck ignored`
			);
		}
	}

	const rule = {
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
	rule.fingerprint = ruleFingerprint(rule);
	rule.prefixFingerprints = prefixFingerprints(rule);
	return rule;
};

/**
 * Compile an ENABLED request-mode `pageCheck` block, or null when nothing in it is usable.
 *
 * Three independent parts, each validated on its own so one bad part never costs the others:
 *
 *   priceFrom/availableFrom  the original price + availability claim, compiled EXACTLY as before —
 *                            dropped as a pair if either index is out of bounds, because a
 *                            half-applied pair compares the wrong column. Optional once `fields`
 *                            or `ignoreChanges` is given (null here then means "no claim pair").
 *   fields                   the page-record mapping (`compilePageFields`): a bad entry drops that
 *                            entry alone, with a warning.
 *   ignoreChanges            slots whose origin changes never trigger (`compileIgnoreChanges`).
 *
 * The vocabulary (availableValues/unavailableValues) serves both the pair and a `skus` field, so it
 * compiles whenever the block survives.
 */
const compilePageCheck = (pc, extract, label, warn) => {
	const inBounds = (v) => Number.isInteger(v) && v >= 0 && v < extract.length;
	const fields = compilePageFields(pc.fields, inBounds, extract, label, warn);
	const ignoreChanges = compileIgnoreChanges(pc.ignoreChanges, inBounds, extract, label, warn);
	const more = fields.length > 0 || ignoreChanges.length > 0;
	let priceFrom = null;
	let availableFrom = null;
	// Without fields or ignoreChanges the pair is the whole block, so it is required exactly as it
	// always was. With them it is optional — but a pair that IS given must still be a valid one.
	if (
		!more ||
		(pc.priceFrom !== undefined && pc.priceFrom !== null) ||
		(pc.availableFrom !== undefined && pc.availableFrom !== null)
	) {
		if (!inBounds(pc.priceFrom) || !inBounds(pc.availableFrom)) {
			warn(
				`change-probe ${label}: pageCheck.priceFrom and .availableFrom must be integer indices into ` +
					`extract (0-${extract.length - 1}) — ` +
					(more
						? 'the price/availability claim is ignored (fields and ignoreChanges still apply)'
						: 'pageCheck ignored')
			);
			if (!more) return null;
		} else {
			priceFrom = pc.priceFrom;
			availableFrom = pc.availableFrom;
		}
	}
	return { priceFrom, availableFrom, vocabulary: compileVocabulary(pc, label, warn), fields, ignoreChanges };
};

/**
 * The rule's own availability words, on top of the built-in schema.org/retail sets. Tokenized the
 * same way the endpoint's values will be, so "In Stock" and "IN_STOCK" in config meet "in stock" in
 * a response. Invalid lists drop the vocabulary, not pageCheck: the built-in words still apply.
 */
const compileVocabulary = (pc, label, warn) => {
	const words = (key) => {
		const list = pc[key];
		if (list === undefined || list === null) return [];
		if (!Array.isArray(list) || list.some((w) => typeof w !== 'string' || !availabilityToken(w))) {
			warn(`change-probe ${label}: pageCheck.${key} must be an array of availability words — ignored`);
			return null;
		}
		return list.map(availabilityToken);
	};
	const available = words('availableValues');
	const unavailable = words('unavailableValues');
	if (!available || !unavailable || (!available.length && !unavailable.length)) return null;
	const overlap = available.filter((w) => unavailable.includes(w));
	if (overlap.length) {
		warn(
			`change-probe ${label}: pageCheck.availableValues and .unavailableValues both list ` +
				`${overlap.join(', ')} — vocabulary ignored`
		);
		return null;
	}
	return { available: new Set(available), unavailable: new Set(unavailable) };
};

/**
 * `pageCheck.fields`: which extracted slot holds what the page shows as which PAGE FACT, and how
 * the two are compared. Each entry `{ slot, fact, compare, ...options }` compiles to
 * `{ slot, fact, compare, options, label }` where `label` ("<slot>:<fact>") names it in stats and
 * warnings.
 *
 * DROPPED PER ENTRY, never the rule and never the list: a mapping entry is independent of its
 * siblings (each compares its own slot to its own fact), so a typo in one is no reason to stop
 * checking the others. What IS refused is an entry that could only ever compare wrongly — a
 * comparator applied to a fact of the wrong kind (a price set against a title), an unknown fact or
 * comparator, an out-of-bounds slot — because a confident wrong comparison disagrees on every pass
 * and re-renders every page it matches, forever.
 */
const compilePageFields = (list, inBounds, extract, label, warn) => {
	if (list === undefined || list === null) return [];
	if (!Array.isArray(list)) {
		warn(`change-probe ${label}: pageCheck.fields must be an array of { slot, fact, compare } — ignored`);
		return [];
	}
	const fields = [];
	const seen = new Set();
	for (const [i, entry] of list.entries()) {
		const where = `change-probe ${label}: pageCheck.fields[${i}]`;
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			warn(`${where} must be an object { slot, fact, compare } — entry dropped`);
			continue;
		}
		if (!inBounds(entry.slot)) {
			warn(`${where}.slot must be an integer index into extract (0-${extract.length - 1}) — entry dropped`);
			continue;
		}
		if (typeof entry.fact !== 'string' || !Object.hasOwn(PAGE_FACTS, entry.fact)) {
			warn(`${where}.fact must be one of ${Object.keys(PAGE_FACTS).join(', ')} — entry dropped`);
			continue;
		}
		if (typeof entry.compare !== 'string' || !Object.hasOwn(COMPARATORS, entry.compare)) {
			warn(`${where}.compare must be one of ${Object.keys(COMPARATORS).join(', ')} — entry dropped`);
			continue;
		}
		const comparator = COMPARATORS[entry.compare];
		const kind = PAGE_FACTS[entry.fact].kind;
		if (!comparator.kinds.includes(kind)) {
			const fitting = Object.keys(COMPARATORS).filter((name) => COMPARATORS[name].kinds.includes(kind));
			warn(
				`${where}: compare "${entry.compare}" does not apply to fact "${entry.fact}" (use ${fitting.join(' or ')}) — entry dropped`
			);
			continue;
		}
		let problem = null;
		const options = comparator.options(entry, (message) => {
			problem = message;
		});
		if (problem !== null) {
			warn(`${where}: ${problem} — entry dropped`);
			continue;
		}
		const unknown = Object.keys(entry).filter(
			(key) => key !== 'slot' && key !== 'fact' && key !== 'compare' && !comparator.keys.includes(key)
		);
		if (unknown.length) warn(`${where}: unknown key(s) ${unknown.join(', ')} ignored`);
		const fieldLabel = `${entry.slot}:${entry.fact}`;
		if (seen.has(fieldLabel)) {
			warn(`${where} maps slot ${entry.slot} to ${entry.fact} a second time — entry dropped`);
			continue;
		}
		seen.add(fieldLabel);
		fields.push({ slot: entry.slot, fact: entry.fact, compare: entry.compare, options, label: fieldLabel });
	}
	return fields;
};

/**
 * `pageCheck.ignoreChanges`: extract slots whose origin changes do NOT trigger a re-render — the
 * fields the page cannot show (an inventory counter, a store flag), watched only because the
 * endpoint returns them next to fields it can. A change confined to these slots writes the new
 * baseline and triggers nothing, and the canary does not count it as a change either. Returned
 * sorted and de-duplicated; a bad entry drops alone.
 */
const compileIgnoreChanges = (list, inBounds, extract, label, warn) => {
	if (list === undefined || list === null) return [];
	if (!Array.isArray(list)) {
		warn(`change-probe ${label}: pageCheck.ignoreChanges must be an array of extract indices — ignored`);
		return [];
	}
	const slots = new Set();
	for (const [i, slot] of list.entries()) {
		if (!inBounds(slot)) {
			warn(
				`change-probe ${label}: pageCheck.ignoreChanges[${i}] must be an integer index into extract ` +
					`(0-${extract.length - 1}) — entry dropped`
			);
			continue;
		}
		slots.add(slot);
	}
	if (slots.size === extract.length) {
		warn(
			`change-probe ${label}: pageCheck.ignoreChanges lists EVERY extract slot — no origin change on this rule ` +
				`will ever trigger a re-render; only page mismatches (pageCheck fields) will`
		);
	}
	return [...slots].sort((a, b) => a - b);
};

/**
 * What a rule OBSERVES, hashed: the endpoint, how it is asked, which values are taken from the
 * answer, and which statuses stand in for values. Stored beside every baseline (ProbeState.
 * ruleFingerprint) so the sweep can tell "the origin changed" from "the rule changed".
 *
 * WHY THIS EXISTS. A stored signature is only comparable to an observation made THE SAME WAY.
 * Edit a rule's extract list, move it to another endpoint, add a header that changes which
 * backend answers — and the next probe of every matched URL produces a differently-shaped
 * signature. Without this, that read as 100% of the corpus changing in one pass: every URL a
 * spurious re-render (bounded by maxTriggersPerSweep, so most of them deferred and retried
 * forever), and the canary a certain trip, invalidating the rule's whole scope over a config
 * edit. The only safe way to change a rule was a full dry-run cycle first. With the fingerprint,
 * a mismatch re-baselines that URL — observation stored, nothing compared, nothing triggered,
 * and it does not count toward the canary's verdict — so a rule edit costs one pass of blindness
 * for the edited rule and nothing else. APPENDING extract paths costs not even that: see
 * `prefixFingerprints`.
 *
 * WHAT IS IN IT, AND WHAT IS NOT. Everything that shapes the observed value: source, URL
 * template, method, headers (a cookie or header can route to a different backend), body,
 * extract paths, status signals (a signal is a value). NOT the label, the pathPattern (which
 * URLs match, not what is seen of them), invalidateScope or pageCheck (how an observation is
 * acted on, not what it is). Header keys are sorted so a reordered YAML map is not a new rule.
 */
export const ruleFingerprint = (rule) => {
	const headers = Object.fromEntries(
		Object.entries(rule.request?.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	);
	const observed =
		rule.source === 'request'
			? {
					source: 'request',
					url: rule.request.urlTemplate,
					method: rule.request.method,
					headers,
					body: rule.request.body ?? null,
					extract: rule.extract,
					signals: rule.statusSignals,
				}
			: { source: 'document', headers, signals: rule.statusSignals };
	return fnv1a32(JSON.stringify(observed)).toString(16).padStart(8, '0');
};

/**
 * The fingerprint this rule WOULD have had with its extract list cut to its first k paths, for
 * every 1 <= k < extract.length, mapped to k. A baseline stored under one of them was taken before
 * the rest of the paths were APPENDED, and is still comparable on the slots it has.
 *
 * WHY THIS EXISTS. A full re-baseline is the right answer to a real rule change, and the wrong one
 * to the commonest edit there is: adding a field. Appending one path (a per-variant availability
 * projection, say) left every existing slot observed exactly as before, yet the fingerprint moved,
 * so every matched URL spent a pass re-baselining with nothing compared. In anchored mode that pass
 * is the nightly one scheduled right after the origin's daily change, so a whole night of changes
 * on the fields the rule ALREADY watched went undetected until each page's cadence render. With
 * this map the sweep compares those slots (`signatureUnderPrefix`) and upgrades the baseline in the
 * same write.
 *
 * Built with `ruleFingerprint` itself over the sliced list, so a fingerprint stored by the shorter
 * rule — today, in production — matches with no migration. Everything else in the fingerprint must
 * be identical for a prefix to match: an edit that ALSO changes the endpoint, a header, the body or
 * a status signal is a different observation and still re-baselines. Removing, reordering or
 * rewording an existing path matches no prefix either. Document mode has no extract list, so its
 * map is empty.
 */
export const prefixFingerprints = (rule) => {
	const prefixes = new Map();
	if (rule.source !== 'request' || !Array.isArray(rule.extract)) return prefixes;
	for (let k = 1; k < rule.extract.length; k++) {
		prefixes.set(ruleFingerprint({ ...rule, extract: rule.extract.slice(0, k) }), k);
	}
	return prefixes;
};

// A signature's slots, or null for anything that is not a JSON array (a status-signal literal).
const slotsOf = (signature) => {
	try {
		const values = JSON.parse(signature);
		return Array.isArray(values) ? values : null;
	} catch {
		return null;
	}
};

/**
 * The observation as the rule's first `k` extract paths would have signed it — the string to
 * compare with a baseline taken before the rest were appended — or null when either side does not
 * have the shape those rules write, and the caller must re-baseline as for any rule change.
 *
 * BYTE FOR BYTE what `signatureOf` built for the shorter rule. Each path is extracted on its own, so
 * this observation's first k values ARE the shorter rule's values for the same response, and
 * `observed` is `signatureOf`'s JSON of them: parse, slice and stringify reproduces the shorter
 * rule's string exactly (JSON.stringify is stable through a JSON.parse of its own output), so equal
 * values compare equal. What it deliberately does NOT do is apply the all-null rule to the prefix.
 * The observation as a whole was valid; old slots gone null beside a new one that is not is a value
 * change, and the longer rule reports it as one against its own baseline too.
 *
 * A status-signal LITERAL has no slots and passes through whole, so it compares as it always has:
 * the same literal is unchanged, and a literal against values (either way round) is a change.
 *
 * THE SHAPE CHECK is what stands between this and the failure fingerprints exist to prevent —
 * every row of an upgrade reading as a change. The shorter rule only ever stored one of its
 * literals (status signals are in the fingerprint, so they are this rule's too) or exactly `k`
 * values; a baseline that is neither matched its prefix by hash collision or was never written by
 * that rule, and is not comparable. The observation is held to its own shape the same way.
 */
export const signatureUnderPrefix = (rule, k, storedSignature, observed) => {
	const literals = new Set((rule.statusSignals ?? []).map((signal) => signal.signature));
	if (!literals.has(storedSignature) && slotsOf(storedSignature)?.length !== k) return null;
	if (literals.has(observed)) return observed;
	const values = slotsOf(observed);
	if (!values || values.length !== rule.extract?.length) return null;
	return JSON.stringify(values.slice(0, k));
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
 * Availability vocabularies, matched after reducing a schema.org URL form to its last segment.
 * AVAILABLE is Google's own "in stock" reading (InStock, InStoreOnly, OnlineOnly,
 * LimitedAvailability); UNAVAILABLE is the definitive negative. Everything else — PreOrder,
 * BackOrder, a site's private vocabulary — is NO verdict: a value the plugin cannot confidently
 * read must make the claim incomparable, never a guess. A wrong guess here disagrees with the
 * endpoint on EVERY pass and hard-expires every matched page, forever — the one failure mode this
 * feature must not have — so an unrecognized vocabulary degrades to "detects nothing" instead.
 */
const AVAILABLE = new Set(['instock', 'instoreonly', 'onlineonly', 'limitedavailability', 'available']);
const UNAVAILABLE = new Set(['outofstock', 'soldout', 'discontinued', 'unavailable']);

/**
 * A vocabulary token: the last path segment of a schema.org URL form, lower-cased, with every
 * separator dropped — so `https://schema.org/InStock`, `InStock`, `IN_STOCK`, `in-stock` and the
 * plain retail phrase `In Stock` all reduce to `instock`. Endpoints spell availability every one
 * of these ways; the plugin is not the place to know which retailer uses which.
 */
export const availabilityToken = (raw) =>
	String(raw)
		.split('/')
		.filter(Boolean)
		.pop()
		?.toLowerCase()
		.replace(/[^a-z0-9]/g, '') ?? '';

/**
 * The verdict for one availability word: true, false, or null for no verdict. `vocabulary` is a
 * rule's own `{ available, unavailable }` token sets (pageCheck.availableValues /
 * unavailableValues), consulted BEFORE the built-in schema.org/retail sets so an operator can
 * both extend the vocabulary and override a built-in reading for their endpoint.
 */
const availabilityVerdict = (raw, vocabulary = null) => {
	if (typeof raw !== 'string') return null;
	const token = availabilityToken(raw);
	if (!token) return null;
	if (vocabulary?.available.has(token)) return true;
	if (vocabulary?.unavailable.has(token)) return false;
	if (AVAILABLE.has(token)) return true;
	if (UNAVAILABLE.has(token)) return false;
	return null;
};

/**
 * What the CACHED PAGE claims, as a comparable claim: the set of offer prices it prints, and an
 * availability verdict — true when ANY offer is in stock (that is what a reader concludes from the
 * page), false only when every stated availability is a definitive negative, null when the
 * vocabulary is mixed or unrecognized (no claim, so never a disagreement).
 *
 * The offers come from the RENDERER, which extracts them from its live DOM and posts them with the
 * result (browser >= 1.20.0) — strictly better than doing it here, where it would mean a regex
 * scan and JSON parse of a ~1MB document on the hottest write path in the system to recover data
 * the browser had structured in front of it. There is deliberately no HTML-parsing fallback;
 * pageCheck is simply inert against an older renderer.
 *
 * Shape is the renderer's: a flat [price, currency, availability] triple sequence. Returns null
 * when nothing comparable can be read — the caller must then leave the stored claim alone,
 * exactly as a failed probe does.
 */
export const pageClaimFromOffers = (flat) => {
	if (!Array.isArray(flat) || !flat.length) return null;
	const prices = new Set();
	let sawAvailable = false;
	let sawUnavailable = false;
	let sawUnrecognized = false;
	for (let i = 0; i + 3 <= flat.length; i += 3) {
		const price = canonicalPrice(flat[i]);
		if (price !== null) prices.add(price);
		const verdict = availabilityVerdict(flat[i + 2]);
		if (verdict === true) sawAvailable = true;
		else if (verdict === false) sawUnavailable = true;
		else if (flat[i + 2] !== null && flat[i + 2] !== undefined) sawUnrecognized = true;
	}
	const inStock = sawAvailable ? true : sawUnavailable && !sawUnrecognized ? false : null;
	if (!prices.size && inStock === null) return null;
	return JSON.stringify([[...prices].sort(), inStock]);
};

/**
 * The endpoint's availability field as a verdict. Three shapes are readable, everything else is
 * NO claim (null) — a field this plugin cannot read must degrade to "detects nothing", never to
 * a guess that disagrees with every page on every pass:
 *
 *   boolean (or 'true'/'false')   the verdict itself
 *   string                        an availability word, read by `availabilityVerdict` — the
 *                                 schema.org forms, the plain retail phrases ("In Stock",
 *                                 "Out of Stock", "Sold Out") and the rule's own vocabulary
 *   array (a `[*]` projection)    per-variant words: in stock when ANY variant is, out of stock
 *                                 only when every readable variant is and none is unreadable —
 *                                 the same reduction `pageClaimFromOffers` applies to the page's
 *                                 offers, so the two sides answer the same question
 */
const availabilityClaim = (raw, vocabulary) => {
	if (raw === true || raw === 'true') return true;
	if (raw === false || raw === 'false') return false;
	if (typeof raw === 'string') return availabilityVerdict(raw, vocabulary);
	if (Array.isArray(raw)) {
		let sawAvailable = false;
		let sawUnavailable = false;
		let sawUnrecognized = false;
		for (const item of raw) {
			const verdict = availabilityClaim(item, vocabulary);
			if (verdict === true) sawAvailable = true;
			else if (verdict === false) sawUnavailable = true;
			// EVERY element that yields no verdict counts as unreadable, including a null one. A
			// `[*]` projection writes exactly null where the path could not be walked — a variant
			// that simply has no availability field yet — so skipping nulls let a list of one
			// sold-out variant and one unreadable variant answer a confident "out of stock" that
			// the endpoint never said. That claim is compared against the page's own, and a
			// disagreement expires a page: the cost of guessing here is paid in origin traffic on
			// products that were never out of stock.
			else sawUnrecognized = true;
		}
		return sawAvailable ? true : sawUnavailable && !sawUnrecognized ? false : null;
	}
	return null;
};

/**
 * The same claim shape, projected from the values the probe just extracted from the endpoint.
 * Null when neither field yields a claim.
 */
export const apiClaimOf = (values, pageCheck) => {
	// A block with no claim pair (fields or ignoreChanges only) projects no claim at all — an index
	// of null would read `values[null]` and happen to yield nothing, which is not a contract.
	if (!pageCheck || !Array.isArray(values) || pageCheck.priceFrom === null || pageCheck.priceFrom === undefined) {
		return null;
	}
	const price = canonicalPrice(values[pageCheck.priceFrom]);
	const available = availabilityClaim(values[pageCheck.availableFrom], pageCheck.vocabulary ?? null);
	if (price === null && available === null) return null;
	return JSON.stringify([price === null ? [] : [price], available]);
};

/**
 * Do the page's claim and the endpoint's claim disagree?
 *
 * Asymmetric on price BY DESIGN: the page may legitimately print several offer prices (variants)
 * while the endpoint reports one, so the test is whether the endpoint's price is ABSENT from the
 * page's set — not whether the sets are equal. Each dimension compares only when both sides
 * actually claim it; a null/empty side is "no claim", which is never a disagreement.
 */
export const claimsDisagree = (pageClaim, apiClaim) => {
	if (!pageClaim || !apiClaim) return false;
	try {
		const page = JSON.parse(pageClaim);
		const api = JSON.parse(apiClaim);
		// Shape-check INSIDE the try, and destructure only after. A stored claim is data from a
		// previous release (or a corrupted row), so it may be any JSON at all — destructuring a
		// non-array throws, and this runs inside the sweep's per-URL path where an uncaught throw
		// would end the whole pass. Anything unrecognisable reads as "no comparable claim".
		if (!Array.isArray(page) || !Array.isArray(api)) return false;
		const [pagePrices, pageInStock] = page;
		const [apiPrices, apiInStock] = api;
		if (!Array.isArray(pagePrices) || !Array.isArray(apiPrices)) return false;
		// Availability compares only when BOTH sides hold a boolean verdict — null means that side
		// makes no availability claim (unrecognized vocabulary, unmapped field), and no claim is
		// never a disagreement.
		if (typeof pageInStock === 'boolean' && typeof apiInStock === 'boolean' && apiInStock !== pageInStock) return true;
		// Price compares only when the page prints at least one price the plugin could read: an
		// unreadable price format (currency-prefixed strings, an AggregateOffer) must reduce to
		// "no price claim", not to "disagrees with every endpoint price" — the latter re-expires
		// the page after every render, forever.
		return pagePrices.length > 0 && apiPrices.length > 0 && !apiPrices.every((price) => pagePrices.includes(price));
	} catch {
		return false;
	}
};

// ---- the page record: what each cached page claims, field by field ------------------------------

/**
 * THE PAGE RECORD generalizes the price/availability claim above to every field a page visibly
 * states. The renderer reads them off the settled DOM (`pageFacts`, @harperfast/prerender-browser
 * >= 1.37.0) and posts them with the result; the render path stores them beside the claim
 * (`ProbeState.pageFacts`, see changeProbe.js recordPageClaim); and each probe compares them with
 * the slots a rule maps (`pageCheck.fields`). That lets the probe ask "is the CACHED PAGE wrong"
 * instead of only "did the ORIGIN change" — so it re-renders a page that disagrees on any mapped
 * field, and does NOT re-render one that already shows the new value (a cadence render that landed
 * after the change).
 *
 * EVERY COMPARATOR FAILS TOWARD NO CLAIM, NEVER A GUESS. Null, absent, empty or unparseable on
 * either side is "not compared" (null), never a disagreement: a confident wrong comparison
 * disagrees on every pass and re-renders every page it matches, forever — the one failure this
 * feature must not have. The comparators are a CLOSED set of typed functions rather than
 * configurable transforms for the same reason: each one encodes a measured quirk of how an
 * endpoint and a page state the same fact, and nothing else.
 */

/** Largest page record stored, in UTF-8 bytes — see `serializePageFacts`. */
export const PAGE_FACTS_MAX_BYTES = 16 * 1024;

/**
 * The page facts a mapping may name, with the KIND of value each holds. The kind decides which
 * comparators apply, so a nonsensical pairing (a price set against a title) is refused at compile
 * time instead of disagreeing at run time.
 */
const PAGE_FACTS = {
	'canonical': { kind: 'url', get: (facts) => facts.canonical },
	'title': { kind: 'text', get: (facts) => facts.title },
	'metaDescription': { kind: 'text', get: (facts) => facts.metaDescription },
	'h1': { kind: 'text', get: (facts) => facts.h1 },
	'product.name': { kind: 'text', get: (facts) => facts.product?.name },
	'product.brand': { kind: 'text', get: (facts) => facts.product?.brand },
	'product.image': { kind: 'url', get: (facts) => facts.product?.image },
	'product.rating.value': { kind: 'number', get: (facts) => facts.product?.rating?.[0] },
	'product.rating.count': { kind: 'number', get: (facts) => facts.product?.rating?.[1] },
	'product.offers': { kind: 'offers', get: (facts) => facts.product?.offers },
	'breadcrumbs': { kind: 'names', get: (facts) => facts.breadcrumbs },
};

/**
 * Text as a page and an endpoint both state it: NFC, every whitespace run (NBSP and line breaks
 * included) collapsed to one space, trimmed. Deliberately NOT case-folded and NOT HTML-stripped —
 * measured, an endpoint's meta description can carry `<br>` and `<li><a …>` while the page's
 * `<meta name=description>` holds that exact raw string, so stripping would turn a 100% match into
 * a disagreement. Non-strings and empty text are no claim.
 */
const normalizeText = (value) => {
	if (typeof value !== 'string') return null;
	const text = value.normalize('NFC').replace(/\s+/g, ' ').trim();
	return text === '' ? null : text;
};

/**
 * A URL's PATH, the only part of it an endpoint and a page reliably agree on: measured, the
 * endpoint's image URL differed from the page's on every page, only by size query parameters.
 * Origin, query and fragment are ignored; a relative value resolves against the page's own URL.
 * `decodeURI` (not `decodeURIComponent`) so `%7E` meets `~` without `%2F` turning into a separator.
 */
const pathOf = (value, base) => {
	if (typeof value !== 'string' || value.trim() === '') return null;
	const url = URL.parse(value.trim(), base ?? undefined);
	if (!url) return null;
	try {
		return decodeURI(url.pathname);
	} catch {
		return url.pathname;
	}
};

/** A finite number from a number or a numeric string ("4.0" from an endpoint, 4 from JSON-LD). */
const numberOf = (value) => {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string' || value.trim() === '') return null;
	const n = Number(value.trim());
	return Number.isFinite(n) ? n : null;
};

/**
 * The distinct canonical prices of a value, or null when ANY element is unreadable: a set with a
 * hole in it cannot be compared for equality, and guessing the hole away would disagree with the
 * page on every pass for that product. Measured, an endpoint's single "lowest price" is null
 * exactly when the product is out of stock, so a null here is "no claim" and nothing more.
 */
const priceSetOf = (list) => {
	if (!Array.isArray(list) || !list.length) return null;
	const prices = new Set();
	for (const item of list) {
		const price = canonicalPrice(item);
		if (price === null) return null;
		prices.add(price);
	}
	return prices;
};

const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));

/** A SKU key: a non-empty string, or a number in its string form (the renderer's convention). */
const skuKey = (value) => {
	if (typeof value === 'string') return value.trim() || null;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
};

/**
 * Per-SKU state keyed by SKU, with every SKU that appears more than once set aside in `dups`: two
 * different states for one key is ambiguous, and ambiguity is no claim.
 */
const keyedBySku = (entries, read) => {
	const map = new Map();
	const dups = new Set();
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!Array.isArray(entry)) continue;
		const state = read(entry);
		if (state.sku === null) continue;
		if (map.has(state.sku) || dups.has(state.sku)) {
			map.delete(state.sku);
			dups.add(state.sku);
			continue;
		}
		map.set(state.sku, state);
	}
	return { map, dups };
};

// The endpoint's tuples under a field's `tuple` naming, and the page's [sku, price, currency,
// availability] offers, both as { sku, price, availability }.
const apiSkus = (value, tuple) =>
	keyedBySku(value, (entry) => ({
		sku: skuKey(entry[tuple.sku]),
		price: tuple.price === null ? undefined : entry[tuple.price],
		availability: tuple.availability === null ? undefined : entry[tuple.availability],
	}));
const pageSkus = (offers) =>
	keyedBySku(offers, (offer) => ({ sku: skuKey(offer[0]), price: offer[1], availability: offer[3] }));

/**
 * One SKU on both sides: false when the availability VERDICTS differ (both must be readable — the
 * same tri-state reduction the claim pair uses, the rule's vocabulary on the endpoint side) or,
 * when both state one, the prices differ; true when at least one of those was compared and agreed;
 * null when neither could be.
 */
const skuVerdict = (api, page, tuple, vocabulary) => {
	let compared = false;
	if (tuple.availability !== null) {
		const apiInStock = availabilityClaim(api.availability, vocabulary);
		const pageInStock = availabilityVerdict(page.availability);
		if (typeof apiInStock === 'boolean' && typeof pageInStock === 'boolean') {
			if (apiInStock !== pageInStock) return false;
			compared = true;
		}
	}
	if (tuple.price !== null) {
		const apiPrice = canonicalPrice(api.price);
		const pagePrice = canonicalPrice(page.price);
		if (apiPrice !== null && pagePrice !== null) {
			if (apiPrice !== pagePrice) return false;
			compared = true;
		}
	}
	return compared ? true : null;
};

const noOptions = () => ({});

/**
 * The closed set of comparators. `kinds` are the fact kinds each applies to, `keys` the extra
 * entry keys it reads, `options` validates them (calling `fail` on a bad one), and `compare`
 * returns true (agrees), false (disagrees) or null (not compared).
 */
const COMPARATORS = {
	// Exact after normalizeText. Measured 100% on title, product name, h1, meta description, brand.
	text: {
		kinds: ['text', 'url'],
		keys: [],
		options: noOptions,
		compare: (api, page) => {
			const a = normalizeText(api);
			const b = normalizeText(page);
			return a === null || b === null ? null : a === b;
		},
	},
	// URL pathname only. Measured 100% on an SEO URL against the canonical's path; required for
	// images, whose URLs differ on every page by size parameters alone.
	path: {
		kinds: ['url'],
		keys: [],
		options: noOptions,
		compare: (api, page, field, ctx) => {
			const a = pathOf(api, ctx.pageUrl);
			const b = pathOf(page, ctx.pageUrl);
			return a === null || b === null ? null : a === b;
		},
	},
	// Numeric equality with an optional absolute tolerance: an endpoint's rating is "4.0", the
	// page's 4.
	number: {
		kinds: ['number'],
		keys: ['tolerance'],
		options: (entry, fail) => {
			const tolerance = entry.tolerance === undefined || entry.tolerance === null ? 0 : entry.tolerance;
			if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
				fail('tolerance must be a finite number >= 0');
			}
			return { tolerance };
		},
		compare: (api, page, field) => {
			const a = numberOf(api);
			const b = numberOf(page);
			return a === null || b === null ? null : Math.abs(a - b) <= field.options.tolerance + 1e-9;
		},
	},
	// The endpoint's price (a number, or a list from a `[*]` projection) against the SET of prices
	// the page's offers print — distinct canonical 2-decimal strings, set EQUALITY. Measured 100%
	// where the endpoint's price list and the page's offers describe the same variants. Where the
	// page lists fewer offers than the endpoint has variants, use `skus` instead: set equality over
	// a truncated list disagrees on the missing prices, on every pass.
	priceSet: {
		kinds: ['offers'],
		keys: [],
		options: noOptions,
		compare: (api, page) => {
			const a = priceSetOf(Array.isArray(api) ? api : [api]);
			const b = Array.isArray(page) ? priceSetOf(page.map((offer) => (Array.isArray(offer) ? offer[1] : null))) : null;
			return a === null || b === null ? null : sameSet(a, b);
		},
	},
	// An ordered list of names (strings, or objects carrying `nameKey`, default "name") against the
	// page's list, as a SUFFIX: measured, a page's breadcrumbs open with a site-home crumb the
	// endpoint omits, so the endpoint's list is compared with the page list's tail of the same
	// length — no per-site configuration. An endpoint list LONGER than the page's is a disagreement
	// (the page is missing levels). Extract the list itself, not a `[*]` projection: projections are
	// sorted, and order is what this compares.
	names: {
		kinds: ['names'],
		keys: ['nameKey'],
		options: (entry, fail) => {
			const nameKey = entry.nameKey === undefined || entry.nameKey === null ? 'name' : entry.nameKey;
			if (typeof nameKey !== 'string' || nameKey === '') fail('nameKey must be a non-empty string');
			return { nameKey };
		},
		compare: (api, page, field) => {
			if (!Array.isArray(api) || !api.length || !Array.isArray(page) || !page.length) return null;
			const names = [];
			for (const item of api) {
				const raw = item && typeof item === 'object' && !Array.isArray(item) ? item[field.options.nameKey] : item;
				const name = normalizeText(raw);
				if (name === null) return null;
				names.push(name);
			}
			const crumbs = page.map(normalizeText);
			if (crumbs.includes(null)) return null;
			if (names.length > crumbs.length) return false;
			const tail = crumbs.slice(crumbs.length - names.length);
			return names.every((name, i) => name === tail[i]);
		},
	},
	// Per-variant state: the endpoint's tuples (a `[*].{…}` projection) against the page's offers,
	// keyed by SKU, over the INTERSECTION of SKUs only — measured, a page lists at most 50 SKU offers
	// where the endpoint lists more, so a SKU missing from either side is not a disagreement.
	// `tuple` names each tuple position: "sku" (required), "availability", "price", or null to skip
	// a position; default ["sku", "availability", "price"].
	skus: {
		kinds: ['offers'],
		keys: ['tuple'],
		options: (entry, fail) => {
			const names = entry.tuple === undefined || entry.tuple === null ? ['sku', 'availability', 'price'] : entry.tuple;
			const tuple = { sku: null, availability: null, price: null };
			if (!Array.isArray(names) || !names.length) {
				fail('tuple must be an array naming each tuple position ("sku", "availability", "price" or null)');
				return null;
			}
			for (const [i, name] of names.entries()) {
				if (name === null) continue;
				if (!Object.hasOwn(tuple, name) || tuple[name] !== null) {
					fail(`tuple[${i}] must be "sku", "availability", "price" or null, each at most once`);
					return null;
				}
				tuple[name] = i;
			}
			if (tuple.sku === null || (tuple.availability === null && tuple.price === null)) {
				fail('tuple must name "sku" and at least one of "availability" or "price"');
				return null;
			}
			return { tuple };
		},
		compare: (api, page, field, ctx) => {
			if (!Array.isArray(api) || !Array.isArray(page)) return null;
			const { tuple } = field.options;
			const endpoint = apiSkus(api, tuple).map;
			const offers = pageSkus(page).map;
			let agreed = false;
			for (const [sku, state] of endpoint) {
				const offer = offers.get(sku);
				if (!offer) continue;
				const verdict = skuVerdict(state, offer, tuple, ctx.vocabulary);
				if (verdict === false) return false;
				if (verdict === true) agreed = true;
			}
			return agreed ? true : null;
		},
	},
};

/**
 * One mapped field's verdict: true (the page agrees with the endpoint value), false (disagrees),
 * null (not compared). `facts` is a parsed page record (`parsePageFacts`), `ctx` is
 * `{ pageUrl, vocabulary }`. Never throws — a comparator fault on data from a previous release or
 * a corrupted row must not end the sweep; it is no claim.
 */
export const compareField = (field, apiValue, facts, ctx = {}) => {
	if (!facts || apiValue === null || apiValue === undefined) return null;
	try {
		const pageValue = PAGE_FACTS[field.fact].get(facts);
		if (pageValue === null || pageValue === undefined) return null;
		return COMPARATORS[field.compare].compare(apiValue, pageValue, field, ctx);
	} catch {
		return null;
	}
};

/**
 * Has the page CAUGHT UP with a change in this field's slot — does it already show `after`, the
 * value the probe just observed in place of `before`? True only on positive evidence, because a
 * true here is what lets a real change go un-rendered.
 *
 * THE PAGE MUST AGREE WITH THE NEW VALUE AND NOT WITH THE OLD ONE. Agreement with `after` alone is
 * not evidence when the change is invisible to the comparator: a crumb's URL changing inside a
 * `names` object (only names are compared), a query parameter under `path`, a whitespace edit under
 * `text`, a variant removed from a `priceSet` without changing the set. The page agrees with both
 * values then, so nothing says it was re-rendered since — and the part that changed may well be on
 * the page (a crumb's link) and stale. Those changes trigger, exactly as they did before fields.
 *
 * `skus` compares an intersection, so even that proves nothing about the SKU that actually changed —
 * it may be one the page does not list (the page's offers are truncated), and reading "the SKUs I
 * can see agree" as "the page caught up" would swallow that change. So every SKU whose tuple changed
 * is proven on its own: a SKU still at the endpoint must be on the page, agreeing with its new state
 * and not its old one (a change only in a skipped tuple position proves nothing); a SKU gone from the
 * endpoint must be gone from the page. A changed tuple that cannot be keyed (no SKU, or a duplicated
 * one) is not provable at all.
 */
export const fieldCaughtUp = (field, before, after, facts, ctx = {}) => {
	if (compareField(field, after, facts, ctx) !== true) return false;
	if (compareField(field, before, facts, ctx) === true) return false;
	if (field.compare !== 'skus') return true;
	try {
		const { tuple } = field.options;
		const was = apiSkus(before, tuple);
		const now = apiSkus(after, tuple);
		const page = pageSkus(PAGE_FACTS['product.offers'].get(facts));
		const beforeTuples = new Set((Array.isArray(before) ? before : []).map((entry) => JSON.stringify(entry)));
		const afterTuples = new Set((Array.isArray(after) ? after : []).map((entry) => JSON.stringify(entry)));
		const changed = [
			...(Array.isArray(after) ? after : []).filter((entry) => !beforeTuples.has(JSON.stringify(entry))),
			...(Array.isArray(before) ? before : []).filter((entry) => !afterTuples.has(JSON.stringify(entry))),
		];
		for (const entry of changed) {
			const sku = Array.isArray(entry) ? skuKey(entry[tuple.sku]) : null;
			if (sku === null || was.dups.has(sku) || now.dups.has(sku) || page.dups.has(sku)) return false;
			const state = now.map.get(sku);
			const offer = page.map.get(sku);
			if (state) {
				if (!offer || skuVerdict(state, offer, tuple, ctx.vocabulary) !== true) return false;
				const old = was.map.get(sku);
				if (old && skuVerdict(old, offer, tuple, ctx.vocabulary) === true) return false;
			} else if (offer) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
};

/**
 * The slot indices at which two signatures differ, or null when that cannot be said: either side
 * is a status-signal literal (a state, not slots), the shapes differ, or — defensively — the
 * strings differ with no slot differing. Null means "treat as a change of everything", the safe
 * reading for every caller (nothing is ignored, nothing is caught up).
 */
export const changedSlots = (storedSignature, observedSignature) => {
	const before = slotsOf(storedSignature);
	const after = slotsOf(observedSignature);
	if (!before || !after || before.length !== after.length) return null;
	const changed = [];
	for (let i = 0; i < after.length; i++) {
		if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) changed.push(i);
	}
	return changed.length ? changed : null;
};

/** A signature's slot values, or null for a literal (exported for the sweep's caught-up test). */
export const signatureSlots = (signature) => slotsOf(signature);

const factString = (value) => (typeof value === 'string' && value !== '' ? value : null);
const factNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The renderer's `pageFacts` reduced to the contract's shape, in a FIXED key order — so the stored
 * string is canonical (equal facts store equal bytes) and a renderer that sends extra keys or a
 * wrong type cannot put anything into the record the comparators do not expect. A record where
 * every fact is empty is null: it can support no comparison, and null says so for free.
 */
export const canonicalPageFacts = (raw) => {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const p = raw.product;
	const product =
		p && typeof p === 'object' && !Array.isArray(p)
			? {
					name: factString(p.name),
					brand: factString(p.brand),
					image: factString(p.image),
					rating: Array.isArray(p.rating) ? [factNumber(p.rating[0]), factNumber(p.rating[1])] : null,
					offers: Array.isArray(p.offers)
						? p.offers.map((offer) =>
								Array.isArray(offer)
									? [factString(offer[0]), factString(offer[1]), factString(offer[2]), factString(offer[3])]
									: [null, null, null, null]
							)
						: null,
				}
			: null;
	const facts = {
		canonical: factString(raw.canonical),
		title: factString(raw.title),
		metaDescription: factString(raw.metaDescription),
		h1: factString(raw.h1),
		product:
			product && (product.name || product.brand || product.image || product.rating || product.offers) ? product : null,
		breadcrumbs:
			Array.isArray(raw.breadcrumbs) && raw.breadcrumbs.length && raw.breadcrumbs.every((crumb) => factString(crumb))
				? raw.breadcrumbs.slice()
				: null,
	};
	return Object.values(facts).some((value) => value !== null) ? facts : null;
};

/**
 * The page record as stored: `{ json, bytes, refused }`. `json` is the canonical string, or null
 * when there is nothing to store OR the record is REFUSED for exceeding PAGE_FACTS_MAX_BYTES.
 *
 * WHY 16 KB. The record is written on every render of a mapped URL into a node-local table that
 * holds one row per probed URL (hundreds of thousands per node), and it is read on every probe of
 * that URL — so its size is paid in both places, at corpus scale. A typical product page's record
 * is 1-3 KB (the renderer measures well under 2 KB; 50 SKU offers add ~2 KB); even the renderer's
 * own 200-offer cap fits at ~10 KB. The renderer's worst case is ~125 KB, and a page that large is
 * pathological: storing it would make one URL's row cost what fifty normal ones do. Refused rather
 * than truncated, like the renderer's own bounds — a truncated offer list or trail would disagree
 * with the endpoint forever — and refusal stores NULL, so that page simply has no record (no
 * claim) until a render fits.
 */
export const serializePageFacts = (raw) => {
	const facts = canonicalPageFacts(raw);
	if (!facts) return { json: null, bytes: 0, refused: false };
	const json = JSON.stringify(facts);
	const bytes = Buffer.byteLength(json, 'utf8');
	return bytes > PAGE_FACTS_MAX_BYTES ? { json: null, bytes, refused: true } : { json, bytes, refused: false };
};

/** A stored page record parsed, or null for anything that is not one (absent, corrupted, legacy). */
export const parsePageFacts = (json) => {
	if (typeof json !== 'string' || json === '') return null;
	try {
		const facts = JSON.parse(json);
		return facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : null;
	} catch {
		return null;
	}
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
 * Tokens are plain property names, `[N]` numeric indexes and `[*]` projections; anything
 * unreachable is undefined rather than a throw, because a probe response missing a branch is
 * data, not a bug.
 *
 * `[*]` projects the REST of the path over every element of an array (`SKUS[*].availability` ->
 * `["In Stock", "Out of Stock", ...]`), positionally: element k of the result is element k of the
 * array, with an unreachable branch as null so a variant that lost a field does not shift the
 * others. Order is the endpoint's — a reorder reads as a change, exactly like a reordered array
 * value in any other extracted field. This is how a rule watches per-variant state without
 * signing the whole variant object, whose other fields (inventory counters, store data) move
 * without the page moving.
 *
 * A trailing TUPLE projection, `[*].{a,b.c}`, projects each element to the tuple `[a, b.c]`
 * (dotted inner paths, no brackets, no nesting; an unreachable inner path is null). It exists so
 * per-variant state can be compared BY KEY: `variants[*].{sku,availability,price.value}` keeps each
 * SKU's availability and price attached to its SKU, where two separate `[*]` projections are each
 * sorted on their own and lose the pairing. Tuples sort by their JSON like any projected element.
 */
export const valueAtPath = (value, path) => walkPath(value, tokensOf(path), 0);

// `[*]` and `[N]` are tried BEFORE the bare-name alternative: `*` and digits are legal name
// characters to that alternative, so ordering it first would tokenize `[*]` as the name `*`.
const PATH_TOKEN = /\[\*\]|\[\d+\]|[^.[\]]+/g;

// `<prefix ending in [*]>.{inner,inner.path}` — the only place a tuple may appear.
const TUPLE_TAIL = /^(.*\[\*\])\.\{([^{}]*)\}$/;
// One inner path of a tuple: dotted names, no brackets, braces, commas or empty segments.
const TUPLE_INNER = /^[^.[\]{},]+(?:\.[^.[\]{},]+)*$/;

/**
 * Why an extract path cannot be used, or null. Only tuple syntax is checked — any other string is a
 * path, and a path to nowhere is data (it extracts null), not a config error. Braces anywhere but a
 * well-formed trailing tuple, though, can only be a mistyped projection that would silently
 * extract null on every probe.
 */
export const extractPathProblem = (path) => {
	const text = String(path);
	if (!text.includes('{') && !text.includes('}')) return null;
	const match = TUPLE_TAIL.exec(text);
	if (!match || match[1].includes('{') || match[1].includes('}')) {
		return 'a tuple projection must END the path, directly after [*] — e.g. "items[*].{sku,price.value}"';
	}
	if (match[2].split(',').some((inner) => !TUPLE_INNER.test(inner.trim()))) {
		return 'each name inside {…} must be a dotted path (no brackets, no empty names)';
	}
	return null;
};

// A path's tokens; a well-formed trailing tuple becomes one final `{ tuple: [tokens, ...] }` token.
const tokensOf = (path) => {
	const text = String(path);
	const match = extractPathProblem(text) === null ? TUPLE_TAIL.exec(text) : null;
	if (!match) return text.match(PATH_TOKEN) ?? [];
	return [
		...(match[1].match(PATH_TOKEN) ?? []),
		{ tuple: match[2].split(',').map((inner) => inner.trim().match(PATH_TOKEN) ?? []) },
	];
};

// A total, stable order over projected elements of any shape — they may be strings, numbers, nulls
// or whole objects. Comparing their JSON keeps the sort deterministic across passes, which is the
// only property that matters here: the same multiset must always produce the same signature.
const byProjectedValue = (a, b) => {
	const left = JSON.stringify(a) ?? 'null';
	const right = JSON.stringify(b) ?? 'null';
	return left < right ? -1 : left > right ? 1 : 0;
};

const walkPath = (value, tokens, from) => {
	let current = value;
	for (let i = from; i < tokens.length; i++) {
		const token = tokens[i];
		if (typeof token === 'object') {
			// The tuple: always the last token, and always reached through a `[*]`, so `current` is one
			// element. An element that is not there still yields a tuple (of nulls), so every element of
			// the projection has the same shape.
			return token.tuple.map((inner) => {
				const field = current === null || current === undefined ? undefined : walkPath(current, inner, 0);
				return field === undefined ? null : field;
			});
		}
		if (current === null || current === undefined) return undefined;
		if (token === '[*]') {
			if (!Array.isArray(current)) return undefined;
			const projected = current.map((element) => {
				const value = walkPath(element, tokens, i + 1);
				return value === undefined ? null : value;
			});
			// ORDER IS NOT A CHANGE, so it is sorted out of the projection before it can become one.
			// A signature is compared byte for byte, and plenty of endpoints return their variant
			// array in whatever order the query came back in. Left positional, one such endpoint
			// reads as 100% changed on EVERY pass — which on the canary cohort is not a wave of
			// per-URL re-renders but a trip, and a bulk invalidation of the rule's whole scope.
			// Sorting trades away the one case where a multiset is stable but its order is not: two
			// variants swapping prices with each other is invisible. The offers on the page are the
			// same set either way, which is what the signature is asking about.
			return projected.sort(byProjectedValue);
		}
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
