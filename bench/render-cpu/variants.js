/**
 * The variants under test.
 *
 * A variant is a named (config, launch, experiments) triple. `experiments` flips flags in the
 * browser package's `experiments` module — temporary scaffolding that exists so a candidate and the
 * code it replaces can be measured in the SAME process, against the same fixture, minutes apart.
 * Whatever wins becomes unconditional and the flag is deleted; nothing here ships.
 *
 * The base config mirrors the deployed render-service config (the shapes that matter for cost:
 * domcontentloaded + scroll-settle to stability, a mobile-scoped waitFor gate on the review widget,
 * images/media/fonts blocked and stubbed, and every postProcess pass on). Kept here rather than
 * imported so the bench is self-contained and a config change downstream cannot silently move a
 * published number.
 */

export const BASE_CONFIG = {
	navigation: {
		waitUntil: 'domcontentloaded',
		navigationTimeoutMs: 12000,
		renderBudgetMs: 30000,
		networkIdleMs: 500,
		networkIdleTimeoutMs: 2000,
		domStableMs: 1200,
		domStableTimeoutMs: 12000,
		domStablePollMs: 250,
		domStableTolerance: 120,
		skipSettleWhenNonIndexable: true,
	},
	scroll: { enabled: true, stepMs: 60, stepFraction: 1.0, settleUntilStable: true, settleStablePasses: 1 },
	waitFor: [
		{
			name: 'reviews',
			selector: '#reviewsAnchor',
			waitForSelector: '[class*=rv-]',
			minCount: 1,
			timeoutMs: 15000,
			devices: ['mobile', 'tablet'],
			pathPattern: '^/product/',
		},
		{
			name: 'reviews-reveal',
			selector: '#reviewTabs',
			waitForSelector: '#reviewTabs .transition-all:not(.max-h-0):not(.hidden)',
			minCount: 1,
			timeoutMs: 10000,
			devices: ['desktop'],
			pathPattern: '^/product/',
		},
	],
	block: {
		resourceTypes: ['image', 'media', 'font'],
		urlPatterns: ['analytics-beacon'],
		stubImages: true,
	},
	postProcess: {
		stripScripts: true,
		inlineEmptyStyleSheets: true,
		minifyInlineCss: true,
		pruneUnmatchedCss: true,
		flattenShadowDom: true,
		resolveLazyImages: true,
		removeSelectors: [],
		removeAttributes: [{ selector: 'astro-island', attributes: ['props'] }],
	},
};

/** Deep-merge helper for variant overrides (arrays replace, objects merge). */
export const merge = (base, over) => {
	if (!over) return base;
	const out = Array.isArray(base) ? [...base] : { ...base };
	for (const [key, value] of Object.entries(over)) {
		if (value && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object' && out[key]) {
			out[key] = merge(out[key], value);
		} else {
			out[key] = value;
		}
	}
	return out;
};

/**
 * Each entry: { name, why, config?, launch?, experiments?, devices? }
 *
 * `devices` limits a variant to the device profiles where the question applies (the mobile review
 * gate is the expensive poll loop; the tall-viewport question is only about short viewports).
 */
export const VARIANTS = [
	{
		name: 'baseline',
		why: 'the deployed shape, unchanged — every other row is read against this',
	},

	// ---- evaluate combines: fewer round trips, identical semantics -------------------------------
	{
		name: 'combine-scroll-count',
		why: 'MEASURED LOSS (round 1, +31% wall): folding the count into the pass makes the loop decide a pass late, and an extra scroll pass costs far more than the round trip it saved. Kept so the result stays reproducible.',
		experiments: { combineScrollCount: true },
	},
	{
		name: 'combine-waitfor',
		why: 'fold scrollSelectorIntoView + countMatchingElements into one call per poll tick',
		experiments: { combineWaitFor: true },
	},
	{
		name: 'combine-tail',
		why: 'return offers and the serialized document from one call instead of two',
		experiments: { combineTail: true },
	},
	{
		name: 'install-helpers',
		why: 'install the in-page helpers once at document start instead of shipping+compiling their source on every poll',
		experiments: { installHelpers: true },
	},
	{
		name: 'combines-all',
		why: 'the combines that are actually free — scroll-count excluded after round 1',
		experiments: { combineWaitFor: true, combineTail: true, installHelpers: true },
	},

	// ---- the counting primitives: same answer, cheaper in-page ----------------------------------
	{
		name: 'exists-shortcircuit',
		why: 'a minCount:1 gate is an existence test — querySelector short-circuits instead of counting every match',
		experiments: { existsShortCircuit: true },
	},
	{
		name: 'native-count',
		why: 'count with querySelectorAll/getElementsByTagName (C++ traversal) instead of a JS firstChild walk',
		experiments: { nativeCount: true },
	},
	{
		name: 'monitor',
		why: 'a document-start MutationObserver keeps the element count and last-change time, so a poll reads a number instead of re-walking the tree',
		experiments: { monitor: true },
	},

	// ---- viewport: the thing desktop already exploits and mobile does not ------------------------
	{
		name: 'tall-viewport',
		why: 'desktop is already 1920x5000; give mobile the same tall viewport so a scroll pass is ~4 steps instead of ~24',
		devices: ['mobile'],
		config: { devices: { mobile: { viewport: { width: 390, height: 5000 } } } },
	},

	// ---- viewport height: round 1 made this the headline, so find the knee --------------------
	{
		name: 'viewport-2000',
		why: 'is the win proportional to viewport height, or is there a knee?',
		devices: ['mobile'],
		config: { devices: { mobile: { viewport: { width: 390, height: 2000 } } } },
	},
	{
		name: 'viewport-10000',
		why: 'two scroll steps for an 18,000px page',
		devices: ['mobile'],
		config: { devices: { mobile: { viewport: { width: 390, height: 10000 } } } },
	},
	{
		name: 'viewport-taller-than-page',
		why: 'the whole document in view at once — does anything lazy still fail to trip with no scrolling at all?',
		devices: ['mobile'],
		config: { devices: { mobile: { viewport: { width: 390, height: 24000 } } } },
	},

	// ---- the scroll pass itself: round 1 showed settle is mostly WAITING ------------------------
	{
		name: 'step-20ms',
		why: 'stepMs is a wall-clock wait per step; 60 -> 20 prices it directly',
		config: { scroll: { stepMs: 20 } },
	},
	{
		name: 'step-raf',
		why: 'pace the pass by animation frames instead of a fixed timer — no wait the page did not need',
		experiments: { rafScroll: true },
	},
	{
		name: 'idle-tight',
		why: 'price the per-pass network-idle window (500/2000 -> 200/700)',
		config: { navigation: { networkIdleMs: 200, networkIdleTimeoutMs: 700 } },
	},
	{
		name: 'poll-60ms',
		why: 'the gate resolves on a 250ms poll; 60ms prices the granularity',
		config: { navigation: { domStablePollMs: 60 } },
	},

	// ---- per-render process cost ---------------------------------------------------------------
	{
		name: 'shared-context',
		why: 'every render currently gets its own browser context, which means its own renderer process to spin up and tear down',
		browserOptions: { incognitoPages: false },
	},

	// ---- Chrome-side ----------------------------------------------------------------------------
	{
		name: 'images-off',
		why: 'block images in Blink instead of stubbing each one over CDP — removes the request pair AND the decode',
		launch: { chromeArgs: ['--blink-settings=imagesEnabled=false'] },
		config: { block: { resourceTypes: ['media', 'font'], stubImages: false } },
	},
	{
		name: 'stub-off',
		why: 'abort blocked images instead of fulfilling a 1x1 GIF for each — same message count, no body payload',
		config: { block: { stubImages: false } },
	},
	// ---- what each postProcess pass costs (fidelity divergence here is the POINT: the table shows
	// what the cheaper render gives up) --------------------------------------------------------
	{
		name: 'no-prune-css',
		why: 'price pruneUnmatchedCss — it probes every selector in every inline sheet against the finished DOM',
		config: { postProcess: { pruneUnmatchedCss: false } },
	},
	{
		name: 'no-flatten-shadow',
		why: 'price flattenShadowDom — it rewrites and re-scopes every rule of every open shadow root',
		config: { postProcess: { flattenShadowDom: false } },
	},
	{
		name: 'no-minify-css',
		why: 'price minifyInlineCss — re-emits every inline sheet from the CSSOM',
		config: { postProcess: { minifyInlineCss: false } },
	},
	{
		name: 'no-remove-attrs',
		why: 'price removeAttributes — walks the live attribute map of every matched element',
		config: { postProcess: { removeAttributes: [] } },
	},

	// ---- the deployed non-indexable bail, priced against the same document ----------------------
	{
		name: 'noindex-bail',
		why: 'skipSettleWhenNonIndexable on the SAME document, served noindex: what the bail actually returns',
		urlQuery: 'noindex=1',
		// The bail is exempt for sitemap-sourced jobs, and the harness marks every job sitemap-sourced
		// by default so its HTML is always inspectable. This one has to opt out to reach the bail.
		captureNonIndexable: false,
	},

	{
		name: 'tall-plus-raf',
		why: 'the two structural winners together, without touching the idle window',
		devices: ['mobile'],
		config: { devices: { mobile: { viewport: { width: 390, height: 5000 } } } },
		experiments: { rafScroll: true },
	},
	{
		name: 'best-of',
		why: 'the winners stacked: tall viewport + frame-paced passes + tight idle window',
		devices: ['mobile'],
		config: {
			devices: { mobile: { viewport: { width: 390, height: 5000 } } },
			navigation: { networkIdleMs: 200, networkIdleTimeoutMs: 700 },
		},
		experiments: { rafScroll: true },
	},
	{
		// Under constant load CPU is the shared resource, so a change that only removes CPU — which
		// reads as 0% on an idle single-render bench — is a throughput gain. This stacks every
		// fidelity-preserving win measured, whatever its effect on single-render wall time.
		name: 'cpu-stack-safe',
		why: 'every measured CPU win that preserves fidelity, stacked: tall viewport + frame-paced passes + tight idle + monitor counting + combined calls + reduced motion',
		devices: ['mobile'],
		config: {
			devices: { mobile: { viewport: { width: 390, height: 5000 } } },
			navigation: { networkIdleMs: 200, networkIdleTimeoutMs: 700 },
		},
		experiments: {
			rafScroll: true,
			monitor: true,
			combineWaitFor: true,
			combineTail: true,
			reducedMotion: true,
		},
	},
	{
		name: 'cpu-stack-max',
		why: 'cpu-stack-safe plus images off in Blink — the cheapest render available, and it LOSES content gated on an image load event',
		devices: ['mobile'],
		launch: { chromeArgs: ['--blink-settings=imagesEnabled=false'] },
		config: {
			devices: { mobile: { viewport: { width: 390, height: 5000 } } },
			navigation: { networkIdleMs: 200, networkIdleTimeoutMs: 700 },
			block: { resourceTypes: ['media', 'font'], stubImages: false },
		},
		experiments: {
			rafScroll: true,
			monitor: true,
			combineWaitFor: true,
			combineTail: true,
			reducedMotion: true,
		},
	},
	{
		// The candidate the old harness could not see: a long-lived context per slot, wiped between
		// renders, so Chrome's HTTP cache and the V8 code cache built from it survive. Needs the
		// resource cache OFF to isolate the mechanism — otherwise our own cache answers the same
		// requests over CDP and Chrome never gets to cache anything.
		name: 'context-pool',
		why: 'slot-scoped browser contexts: Chrome keeps its HTTP + compiled-script cache across renders instead of a cold browser every time',
		contextPool: true,
	},
	{
		name: 'resource-cache-on',
		why: 'the on-disk resource cache as deployed — measured against a cold browser, which is what it is actually replacing',
		resourceCache: { enabled: true, dir: process.env.BENCH_CACHE_DIR || '/tmp/prerender-bench-cache' },
	},
	{
		name: 'context-pool-plus-cache',
		why: 'both caches together — do they compose or does one make the other redundant?',
		contextPool: true,
		resourceCache: { enabled: true, dir: process.env.BENCH_CACHE_DIR2 || '/tmp/prerender-bench-cache2' },
	},
	{
		// The resource-cache question at PRODUCTION resource counts. ~70 cacheable sub-resources per
		// render is what a real storefront page costs; the default fixture's 11 is not enough to load
		// a 4-thread libuv pool, so a null result there would prove nothing about the fleet.
		name: 'cache-on-70',
		why: 'the on-disk resource cache with 70 cacheable sub-resources per render — production shape for the read path',
		urlQuery: 'chunks=69',
		resourceCache: { enabled: true, dir: process.env.BENCH_CACHE_DIR || '/tmp/prerender-bench-cache' },
	},
	{
		name: 'cache-off-70',
		why: 'the same 70-sub-resource page with NO resource cache — the control the cache is judged against',
		urlQuery: 'chunks=69',
	},
	{
		name: 'context-pool-70',
		why: "Chrome's own cache against the same 70-sub-resource page: does it make ours redundant?",
		urlQuery: 'chunks=69',
		contextPool: true,
	},
	{
		name: 'context-pool-cache-70',
		why: 'both caches, 70 sub-resources',
		urlQuery: 'chunks=69',
		contextPool: true,
		resourceCache: { enabled: true, dir: process.env.BENCH_CACHE_DIR2 || '/tmp/prerender-bench-cache2' },
	},
	{
		// Chrome's own DISK cache (and the V8 code cache that lives inside it) only exists for a
		// persistent profile's default context. An incognito context's cache is in-memory by
		// construction, so `--disk-cache-size` has never applied to a single production render — this
		// row is what it would buy if it did.
		name: 'udd-default-context',
		why: "persistent --user-data-dir + the default (non-incognito) context: Chrome's disk cache and code cache survive even a browser restart",
		browserOptions: { incognitoPages: false },
		launch: { userDataDir: process.env.BENCH_UDD || '/tmp/prerender-bench-udd' },
	},
	{
		name: 'udd-context-pool',
		why: 'does a persistent profile compose with slot-scoped INCOGNITO contexts, or is the pool already the whole effect?',
		contextPool: true,
		launch: { userDataDir: process.env.BENCH_UDD2 || '/tmp/prerender-bench-udd2' },
	},
	{
		name: 'default-context-pooled-pages',
		why: 'the default context with no persistent profile — a temp-profile disk cache shared by every render in one browser lifetime',
		browserOptions: { incognitoPages: false },
	},
	{
		name: 'context-pool-no-wipe',
		why: 'the pool WITHOUT the per-render cookie/storage wipe — prices the wipe itself, and is not shippable (renders would share a session)',
		contextPool: true,
		skipWipe: true,
	},
	{
		name: 'reduced-motion',
		why: 'emulate prefers-reduced-motion so animation frames stop competing with settle',
		experiments: { reducedMotion: true },
	},
];
