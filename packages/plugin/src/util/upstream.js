import { Readable } from 'node:stream';
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
const agentOptions = () => ({ maxHeaderSize: config.origin.maxResponseHeaderBytes });

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

// The full ignore set also includes the configurable security-token and debug
// header names (so a client can't spoof them) plus any operator-configured
// `ignoredHeaders`. Header names are matched case-insensitively — downstream
// keys and the base set are lowercase, so every configurable name (token, debug,
// and each ignoredHeaders entry) is lowercased here; otherwise a mixed-case
// configured name would let a lowercase spoof slip past. Memoize the Set and
// rebuild only when those inputs change, instead of allocating on every fetch.
let ignoredHeadersCache = null;
let ignoredHeadersKey = '';
const ignoredDownstreamRequestHeaders = () => {
	const tokenHeader = config.origin.securityToken.header;
	const debugKey = config.debugHeader.key;
	const configured = config.origin.ignoredHeaders;
	const key = `${tokenHeader} ${debugKey} ${configured.join(',')}`;
	if (ignoredHeadersCache === null || key !== ignoredHeadersKey) {
		ignoredHeadersCache = new Set([
			...BASE_IGNORED_HEADERS,
			String(tokenHeader).toLowerCase(),
			String(debugKey).toLowerCase(),
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
const FORWARDED_RESPONSE_HEADERS = new Set([
	'content-type',
	'content-encoding',
	'content-length',
	'cache-control',
	'expires',
	'etag',
	'last-modified',
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

export const resolveUpstreamHeaders = (downstream, deviceType) => {
	const upstream = {
		'user-agent': config.origin.userAgents[deviceType] ?? config.origin.userAgents.desktop,
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
			upstream[key] = downstream[key];
		});
	}

	return upstream;
};

export const fetchOriginResource = async (request) => {
	const { url, deviceType, method = 'GET', body } = request;
	const headers = request.headers.asObject;

	const urlObj = url instanceof URL ? url : new URL(url);

	// Cache misses (and non-GET passthroughs) may be routed to a staging edge when the
	// request opts in via the staging header; the origin/Host stays the real host so only
	// the connect address differs.
	const stagingIp = stagingTargetIp(request.headers);

	const response = await dispatcherFor(stagingIp).request({
		origin: urlObj.origin,
		path: urlObj.pathname + urlObj.search,
		method,
		headers: resolveUpstreamHeaders(headers, deviceType),
		body,
	});

	return {
		miss: true,
		url: urlObj.href,
		deviceType,
		statusCode: response.statusCode,
		headers: sanitizeOriginResponseHeaders(response.headers),
		content: Readable.toWeb(response.body),
		viaStaging: Boolean(stagingIp),
	};
};
