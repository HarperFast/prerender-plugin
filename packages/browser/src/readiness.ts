/**
 * Readiness contracts — deciding a render is COMPLETE by asking the page, instead of by waiting.
 *
 * ## Why
 *
 * Everything the settle phase does today is a timer. A scroll pass waits `stepMs` per step; the
 * network-idle window waits out a timeout that, on a page with a long tail of third-party chatter,
 * can never resolve early; a DOM-stability plateau waits `domStableMs` from the moment it is entered
 * even if the page has been quiescent for seconds. Measured on a live product page, those waits were
 * essentially the entire settle budget, and the in-page work they were protecting was under 1% of it.
 *
 * Worse than slow: unfalsifiable. A render that quietly missed the review widget, or that serialized
 * pre-hydration markup, reports `outcome=ok` with a 200 and non-empty content, and nothing
 * downstream can tell. The failure mode this system fears most — shipping a snapshot that is missing
 * what a real browser would show — is invisible to every timer in the renderer.
 *
 * A contract inverts both problems. It states, per page type, what a complete render CONTAINS:
 * "a Product JSON-LD block, an h1, the review widget or an explicit no-reviews state, every island
 * hydrated, no unresolved skeletons". The renderer holds until that is true AND the DOM has gone
 * quiet, and reports which assertions held — so an incomplete render is a fact on the wire rather
 * than a silence.
 *
 * ## Where the speed actually comes from — measured, and not what it looks like
 *
 * Running the same stop policy with an EMPTY contract saves the same time to within 30ms on 7 of 8
 * pages. The saving is not the contract: it is replacing ~2.2s of blind timers (two network-idle
 * windows that cannot observe idle, two `topSettleMs` dwells, two plateaus) with ONE real quiescence
 * test, worth 25-44% of render wall time.
 *
 * The contract's contribution is falsifiability, and that is what makes so short a quiet window
 * safe to ship. Under 6x CPU throttling, 8 of 15 renders finish with the contract unsatisfied — and
 * all 15 report `outcome=ok`. One stored 426KB instead of 958KB, with 11 of 27 islands unhydrated
 * and zero product links, while the hand-written review gate was satisfied. Without a contract that
 * render is cached and nothing anywhere says otherwise.
 *
 * ## What makes an assertion usable
 *
 * Two properties, and both have to be measured on real pages rather than assumed:
 *
 *  - **Stable.** It must not vary between two renders of the same URL minutes apart. Measured on a
 *    live commerce site, review-node counts, JSON-LD block counts, `Offer` counts and `h1` are exact
 *    across repeated renders, while product-link and `<img>` counts move ±5% because the rails are
 *    personalised. Gate on the first kind; `observe` the second.
 *  - **Falsifiable.** It must be FALSE on a deliberately truncated render. An assertion satisfied by
 *    the raw server-rendered HTML before anything hydrates proves nothing and only costs a check.
 *
 * ## Deliberately NOT here
 *
 * No customer selectors, no page-type names beyond what a config supplies. This repository is
 * public; a contract's content is configuration, and the shapes below are the vocabulary it is
 * written in.
 */

/** One thing a complete render of this page type contains. */
export type ReadinessAssertion = { onlyIf?: ReadinessGuard } & (
	| {
			name: string;
			/** Satisfied when at least `minCount` (default 1) elements match, across open shadow roots. */
			selector: string;
			minCount?: number;
	  }
	| {
			name: string;
			/**
			 * Satisfied when ANY branch matches — the shape that lets a gate exist on a page type whose
			 * content is legitimately optional.
			 *
			 * A catalog grid is the canonical case: "the grid has products" and "the grid is genuinely
			 * empty" are structurally identical except for one element, so a plain presence gate cannot
			 * tell an empty facet from a grid that has not arrived, and every empty facet pays the full
			 * timeout. Written as `anyOf: [grid-has-tiles, explicit-empty-state]`, both pages satisfy the
			 * contract immediately and neither waits.
			 */
			anyOf: Array<{ selector: string; minCount?: number }>;
	  }
	| {
			name: string;
			/** Satisfied when NOTHING matches — skeletons, spinners, unresolved placeholders. */
			absent: string;
	  }
	| {
			name: string;
			/**
			 * Satisfied when every element matching `selector` has SHED `attribute`.
			 *
			 * The generic form of a hydration check. Astro removes `ssr` from `<astro-island>` when the
			 * island hydrates, so `{ selector: 'astro-island', shed: 'ssr' }` is "the page is hydrated" —
			 * the single assertion that would have caught the incident where every deployed page was
			 * cached as pre-hydration server markup while reporting 200, non-empty and indexable.
			 */
			selector: string;
			shed: string;
			/**
			 * How many elements may still carry the attribute. Defaults to 0.
			 *
			 * Not every island is meant to hydrate: measured, a catalog page always leaves exactly one
			 * (a visual-nav component) marked on all 24 renders, so `== 0` there is unreachable and a
			 * contract asserting it would time out on every single catalog render.
			 */
			maxRemaining?: number;
			/**
			 * Accept a page with NO matching elements. Off by default: "all of them have hydrated" is
			 * vacuously true when there are none, which is precisely what a still-parsing document looks
			 * like, so by default this clause also requires that at least one exists.
			 */
			allowNone?: boolean;
	  }
	| {
			name: string;
			/**
			 * Satisfied when every element matching `selector` contains at least `minContained`
			 * descendants matching `contains` — and at least one such element exists.
			 *
			 * THE FORM THAT DOES NOT ROT. "At least 3 rails" is a constant somebody measured once; it
			 * keeps passing on the day the template ships a fourth rail empty, and starts failing on the
			 * day it ships two. "Every rail that exists is filled" is the same assertion with the magic
			 * number removed, and it survives the template changing underneath it.
			 *
			 * The `>= 1 exists` floor is not optional: without it the clause is vacuously true from t=0,
			 * because a rail's wrapper and its content appear in the same frame — there is no empty
			 * wrapper to catch. Zero of zero filled is true, and it means nothing.
			 */
			every: string;
			contains: string;
			minContained?: number;
	  }
	| {
			name: string;
			/** Satisfied when at least one match's text content satisfies the pattern (or is non-empty). */
			selector: string;
			textMatches?: string;
			nonEmptyText: true;
	  }
);

/**
 * A guard that makes an assertion CONDITIONAL on what the page's own server-rendered data says.
 *
 * This is the piece that turns "is the review widget there?" into a question with a right answer.
 * A product page with genuine reviews and one with none are structurally identical apart from the
 * review items themselves, so a presence gate cannot tell "no reviews" from "reviews haven't
 * arrived". The obvious fix — accept EITHER review items OR a rating summary — measured as a false
 * positive: on 6 of 13 renders the rating summary appears 236-263ms BEFORE the first review node, so
 * the gate releases early on exactly the pages that have reviews.
 *
 * The page already knows. Its server-rendered JSON-LD carries `aggregateRating.ratingCount`. Keying
 * the requirement on that turns a guess into a cross-source check: the document declares what should
 * exist, and the client-rendered DOM is held to it.
 */
export type ReadinessGuard =
	| {
			/**
			 * Dotted path searched across every JSON-LD block on the page (including `@graph` members and
			 * array entries), e.g. `aggregateRating.ratingCount`. The first numeric match wins.
			 */
			jsonLdNumber: string;
			/** Require the assertion only when that number is >= this. Default 1. */
			atLeast?: number;
	  }
	| {
			/**
			 * Require the assertion only when the page has at least `atLeast` of these elements.
			 *
			 * The DOM form of the same idea, and the one that lets a listing page be contracted at all:
			 * "every product tile carries its image" is a good clause on a populated grid and an
			 * impossible one on a legitimately empty facet, where there are no tiles to carry anything.
			 * Guarded on the grid having children, the same contract serves both — the populated page is
			 * checked and the empty one short-circuits instead of waiting out its timeout. Measured
			 * ungated: +351% wall on an empty facet.
			 */
			present: string;
			atLeast?: number;
	  };

/** The contract for one page type. */
export type ReadinessContract = {
	name: string;
	/** Scope, matched the way `waitFor` rules and config overrides are scoped. */
	pathPattern?: string;
	devices?: string[];
	/** Must ALL hold before the render is considered complete. */
	require: ReadinessAssertion[];
	/**
	 * Evaluated and reported, never waited on. This is where a volatile-but-interesting signal goes
	 * (rail counts, image counts): visibility without letting churn hold a render open.
	 */
	observe?: ReadinessAssertion[];
	/** Give up after this long and report what was still false. Clamped by the render budget. */
	timeoutMs?: number;
	/** Sample interval. Defaults to `navigation.domStablePollMs`. */
	pollMs?: number;
	/**
	 * How long the DOM must be unchanged before this page type's snapshot is taken. Overrides
	 * `readiness.quietMs`.
	 *
	 * Per page type because the lulls are per page type. Measured: 250ms is enough on a product page,
	 * where the contract names the late content directly, and NOT enough on a listing page, where the
	 * only late content is recommendation rails that no clause can name — there, a 250ms window landed
	 * inside a lull before the rails arrived and stored 610 product links instead of 674.
	 */
	quietMs?: number;
};

export type ReadinessConfig = {
	contracts: ReadinessContract[];
	/**
	 * What the settle phase does once a contract is satisfied.
	 *
	 *  - `report` — DO NOT GATE. The contract is evaluated alongside the ordinary settle and its
	 *    verdict is reported, while the render behaves exactly as it does without a contract. This is
	 *    how a contract should be rolled out: `timeoutMs` has to be set against the fleet, and the
	 *    fleet's own `satisfied_ms` distribution is the only honest source for it. Measured on a
	 *    laptop a product contract holds at 856ms; at 2x CPU throttle 1,749ms; at 4x it does not hold
	 *    at all within 30s. Picking the number from the first of those would arm a gate that clips its
	 *    own tail in production, and the failure would look like "renders are incomplete" rather than
	 *    "the timeout is wrong".
	 *  - `quiet` — stop once the contract holds AND the DOM has been unchanged for `quietMs`.
	 *  - `plateau` — stop once the contract holds, then still run the full final plateau. The
	 *    conservative setting for a page type whose contract is new or known to be partial.
	 *
	 * THERE IS DELIBERATELY NO "STOP IMMEDIATELY". Measured on 49 real renders: stopping the instant
	 * a contract is satisfied saves 47-78% and loses the recommendation rails — 99% of product links
	 * and 89% of images on one product page, 100% of both on an empty catalog facet. Rails have no
	 * server-rendered placeholder (wrapper and content appear in the same 250ms tick), so NO contract
	 * can assert that one is still coming. Only quiescence can.
	 *
	 * This is the honest division of labour, and it is the opposite of what it looks like: the quiet
	 * window supplies the SPEED (replacing ~2.2s of blind timers with one real quiescence test, worth
	 * 25-44% of render wall time), and the contract supplies the SAFETY that makes so short a window
	 * defensible — a page that goes quiet early because it is broken now fails a check instead of
	 * being cached.
	 */
	onSatisfied: 'report' | 'quiet' | 'plateau';
	/**
	 * How long to keep waiting for a clause that has NEVER been true in this render, once every other
	 * clause holds and the DOM has gone quiet. Default 1000ms.
	 *
	 * THIS IS THE ROT VALVE. A contract is written against a template, and templates change: a renamed
	 * class or a restructured widget turns a clause permanently false, and without this the contract
	 * waits out its whole `timeoutMs` on every single render of that page type, for as long as nobody
	 * notices. Measured, that is +385% wall on a page where one clause could not be satisfied.
	 *
	 * With it, a rotted clause costs one grace window and then stands aside: the render falls back to
	 * the ordinary timer-based settle, so cost degrades to roughly what it is today rather than to
	 * something far worse, and `readiness.satisfied` comes back false naming the clause. Degrading is
	 * the point — a contract that can only ever make renders slower would not be safe to adopt.
	 *
	 * The condition is deliberately narrow: EVERY other clause must hold and the DOM must be quiet. A
	 * clause that was true and has gone false again means the page is still moving, which is not rot.
	 */
	unmetGraceMs?: number;
	/**
	 * How long the DOM must be unchanged, once the contract holds, before the snapshot is taken.
	 *
	 * 250ms measured at zero content loss across 49 renders on four page types; 500ms is the
	 * conservative setting and still worth 19-37%.
	 */
	quietMs?: number;
	/** How history is compared against (see ReadinessExpectations). Omitted = the defaults. */
	expectations?: Partial<ExpectationPolicy>;
};

/** Per-assertion outcome, posted with the render so an incomplete page is a fact, not a silence. */
export type AssertionResult = {
	name: string;
	ok: boolean;
	/** Matched elements (or, for `shed`, the number still carrying the attribute). */
	count: number;
	/** True when a guard decided this clause did not apply — never conflate with "checked and passed". */
	skipped?: boolean;
	/** Ms from the start of the wait until this clause first held. */
	firstTrueMs?: number;
};

export type ReadinessResult = {
	contract: string;
	/** Observations that fell far below what this URL last produced (see assessExpectations). */
	shortfalls?: Shortfall[];
	/** The shortfalls repeated often enough to be the page's new shape; re-learn from this render. */
	rebaselined?: boolean;
	/** What the consumer should store as this URL's expectation after this render. */
	learned?: Record<string, number>;
	satisfied: boolean;
	/**
	 * True when this contract ENDED the render: every clause held and the page had gone quiet. Not
	 * the same as `satisfied` — a contract whose clauses all held but that never saw the page quiet
	 * within its timeout is satisfied and did not stop; the render fell back to the ordinary settle.
	 */
	stopped: boolean;
	/** Wall time the contract held the render open. */
	waitedMs: number;
	/** How long until it first became true, or null if it never did. */
	firstSatisfiedMs: number | null;
	require: AssertionResult[];
	observe: AssertionResult[];
};

/** The contract that governs this render, or null. First match wins, like `config.overrides`. */
export function contractFor(
	config: ReadinessConfig | undefined,
	url: string,
	deviceType: string
): ReadinessContract | null {
	if (!config?.contracts?.length) return null;
	let path = '';
	try {
		path = new URL(url).pathname;
	} catch {
		/* leave '' — a contract with a pathPattern simply will not match */
	}
	for (const contract of config.contracts) {
		if (contract.devices && !contract.devices.includes(deviceType)) continue;
		if (contract.pathPattern && !new RegExp(contract.pathPattern).test(path)) continue;
		return contract;
	}
	return null;
}

/**
 * Evaluate a contract IN THE PAGE. Self-contained: passed to `page.evaluate`, so no imports, no
 * closure over module scope, and every helper inlined.
 *
 * Shadow-aware throughout, because the content most worth asserting on (review widgets, rating
 * stars, UGC) is routinely rendered into open shadow roots and is invisible to a light-DOM-only
 * query. A malformed selector yields a failed assertion rather than a thrown render: a bad contract
 * must be able to make a render slow, never to make it crash.
 */
export function evaluateContract(payload: {
	require: ReadinessAssertion[];
	observe: ReadinessAssertion[];
	/** Element-count drift that does not count as a change, matching the plateau's own tolerance. */
	tolerance: number;
}): { require: AssertionResult[]; observe: AssertionResult[]; quietMs: number; started: boolean } {
	// ONE shadow-root walk per tick, shared by every clause. A per-clause walk measured 2-22ms on a
	// review-heavy page — 9% of a thread at a 250ms poll — for an answer that cannot change between
	// clauses of the same tick.
	const roots: Array<Document | ShadowRoot> = [document];
	const collect = (root: Document | ShadowRoot) => {
		for (const el of root.querySelectorAll('*')) {
			const sr = (el as Element).shadowRoot;
			if (sr) {
				roots.push(sr);
				collect(sr);
			}
		}
	};
	collect(document);

	// The review widget renders into an OPEN SHADOW ROOT: a light-DOM-only query returns 0 where the
	// piercing walk returns 1,974 on the same page. Every count here pierces.
	const countAll = (selector: string): number => {
		let n = 0;
		for (const root of roots) {
			try {
				n += root.querySelectorAll(selector).length;
			} catch {
				return -1; // malformed selector — a failed assertion, never a thrown render
			}
		}
		return n;
	};

	// Numbers the page itself declares, read from its JSON-LD (including @graph and array entries).
	// This is what lets a clause ask "does this page claim to have reviews?" instead of guessing.
	// How many JSON-LD blocks have parsed at all. The guard needs this to tell "the page declares
	// nothing here" from "the page has not rendered its structured data yet" — which are the same
	// `null` and opposite verdicts. Getting this wrong made a product with genuinely zero reviews
	// wait out its entire 15s gate: measured +385% wall on a live page.
	const jsonLdBlocks = (): number => {
		let n = 0;
		for (const block of document.querySelectorAll('script[type="application/ld+json"]')) {
			try {
				JSON.parse(block.textContent ?? '');
				n++;
			} catch {
				/* unparsed block does not count as declared data */
			}
		}
		return n;
	};

	const jsonLdNumber = (path: string): number | null => {
		const parts = path.split('.');
		// Each step descends through arrays as well as objects, because schema.org fields are routinely
		// either — `offers` is one offer or fifty. Resolving `offers.price` against an array by property
		// lookup yields undefined, which read as "the page declares nothing" and SKIPPED the clause
		// silently. That turned the cross-source check into a no-op and cost a render its reviews.
		const step = (node: unknown, key: string): unknown[] => {
			if (node === null || node === undefined) return [];
			if (Array.isArray(node)) return node.flatMap((entry) => step(entry, key));
			if (typeof node !== 'object') return [];
			const value = (node as Record<string, unknown>)[key];
			return value === undefined ? [] : [value];
		};
		const dig = (node: unknown): number | null => {
			let cursors: unknown[] = [node];
			for (const part of parts) cursors = cursors.flatMap((c) => step(c, part));
			for (const cursor of cursors.flat()) {
				const value = typeof cursor === 'string' ? Number(cursor) : cursor;
				if (typeof value === 'number' && Number.isFinite(value)) return value;
			}
			// Not at this path — try nested nodes (@graph members, nested products).
			if (node && typeof node === 'object') {
				for (const child of Object.values(node as Record<string, unknown>)) {
					if (child && typeof child === 'object') {
						const hit = dig(child);
						if (hit !== null) return hit;
					}
				}
			}
			return null;
		};
		for (const block of document.querySelectorAll('script[type="application/ld+json"]')) {
			try {
				const hit = dig(JSON.parse(block.textContent ?? ''));
				if (hit !== null) return hit;
			} catch {
				/* a malformed block is the page's problem, not this clause's */
			}
		}
		return null;
	};

	const run = (assertion: ReadinessAssertion): AssertionResult => {
		const a = assertion as unknown as Record<string, unknown>;
		const guard = a.onlyIf as { jsonLdNumber?: string; present?: string; atLeast?: number } | undefined;
		if (guard && typeof guard.present === 'string') {
			const have = countAll(guard.present);
			if (have < (guard.atLeast ?? 1)) return { name: assertion.name, ok: true, count: 0, skipped: true };
		} else if (guard && typeof guard.jsonLdNumber === 'string') {
			const declared = jsonLdNumber(guard.jsonLdNumber);
			if (declared === null) {
				// A missing path is two different situations and they need opposite answers:
				//  - no structured data has parsed yet -> we cannot know; fail, and keep waiting.
				//  - structured data IS there and simply does not carry this field -> the page is telling
				//    us there is none. A product with zero reviews has no aggregateRating at all, and
				//    treating that as "not yet" makes every such page wait out its whole gate.
				if (jsonLdBlocks() === 0) return { name: assertion.name, ok: false, count: 0 };
				return { name: assertion.name, ok: true, count: 0, skipped: true };
			}
			if (declared < (guard.atLeast ?? 1)) return { name: assertion.name, ok: true, count: 0, skipped: true };
		}
		if (typeof a.absent === 'string') {
			const n = countAll(a.absent);
			return { name: assertion.name, ok: n === 0, count: Math.max(n, 0) };
		}
		if (Array.isArray(a.anyOf)) {
			let best = 0;
			for (const branch of a.anyOf as Array<{ selector: string; minCount?: number }>) {
				const n = countAll(branch.selector);
				if (n >= (branch.minCount ?? 1)) return { name: assertion.name, ok: true, count: n };
				best = Math.max(best, n);
			}
			return { name: assertion.name, ok: false, count: best };
		}
		if (typeof a.every === 'string' && typeof a.contains === 'string') {
			let containers = 0;
			let filled = 0;
			for (const root of roots) {
				try {
					for (const el of root.querySelectorAll(a.every as string)) {
						containers++;
						if (el.querySelectorAll(a.contains as string).length >= ((a.minContained as number) ?? 1)) filled++;
					}
				} catch {
					return { name: assertion.name, ok: false, count: 0 };
				}
			}
			// No containers at all is NOT satisfaction: see the doc on `every`.
			return { name: assertion.name, ok: containers > 0 && filled === containers, count: filled };
		}
		if (a.nonEmptyText === true && typeof a.selector === 'string') {
			let ok = false;
			let seen = 0;
			let pattern: RegExp | null = null;
			try {
				pattern = typeof a.textMatches === 'string' ? new RegExp(a.textMatches as string) : null;
			} catch {
				// Defence in depth: `validateReadiness` rejects a malformed pattern at config load, so this
				// is unreachable through the public API. It stays because the alternative shape — building
				// the RegExp outside the loop's try — threw out of the WHOLE evaluator, discarding every
				// other clause's result for that tick rather than failing this one.
				return { name: assertion.name, ok: false, count: 0 };
			}
			for (const root of roots) {
				try {
					for (const el of root.querySelectorAll(a.selector as string)) {
						seen++;
						const text = (el.textContent ?? '').trim();
						if (text.length > 0 && (!pattern || pattern.test(text))) ok = true;
					}
				} catch {
					return { name: assertion.name, ok: false, count: 0 };
				}
			}
			return { name: assertion.name, ok, count: seen };
		}
		if (typeof a.shed === 'string' && typeof a.selector === 'string') {
			// "Every island has hydrated" is TRIVIALLY TRUE on a document with no islands — which is what
			// an empty or still-parsing page looks like. So the elements must exist before their state
			// can mean anything; `allowNone` opts out for a page type that may genuinely have none.
			const present = countAll(a.selector as string);
			if (present <= 0) return { name: assertion.name, ok: a.allowNone === true, count: 0 };
			const remaining = countAll(`${a.selector}[${a.shed}]`);
			return {
				name: assertion.name,
				ok: remaining <= ((a.maxRemaining as number) ?? 0),
				count: Math.max(remaining, 0),
			};
		}
		const n = countAll(a.selector as string);
		return { name: assertion.name, ok: n >= ((a.minCount as number) ?? 1), count: Math.max(n, 0) };
	};

	// Quiescence comes from the document-start monitor, which maintains it from mutation records —
	// O(1) here, and judged against the same tolerance the plateau uses. -1 means "cannot say", which
	// the caller must treat as "not quiet".
	const monitor = window.__prerenderMonitor;
	const quiet = monitor && typeof monitor.quietMs === 'function' ? monitor.quietMs(payload.tolerance) : -1;

	// A document that is still parsing can satisfy clauses by having nothing in it yet, and it is
	// quiet for the same reason. No contract verdict is meaningful before the parser has finished.
	const started = document.readyState !== 'loading';

	return { require: payload.require.map(run), observe: payload.observe.map(run), quietMs: quiet, started };
}

/**
 * The ceiling `setTimeout` accepts. Past it Node fires the callback after 1ms instead of waiting, so
 * an over-large dwell silently becomes NO dwell — the same trap `scroll.topSettleMs` already guards.
 * A poll interval that large is nonsense anyway; what matters is that it fails loudly.
 */
const MAX_TIMER_MS = 2147483647;

/** Every ms-valued readiness field, checked the same way, so none of them can silently misbehave. */
const checkMs = (label: string, value: unknown, { positive = false } = {}): void => {
	if (value === undefined) return;
	const bad =
		typeof value !== 'number' || !Number.isFinite(value) || value > MAX_TIMER_MS || (positive ? value <= 0 : value < 0);
	if (bad) {
		throw new Error(
			`prerender config: ${label} must be a ${positive ? 'positive' : 'non-negative'} number up to ${MAX_TIMER_MS}`
		);
	}
};

/** Validate contracts at config load, so a broken one cannot first surface inside a render. */
export function validateReadiness(readiness: unknown): void {
	if (readiness === undefined) return;
	const cfg = readiness as ReadinessConfig;
	if (typeof cfg !== 'object' || cfg === null) throw new Error('prerender config: readiness must be an object');
	if (cfg.onSatisfied !== undefined && !['report', 'quiet', 'plateau'].includes(cfg.onSatisfied)) {
		throw new Error("prerender config: readiness.onSatisfied must be 'report', 'quiet' or 'plateau'");
	}
	checkMs('readiness.quietMs', cfg.quietMs);
	checkMs('readiness.unmetGraceMs', cfg.unmetGraceMs);
	if (cfg.expectations !== undefined) {
		if (typeof cfg.expectations !== 'object' || cfg.expectations === null) {
			throw new Error('prerender config: readiness.expectations must be an object');
		}
		checkMs('readiness.expectations.graceMs', cfg.expectations.graceMs);
		const { tolerance, rebaselineAfter } = cfg.expectations;
		if (tolerance !== undefined && (typeof tolerance !== 'number' || !(tolerance >= 0 && tolerance <= 1))) {
			throw new Error('prerender config: readiness.expectations.tolerance must be a number between 0 and 1');
		}
		if (rebaselineAfter !== undefined && (!Number.isInteger(rebaselineAfter) || rebaselineAfter < 1)) {
			throw new Error('prerender config: readiness.expectations.rebaselineAfter must be a positive integer');
		}
	}
	if (!Array.isArray(cfg.contracts)) throw new Error('prerender config: readiness.contracts must be an array');
	for (const contract of cfg.contracts) {
		if (!contract.name) throw new Error('prerender config: every readiness contract needs a name');
		if (!Array.isArray(contract.require) || contract.require.length === 0) {
			throw new Error(`prerender config: readiness contract "${contract.name}" needs at least one require assertion`);
		}
		checkMs(`readiness contract "${contract.name}" timeoutMs`, contract.timeoutMs);
		checkMs(`readiness contract "${contract.name}" quietMs`, contract.quietMs);
		// POSITIVE, not merely non-negative: a zero poll interval is a tight loop calling into the page
		// as fast as the event loop allows, which would burn a core per render.
		checkMs(`readiness contract "${contract.name}" pollMs`, contract.pollMs, { positive: true });
		if (contract.pathPattern) {
			try {
				new RegExp(contract.pathPattern);
			} catch {
				throw new Error(`prerender config: readiness contract "${contract.name}" has an invalid pathPattern`);
			}
		}
		for (const assertion of [...contract.require, ...(contract.observe ?? [])]) {
			const a = assertion as Record<string, unknown>;
			for (const field of ['minCount', 'maxRemaining', 'minContained'] as const) {
				const value = a[field];
				if (value === undefined) continue;
				if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
					throw new Error(
						`prerender config: readiness assertion "${assertion.name}" ${field} must be a non-negative number`
					);
				}
			}
			// Compiled here so a malformed pattern is a config error rather than a clause that can never
			// hold — the same rule `waitFor.pathPattern` follows.
			if (typeof a.textMatches === 'string') {
				try {
					new RegExp(a.textMatches);
				} catch {
					throw new Error(`prerender config: readiness assertion "${assertion.name}" has an invalid textMatches`);
				}
			}
			const forms = [
				a.selector && !a.shed && !a.nonEmptyText,
				a.anyOf,
				a.absent,
				a.shed,
				a.every,
				a.nonEmptyText,
			].filter(Boolean).length;
			if (!assertion.name || forms !== 1) {
				throw new Error(
					`prerender config: readiness assertion in "${contract.name}" must have a name and exactly one of ` +
						'selector / anyOf / absent / (selector + shed) / (every + contains) / (selector + nonEmptyText)'
				);
			}
		}
	}
}

/**
 * What the last accepted render of THIS URL saw — the defence against a contract that has rotted,
 * and against content that disappears without any clause noticing.
 *
 * ## The gap this closes
 *
 * A contract bounds what it names. Recommendation rails cannot be named usefully: they have no
 * server-rendered placeholder, so a contract can only assert "at least N exist", with N a constant
 * someone measured once. That constant is wrong the day the template changes, and wrong in the
 * dangerous direction — it keeps passing while the page quietly serves less.
 *
 * The page's own history is a better oracle than any constant. A URL that carried 3 rails and 350
 * product links yesterday should not silently store 0 today. Nothing has to be written down, and
 * nothing rots: the expectation is whatever this URL last actually produced.
 *
 * ## Why it converges instead of alarming forever
 *
 * The obvious version of this is a trap. Compare against history, refuse anything that dropped, and
 * the first legitimate change — a rail removed site-wide, a product delisted, a template redesign —
 * makes every future render of that URL fail forever, and a re-render loop makes it worse.
 *
 * So a shortfall is not a verdict, it is a vote. The consumer carries `consecutiveShortfalls` per
 * URL; once the same shortfall has been seen `rebaselineAfter` times in a row, the renderer stops
 * treating it as a regression and says so (`rebaselined`). Repetition is the signal: once is a lost
 * rail, three times in a row is the new shape of the page.
 */
export type ReadinessExpectations = {
	/** Observation name -> the value the last accepted render of this URL produced. */
	counts: Record<string, number>;
	/** How many renders in a row have already reported the same shortfall (consumer-maintained). */
	consecutiveShortfalls?: number;
	/**
	 * Required clauses that have failed on this URL often enough to be treated as unsatisfiable HERE.
	 * They are still evaluated and reported — they are simply not worth holding the render open for.
	 * This is the answer to a gate that "burns its timeout invisibly on every render".
	 */
	unsatisfiable?: string[];
};

export type ExpectationPolicy = {
	/** Fractional drop that counts as a shortfall. Default 0.5 — measured run-to-run churn is ~5%. */
	tolerance: number;
	/** Extra time to let a shortfall recover before reporting it. Default 1000ms. */
	graceMs: number;
	/** Consecutive shortfalls after which the expectation is stale and the page has simply changed. */
	rebaselineAfter: number;
};

export const DEFAULT_EXPECTATION_POLICY: ExpectationPolicy = {
	tolerance: 0.5,
	graceMs: 1000,
	rebaselineAfter: 3,
};

export type Shortfall = {
	name: string;
	expected: number;
	got: number;
	/** got / expected, so a reader can see "lost 99%" rather than two bare numbers. */
	ratio: number;
};

export type ExpectationVerdict = {
	shortfalls: Shortfall[];
	/**
	 * True when the shortfalls have repeated enough times to be the page's new shape. The render is
	 * accepted and the consumer should re-learn from it.
	 */
	rebaselined: boolean;
	/** What the consumer should store as this URL's expectation after this render. */
	learned: Record<string, number>;
};

/**
 * Compare this render's observations against what this URL last produced.
 *
 * Pure, so the interesting cases are unit-testable rather than only reachable through a browser.
 * An observation with no history is never a shortfall — a first render has nothing to regress from,
 * and treating "unknown" as "zero" would make every new URL look broken.
 */
export function assessExpectations(
	observed: AssertionResult[],
	expectations: ReadinessExpectations | undefined,
	policy: ExpectationPolicy = DEFAULT_EXPECTATION_POLICY
): ExpectationVerdict {
	const learned: Record<string, number> = {};
	for (const o of observed) learned[o.name] = o.count;

	const previous = expectations?.counts;
	if (!previous) return { shortfalls: [], rebaselined: false, learned };

	const shortfalls: Shortfall[] = [];
	for (const o of observed) {
		const expected = previous[o.name];
		// No history for this name, or the page never had any: nothing to fall short OF.
		if (typeof expected !== 'number' || expected <= 0) continue;
		if (o.count < expected * (1 - policy.tolerance)) {
			shortfalls.push({ name: o.name, expected, got: o.count, ratio: expected ? o.count / expected : 1 });
		}
	}

	// Enough renders have agreed on the drop that it is the page, not the render. Accept, and hand
	// back what we saw so the next render is judged against the page as it is now.
	const rebaselined = shortfalls.length > 0 && (expectations.consecutiveShortfalls ?? 0) + 1 >= policy.rebaselineAfter;
	return { shortfalls: rebaselined ? [] : shortfalls, rebaselined, learned };
}
