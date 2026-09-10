import { setTimeout as sleep } from 'timers/promises';
import { request } from './external/http.js';
import logger from './util/Logger.js';
import { settings } from './settings.js';
import { encode } from './util/encoder.js';
import { getHostHealth, parseRetryAfter } from './HostHealth.js';
import { renderPhaseOf } from './util/renderPhase.js';

// Result-POST failures worth retrying: transient overload/gateway errors. Anything else
// (e.g. a 4xx) is a bug, not a blip — logged and dropped (the lease expires → re-render).
const RESULT_RETRIABLE_STATUS = new Set([429, 502, 503, 504]);

// Cap on the sleep BETWEEN result-POST attempts. This is deliberately small and independent
// of the (up-to-30s) circuit backoff: `render()` awaits `sendResult()` inside a CONCURRENCY
// slot, so a long sleep pins a slot. The host-level backoff (honoring Retry-After) is applied
// to the shared circuit via recordUnavailable; this only spaces out THIS render's few retries.
const RESULT_MAX_SLEEP_MS = 5000;

/** Backoff (ms) between result-POST attempts: exponential + equal jitter, capped small. */
const resultBackoffMs = (attempt: number): number => {
	const exp = Math.min(RESULT_MAX_SLEEP_MS, settings.backoff.minMs * 2 ** (attempt - 1));
	return Math.round(exp / 2 + Math.random() * (exp / 2));
};

export type JobConfig = {
	id: string;
	url: string;
	expiresAt: number;
	headers?: Record<string, string>;
	/**
	 * The ONE device this job renders — a legacy per-device job (plugin < 0.66.0), or one variant
	 * of a multi-device job (see `variants()`). A multi-device job as claimed also carries this as
	 * the first entry of `deviceTypes`, for renderers that predate the list.
	 */
	deviceType: string;
	/**
	 * Every device this job must render (plugin >= 0.66.0 claims ONE job per URL and expects every
	 * variant back in a single result). Absent on a legacy per-device job.
	 */
	deviceTypes?: string[];
	acceptLanguage?: string;
	renderBudget?: number;
	callbackOrigin: string;
	isFromSitemap: boolean;
};

/**
 * Per-phase wall-clock split of a single render, in ms, populated by the renderer. Lets the
 * per-window stats attribute the render time to network-wait vs Chrome-CPU work:
 *  - `navTtfb`: navigation start → main-document response headers received — origin/edge
 *    response time (the signal for a slow pinned upstream IP).
 *  - `navTotal`: full `page.goto` (TTFB + waiting for the `waitUntil` lifecycle event).
 *  - `settle`: the post-navigation scroll / network-idle / DOM-stable settling loop (mixed
 *    network-idle waits + in-page `evaluate` passes).
 *  - `postProcess`: the final in-page serialize/flatten `evaluate` (Chrome CPU).
 */
export type RenderTimings = {
	navTtfb?: number;
	navTotal?: number;
	settle?: number;
	postProcess?: number;
};

type RenderAttempt = {
	renderStartTime: number;
	renderEndTime?: number;
	error?: Error;
	content?: string;
	timings?: RenderTimings;
	/**
	 * Same-origin subresources (scripts, stylesheets, XHR) the origin answered 4xx/5xx while the
	 * document itself succeeded. Non-zero means the page rendered against a crippled asset set —
	 * typically an edge policy the navigation slipped past — and the snapshot is missing whatever
	 * those assets would have produced. The render still "succeeds", so this is the only signal.
	 * Our own aborts (`block.resourceTypes` / `block.urlPatterns`) never appear here: an aborted
	 * request produces no response.
	 */
	subresourceErrors?: number;
};

type OriginHttpResponse = {
	statusCode: number;
	headers: Record<string, string>;
};

/**
 * What happened to a render, as the ONE decision field the plugin keys result handling on:
 *  - 'rendered'       — content was produced. A rendered-through client-side redirect is still
 *                       a rendered page (the plugin refiles it under the landed key).
 *  - 'redirected'     — the render ended WITHOUT content because navigation landed on a
 *                       different document (HTTP bail, or a client-side move to a page that
 *                       produced nothing).
 *  - 'non-indexable'  — the page itself said not to (see `reason`).
 *  - 'error'          — nothing usable and nothing deliberate about it (see `error`).
 * `isIndexable` still rides along, but as a PROPERTY of a rendered page (it is stored on the
 * cache row) — not the signal decisions are inferred from.
 */
export type JobOutcome = 'rendered' | 'redirected' | 'non-indexable' | 'error';

const allowedResponseHeaders = [
	'etag', // helps 304 Not Modified
	'last-modified', // helps 304 Not Modified
	'link', // canonical / hreflang if set via headers
	'x-robots-tag', // noindex/nofollow etc. via headers
	'retry-after', // for 503 responses
	'cache-control',
	'content-type',
	'vary',
];

export default class RenderJob {
	id: string;
	url: string;
	expiresAt: number;
	headers?: Record<string, string>;
	deviceType: string;
	/** See {@link JobConfig.deviceTypes}. Set on the job as CLAIMED; never on a variant. */
	deviceTypes: string[] | undefined;
	acceptLanguage: string | undefined;
	renderBudget: number | undefined;
	callbackOrigin: string;
	isIndexable: boolean | undefined;
	redirectedTo: string | undefined;
	isFromSitemap: boolean;
	/**
	 * The page's own schema.org Product offers, flattened to [price, currency, availability]
	 * triples, read off the live DOM at the end of the settle. `null` means the extraction ran and
	 * the page declared no Product offers (or it failed benignly) — posted as null, NOT omitted,
	 * because the consumer reads an ABSENT field as "this renderer predates the feature" and
	 * alarms on it.
	 *
	 * WHY THE RENDERER AND NOT THE CONSUMER. The consumer can recover the same values by
	 * regex-scanning and JSON-parsing the serialized document, but that is ~1MB of work on its
	 * hottest write path to reconstruct data this process had structured in front of it. Here it is
	 * one `page.evaluate` against a DOM that is already parsed and already settled.
	 */
	structuredOffers: Array<string | null> | null | undefined;
	/**
	 * Why this render produced no cacheable content — one slug across every no-content class,
	 * so the plugin logs/tracks a single field: 'noindex' (robots meta/header),
	 * 'canonical-mismatch' (page canonicalizes to a different URL), 'canonical-variant'
	 * (canonicalizes to the same URL RE-SPELLED — one document, two cache keys), 'http-error'
	 * (non-200 document),
	 * 'redirect-loop', 'redirect' (bailed at navigation), or 'error' (renderer threw — details
	 * ride in the posted `error`). Unset when content was produced; sendResult derives the
	 * redirect/error fallbacks so callers only set the values they alone can know.
	 */
	reason: string | undefined;

	_httpResponse: OriginHttpResponse | null = null;

	attempts: RenderAttempt[] = [];

	latestAttempt: RenderAttempt | null = null;

	constructor(config: JobConfig) {
		this.id = config.id;
		this.url = config.url;
		this.headers = config.headers;
		this.expiresAt = config.expiresAt;
		this.deviceTypes = Array.isArray(config.deviceTypes) && config.deviceTypes.length ? config.deviceTypes : undefined;
		// A multi-device job names its devices in `deviceTypes`; `deviceType` then only exists for
		// renderers that predate the list, and the first entry is what such a renderer would render.
		this.deviceType = config.deviceType ?? this.deviceTypes?.[0] ?? '';
		this.acceptLanguage = config.acceptLanguage;
		this.renderBudget = config.renderBudget;
		this.callbackOrigin = config.callbackOrigin;
		this.isFromSitemap = config.isFromSitemap;
	}

	/**
	 * The renders this claimed job stands for, one RenderJob per device.
	 *
	 * A legacy per-device job IS its own single variant. A multi-device job (plugin >= 0.66.0 claims
	 * one job per URL) fans out to one job per entry of `deviceTypes`, each sharing the claim's id,
	 * lease and callback — the renderer sees a plain per-device job either way, and only the worker
	 * knows that several of them travel back in one result (`sendVariantsResult`).
	 */
	variants(): RenderJob[] {
		if (!this.deviceTypes) return [this];
		return this.deviceTypes.map(
			(deviceType) =>
				new RenderJob({
					id: this.id,
					url: this.url,
					expiresAt: this.expiresAt,
					headers: this.headers,
					deviceType,
					acceptLanguage: this.acceptLanguage,
					renderBudget: this.renderBudget,
					callbackOrigin: this.callbackOrigin,
					isFromSitemap: this.isFromSitemap,
				})
		);
	}

	sanitizeHeaders(headers: Record<string, string>) {
		const sanitized: Record<string, string> = {};
		for (const header of allowedResponseHeaders) {
			if (headers[header]) {
				sanitized[header] = headers[header];
			}
		}
		return sanitized;
	}

	set httpResponse(response: OriginHttpResponse) {
		const { statusCode, headers } = response;
		this._httpResponse = { statusCode, headers: this.sanitizeHeaders(headers) };
	}

	get httpResponse(): OriginHttpResponse | null {
		return this._httpResponse;
	}

	attemptStarted() {
		this.latestAttempt = { renderStartTime: Date.now() };
		this.attempts.push(this.latestAttempt);
		return this.latestAttempt;
	}

	attemptEnded(error?: Error, content?: string) {
		const attempt = this.latestAttempt!;
		attempt.renderEndTime = Date.now();
		attempt.error = error;
		attempt.content = content;
	}

	get content(): string | null {
		return this.latestAttempt?.content || null;
	}

	/** See {@link JobOutcome}. Content wins; then a landed-elsewhere navigation; then the
	 *  page's own indexability verdict; anything else is an error by definition. */
	get outcome(): JobOutcome {
		if (this.content) return 'rendered';
		if (this.redirectedTo) return 'redirected';
		if (this.isIndexable === false) return 'non-indexable';
		return 'error';
	}

	get error(): Error | null {
		return this.latestAttempt?.error || null;
	}

	/**
	 * This render's result as the plugin reads it — every field of the wire metadata EXCEPT the job
	 * identity (`id`/`url`), which belongs to the result envelope. One variant of a multi-device
	 * result, or (with the identity added) the whole of a legacy per-device result.
	 *
	 * Builds the encoded body too (the expensive gzip) so a caller assembling several variants pays
	 * it once per variant and retries re-send the same bytes.
	 */
	async resultMetadata(): Promise<{ metadata: VariantMetadata; contentBuffer: Buffer | null }> {
		const attemptError = this.error;
		const metadata: VariantMetadata = {
			deviceType: this.deviceType,
			statusCode: this.httpResponse?.statusCode,
			headers: {},
			renderTime: undefined,
			redirectedTo: this.redirectedTo,
			isIndexable: this.isIndexable,
			structuredOffers: this.structuredOffers,
			outcome: this.outcome,
			// One slug for WHY there is no content (see the field doc). The redirect/error
			// fallbacks are derived here so every no-content result carries a reason without
			// each producer having to remember to set one.
			reason: this.content
				? undefined
				: (this.reason ?? (attemptError ? 'error' : this.redirectedTo ? 'redirect' : undefined)),
			// The failed attempt's detail — without it the plugin can only log "unknown
			// prerender error". `phase` separates a navigation that never completed (slow
			// origin) from a failure in the settle/serialize work. Anything can be thrown, so
			// don't trust the Error shape: a string/object throw must not serialize as
			// "undefined: undefined".
			error: attemptError
				? {
						name: attemptError?.name ?? 'Error',
						message: attemptError?.message ?? String(attemptError),
						phase: renderPhaseOf(attemptError),
					}
				: undefined,
		};
		if (this.httpResponse) {
			Object.entries(this.httpResponse.headers).forEach(([key, val]) => {
				metadata.headers[key] = val;
			});
		}
		if (this.latestAttempt?.renderEndTime) {
			metadata.renderTime = this.latestAttempt.renderEndTime - this.latestAttempt.renderStartTime;
		}

		let contentBuffer: Buffer | null = null;
		if (this.content) {
			metadata.headers['content-encoding'] = settings.contentEncoding;
			contentBuffer = await encode(this.content, settings.contentEncoding);
		}
		return { metadata, contentBuffer };
	}

	/**
	 * Post THIS render as a legacy per-device result: `{ id, url, ...variant }` followed by the one
	 * encoded body. The shape every plugin release understands; a multi-device job posts through
	 * `sendVariantsResult` instead. Returns true if the result was delivered (204), false if it was
	 * dropped after retries.
	 */
	async sendResult(): Promise<boolean> {
		const { metadata, contentBuffer } = await this.resultMetadata();
		// `deviceType` is not part of the legacy metadata — the plugin reads it off the cache key —
		// but posting it is harmless and lets a newer plugin log the device without parsing.
		const envelope = { id: this.id, url: this.url, ...metadata };
		return postResult(this, envelope, contentBuffer ? [contentBuffer] : []);
	}

	/**
	 * Post ONE result for a multi-device job: `{ id, url, deviceTypes, variants: [...] }` followed by
	 * every variant's encoded body, concatenated in `variants` order — each variant's `contentLength`
	 * says how many of those bytes are its own (0 = no content). Plugin >= 0.66.0.
	 *
	 * `variants` is what was ATTEMPTED, which can be fewer than `deviceTypes` when the lease ran short
	 * or the worker began draining mid-job; the plugin treats a device it asked for and did not get
	 * back as a failed render and retries the URL.
	 */
	static async sendVariantsResult(job: RenderJob, variants: RenderJob[]): Promise<boolean> {
		const encoded = await Promise.all(variants.map((variant) => variant.resultMetadata()));
		const bodies: Buffer[] = [];
		const envelope = {
			id: job.id,
			url: job.url,
			deviceTypes: job.deviceTypes ?? variants.map((variant) => variant.deviceType),
			variants: encoded.map(({ metadata, contentBuffer }) => {
				if (contentBuffer) bodies.push(contentBuffer);
				return { ...metadata, contentLength: contentBuffer?.byteLength ?? 0 };
			}),
		};
		return postResult(job, envelope, bodies);
	}
}

/** One variant's share of a posted result — see `RenderJob.resultMetadata`. */
export type VariantMetadata = {
	deviceType: string;
	statusCode: number | undefined;
	headers: Record<string, string>;
	renderTime: number | undefined;
	redirectedTo: string | undefined;
	isIndexable: boolean | undefined;
	structuredOffers: Array<string | null> | null | undefined;
	outcome: JobOutcome;
	reason: string | undefined;
	error: { name: string; message: string; phase: string | undefined } | undefined;
};

/**
 * POST one result body to the job's callback: the JSON envelope, then `bodies` concatenated, with
 * `x-metadata-size` marking where the JSON ends. Shared by the legacy and the multi-device shapes so
 * the retry policy cannot drift between them.
 *
 * Retries transient failures (503/overload/network) so an expensive render isn't thrown away on a
 * blip — bounded by the retry cap AND the job's lease (`expiresAt`), after which Harper may have
 * re-leased it, so posting is pointless. Returns true on a 204, false when dropped.
 */
async function postResult(job: RenderJob, envelope: object, bodies: Buffer[]): Promise<boolean> {
	const health = getHostHealth();
	let host = '';
	try {
		host = new URL(job.callbackOrigin).hostname;
	} catch {
		// Malformed callbackOrigin — can't track host health, but still attempt the POST.
	}

	// Build the payload ONCE; retries re-send the same bytes.
	const metadataBuffer = Buffer.from(JSON.stringify(envelope), 'utf-8');
	const body = bodies.length ? Buffer.concat([metadataBuffer, ...bodies]) : metadataBuffer;

	const maxAttempts = Math.max(1, settings.backoff.resultRetries + 1);
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const res = await request(job.callbackOrigin, {
				method: 'POST',
				path: '/render_queue/job_result',
				body,
				headers: {
					'x-metadata-size': metadataBuffer.byteLength.toString(),
					'content-type': 'application/octet-stream',
				},
			});

			if (res.statusCode === 204) {
				await res.body.bytes();
				if (host) health.recordSuccess(host);
				return true;
			}

			const text = await res.body.text().catch(() => '');
			if (RESULT_RETRIABLE_STATUS.has(res.statusCode)) {
				const retryAfterMs = parseRetryAfter(res.headers['retry-after'] as string | string[] | undefined);
				if (host) health.recordUnavailable(host, retryAfterMs);
				if (attempt < maxAttempts && Date.now() < job.expiresAt) {
					await sleep(resultBackoffMs(attempt));
					continue;
				}
			} else if (host) {
				// Non-retriable (4xx bug, auth failure, wrong endpoint) — usually persistent and
				// host-wide. Feed the shared circuit (same as the claim path's non-2xx handling)
				// so the consumer stops claiming work it can't deliver to this host, instead of
				// rendering more results that will only be dropped.
				health.recordError(host);
			}
			logger.error({ id: job.id, statusCode: res.statusCode, body: text, attempt }, 'failed to send job result');
			return false;
		} catch (e) {
			// Network error — host unreachable.
			if (host) health.recordUnavailable(host);
			if (attempt < maxAttempts && Date.now() < job.expiresAt) {
				await sleep(resultBackoffMs(attempt));
				continue;
			}
			logger.error({ id: job.id, err: e, attempt }, 'failed to send job result');
			return false;
		}
	}
	// Exhausted retries without a definitive response (e.g. lease expired mid-backoff).
	return false;
}
