import type { HTTPRequest, HTTPResponse } from 'puppeteer';

/**
 * Reuse of the main document across the device variants of ONE job.
 *
 * A job renders every device of one URL in turn (see Worker.render). Each variant navigates to the
 * same URL seconds apart, and on a responsive site the origin answers with the same document — the
 * device only changes how the page LAYS OUT, through CSS media queries and the viewport the page
 * script sees. So the first variant's document can stand in for the second's: it is captured off the
 * wire as it arrives, and the next variant's navigation request is fulfilled from it instead of going
 * to the origin. Measured on a production storefront (full-document diffs, desktop vs mobile, against
 * a same-device repeat as the noise floor): product 3 hunks vs 4, homepage 1 vs 2, catalog 1 vs 1,202
 * — every device difference was per-request noise (RUM variables, hydration island ids), and every
 * document sent `Vary: Accept-Encoding` only. What it saves is one document fetch per URL render —
 * 0.4–0.7 s of origin time on a 4.7 MB product document there, plus the second variant's download.
 *
 * WHAT MAKES IT SAFE TO REUSE, and why each guard exists:
 *
 *   - OPT-IN, PER SITE. An ADAPTIVE site (server-side device detection, an m-dot redirect, a
 *     `Vary: User-Agent`) serves different markup per device, and replaying desktop markup into a
 *     mobile render would cache a page no mobile visitor is ever served — the snapshot is wrong in the
 *     direction that matters for cloaking. Nothing here can tell a responsive site from an adaptive
 *     one by itself, so the operator says so (`documentReuse.enabled`), and the sampled check below is
 *     how that claim keeps being tested.
 *   - `Vary`. A document that declares it varies on the user agent or the client hints is never
 *     reused, whatever the flag says; `Accept-Encoding` (the universal value) and other header names
 *     are fine — the request headers that differ between variants are the UA and its hints, and the
 *     body is stored DECODED, so encoding cannot matter.
 *   - Only a final 200 `text/html` with no redirect chain. A redirected navigation is decided by the
 *     plugin (and rendered by nobody); an error page is its own verdict; a non-HTML body is not a
 *     document. Anything else falls through to a normal fetch — reuse is an optimisation, never a
 *     substitute for the origin's answer.
 *   - NO COOKIE CROSSES VARIANTS EXCEPT THE ONES NAMED, and the default list is empty. Every variant
 *     otherwise starts with an empty jar, exactly as it did when each fetched its own document and
 *     exactly as the bots this cache serves arrive. A document response sets plenty (bot-manager,
 *     experiment buckets, store selection) and a replayed variant's scripts run without them, because
 *     a cookie is what ties a render to an identity and two devices sharing one is what a two-device
 *     job must not manufacture.
 *
 *     THE EXCEPTION IS ROUTING. Where a storefront picks WHICH BACKEND serves the page's API calls
 *     from a cookie its document sets, a sibling replaying that document without the cookie renders
 *     against a different backend than the device that fetched it — so one URL's two snapshots come
 *     from two different systems, which is the very divergence rendering both devices in one job
 *     exists to close. Such a cookie is part of the document's meaning, not of a session, so
 *     `documentReuse.cookies.pin` names those and only those, and a pinned cookie is also sent by a
 *     variant that goes to the origin itself — parity whichever path a variant takes. See
 *     `crossableCookies`, and note the corollary: with reuse OFF each device gets its own document
 *     and its own cookie, so if that value is assigned per response rather than derived from the
 *     request, the two devices can already disagree today. Worth measuring before assuming otherwise.
 *
 *     A prefetch answering the navigation of the device that FETCHED it replays that response's
 *     cookies in full: they are that variant's own, arriving a moment early, not another device's.
 *   - REPLAY IS MARKED. The fulfilled response carries `x-render-document-reuse: 1` so the renderer's
 *     own response handler does not re-capture it, and the variant reports `documentReused: true` to
 *     the plugin, so reuse is visible per result rather than inferred from timing.
 *
 * PREFETCH (`documentReuse.prefetch`, documentPrefetch.ts). Reuse takes the document fetch from once
 * per device to once per URL; prefetch takes it OFF THE RENDER'S CRITICAL PATH. The worker fetches a
 * claimed job's document in this process while earlier jobs are still rendering, and the job's first
 * variant is answered from it — with the response's own cookies, so that variant is indistinguishable
 * from one whose navigation Chrome served — and the later variants replay it as they always did. A
 * prefetched document is that device's own response fetched early, so it needs none of the cross-device
 * guards (the `Vary` rule, the responsive-site claim, sampling): prefetch works on its own for a
 * single-device job, and with `enabled` it is also what the siblings replay. The variant reports
 * `documentPrefetched: true`. With prefetch on, a sample job's comparison is between a document THIS
 * process fetched and one Chrome fetched for the same URL, so it also keeps the prefetch's fidelity
 * under test.
 *
 * THE SAMPLED CHECK (`documentReuse.sampleEvery`). Every Nth job renders its second variant the old
 * way — a real fetch — and compares that document against the one the first variant captured. The
 * comparison is STRUCTURAL: both documents are split at tag boundaries, hashed asset names, hydration
 * island ids and script bodies are normalised away, and the result is the share of chunks present in
 * one and not the other. That normalisation is load-bearing: measured on the same storefront, two
 * desktop fetches of one catalog page seconds apart were DIFFERENT BUILDS of the site (1,202 raw hunks,
 * every one an asset hash or an inlined-vs-linked stylesheet), so a raw diff would report divergence
 * on any deploy day. The sample is OBSERVABILITY, not a circuit breaker — it is logged and counted so
 * an operator can see a site turn adaptive, and it deliberately does not switch reuse off by itself,
 * because a deploy in progress would trip it for nothing.
 */

export const DOCUMENT_REUSE_HEADER = 'x-render-document-reuse';

/**
 * How long a navigation will wait for a prefetch that has not landed — see `replayFor`. Small on
 * purpose and deliberately not configurable: this is a grace for a document arriving right now, not
 * a budget. A deployment that needs a bigger one needs a deeper pool instead.
 */
export const PREFETCH_MAX_WAIT_MS = 500;

/**
 * True if `promise` settles within `graceMs`. A sentinel rather than the resolved value, because
 * the prefetch resolves to NULL when it legitimately yielded no document (a redirect, a non-HTML
 * body) — reading that as "did not land in time" would abort a prefetch that had already finished
 * and count a normal fall-through as a late one. The timer never holds the process open.
 */
const LATE = Symbol('prefetch-late');
const settledInTime = async (promise: Promise<unknown>, graceMs: number): Promise<boolean> => {
	let timer: NodeJS.Timeout | undefined;
	const grace = new Promise<typeof LATE>((resolve) => {
		timer = setTimeout(() => resolve(LATE), graceMs);
		timer.unref?.();
	});
	try {
		return (await Promise.race([promise, grace])) !== LATE;
	} finally {
		clearTimeout(timer);
	}
};

/** A job's document, held to answer a navigation: captured off the first variant's wire, or prefetched. */
export type CapturedDocument = {
	url: string;
	status: number;
	/**
	 * Response headers as received, WITHOUT `set-cookie` — stripped by whoever captured this, so the
	 * type's own invariant holds rather than resting on `toRespondPayload`'s filter. Any cookies the
	 * response set live in `setCookies` instead, and only a prefetch keeps them.
	 */
	headers: Record<string, string>;
	/** The DECODED body — the content encoding has already been undone by whoever fetched it. */
	body: Buffer;
	/** The device whose request fetched it — the device whose navigation this document IS, not a stand-in. */
	deviceType: string;
	/**
	 * Where it came from: `navigation` — captured from a variant's own response, which Chrome has
	 * already applied (cookies included) to that variant; `prefetch` — fetched by the worker ahead of
	 * the render (documentPrefetch.ts), which no variant has seen yet.
	 */
	source: 'navigation' | 'prefetch';
	/**
	 * The response's `Set-Cookie` values, kept apart from `headers`. Only a prefetch carries them, and
	 * they are replayed ONLY to `deviceType`'s own navigation — the cookies that variant's document
	 * would have set had Chrome fetched it — never to another device (see the module comment).
	 */
	setCookies?: string[];
};

/**
 * One job's document state. Created by the worker — for a multi-device job when reuse is enabled,
 * and for every job when prefetch is — handed to every variant, and read by the renderer through
 * `replayFor`: a prefetched document answers the navigation of the device it was fetched for; the
 * first variant's document (prefetched or captured) answers the later variants — or, on a SAMPLE job,
 * the later variant fetches normally and the two are compared.
 */
export class JobDocumentCache {
	entry: CapturedDocument | null = null;
	/**
	 * Replays the browser refused to fulfil, by device. A fulfilment failure is survivable — the
	 * variant falls through and fetches its own document — but it must never be silent: it means every
	 * sibling of every job is paying an extra origin fetch, and the reason is in the message.
	 */
	replayFailures: Array<{ deviceType: string; message: string }> = [];
	/** True on the jobs `documentReuse.sampleEvery` selects: later variants fetch normally and compare. */
	readonly sample: boolean;
	/** Whether a document may answer a DIFFERENT device's navigation (`documentReuse.enabled`). */
	readonly acrossDevices: boolean;
	/**
	 * The worker's prefetch of this job's document, when one was started (documentPrefetch.ts): settles
	 * to the document, or to null when the variant must fetch for itself. Fills `entry` on success.
	 */
	prefetch: Promise<CapturedDocument | null> | null = null;
	/** Cancels a prefetch still in flight — a job dropped at shutdown, or one whose lease ran out. */
	prefetchAbort: AbortController | null = null;
	/** Devices whose navigation was answered from ANOTHER device's document. */
	reusedBy: string[] = [];
	/** Devices whose navigation was answered from the prefetched document. */
	prefetchedBy: string[] = [];
	/**
	 * How long a navigation had to wait for a prefetch still in flight, ms (the longest, over the job's
	 * variants); 0 when the document was already in hand — the signal that `prefetch.depth` is enough.
	 * Null until a variant asked.
	 */
	prefetchWaitMs: number | null = null;
	/** True when a prefetch was still in flight past the grace above, so the render fetched instead. */
	prefetchLate = false;
	/**
	 * For each device that fetched its OWN document, the pinned cookies that response set — the
	 * evidence for whether those cookies are device-independent, which is what pinning assumes.
	 * Populated only when a pin list is configured, and only from cold fetches (a replay sets nothing
	 * new). Two devices here with different values is the assumption failing.
	 */
	pinnedCookiesByDevice = new Map<string, string>();
	/** The sampled comparison's result, once a sample job has run its second variant. */
	divergence: DocumentDivergence | null = null;

	private readonly pinnedNames: Set<string>;

	constructor({
		sample = false,
		acrossDevices = true,
		pin = [],
	}: { sample?: boolean; acrossDevices?: boolean; pin?: string[] } = {}) {
		this.sample = sample;
		this.acrossDevices = acrossDevices;
		this.pinnedNames = new Set(pin.map((name) => name.toLowerCase()));
	}

	/**
	 * The document that may answer `deviceType`'s navigation, or null when it must fetch for itself.
	 * Waits for a pending prefetch first. A document fetched FOR this device (a prefetch) always
	 * qualifies — it is that device's own response, only fetched earlier. Another device's document
	 * qualifies only across devices, on a non-sample job, and when its `Vary` does not name the user
	 * agent or a client hint.
	 */
	async replayFor(deviceType: string): Promise<CapturedDocument | null> {
		// THE WAIT IS BOUNDED, and the bound is the whole point. This runs inside the PAUSED
		// navigation request, so every millisecond spent here is spent inside `page.goto` — whose
		// timeout defaults to the entire render budget. An unbounded wait therefore inverted the
		// feature: against a slow origin the render blocked for the full prefetch timeout, got
		// nothing, fetched the document itself anyway, and entered the settle phase with a fraction
		// of its budget left — an under-hydrated snapshot from a render that reports success.
		// Strictly worse than never prefetching at all.
		//
		// A prefetch that has not landed by now is a miss, and the honest response to a miss is to
		// go to the origin. The grace below only exists to catch one that is a hair from arriving;
		// anything longer is not a saving, it is latency moved from the fetch to the wait. If these
		// are common, `prefetch.depth` is too shallow for the concurrency — which is exactly what
		// `prefetchWaitMs` and `prefetchLate` are for.
		if (this.prefetch) {
			const waitStart = Date.now();
			const landed = await settledInTime(this.prefetch, PREFETCH_MAX_WAIT_MS);
			this.prefetchWaitMs = Math.max(this.prefetchWaitMs ?? 0, Date.now() - waitStart);
			if (!landed) {
				// Stop it holding an origin connection for a render that is no longer waiting on it.
				this.prefetchLate = true;
				this.abortPrefetch();
				return null;
			}
		}
		const doc = this.entry;
		if (!doc) return null;
		// A SAMPLE JOB REPLAYS NOTHING, its own device included. With prefetch on, the comparison
		// that matters is no longer only "is this site still responsive" but "is the document this
		// process fetched the one Chrome would have got" — and that question is only answered by
		// letting Chrome fetch the SAME device and diffing the two. Returning the prefetched
		// document here would compare this process's fetch of one device against Chrome's fetch of
		// another, which is two variables in one number.
		if (this.sample) return null;
		if (doc.deviceType === deviceType) return doc;
		if (!this.acrossDevices) return null;
		if (varyForbidsReuse(doc.headers['vary'])) return null;
		return doc;
	}

	/** Record what one device's own document response set, for the pinned names. */
	notePinnedCookies(deviceType: string, setCookieHeader: string | undefined): void {
		const values = setCookieHeader ? setCookieHeader.split('\n') : [];
		const pinned = values.filter((value) => this.pinnedNames.has(cookieName(value).toLowerCase()));
		if (pinned.length) this.pinnedCookiesByDevice.set(deviceType, pinned.slice().sort().join('; '));
	}

	/**
	 * The devices whose pinned cookies disagree, if any — empty when fewer than two devices fetched
	 * their own document, or when they all got the same values.
	 */
	pinnedCookieConflict(): string[] {
		const seen = new Set(this.pinnedCookiesByDevice.values());
		return seen.size > 1 ? [...this.pinnedCookiesByDevice.keys()] : [];
	}

	abortPrefetch(): void {
		this.prefetchAbort?.abort();
	}
}

/**
 * Header NAMES a `Vary` may cite without forbidding reuse. Everything the variants send differently
 * is the user agent and its client hints, so a document that varies on those is device-specific by
 * the origin's own declaration; a document that varies on anything else varies on something both
 * variants send identically (or, for `Accept-Encoding`, on something the decoded body has already
 * absorbed).
 */
const DEVICE_VARY =
	/^(user-agent|sec-ch-ua(-[a-z-]+)?|sec-ch-viewport-width|sec-ch-dpr|sec-ch-device-memory|width|dpr|viewport-width|device-memory|\*)$/;

/** True when a `Vary` header names the user agent, a client hint, or `*`. */
export const varyForbidsReuse = (vary: string | undefined | null): boolean => {
	if (!vary) return false;
	return vary
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.some((name) => DEVICE_VARY.test(name));
};

/** True when this navigation response is one the next variant may be answered from. */
export const isReusableDocument = (res: HTTPResponse, req: HTTPRequest): boolean => {
	if (res.status() !== 200) return false;
	if (req.redirectChain().length > 0) return false;
	const headers = res.headers();
	if (headers[DOCUMENT_REUSE_HEADER]) return false; // our own replay
	const contentType = (headers['content-type'] ?? '').toLowerCase();
	if (!contentType.startsWith('text/html')) return false;
	if (varyForbidsReuse(headers['vary'])) return false;
	return true;
};

/**
 * Headers that must not be replayed. Hop-by-hop headers (RFC 7230 §6.1); `content-encoding` and
 * `content-length`, because the stored body is decoded and Chrome recomputes the length; and
 * `set-cookie`, because no cookie crosses variants (see the module comment — Chrome would store it,
 * which is exactly why it has to be stripped). The same list the resource cache applies to a
 * replayed asset. A prefetched document's own cookies are carried apart from its headers
 * (`CapturedDocument.setCookies`) and added back by `toRespondPayload` only for the device that
 * fetched it.
 */
const NON_REPLAYABLE = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-encoding',
	'content-length',
	'set-cookie',
]);

/** The name of a `Set-Cookie` value — everything before the first `=`. */
export const cookieName = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf('=')).trim();

/**
 * The `Set-Cookie` values a variant may be given, from a document that is not its own.
 *
 * ONLY THE PINNED ONES CROSS, and the operator names them. The reason they must cross at all is
 * backend parity: where a storefront picks the backend that serves its API calls from a cookie its
 * document sets, a sibling replaying that document WITHOUT the cookie renders against a different
 * backend than the device that fetched it — so a URL's two snapshots come from two different systems,
 * which is the one thing rendering both devices in one job exists to prevent. A cookie that decides
 * routing is not a session; it is part of the document's meaning.
 *
 * Everything else still never crosses. Session, cart, visitor and bot-manager cookies tie a render
 * to an identity, and two devices sharing one is exactly what a two-device job must not manufacture
 * — so the list is an allowlist of names, empty by default, and never a pattern.
 */
export const crossableCookies = (doc: CapturedDocument, pin: string[]): string[] => {
	if (!pin.length || !doc.setCookies?.length) return [];
	const wanted = new Set(pin.map((name) => name.toLowerCase()));
	return doc.setCookies.filter((value) => wanted.has(cookieName(value).toLowerCase()));
};

/** Those same cookies as a request `Cookie` header, for a variant that fetches its own document. */
export const cookieHeaderOf = (setCookies: string[]): string =>
	setCookies.map((value) => value.split(';', 1)[0].trim()).join('; ');

/**
 * The fulfilment payload for `HTTPRequest.respond()` built from a held document. `cookies` are the
 * `Set-Cookie` values to replay (puppeteer accepts a list): all of the document's own for the device
 * that fetched it, so it starts exactly as it would have had Chrome fetched it, and for a sibling
 * only the pinned subset — see `crossableCookies`.
 */
export const toRespondPayload = (doc: CapturedDocument, { cookies = [] }: { cookies?: string[] } = {}) => {
	const headers: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(doc.headers)) {
		if (NON_REPLAYABLE.has(name.toLowerCase())) continue;
		// A REPEATED response header reaches us as puppeteer's `\n`-join of its values, and CDP refuses
		// a header value containing one — `Fetch.fulfillRequest` fails with `Invalid header: <name>`,
		// which fails the WHOLE replay, not that header. Measured against a production CDN, which
		// repeats `server-timing` on every document. Repeats go back as a list, which puppeteer expands
		// into repeated headers, exactly as `set-cookie` already did.
		headers[name] = value.includes('\n') ? value.split('\n') : value;
	}
	if (cookies.length) headers['set-cookie'] = cookies;
	headers[DOCUMENT_REUSE_HEADER] = '1';
	return { status: doc.status, headers, body: doc.body };
};

// ── the sampled structural comparison ────────────────────────────────────────────────────────────

export type DocumentDivergence = {
	/** Distinct normalised chunks across both documents. */
	chunks: number;
	/** Chunks present in one document and not the other, after normalisation. */
	differing: number;
	/** `differing / chunks`, 0 for identical structure. */
	ratio: number;
	/** Up to a handful of differing chunks, for the log line. */
	samples: string[];
};

/**
 * Normalise one tag-boundary chunk so that deploy churn does not read as device divergence:
 * hashed asset names (`Layout.Dvfxdw-C.css`, `index.uzchtO2o.js`), hydration island ids
 * (`uid="ZV9nP3"`), and inline script/style bodies (RUM variables, per-request ids) — the things
 * that differed between two same-device fetches seconds apart.
 */
const normaliseChunk = (chunk: string): string =>
	chunk
		.replace(/\.[A-Za-z0-9_-]{6,12}\.(js|css|mjs)\b/g, '.HASH.$1')
		.replace(/\buid="[^"]*"/g, 'uid=""')
		.replace(/(^|>)script(\s[^>]*)?>[\s\S]*$/, '$1script$2>')
		.replace(/(^|>)style(\s[^>]*)?>[\s\S]*$/, '$1style$2>')
		.replace(/\s+/g, ' ')
		.trim();

/**
 * How much two documents differ STRUCTURALLY, as a bag-of-chunks difference (order-insensitive,
 * O(n)) rather than an alignment — cheap enough to run on a multi-megabyte document inside a render,
 * and what the question actually needs: "does the mobile document contain markup the desktop one
 * does not", not "where".
 */
export const normalisedChunks = (doc: Buffer | string): Map<string, number> => {
	const counts = new Map<string, number>();
	for (const raw of doc.toString().split('><')) {
		const chunk = normaliseChunk(raw);
		if (!chunk) continue;
		counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
	}
	return counts;
};

export const documentDivergence = (a: Buffer | string, b: Buffer | string): DocumentDivergence => {
	const left = normalisedChunks(a);
	const right = normalisedChunks(b);
	let differing = 0;
	let chunks = 0;
	const samples: string[] = [];
	// The key set is built in place rather than from `[...left.keys(), ...right.keys()]`: this runs on
	// multi-megabyte documents inside a render, and the spread would allocate a throwaway array holding
	// every distinct chunk of both documents before the Set ever sees one.
	const keys = new Set(left.keys());
	for (const key of right.keys()) keys.add(key);
	for (const key of keys) {
		const l = left.get(key) ?? 0;
		const r = right.get(key) ?? 0;
		chunks += Math.max(l, r);
		const delta = Math.abs(l - r);
		if (delta > 0) {
			differing += delta;
			if (samples.length < 5) samples.push(key.slice(0, 160));
		}
	}
	return { chunks, differing, ratio: chunks ? differing / chunks : 0, samples };
};
