import dns from 'node:dns';
import { Agent, fetch } from 'undici';
import type RenderJob from './RenderJob.js';
import { settings } from './settings.js';
import type { CapturedDocument } from './documentReuse.js';

/**
 * Fetching a job's document AHEAD of its render, in this process rather than in Chrome, so that the
 * fetch overlaps an EARLIER job's render instead of sitting at the head of this one.
 *
 * WHY. A render is ~12 s of mostly Chrome CPU (the settle loop), and the document fetch at its head is
 * origin time the slot spends waiting: measured on a production storefront, 0.4–0.7 s mean and 1.3 s
 * p95 for a product document that the edge revalidates to the origin on every cookieless fetch. With
 * document reuse (documentReuse.ts) that fetch already happens once per URL instead of once per
 * device; this moves it off the critical path altogether. The worker keeps a small pool of claimed
 * jobs (`documentReuse.prefetch.depth`) whose documents are being fetched while the render slots are
 * busy with earlier jobs, and by the time a slot frees, the next job's document is usually in hand:
 * its first variant's navigation is answered from it (with the response's own cookies, exactly as if
 * Chrome had fetched it), and the later variants replay it as they always did. The pool is bounded, so
 * the worker never runs ahead of its slots by more than `depth` claims — the plugin already claims
 * jobs in batches of `jobClaimLimit`, so a pooled job sits claimed no longer than it would have in
 * that batch — and a prefetch that fails in any way simply yields nothing: the variant navigates as
 * before. Prefetch is an optimisation, never a substitute for the origin's answer.
 *
 * FIDELITY. The request is built to be what the navigation would have sent: the device profile's user
 * agent (or the browser's own, for a profile without one), `config.extraHeaders`, the origin-bypass
 * token, the job's own headers, and Chrome's navigation `Accept` / `Sec-Fetch-*` set. Host resolution
 * follows `hostResolverRules` exactly as Chrome's `--host-resolver-rules` does — connect to the mapped
 * IP, keep the Host header and TLS SNI — because a deployment that pins its origin host to a staging
 * edge must not have the prefetch quietly reach production instead. What cannot be replicated is the
 * TLS/HTTP fingerprint of Chrome itself; an edge that keys on it answers the prefetch differently (a
 * challenge page, a 403), and that is caught by the guards below (only a 200 `text/html` is held) and,
 * over time, by the sampled comparison in documentReuse.ts, which with prefetch on compares THIS
 * process's document against one Chrome fetched for the same URL.
 *
 * ONLY A 200 `text/html` IS HELD. A redirect is decided by the plugin from Chrome's redirect chain; an
 * error status carries retry semantics the renderer already implements from a live response; a
 * non-HTML body is not a document. Each of those falls through to a normal navigation at the cost of
 * one extra request for that URL — a small share of jobs, and the price of keeping one code path for
 * every non-200 outcome.
 */

/** A document larger than this is not held ahead of a render; the variant fetches it itself. */
export const PREFETCH_MAX_BYTES = 32 * 1024 * 1024;

export type PrefetchOutcome = 'fetched' | 'status' | 'not-html' | 'too-large' | 'timeout' | 'aborted' | 'error';

export type PrefetchResult = {
	/** The document, when the response was a 200 `text/html` within the size cap; else null. */
	doc: CapturedDocument | null;
	outcome: PrefetchOutcome;
	/** The response status, when there was a response. */
	status?: number;
	/** Wall time of the fetch, whatever its outcome. */
	ms: number;
	error?: unknown;
};

type LookupCallback = (
	err: NodeJS.ErrnoException | null,
	address: string | dns.LookupAddress[],
	family?: number
) => void;

let agent: Agent | null = null;
let agentRules: Record<string, string> | null = null;

/**
 * One keep-alive agent for every prefetch — connections to the origin are reused across jobs, which
 * is where the amortisation of the fetch cost comes from beyond hiding its latency (no TLS handshake
 * per document). Rebuilt when `settings.hostResolverRules` is replaced (resolveSettings does that),
 * so the mapping it honours is always the one Chrome was launched with.
 */
export const prefetchAgent = (): Agent => {
	const rules = settings.hostResolverRules;
	if (agent && agentRules === rules) return agent;
	agentRules = rules;
	agent?.close().catch(() => {});
	agent = new Agent({
		connect: {
			lookup: ((hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
				const ip = rules[hostname];
				if (ip) {
					const family = ip.includes(':') ? 6 : 4;
					if (options?.all) callback(null, [{ address: ip, family }]);
					else callback(null, ip, family);
					return;
				}
				dns.lookup(hostname, options, callback as never);
			}) as never,
		},
	});
	return agent;
};

/** Chrome's navigation `Accept`, so an origin that negotiates on it sees what the browser sends. */
const NAVIGATION_ACCEPT =
	'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

/**
 * The request headers the renderer's navigation carries, in the order the renderer applies them
 * (`config.extraHeaders`, then the bypass token, then the job's own headers — later wins), plus the
 * browser-shaped navigation headers Chrome adds on its own.
 */
export const prefetchHeaders = (
	job: RenderJob,
	deviceType: string,
	defaultUserAgent?: string
): Record<string, string> => {
	const config = settings.config;
	const profile = config.devices[deviceType] ?? config.devices[config.defaultDevice];
	const headers: Record<string, string> = {
		'accept': NAVIGATION_ACCEPT,
		'accept-language': 'en-US,en;q=0.9',
		'upgrade-insecure-requests': '1',
		'sec-fetch-dest': 'document',
		'sec-fetch-mode': 'navigate',
		'sec-fetch-site': 'none',
		'sec-fetch-user': '?1',
	};
	const userAgent = profile?.userAgent ?? defaultUserAgent;
	if (userAgent) headers['user-agent'] = userAgent;
	for (const [key, value] of Object.entries(config.extraHeaders)) headers[key.toLowerCase()] = value;
	if (settings.bypass.token) headers[settings.bypass.header.toLowerCase()] = settings.bypass.token;
	if (job.headers) for (const [key, value] of Object.entries(job.headers)) headers[key.toLowerCase()] = value;
	return headers;
};

/**
 * Fetch `job.url` as `deviceType`'s navigation would, without following redirects. Never rejects:
 * every failure is an outcome, and only `fetched` carries a document.
 */
export const prefetchDocument = async (
	job: RenderJob,
	deviceType: string,
	{ timeoutMs, signal, defaultUserAgent }: { timeoutMs: number; signal?: AbortSignal; defaultUserAgent?: string }
): Promise<PrefetchResult> => {
	const started = Date.now();
	const elapsed = () => Date.now() - started;
	const ac = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		ac.abort();
	}, timeoutMs);
	const onAbort = () => ac.abort();
	if (signal?.aborted) onAbort();
	else signal?.addEventListener('abort', onAbort, { once: true });

	try {
		const res = await fetch(job.url, {
			method: 'GET',
			headers: prefetchHeaders(job, deviceType, defaultUserAgent),
			redirect: 'manual',
			signal: ac.signal,
			dispatcher: prefetchAgent(),
		});
		if (res.status !== 200) {
			await res.body?.cancel().catch(() => {});
			return { doc: null, outcome: 'status', status: res.status, ms: elapsed() };
		}
		const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
		if (!contentType.startsWith('text/html')) {
			await res.body?.cancel().catch(() => {});
			return { doc: null, outcome: 'not-html', status: res.status, ms: elapsed() };
		}
		const declared = Number(res.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > PREFETCH_MAX_BYTES) {
			await res.body?.cancel().catch(() => {});
			return { doc: null, outcome: 'too-large', status: res.status, ms: elapsed() };
		}
		// undici's fetch has already undone the content encoding; the stored body is decoded, and
		// the replay drops `content-encoding` / `content-length` for that reason (documentReuse.ts).
		const body = Buffer.from(await res.arrayBuffer());
		if (body.byteLength > PREFETCH_MAX_BYTES) {
			return { doc: null, outcome: 'too-large', status: res.status, ms: elapsed() };
		}
		const headers: Record<string, string> = {};
		res.headers.forEach((value, name) => {
			if (name !== 'set-cookie') headers[name] = value;
		});
		return {
			doc: {
				url: job.url,
				status: res.status,
				headers,
				body,
				deviceType,
				source: 'prefetch',
				// Kept apart from the headers: replayed ONLY to the device this was fetched for.
				setCookies: res.headers.getSetCookie(),
			},
			outcome: 'fetched',
			status: res.status,
			ms: elapsed(),
		};
	} catch (error) {
		if (timedOut) return { doc: null, outcome: 'timeout', ms: elapsed(), error };
		if (ac.signal.aborted) return { doc: null, outcome: 'aborted', ms: elapsed(), error };
		return { doc: null, outcome: 'error', ms: elapsed(), error };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
};
