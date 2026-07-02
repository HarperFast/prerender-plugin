import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { config } from '../config.js';

const agent = new Agent({});

/**
 * The staging IP to connect to for this origin fetch, or undefined for a normal fetch.
 * Staging passthrough is active only when a staging `ip` is configured (and valid) AND
 * the request carries the configured toggle header. The address is always the configured
 * `config.staging.ip` — never a value from the request — so a request can only switch the
 * fetch to the one pre-approved IP, not repoint it at an arbitrary host.
 */
export const stagingTargetIp = (headers) => {
	const { ip, header } = config.staging;
	if (!ip || !header || !isIP(ip)) return undefined;
	return headers?.get(header) ? ip : undefined;
};

// Dispatchers that pin DNS resolution to a fixed IP (staging passthrough), one per IP.
// Only the connect address is overridden — the origin (so Host header + TLS SNI + cert
// validation) stays the real origin host, the server-side equivalent of Chrome's
// --host-resolver-rules=MAP host ip. In practice there is at most one entry (the single
// configured staging IP); the map just keeps it stable across requests and across a
// config reload that changes the IP.
const pinnedDispatchers = new Map();
const dispatcherFor = (ip) => {
	if (!ip) return agent;
	let dispatcher = pinnedDispatchers.get(ip);
	if (!dispatcher) {
		const family = isIP(ip);
		dispatcher = new Agent({
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
	const tokenHeader = config.securityToken.header;
	const debugKey = config.debugHeader.key;
	const configured = config.ignoredHeaders;
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

// Origin responses are relayed to the edge on a cache miss. The origin sits behind a CDN
// (Akamai), so its response carries the CDN's own control headers (akamai-grn, x-akamai-*,
// x-cache*, via, server-timing, …). When the edge's "Serve Alternate Response" swap re-adds
// its own copies the response ends up with duplicated CDN headers, and the edge fails the
// transform (ERR_SWAPFAIL_*|badxform). Relay only this allowlist of genuine origin-response
// headers so the swapped-in response looks like a clean origin reply; everything else (CDN
// headers, hop-by-hop headers, set-cookie) is dropped.
//
// server-timing is deliberately NOT relayed: the value from the origin is the staging edge's
// own Akamai timing tokens, and the serving edge adds its own on egress — so dropping the
// origin's avoids re-doubling it and keeps Akamai-internal tokens off the response.
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
		'user-agent': config.userAgents[deviceType] ?? config.userAgents.desktop,
		[config.securityToken.header]: config.securityToken.value,
		// Request gzip (not brotli) from the origin. On a cache miss this response is relayed
		// to the Akamai edge for its "Serve Alternate Response" swap, and Akamai cannot apply
		// its outgoing transform to a brotli-encoded alternate response (ERR_SWAPFAIL_*|badxform).
		// gzip is transform-safe; the edge re-compresses (to br) for the real client on egress.
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
