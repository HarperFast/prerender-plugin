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
 *   - NO COOKIES CROSS VARIANTS. The replayed response carries no `Set-Cookie`, and nothing is copied
 *     from the first variant's context: every variant still starts with an empty jar, exactly as it
 *     did when each fetched its own document, and exactly as the bots this cache serves arrive. The
 *     document response does set cookies (bot-manager, experiment buckets, store selection) that page
 *     scripts may read, so a replayed variant's scripts run without them — a deliberate choice: a
 *     cookie is what ties a render to a session, and two devices sharing one session is the one thing
 *     a two-device job must not manufacture. Both alternatives were checked and declined: copying the
 *     first context's cookies works, and Chrome DOES store `Set-Cookie` from a fulfilled response
 *     (verified against Chrome via Fetch.fulfillRequest), so either would be a one-line change if the
 *     decision is ever revisited. The one place `Set-Cookie` IS replayed is the prefetch answering the
 *     navigation of the device that fetched it (below): those are that variant's OWN cookies, arriving
 *     a moment early, not another device's.
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

/** A job's document, held to answer a navigation: captured off the first variant's wire, or prefetched. */
export type CapturedDocument = {
	url: string;
	status: number;
	/** Response headers as received (without `set-cookie`), before `toRespondPayload` filters them. */
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
	/** The sampled comparison's result, once a sample job has run its second variant. */
	divergence: DocumentDivergence | null = null;

	constructor({ sample = false, acrossDevices = true }: { sample?: boolean; acrossDevices?: boolean } = {}) {
		this.sample = sample;
		this.acrossDevices = acrossDevices;
	}

	/**
	 * The document that may answer `deviceType`'s navigation, or null when it must fetch for itself.
	 * Waits for a pending prefetch first. A document fetched FOR this device (a prefetch) always
	 * qualifies — it is that device's own response, only fetched earlier. Another device's document
	 * qualifies only across devices, on a non-sample job, and when its `Vary` does not name the user
	 * agent or a client hint.
	 */
	async replayFor(deviceType: string): Promise<CapturedDocument | null> {
		if (this.prefetch) {
			const waitStart = Date.now();
			await this.prefetch;
			this.prefetchWaitMs = Math.max(this.prefetchWaitMs ?? 0, Date.now() - waitStart);
		}
		const doc = this.entry;
		if (!doc) return null;
		if (doc.deviceType === deviceType) return doc;
		if (!this.acrossDevices || this.sample) return null;
		if (varyForbidsReuse(doc.headers['vary'])) return null;
		return doc;
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

/**
 * The fulfilment payload for `HTTPRequest.respond()` built from a held document. `withCookies` adds
 * the document's own `Set-Cookie` values back (puppeteer accepts a list) — for the device whose
 * navigation this document is, so it starts exactly as it would have had Chrome fetched it; never for
 * a sibling replaying it.
 */
export const toRespondPayload = (doc: CapturedDocument, { withCookies = false }: { withCookies?: boolean } = {}) => {
	const headers: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(doc.headers)) {
		if (!NON_REPLAYABLE.has(name.toLowerCase())) headers[name] = value;
	}
	if (withCookies && doc.setCookies?.length) headers['set-cookie'] = doc.setCookies;
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
export const documentDivergence = (a: Buffer | string, b: Buffer | string): DocumentDivergence => {
	const bag = (doc: Buffer | string) => {
		const counts = new Map<string, number>();
		for (const raw of doc.toString().split('><')) {
			const chunk = normaliseChunk(raw);
			if (!chunk) continue;
			counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
		}
		return counts;
	};
	const left = bag(a);
	const right = bag(b);
	let differing = 0;
	let chunks = 0;
	const samples: string[] = [];
	for (const key of new Set([...left.keys(), ...right.keys()])) {
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
