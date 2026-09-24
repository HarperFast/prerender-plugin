import ManagedBrowser from '../ManagedBrowser.js';
import RenderJob from '../RenderJob.js';
import defaultRenderer from '../renderer.js';
import { JobDocumentCache, documentDivergence, normalisedChunks, type DocumentDivergence } from '../documentReuse.js';
import { defaultLaunchOptions, resolveSettings, settings } from '../settings.js';
import { initResourceCache } from '../ResourceCache.js';
import { noop } from '../util/noop.js';
import type { BrowserOptions } from '../settings.js';
import type { PageFacts } from '../pageFacts.js';
import type { Renderer } from '../Worker.js';
import type { LaunchOptions } from 'puppeteer';

/**
 * DOES EACH DEVICE STILL RENDER ITS OWN PAGE WHEN THE DOCUMENT IS SHARED? Answered locally, against
 * the real site, BEFORE `documentReuse` is enabled anywhere.
 *
 * The sampled check inside the worker reports divergence after the fact, from production, on pages
 * already cached. That is the wrong instrument for the decision to turn reuse on: by the time it
 * says anything, the snapshots it is describing have been served. This renders each URL twice — once
 * with reuse off, which is exactly what production does today and therefore the control, and once
 * with it on — and compares each device against ITS OWN control. Nothing is compared across devices,
 * because the question is not whether desktop and mobile agree (they should not; that is the point
 * of rendering both) but whether each is still the page it would have been.
 *
 * WHAT IT COMPARES, in the order a failure is likely to appear:
 *
 *   - `structuredOffers` — the page's own schema.org price/availability, read off the settled DOM.
 *     This is the sharp end. Where a site routes its API calls by a cookie the document sets, a
 *     replayed variant runs without that cookie, its pricing call is answered by a different backend
 *     (or refused), and the offers come back wrong or empty while everything else still looks
 *     healthy. `cookies.pin` exists to prevent that, and this is how you find out whether it worked.
 *   - `outcome`, `statusCode`, `isIndexable` — a variant that silently stopped being storable.
 *   - Structural divergence of the serialized snapshot, normalised the same way the in-worker sample
 *     normalises it (hashed asset names, hydration ids and inline script bodies), so a deploy
 *     landing between the two renders does not read as a reuse defect.
 *
 *   - DEVICE IDENTITY — does the mobile render still look like a mobile render? Everything above
 *     compares a device against itself, which cannot see the failure people actually fear: reuse
 *     quietly turning the mobile variant into a second desktop render. So each device's control is
 *     also compared against the OTHER devices' controls to learn what markup is DISTINCTIVE to it —
 *     the chunks only that device's page produces — and the replayed render is then checked for how
 *     much of its own signature it kept. A replayed variant that had become its sibling would retain
 *     almost none. This is the only comparison here that crosses devices, and it crosses them to
 *     prove they stayed apart.
 *
 * A NON-ZERO DIVERGENCE IS NOT AUTOMATICALLY A FAILURE and the verdict says so separately: two
 * renders of a live page seconds apart differ for many innocent reasons (a rotating carousel, a
 * personalised rail, an A/B assignment). Read `offersMatch` and `outcomeMatch` first — those are the
 * ones that mean the page is wrong — then use the divergence samples to judge the rest by eye.
 */

export type ReuseParityOptions = Omit<BrowserOptions, 'harper'> & {
	/** URLs to check. A handful of the site's most structured pages beats a long list of simple ones. */
	urls: string[];
	/** Devices to render, in job order. Defaults to every device in the resolved config. */
	devices?: string[];
	/** Cookie names to pin across variants for this check — the routing cookies you intend to configure. */
	pin?: string[];
	/** Also fetch the document in-process first, as the prefetch pipeline does. */
	prefetch?: boolean;
	harper?: Partial<BrowserOptions['harper']>;
	renderer?: Renderer;
	/** Puppeteer launch overrides (headful, devtools). Fidelity-affecting opt-ins, as in renderOnce. */
	launch?: LaunchOptions;
};

export type VariantSnapshot = {
	outcome: string;
	statusCode: number | undefined;
	isIndexable: boolean | undefined;
	structuredOffers: Array<string | null> | null | undefined;
	/** The page's own SEO facts (canonical, title, h1, product JSON-LD, breadcrumbs), as a worker posts them. */
	pageFacts: PageFacts | null | undefined;
	bytes: number;
	/** Only on the reuse run: whether this variant's navigation was answered from a held document. */
	documentReused?: boolean;
	documentPrefetched?: boolean;
};

/**
 * Did this device stay itself? Measured RELATIVELY, because absolute measures do not survive a live
 * page: the replayed render is compared both against its own control and against the nearest OTHER
 * device's control, and what matters is that it is much closer to its own.
 *
 * The first version of this counted the markup distinctive to each device and checked how much the
 * replay kept — and it flagged the DESKTOP variant, which replays nothing at all. Recommendation
 * rails pick different products on every render, so most "distinctive" markup is distinctive to the
 * RENDER, not to the device. Churn inflates both sides of a relative comparison equally, so the ratio
 * between them still answers the question.
 */
export type DeviceIdentity = {
	/** Structural divergence between the replayed render and this device's own control. */
	ownRatio: number;
	/** Divergence from the nearest other device's control; null when there is no other device. */
	crossRatio: number | null;
	/**
	 * THIS DEVICE'S own churn: the distance between two reuse-off renders of it, taken on the same page
	 * in the same minute. Page churn and nothing else, and the floor any honest verdict is read
	 * against. Per device, because churn is not shared — one catalog page churned 0.172 on desktop and
	 * 0.024 on mobile in the same run.
	 */
	churnRatio: number;
	/** How far apart the two CONTROLS are — how distinguishable these devices are on this page at all. */
	deviceGap: number | null;
	/** `(churnRatio + crossRatio) / 2` — the line between "still itself" and "became its sibling". */
	threshold: number | null;
	/**
	 * False when the devices are not distinguishable above the churn (`deviceGap <= churnRatio`): the
	 * page simply does not render differently enough to tell, so the verdict is withheld rather than
	 * invented. Catalog pages with two builds live at the edge do this.
	 */
	conclusive: boolean;
};

export type DeviceParity = {
	deviceType: string;
	control: VariantSnapshot;
	reused: VariantSnapshot;
	/** The page's own offers are identical. The check that matters most. */
	offersMatch: boolean;
	/** Outcome, status and indexability all agree. */
	outcomeMatch: boolean;
	divergence: DocumentDivergence;
	/** How much closer the replayed render is to its own control than to the other device's. */
	identity: DeviceIdentity;
	/** False when the replayed render looks more like its sibling than like itself. */
	identityHeld: boolean;
	/** False when the offers or the outcome differ — the cases that mean the page is wrong. */
	pass: boolean;
};

export type ReuseParityResult = {
	url: string;
	devices: DeviceParity[];
	pass: boolean;
};

/** Render one URL as a multi-device job, the way the worker does, and hand back the variants. */
const renderJobVariants = async (
	browser: ManagedBrowser,
	url: string,
	devices: string[],
	renderFn: Renderer,
	{ reuse, pin }: { reuse: boolean; pin: string[] }
): Promise<RenderJob[]> => {
	const job = new RenderJob({
		id: 'reuse-parity',
		url,
		// Far future: nothing here posts a result, and a short lease would skip variants.
		expiresAt: Date.now() + 60 * 60 * 1000,
		deviceType: devices[0],
		deviceTypes: devices,
		callbackOrigin: 'http://localhost',
		isFromSitemap: false,
	});
	const variants = job.variants();
	// The worker's own construction: one cache shared by every variant of the job. Absent on the
	// control run, which is what makes it the control — each variant then fetches its own document.
	if (reuse) {
		const cache = new JobDocumentCache({ acrossDevices: true, pin });
		for (const variant of variants) variant.documentCache = cache;
	}
	for (const variant of variants) {
		const page = await browser.getPage();
		try {
			const content = await renderFn(page, variant);
			variant.attemptStarted();
			variant.attemptEnded(undefined, content);
		} catch (e) {
			variant.attemptStarted();
			variant.attemptEnded(e as Error, undefined);
		} finally {
			await browser.closePage(page).catch(noop);
		}
	}
	return variants;
};

const snapshotOf = (variant: RenderJob, withReuseFlags: boolean): VariantSnapshot => ({
	outcome: variant.outcome,
	statusCode: variant.httpResponse?.statusCode,
	isIndexable: variant.isIndexable,
	structuredOffers: variant.structuredOffers,
	pageFacts: variant.pageFacts,
	bytes: variant.content?.length ?? 0,
	...(withReuseFlags ? { documentReused: variant.documentReused, documentPrefetched: variant.documentPrefetched } : {}),
});

const sameOffers = (a: VariantSnapshot['structuredOffers'], b: VariantSnapshot['structuredOffers']) =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which page facts differ between two renders (`product.*` per field) — informational, not in `pass`. */
const differingFacts = (a: VariantSnapshot['pageFacts'], b: VariantSnapshot['pageFacts']): string[] => {
	if (!a || !b) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) ? [] : ['pageFacts'];
	const keys = (x: object, y: object) => [...new Set([...Object.keys(x), ...Object.keys(y)])];
	const differs = (x: unknown, y: unknown) => JSON.stringify(x ?? null) !== JSON.stringify(y ?? null);
	const out: string[] = [];
	for (const key of keys(a, b) as Array<keyof PageFacts>) {
		if (key === 'product' && a.product && b.product) {
			for (const field of keys(a.product, b.product) as Array<keyof typeof a.product>) {
				if (differs(a.product[field], b.product[field])) out.push(`product.${field}`);
			}
		} else if (differs(a[key], b[key])) {
			out.push(key);
		}
	}
	return out;
};

/**
 * Did this device stay itself? Asked as three distances measured on the same page in the same minute:
 * how far the replayed render is from its OWN control, how far it is from the nearest OTHER device's
 * control, and how far apart two renders of a device that replayed NOTHING are — the churn floor.
 *
 * The floor is what makes this survivable on a live page. An absolute "kept its own markup" measure
 * was tried first and failed the control: recommendation rails pick different products on every
 * render, so a desktop variant that replays nothing at all still loses most of its distinctive markup
 * between two renders. Catalog pages here churn 0.23 while their two devices differ by 0.28 — any
 * fixed threshold is either blind or crying wolf, and the same number means different things page to
 * page. So the verdict is: a replayed render must sit closer to the churn floor than to its sibling.
 */
const deviceIdentity = (own: string, others: string[], reused: string, churnRatio: number): DeviceIdentity => {
	const ownRatio = documentDivergence(own, reused).ratio;
	const crossRatios = others.map((other) => documentDivergence(other, reused).ratio);
	const crossRatio = crossRatios.length ? Math.min(...crossRatios) : null;
	// Distinguishability is a property of the CONTROLS, not of the render under test: if the replayed
	// render has become its sibling, its own distance to that sibling says nothing about whether the
	// devices were ever telling apart.
	const gaps = others.map((other) => documentDivergence(own, other).ratio);
	const deviceGap = gaps.length ? Math.min(...gaps) : null;
	const conclusive = deviceGap !== null && deviceGap > churnRatio;
	return {
		ownRatio,
		crossRatio,
		churnRatio,
		deviceGap,
		threshold: crossRatio !== null ? (churnRatio + crossRatio) / 2 : null,
		conclusive,
	};
};

/**
 * Run the check over `urls`. One browser for the whole run, each URL rendered control-first so the
 * two runs are as close together in time as possible. Never throws for a page that failed to render:
 * a failure IS the answer, and it is reported as one.
 */
export async function reuseParityCheck(options: ReuseParityOptions): Promise<ReuseParityResult[]> {
	const {
		urls,
		devices: requestedDevices,
		pin = [],
		prefetch = false,
		harper,
		renderer,
		launch,
		...browserOptions
	} = options;
	if (!urls?.length) throw new Error('reuseParityCheck: `urls` is required');

	// The same settings path production resolves through, with the resource cache OFF: a shared cache
	// would serve one run's sub-resources into the other and hide exactly what this is looking for.
	//
	// `config` may be a JSON file path, which cannot be spread — so the reuse block is layered on only
	// when an object was given. With a path, the file's own `documentReuse` is left alone and the
	// caller is responsible for it; the two runs still differ, because the cache is attached per job
	// below rather than read from config.
	const baseConfig =
		typeof browserOptions.config === 'object' && browserOptions.config !== null ? browserOptions.config : {};
	resolveSettings(
		{
			...browserOptions,
			harper: harper ?? {},
			resourceCache: { enabled: false, ...browserOptions.resourceCache },
			config: {
				...baseConfig,
				documentReuse: {
					...baseConfig.documentReuse,
					enabled: true,
					sampleEvery: 0,
					cookies: { pin },
					prefetch: { enabled: prefetch },
				},
			},
		},
		{ requireHarper: false }
	);
	await initResourceCache(settings.resourceCache);

	const devices = requestedDevices ?? Object.keys(settings.config.devices);
	const renderFn = renderer ?? defaultRenderer;
	const browser = await ManagedBrowser.launch({
		maxActivePages: 1,
		puppeteerLaunchOptions: { ...(settings.browserLaunchOptions ?? defaultLaunchOptions()), ...launch },
	});

	const results: ReuseParityResult[] = [];
	try {
		for (const url of urls) {
			// TWO control passes, then the reuse pass — all back to back, so a site change between them is
			// as unlikely as it can be made without freezing the origin.
			//
			// The second control is what makes the identity verdict trustworthy: two reuse-OFF renders of
			// THE SAME DEVICE differ only by page churn, so each device brings its own floor. A shared
			// floor is not good enough — measured on one catalog page, two desktop renders differed by
			// 0.172 while two mobile renders differed by 0.024, and judging mobile against desktop's noise
			// (or the reverse) invents a failure in one direction and hides one in the other.
			const priorControl = await renderJobVariants(browser, url, devices, renderFn, { reuse: false, pin });
			const control = await renderJobVariants(browser, url, devices, renderFn, { reuse: false, pin });
			const reused = await renderJobVariants(browser, url, devices, renderFn, { reuse: true, pin });

			const perDevice = devices.map((deviceType, i) => {
				const a = snapshotOf(control[i], false);
				const b = snapshotOf(reused[i], true);
				const offersMatch = sameOffers(a.structuredOffers, b.structuredOffers);
				const outcomeMatch =
					a.outcome === b.outcome && a.statusCode === b.statusCode && a.isIndexable === b.isIndexable;
				const identity = deviceIdentity(
					control[i].content ?? '',
					control.filter((_, j) => j !== i).map((v) => v.content ?? ''),
					reused[i].content ?? '',
					documentDivergence(priorControl[i].content ?? '', control[i].content ?? '').ratio
				);
				// Only a REPLAYED variant can lose its identity to reuse: the one that fetched its own document
				// is the control by construction, and judging it produces exactly the false failure that made the
				// first version of this useless. An inconclusive measurement is not a failure either — it is
				// reported as inconclusive and the operator decides.
				const identityHeld =
					!reused[i].documentReused || !identity.conclusive || identity.ownRatio <= (identity.threshold ?? Infinity);
				return {
					deviceType,
					control: a,
					reused: b,
					offersMatch,
					outcomeMatch,
					divergence: documentDivergence(control[i].content ?? '', reused[i].content ?? ''),
					identity,
					identityHeld,
					pass: offersMatch && outcomeMatch && identityHeld,
				};
			});
			results.push({ url, devices: perDevice, pass: perDevice.every((d) => d.pass) });
		}
	} finally {
		await browser.close().catch(noop);
	}
	return results;
}

/** A short human-readable report: one line per device, and the verdict that decides the rollout. */
export function formatReuseParity(results: ReuseParityResult[]): string {
	const lines: string[] = [];
	for (const result of results) {
		lines.push(`${result.pass ? 'PASS' : 'FAIL'}  ${result.url}`);
		for (const d of result.devices) {
			const flags = [d.reused.documentReused && 'reused', d.reused.documentPrefetched && 'prefetched']
				.filter(Boolean)
				.join('+');
			const id = !d.reused.documentReused
				? 'n/a (fetched its own document — this is the churn floor)'
				: d.identity.crossRatio === null
					? 'n/a (single device)'
					: !d.identity.conclusive
						? `INCONCLUSIVE (own ${d.identity.ownRatio.toFixed(3)}, sibling ${d.identity.crossRatio.toFixed(3)}, churn ${d.identity.churnRatio.toFixed(3)} — the devices do not differ above the churn)`
						: `own ${d.identity.ownRatio.toFixed(3)} vs sibling ${d.identity.crossRatio.toFixed(3)}, churn ${d.identity.churnRatio.toFixed(3)}${d.identityHeld ? '' : ' — NOT ITSELF'}`;
			lines.push(
				`   ${d.pass ? 'ok  ' : 'DIFF'} ${d.deviceType.padEnd(8)} ` +
					`offers=${d.offersMatch ? 'same' : 'DIFFERENT'} ` +
					`outcome=${d.outcomeMatch ? 'same' : `${d.control.outcome}/${d.control.statusCode} -> ${d.reused.outcome}/${d.reused.statusCode}`} ` +
					`device=${id} ` +
					`divergence=${d.divergence.ratio.toFixed(4)} ` +
					`bytes=${d.control.bytes}->${d.reused.bytes}${flags ? ` [${flags}]` : ''}`
			);
			if (!d.identityHeld) {
				lines.push(
					`        the replayed render sits closer to the other device's page than to page churn — reuse did not preserve ${d.deviceType}`
				);
			}
			if (!d.offersMatch) {
				lines.push(`        control offers : ${JSON.stringify(d.control.structuredOffers)}`);
				lines.push(`        reused  offers : ${JSON.stringify(d.reused.structuredOffers)}`);
			}
			const facts = differingFacts(d.control.pageFacts, d.reused.pageFacts);
			if (facts.length) lines.push(`        page facts differ (informational): ${facts.join(', ')}`);
			if (d.divergence.samples.length) {
				lines.push(`        differing markup: ${d.divergence.samples.slice(0, 2).join(' | ')}`);
			}
		}
	}
	const failed = results.filter((r) => !r.pass).length;
	lines.push(
		failed
			? `\n${failed} of ${results.length} URLs differ where it matters — do NOT enable documentReuse.`
			: `\nAll ${results.length} URLs match per device, and each device kept its own markup — no replayed render became its sibling. Divergence ratios above are page churn, not reuse; read the samples before trusting a high one.`
	);
	return lines.join('\n');
}
