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
 *     decision is ever revisited.
 *   - REPLAY IS MARKED. The fulfilled response carries `x-render-document-reuse: 1` so the renderer's
 *     own response handler does not re-capture it, and the variant reports `documentReused: true` to
 *     the plugin, so reuse is visible per result rather than inferred from timing.
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

/** The first variant's document, ready to stand in for the next variant's navigation. */
export type CapturedDocument = {
	url: string;
	status: number;
	/** Response headers as received, before `replayHeaders` filters them for fulfilment. */
	headers: Record<string, string>;
	/** The DECODED body — `HTTPResponse.buffer()` has already undone the content encoding. */
	body: Buffer;
	/** The device that fetched it, for the log line and the result. */
	deviceType: string;
};

/**
 * One job's shared document state. Created by the worker for a multi-device job when reuse is
 * enabled, handed to every variant, and read by the renderer: the first variant to capture a
 * reusable document fills `entry`; later variants replay it — or, on a SAMPLE job, fetch normally
 * and compare against it.
 */
export class JobDocumentCache {
	entry: CapturedDocument | null = null;
	/** True on the jobs `documentReuse.sampleEvery` selects: fetch normally, compare, do not replay. */
	readonly sample: boolean;
	/** Devices whose navigation was fulfilled from `entry`. */
	reusedBy: string[] = [];
	/** The sampled comparison's result, once a sample job has run its second variant. */
	divergence: DocumentDivergence | null = null;

	constructor({ sample = false }: { sample?: boolean } = {}) {
		this.sample = sample;
	}

	/** Whether the next variant's navigation should be answered from `entry`. */
	get canReplay(): boolean {
		return this.entry !== null && !this.sample;
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
 * replayed asset.
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

/** The fulfilment payload for `HTTPRequest.respond()` built from a captured document. */
export const toRespondPayload = (doc: CapturedDocument) => {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(doc.headers)) {
		if (!NON_REPLAYABLE.has(name.toLowerCase())) headers[name] = value;
	}
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
