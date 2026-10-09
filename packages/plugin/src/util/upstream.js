import { ByteLengthQueuingStrategy } from 'node:stream/web';
import { metrics } from '../metrics.js';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { config } from '../config.js';

/**
 * The staging IP to connect to for this origin fetch, or undefined for a normal fetch.
 * Staging passthrough is active only when a staging `ip` is configured (and valid) AND
 * the request carries the configured toggle header. The address is always the configured
 * `config.origin.staging.ip` — never a value from the request — so a request can only switch the
 * fetch to the one pre-approved IP, not repoint it at an arbitrary host.
 */
export const stagingTargetIp = (headers) => {
	const { ip, header } = config.origin.staging;
	if (!ip || !header || !isIP(ip)) return undefined;
	return headers?.get(header) ? ip : undefined;
};

/**
 * The configured staging IP if it is set and valid, else undefined — regardless of any
 * request header. For callers that opt into staging out-of-band rather than via a per-request
 * toggle header (e.g. the sitemap refresh, which has no incoming request to carry a header).
 */
export const configuredStagingIp = () => {
	const { ip } = config.origin.staging;
	return ip && isIP(ip) ? ip : undefined;
};

// `maxHeaderSize` is fixed at Agent construction — undici exposes no way to change it on a live
// Agent — so `origin.maxResponseHeaderBytes` is restart-scoped: config.js reports a live change
// as pending-restart and the running dispatchers keep the value they were built with. Without it
// undici falls back to Node's http.maxHeaderSize (16 KiB), which a real origin can exceed on a
// single page (a Set-Cookie pile-up plus CSP/Link-preload is enough), and undici answers by
// DESTROYING THE SOCKET with UND_ERR_HEADERS_OVERFLOW. The crawler then gets a 500 for a page
// browsers and the CDN load fine, deterministically, because it is a property of that response.
// Captured on first use and reused by every dispatcher built afterwards, so restart scope holds
// for all of them. Re-reading config per construction would not: `origin.staging.ip` is
// live-scoped, so a pinned dispatcher can be built long after boot, and it would then pick up a
// cap edited in the meantime while the unpinned singleton kept the boot value — two dispatchers
// disagreeing, and a pending-restart notice that was only half true.
let capturedMaxHeaderSize;
const agentOptions = () => ({
	maxHeaderSize: (capturedMaxHeaderSize ??= config.origin.maxResponseHeaderBytes),
});

// The unpinned dispatcher carries every cache-miss and passthrough fetch, so it stays a plain
// lazily-built singleton: one `??=` test on the hot path, no key to build and no Map to probe.
// It cannot be built at import time because the cap is not known until the component applies
// its options; by the first origin fetch it always is.
let agent;

// Dispatchers that pin DNS resolution to a fixed IP (staging passthrough), one per IP. Only the
// connect address is overridden — the origin (so Host header + TLS SNI + cert validation) stays
// the real origin host, the server-side equivalent of Chrome's --host-resolver-rules=MAP host ip.
// In practice there is at most one entry (the single configured staging IP); the map just keeps
// it stable across requests and across a config reload that changes the IP.
const pinnedDispatchers = new Map();
export const dispatcherFor = (ip) => {
	if (!ip) return (agent ??= new Agent(agentOptions()));
	let dispatcher = pinnedDispatchers.get(ip);
	if (!dispatcher) {
		const family = isIP(ip);
		dispatcher = new Agent({
			...agentOptions(),
			connect: {
				// Node's lookup callback has two shapes depending on the `all` option.
				lookup: (_hostname, options, callback) =>
					options?.all ? callback(null, [{ address: ip, family }]) : callback(null, ip, family),
			},
		});
		pinnedDispatchers.set(ip, dispatcher);
	}
	return dispatcher;
};

const hopByHopHeaders = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
];

// Downstream request headers never forwarded to the origin (the static portion).
const BASE_IGNORED_HEADERS = [...hopByHopHeaders, 'host', 'user-agent', 'accept-encoding', 'cookie', 'authorization'];

// The full ignore set also includes the configurable security-token, debug and peer-token
// header names (so a client can't spoof them, and a cluster secret never reaches the origin)
// plus any operator-configured `ignoredHeaders`. The peer token is the one a node attaches to
// its own `/prerender_peer/*` calls: a node that does not know one of those paths (an older
// release, mid-rollout) treats the call as bot traffic under a broad prefix route, and without
// this it would proxy the request to the origin carrying the cluster's shared secret.
// Header names are matched case-insensitively — downstream keys and the base set are
// lowercase, so every configurable name (token, debug, peer, and each ignoredHeaders entry)
// is lowercased here; otherwise a mixed-case configured name would let a lowercase spoof
// slip past. Memoize the Set and
// rebuild only when those inputs change, instead of allocating on every fetch.
let ignoredHeadersCache = null;
let ignoredHeadersKey = '';
const ignoredDownstreamRequestHeaders = () => {
	const tokenHeader = config.origin.securityToken.header;
	const debugKey = config.debugHeader.key;
	const peerHeader = config.peerRescue.header;
	// The render-now header carries `renderNow.token`, a secret, on the very requests that reach the
	// origin when an on-demand render falls back to it. It is ours, not the crawler's, so it never leaves.
	const renderNowHeader = config.renderNow.header;
	const configured = config.origin.ignoredHeaders;
	const key = `${tokenHeader} ${debugKey} ${peerHeader} ${renderNowHeader} ${configured.join(',')}`;
	if (ignoredHeadersCache === null || key !== ignoredHeadersKey) {
		ignoredHeadersCache = new Set([
			...BASE_IGNORED_HEADERS,
			String(tokenHeader).toLowerCase(),
			String(debugKey).toLowerCase(),
			...(peerHeader ? [String(peerHeader).toLowerCase()] : []),
			...(renderNowHeader ? [String(renderNowHeader).toLowerCase()] : []),
			...configured.map((name) => String(name).toLowerCase()),
		]);
		ignoredHeadersKey = key;
	}
	return ignoredHeadersCache;
};

// Origin responses are relayed to the edge on a cache miss. The origin sits behind a CDN, so
// its response carries the CDN's own control headers (request-id/trace headers, x-cache*, via,
// server-timing, …). When the edge's alternate-response swap re-adds its own copies the response
// ends up with duplicated CDN headers, and the edge fails the transform. Relay only this
// allowlist of genuine origin-response headers so the swapped-in response looks like a clean
// origin reply; everything else (CDN headers, hop-by-hop headers, set-cookie) is dropped.
//
// server-timing is deliberately NOT relayed: the value from the origin is the staging edge's
// own timing tokens, and the serving edge adds its own on egress — so dropping the origin's
// avoids re-doubling it and keeps CDN-internal tokens off the response.
//
// NOTE: unlike the render path (RenderJob.allowedResponseHeaders), which strips the origin
// encoding and re-encodes stored pages itself, the proxy path relays content-encoding +
// content-length for the passed-through body. See the accept-encoding note in
// resolveUpstreamHeaders for why the origin body is fetched gzip (not brotli).
//
// `location` IS WHAT MAKES A PROXIED REDIRECT A REDIRECT. The dispatcher's `request()` does not
// follow redirects, so an origin 301/302/307/308 is relayed as that status — and without this
// header the crawler got a 301 naming no target: a dead end it records against the URL instead of
// the move the origin declared. A relative value is resolved against the public URL before it is
// relayed (`publicLocation` in fetchOriginResource).
//
// `content-language` is the origin's own statement of the document's language, which a crawler
// uses to place the page; dropping it on a miss served the same document with less information than
// the origin gave.
//
// `link` is DELIBERATELY STILL ABSENT. It is not a CDN header, but these headers are also what
// traffic discovery reads (`isPrerenderCandidate` refuses a URL whose Link canonical names another
// URL, by exact string compare), and that check has never seen a Link header on this path. Adding it
// here would switch on a never-exercised mint refusal for every origin that sends one. The rendered
// snapshot's stored `link` is governed by `page.serveLinkHeader` (http_handlers/response.js).
const FORWARDED_RESPONSE_HEADERS = new Set([
	'content-type',
	'content-encoding',
	'content-length',
	'content-language',
	'cache-control',
	'expires',
	'etag',
	'last-modified',
	'location',
	'vary',
	'x-robots-tag',
	'retry-after',
]);

export const sanitizeOriginResponseHeaders = (headers) => {
	const clean = {};
	if (!headers) return clean;
	// HTTP header names are case-insensitive; match the allowlist on a lowercased key
	// (undici lowercases already, but a future caller may not).
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const name = key.toLowerCase();
		if (FORWARDED_RESPONSE_HEADERS.has(name)) clean[name] = value;
	}
	return clean;
};

/**
 * The two request validators. Normally forwarded to the origin on purpose — a crawler's conditional
 * request is cheap for everyone when the origin can answer 304 — but they must be stripped when an
 * invalidation is why we are fetching at all. See `stripValidators` below.
 */
const VALIDATOR_HEADERS = ['if-none-match', 'if-modified-since'];

/**
 * The User-Agent the origin sees: the crawler's own plus `origin.forwardUserAgent.suffix` when forwarding is
 * on and the request carried one, else this device's fixed browser string (`origin.userAgents`). A request
 * Harper makes on its own behalf (the negative cache's re-check) has no crawler and takes the fixed string.
 */
const originUserAgent = (downstream, deviceType) => {
	const forward = config.origin.forwardUserAgent;
	const crawler = forward.enabled ? downstream?.['user-agent'] : undefined;
	if (typeof crawler === 'string' && crawler !== '') return forward.suffix ? `${crawler} ${forward.suffix}` : crawler;
	return config.origin.userAgents[deviceType] ?? config.origin.userAgents.desktop;
};

export const resolveUpstreamHeaders = (downstream, deviceType, { stripValidators = false } = {}) => {
	const upstream = {
		'user-agent': originUserAgent(downstream, deviceType),
		[config.origin.securityToken.header]: config.origin.securityToken.value,
		// Request gzip (not brotli) from the origin. On a cache miss this response is relayed
		// to the CDN edge for its alternate-response swap, and the edge cannot apply its outgoing
		// transform to a brotli-encoded alternate response. gzip is transform-safe; the edge
		// re-compresses (to br) for the real client on egress.
		'accept-encoding': 'gzip',
	};

	if (downstream) {
		const ignored = ignoredDownstreamRequestHeaders();
		Object.keys(downstream).forEach((key) => {
			if (ignored.has(key)) return;
			// STRIP THE VALIDATORS WHEN AN INVALIDATION IS WHY WE ARE HERE, so the origin must send a
			// body. The validators the crawler is holding came from US, off the snapshot that has just
			// been invalidated — and an origin whose ETag is a publish date rather than a content hash
			// answers 304 to them. The plugin then relays that 304, `computeWasCacheMiss` reports a miss,
			// and the request records `cacheStatus: 'invalidated'` while the crawler keeps the exact
			// bytes the invalidation existed to stop serving. Every signal reads as success.
			//
			// Scoped to that one verdict: forwarding a conditional request is otherwise correct and
			// cheap, and stripping these unconditionally would turn every crawler revalidation into a
			// full body transfer.
			if (stripValidators && VALIDATOR_HEADERS.includes(key)) return;
			upstream[key] = downstream[key];
		});
	}

	return upstream;
};

/**
 * End an origin body that nobody will read, so its connection goes back to the pool (or is closed)
 * now rather than when undici's `bodyTimeout` fires. Dropping the reference is not enough — the
 * socket stays held until the body is consumed — and that is how a HEAD, or a 304 answered locally
 * from an origin 200, used to pin one origin connection each.
 *
 * A GET BODY IS DRAINED, up to `DRAIN_LIMIT_BYTES`, so the connection goes back to the pool: a local
 * 304 is an ordinary answer to a crawler revalidating, and closing a pooled TLS connection for each one
 * trades a few hundred KB already in flight for a fresh handshake. Past the limit — or for a HEAD, whose
 * body is empty anyway — the undici stream is DESTROYED.
 *
 * The drain has its own deadline (`DRAIN_DEADLINE_MS`) and destroys past it. A captured body carries
 * its own `releaseBody`, which drains the crawler's branch so the capture beside it still completes
 * (util/rawCache.js#discardStream). Destroying the source rather than cancelling the web stream is
 * belt and braces now that the stream is `originBodyStream`, whose cancel cannot throw either.
 *
 * A resource that did not come from `fetchOriginResource` (a stored page, a test fixture) falls back to
 * its stream's own `cancel`, not awaited: a tee branch's cancel settles only when both branches do.
 */
export const releaseOriginBody = (resource) => {
	if (typeof resource?.releaseBody === 'function') resource.releaseBody();
	else resource?.content?.cancel?.()?.catch?.(() => {});
};

const DRAIN_LIMIT_BYTES = 1024 * 1024;
// A drain is a courtesy to the connection pool, not something to wait on: an origin that stalls
// mid-body would otherwise hold one socket per local 304 until undici's own `bodyTimeout` (300s).
const DRAIN_DEADLINE_MS = 5000;

// Exported for tests; `releaseBody` on an origin resource is the caller.
export const drainOrDestroy = (content, source, deadlineMs = DRAIN_DEADLINE_MS) => {
	let reader;
	try {
		reader = content.getReader();
	} catch {
		source.destroy();
		return;
	}
	const timer = setTimeout(() => source.destroy(), deadlineMs);
	timer.unref?.();
	(async () => {
		let drained = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				drained += value?.byteLength ?? 0;
				if (drained > DRAIN_LIMIT_BYTES) {
					source.destroy();
					return;
				}
			}
		} catch {
			source.destroy();
		} finally {
			clearTimeout(timer);
		}
	})();
};

/**
 * The origin body as a web stream — in place of `Readable.toWeb`, whose adapter can throw from inside a
 * Node event handler.
 *
 * THE HAZARD, MEASURED (Node 24.15, test/originBodyStream.test.js): a `cancel()` that lands in the same
 * microtask phase in which the stream was created — after the start/pull microtask has scheduled the
 * source's `resume`, before that tick runs — closes the controller, and the scheduled flow then emits
 * the source's buffered bytes into it: `ERR_INVALID_STATE: Controller is already closed`, thrown from the
 * `data` listener, an uncaughtException. 20 of 20 against a 4 MB origin body; a cancel that is
 * synchronous, a tick later, or after a read throws 0 of 20, which is why it is easy to miss. This
 * plugin's own releases no longer cancel, but the stream is handed to Harper, which cancels a body when
 * the client has gone — and nothing bounds WHEN it does that.
 *
 * So the adapter is ours, and every enqueue is guarded: once the stream has been cancelled, errored or
 * closed, a late `data` event is dropped instead of thrown. Cancel destroys the source, which is the
 * release (`releaseOriginBody`) and ends the origin connection. Backpressure is the same shape as Node's:
 * the source pauses when the queue is full and resumes on `pull`.
 */
export const originBodyStream = (source) => {
	let controller;
	let settled = false;
	const settle = (finish) => {
		if (settled) return;
		settled = true;
		finish();
	};
	const stream = new ReadableStream(
		{
			start(c) {
				controller = c;
			},
			pull() {
				source.resume();
			},
			cancel() {
				settled = true;
				source.destroy();
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark: source.readableHighWaterMark || 64 * 1024 })
	);
	// Paused BEFORE the listener is attached: attaching `data` resumes a stream that is not explicitly paused.
	source.pause();
	source.on('data', (chunk) => {
		if (settled) return;
		controller.enqueue(chunk);
		if (controller.desiredSize <= 0) source.pause();
	});
	source.once('end', () => settle(() => controller.close()));
	source.once('error', (e) => settle(() => controller.error(e)));
	// A source destroyed without an error (an abort, a peer reset surfaced as close) must not look like a
	// complete body to whoever reads it.
	source.once('close', () => settle(() => controller.error(new Error('origin body closed before it ended'))));
	return stream;
};

// An origin `Location` as the crawler must receive it: absolute, resolved against the PUBLIC URL this
// request asked for (the fetch URL is built from it — the forwarded host and proto, or prefix mode's
// absolute URL). A relative target is legal HTTP and a client resolves it against the URL it
// requested — which is only the public one if the edge relays this response instead of following it,
// or rewriting it against its own request. Resolving here removes that dependency. An absolute value
// is returned untouched, and one that does not parse is relayed verbatim rather than dropped.
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;
const publicLocation = (location, base) => {
	if (typeof location !== 'string' || ABSOLUTE_URL.test(location)) return location;
	try {
		return new URL(location, base).href;
	} catch {
		return location;
	}
};

export const fetchOriginResource = async (request) => {
	const { url, deviceType, method = 'GET', body, stripValidators = false, reason = 'other' } = request;
	const headers = request.headers.asObject;

	const urlObj = url instanceof URL ? url : new URL(url);

	// Cache misses (and non-GET passthroughs) may be routed to a staging edge when the
	// request opts in via the staging header; the origin/Host stays the real host so only
	// the connect address differs.
	const stagingIp = stagingTargetIp(request.headers);

	// origin_fetch times to RESPONSE HEADERS (the body streams to the client afterwards, so
	// body time is the crawler's, not the origin's) and records the caller's `reason` — why
	// the cache didn't answer. statusCode 0 = the fetch itself failed before any status
	// arrived; the throw still propagates to the caller's own error handling.
	const fetchStarted = performance.now();
	let response;
	try {
		response = await dispatcherFor(stagingIp).request({
			origin: urlObj.origin,
			path: urlObj.pathname + urlObj.search,
			method,
			headers: resolveUpstreamHeaders(headers, deviceType, { stripValidators }),
			body,
		});
	} catch (e) {
		metrics.originFetch(performance.now() - fetchStarted, 0, reason);
		throw e;
	}
	metrics.originFetch(performance.now() - fetchStarted, response.statusCode, reason);

	const clean = sanitizeOriginResponseHeaders(response.headers);
	if (clean.location !== undefined) clean.location = publicLocation(clean.location, urlObj);
	const content = originBodyStream(response.body);
	return {
		miss: true,
		url: urlObj.href,
		deviceType,
		// Carried so a caller can tell a HEAD's status from a GET's: a HEAD may confirm a stored answer,
		// but its 200 alone does not reopen a target or drop a stored 404 (bot_request.js, negativeCache.js).
		method,
		statusCode: response.statusCode,
		headers: clean,
		content,
		// See `releaseOriginBody`. A property rather than a lookup so it survives the `{ ...resource }`
		// copies the capture paths make.
		releaseBody: method === 'HEAD' ? () => response.body.destroy() : () => drainOrDestroy(content, response.body),
		viaStaging: Boolean(stagingIp),
		// SURFACED SEPARATELY BECAUSE THE SANITIZER DROPS IT. `set-cookie` is not on the forwarded
		// allowlist, so by the time a caller sees `headers` there is nothing left to tell it the origin
		// tried to set one — and "the origin set a cookie on this document" is the single best hint
		// available that the response was personalized and must not be stored and replayed to every
		// crawler. Reported rather than acted on here: relaying is unaffected, and only a caller that
		// intends to CACHE the body has a decision to make (util/rawCache.js).
		hadSetCookie: response.headers?.['set-cookie'] !== undefined,
	};
};
