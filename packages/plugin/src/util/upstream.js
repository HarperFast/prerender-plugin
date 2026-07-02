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
// keys and the base set are lowercase, so configured names are lowered here.
// Memoize the Set and rebuild only when those inputs change, instead of
// allocating a Set on every origin fetch.
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
			tokenHeader,
			debugKey,
			...configured.map((name) => name.toLowerCase()),
		]);
		ignoredHeadersKey = key;
	}
	return ignoredHeadersCache;
};

export const resolveUpstreamHeaders = (downstream, deviceType) => {
	const upstream = {
		'user-agent': config.userAgents[deviceType] ?? config.userAgents.desktop,
		[config.securityToken.header]: config.securityToken.value,
		'accept-encoding': 'br, gzip',
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

	for (const key of hopByHopHeaders) {
		delete response.headers[key];
	}
	delete response.headers['set-cookie'];

	return {
		miss: true,
		url: urlObj.href,
		deviceType,
		statusCode: response.statusCode,
		headers: response.headers,
		content: Readable.toWeb(response.body),
		viaStaging: Boolean(stagingIp),
	};
};
