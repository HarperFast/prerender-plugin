// suggest.mjs — spec §4.4: aggregate the two diffs' findings into ONE correctly-scoped, partial
// PrerenderConfig patch (the closed-loop `suggestedConfig` that `--verify-fix` deep-merges + re-tests).
//
// PURE: no puppeteer, no I/O, no globals. Takes the already-computed diff1 (SEO completeness, A vs B)
// and diff2 (served fidelity, B vs C) plus page-type/device scoping, and emits the MINIMAL patch —
// empty keys are omitted so a "nothing to fix" cell returns `{}`.
//
// Customer-agnostic: every selector/path/device arrives inside the findings or the options; this
// module bakes in NO hostnames, tokens, or site strings. Field names follow the util Finding contract
// and the browser package's WaitForRule / PostProcessConfig shapes.
//
// Fix routing (the four aggregations §4.4 specifies):
//   - postProcess.removeSelectors  ← diff2 findings whose fixType is 'removeSelectors' (occluded /
//       frozen-dead-spinner) UNION diff1.stale findings that map to a selector. Deduped.
//   - waitFor rule(s)              ← diff1 missing/flakyB that indicate a lazy widget OR diff2
//       'frozen-content-lost'. Selector/waitForSelector derived from the finding; a TODO placeholder
//       is left (never a silently-broken rule) when the audit can't derive one.
//   - postProcess.resolveLazyImages:true  ← any diff2 'broken-src'.
//   - viewport advisory note       ← bucketDrops present together with present-but-hidden content.
//
// No util import is needed: aggregation is plain Set dedup + object assembly.

import type { Diff1, Diff2, Finding, SuggestedConfig, WaitForRule } from './util.js';

// Non-empty, obviously-a-placeholder selector for a lazy widget the audit detected but couldn't pin
// to a stable selector. It passes config validation (non-empty string) yet can never match an element
// (so the rule harmlessly times out) and is unmistakably a human TODO in the emitted patch.
const TODO_WAITFOR_SELECTOR = 'TODO: fill selector for the lazy widget (audit could not derive a stable one)';

const asArray = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
const trimStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A missing/flakyB finding "indicates a lazy widget" when it's explicitly routed to waitFor, or is
 *  an unclassified content gap (fixType absent). A finding already routed elsewhere (viewport /
 *  removeSelectors / resolveLazyImages) is NOT a waitFor candidate. */
function isLazyWidget(finding: Finding | undefined): boolean {
	if (!finding) return false;
	return finding.fixType === 'waitFor' || finding.fixType == null;
}

/** Selector string(s) a removeSelectors fix would add, drawn from a finding. Prefers an explicit
 *  fixPatch (string selector, or a `{postProcess:{removeSelectors:[…]}}` fragment), falls back to the
 *  finding's own selectorPath. Strips a leading additive "+ " marker and skips TODO/empty entries. */
function removeSelectorsOf(finding: Finding | undefined): string[] {
	const out: string[] = [];
	const push = (s: unknown): void => {
		let v = trimStr(s)
			.replace(/^\+\s*/, '')
			.trim(); // drop an additive "+ " display marker if present
		if (!v || /^todo/i.test(v)) return; // never emit an empty or placeholder selector
		out.push(v);
	};
	const fp = finding && finding.fixPatch;
	if (typeof fp === 'string') {
		push(fp);
	} else if (fp && typeof fp === 'object') {
		const rs = fp.postProcess && (fp.postProcess as { removeSelectors?: unknown }).removeSelectors;
		if (Array.isArray(rs)) for (const s of rs) push(s);
	}
	if (!out.length) push(finding && finding.selectorPath); // fall back to the element's own selector
	return out;
}

/** The lazy-content selector a finding carries via its bucket (the class to COUNT → waitForSelector).
 *  Supports either a `bucket:{selector}` object or a flat `bucketSelector` string; a bare bucket NAME
 *  string is not a selector and is ignored here. */
function bucketSelectorOf(finding: Finding | undefined): string {
	if (!finding) return '';
	const b = finding.bucket;
	if (b && typeof b === 'object' && typeof b.selector === 'string') return b.selector.trim();
	if (typeof finding.bucketSelector === 'string') return finding.bucketSelector.trim();
	return '';
}

/** Human-readable bucket name from a bucketDrops entry (string, `{bucket}` name/object, or `{name}`). */
function bucketNameOf(
	entry: string | { bucket?: string | { name?: string }; name?: string } | null | undefined
): string {
	if (!entry) return '';
	if (typeof entry === 'string') return entry;
	const b = entry.bucket;
	if (typeof b === 'string') return b;
	if (b && typeof b === 'object' && typeof b.name === 'string') return b.name;
	if (typeof entry.name === 'string') return entry.name;
	return '';
}

/** Build one waitFor rule from a lazy-widget finding, scoped to the given devices/page type.
 *  Mapping (e.g. `{selector:'#reviews', waitForSelector:'[class*=review-]'}`):
 *    selector        = the specific element/container to scroll into view (finding.selectorPath),
 *    waitForSelector = the lazy-content class to count (the bucket selector), emitted only when it is
 *                      distinct from `selector` (config defaults waitForSelector → selector otherwise).
 *  When neither can be derived, `selector` becomes a TODO placeholder so the rule is visibly
 *  human-fillable rather than silently broken. */
function deriveWaitForRule(
	finding: Finding,
	{ devices, pageType, pathPattern }: { devices: string[]; pageType?: string; pathPattern?: string }
): WaitForRule {
	const content = bucketSelectorOf(finding); // lazy content class → waitForSelector
	const anchor = trimStr(finding && finding.selectorPath); // specific element/container → selector
	let selector = anchor || content;
	const waitForSelector = content && content !== selector ? content : '';
	if (!selector) selector = TODO_WAITFOR_SELECTOR; // §4.4: never emit a broken rule silently

	// Preserve the field order of the §4.4 rule shape for readability.
	const rule: WaitForRule = { selector };
	if (waitForSelector) rule.waitForSelector = waitForSelector;
	rule.minCount = 1;
	rule.timeoutMs = 15000;
	if (devices.length) rule.devices = devices; // omit → all devices (config default); avoids [undefined]
	// Scope so the rule never adds latency where the widget doesn't exist. Prefer the page-type
	// NAME when the audit was given one: it is the plugin's own vocabulary, so the emitted patch
	// stays correct as routes are added to that template — a suggested `pathPattern` is a second
	// copy of the route list that starts drifting the moment one is. Fall back to the pattern when
	// the audit was run without a type.
	const pt = trimStr(pageType);
	const pp = trimStr(pathPattern);
	if (pt) rule.pageTypes = [pt];
	else if (pp) rule.pathPattern = pp;
	return rule;
}

/**
 * Aggregate diff1 (A vs B) + diff2 (B vs C) findings into one partial PrerenderConfig patch.
 *
 * @param {{missing?:object[], flakyB?:object[], stale?:object[], bucketDrops?:object[]}} diff1
 * @param {{findings?:object[]}} diff2
 * @param {object} [options]
 * @param {string} [options.pageType]        page-type name — scopes emitted waitFor rules, and context for the viewport note
 * @param {string} [options.pathPattern]     regex fallback for scoping waitFor rules when no pageType is given
 * @param {string} [options.device]          the device this cell audited (default waitFor scope)
 * @param {string[]} [options.missingDevices] devices that actually lack the content → waitFor scope
 * @returns {object} minimal patch: some subset of { postProcess:{removeSelectors?,resolveLazyImages?},
 *          waitFor?, _notes? }. `_notes` is advisory-only (not a config knob) — additivity reminders,
 *          TODO flags, and the viewport-height suggestion the report surfaces to a human.
 */
export function suggestFixes(
	diff1: Diff1,
	diff2: Diff2,
	options: { pageType?: string; pathPattern?: string; device?: string; missingDevices?: string[] } = {}
): SuggestedConfig {
	const opts = options || {};
	const { pageType, pathPattern, device } = opts;
	const missingDevices = asArray(opts.missingDevices);

	const d1missing = asArray(diff1 && diff1.missing);
	const d1flaky = asArray(diff1 && diff1.flakyB);
	const d1stale = asArray(diff1 && diff1.stale);
	const d1bucketDrops = asArray(diff1 && diff1.bucketDrops);
	const d2findings = asArray(diff2 && diff2.findings);

	// (1) removeSelectors — deduped union of diff2 removeSelectors-fix findings + diff1 stale-with-selector.
	//     Insertion-ordered Set keeps the first-seen ordering while removing duplicates.
	const removeSet = new Set<string>();
	for (const f of d2findings) {
		if (f && f.fixType === 'removeSelectors') for (const s of removeSelectorsOf(f)) removeSet.add(s);
	}
	for (const f of d1stale) {
		for (const s of removeSelectorsOf(f)) removeSet.add(s); // STALE / prerender-only → strip it
	}
	const removeSelectors = [...removeSet];

	// (2) resolveLazyImages — any structural broken-src in the served bytes (env-independent signal).
	const resolveLazyImages = d2findings.some(
		(f) => f && (f.symptom === 'broken-src' || f.fixType === 'resolveLazyImages')
	);

	// (3) waitFor — lazy widgets from Diff 1 (missing/flakyB) + Diff 2 frozen-content-lost.
	//     Scope: the devices that actually miss it (else the audited device), and the page-type path.
	const devices = (missingDevices.length ? missingDevices : device ? [device] : []).map(trimStr).filter(Boolean);
	const lazyCandidates = [
		...d1missing.filter(isLazyWidget),
		...d1flaky.filter(isLazyWidget),
		...d2findings.filter((f) => f && f.symptom === 'frozen-content-lost'), // fixes Diff1 + Diff2 at once
	];
	const waitFor: WaitForRule[] = [];
	const seenRuleKeys = new Set<string>(); // dedupe rules that collapse to the same (selector, waitForSelector)
	let hasTodoRule = false;
	for (const f of lazyCandidates) {
		const rule = deriveWaitForRule(f, { devices, pageType, pathPattern });
		const key = rule.selector + '\n' + (rule.waitForSelector || '');
		if (seenRuleKeys.has(key)) continue;
		seenRuleKeys.add(key);
		if (rule.selector === TODO_WAITFOR_SELECTOR) hasTodoRule = true;
		waitFor.push(rule);
	}

	// (4) viewport advisory — a bucket-count drop while content is present-but-hidden (virtualized /
	//     below-the-fold under a short viewport). Advisory only: we can't compute a concrete height, so
	//     this is a note, not a device.viewport patch.
	const hiddenContent =
		d2findings.some((f) => f && f.symptom === 'hidden-text') ||
		d1missing.some((f) => f && f.fixType === 'viewport') ||
		d1flaky.some((f) => f && f.fixType === 'viewport');
	const viewportSuggested = d1bucketDrops.length > 0 && hiddenContent;

	// ---- assemble the MINIMAL patch (omit every empty key) ----
	const notes: string[] = [];
	const patch: SuggestedConfig = {};
	const postProcess: { removeSelectors?: string[]; resolveLazyImages?: boolean } = {};
	if (removeSelectors.length) {
		postProcess.removeSelectors = removeSelectors;
		// deepMerge replaces arrays wholesale — flag that these must be UNIONed onto the deployed list.
		notes.push(
			'postProcess.removeSelectors is ADDITIVE — union it onto the deployed removeSelectors (deepMerge replaces arrays wholesale).'
		);
	}
	if (resolveLazyImages) postProcess.resolveLazyImages = true;
	if (Object.keys(postProcess).length) patch.postProcess = postProcess;

	if (waitFor.length) {
		patch.waitFor = waitFor;
		if (hasTodoRule) {
			notes.push(
				'waitFor: at least one rule has a TODO placeholder selector the audit could not derive — a human must fill it before deploying.'
			);
		}
	}

	if (viewportSuggested) {
		const names = [...new Set(d1bucketDrops.map(bucketNameOf).filter(Boolean))];
		const where = (device ? ' on ' + device : '') + (pageType ? ' for page type "' + pageType + '"' : '');
		notes.push(
			`viewport: bucket(s) [${names.join(', ')}] dropped (median B < 0.5·median A) while content is present-but-hidden${where} — ` +
				'try a taller device viewport height to bring virtualized / below-the-fold items into the render.'
		);
	}

	if (notes.length) patch._notes = notes;
	return patch;
}
