import { setTimeout as sleep } from 'timers/promises';
import { request } from './external/http.js';
import logger from './util/Logger.js';
import { settings } from './settings.js';
import { encode } from './util/encoder.js';
import { getHostHealth, parseRetryAfter } from './HostHealth.js';

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
	deviceType: string;
	acceptLanguage?: string;
	renderBudget?: number;
	callbackOrigin: string;
	isFromSitemap: boolean;
};

type RenderAttempt = {
	renderStartTime: number;
	renderEndTime?: number;
	error?: Error;
	content?: string;
};

type OriginHttpResponse = {
	statusCode: number;
	headers: Record<string, string>;
};

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
	acceptLanguage: string | undefined;
	renderBudget: number | undefined;
	callbackOrigin: string;
	isIndexable: boolean | undefined;
	redirectedTo: string | undefined;
	isFromSitemap: boolean;

	_httpResponse: OriginHttpResponse | null = null;

	attempts: RenderAttempt[] = [];

	latestAttempt: RenderAttempt | null = null;

	constructor(config: JobConfig) {
		this.id = config.id;
		this.url = config.url;
		this.headers = config.headers;
		this.expiresAt = config.expiresAt;
		this.deviceType = config.deviceType;
		this.acceptLanguage = config.acceptLanguage;
		this.renderBudget = config.renderBudget;
		this.callbackOrigin = config.callbackOrigin;
		this.isFromSitemap = config.isFromSitemap;
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

	get error(): Error | null {
		return this.latestAttempt?.error || null;
	}

	async sendResult() {
		const health = getHostHealth();
		let host = '';
		try {
			host = new URL(this.callbackOrigin).hostname;
		} catch {
			// Malformed callbackOrigin — can't track host health, but still attempt the POST.
		}

		// Build the payload (incl. the expensive gzip) ONCE; retries re-send the same bytes.
		const metadata = {
			id: this.id,
			url: this.url,
			statusCode: this.httpResponse?.statusCode,
			headers: {} as Record<string, string>,
			renderTime: undefined as number | undefined,
			redirectedTo: this.redirectedTo,
			isIndexable: this.isIndexable,
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
		const metadataBuffer = Buffer.from(JSON.stringify(metadata), 'utf-8');
		const body = contentBuffer
			? Buffer.concat([metadataBuffer, contentBuffer], metadataBuffer.byteLength + contentBuffer.byteLength)
			: metadataBuffer;

		// Retry transient failures (503/overload/network) so an expensive render isn't thrown
		// away on a blip — bounded by the retry cap AND the job's lease (`expiresAt`), after
		// which Harper may have re-leased it, so posting is pointless.
		const maxAttempts = Math.max(1, settings.backoff.resultRetries + 1);
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const res = await request(this.callbackOrigin, {
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
					return;
				}

				const text = await res.body.text().catch(() => '');
				if (RESULT_RETRIABLE_STATUS.has(res.statusCode)) {
					const retryAfterMs = parseRetryAfter(res.headers['retry-after'] as string | string[] | undefined);
					if (host) health.recordUnavailable(host, retryAfterMs);
					if (attempt < maxAttempts && Date.now() < this.expiresAt) {
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
				logger.error({ id: this.id, statusCode: res.statusCode, body: text, attempt }, 'failed to send job result');
				return;
			} catch (e) {
				// Network error — host unreachable.
				if (host) health.recordUnavailable(host);
				if (attempt < maxAttempts && Date.now() < this.expiresAt) {
					await sleep(resultBackoffMs(attempt));
					continue;
				}
				logger.error({ id: this.id, err: e, attempt }, 'failed to send job result');
				return;
			}
		}
	}
}
