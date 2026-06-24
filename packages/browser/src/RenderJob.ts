import { request } from './external/http.js';
import logger from './util/Logger.js';
import { settings } from './settings.js';
import { encode } from './util/encoder.js';

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
		try {
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
				const compressed = await encode(this.content, settings.contentEncoding);
				contentBuffer = compressed;
			}

			const metadataBuffer = Buffer.from(JSON.stringify(metadata), 'utf-8');

			const res = await request(this.callbackOrigin, {
				method: 'POST',
				path: '/render_queue/job_result',
				body: contentBuffer
					? Buffer.concat([metadataBuffer, contentBuffer], metadataBuffer.byteLength + contentBuffer.byteLength)
					: metadataBuffer,
				headers: {
					'x-metadata-size': metadataBuffer.byteLength.toString(),
					'content-type': 'application/octet-stream',
				},
			});

			if (res.statusCode !== 204) {
				throw new Error(`Failed to send job result: ${res.statusCode} ${await res.body.text()}`);
			} else {
				await res.body.bytes();
			}
		} catch (e) {
			logger.error(e);
		}
	}
}
