import { getHeader } from './headers.js';

/**
 * Parse an X-Robots-Tag header value into directives. Handles comma-separated
 * directives, with optional ":" scopes (e.g. "googlebot: noindex").
 */
function parseRobotsDirectives(raw) {
	const out = new Set();
	if (!raw) return out;

	const parts = raw
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	for (const p of parts) {
		// strip any agent prefix like "googlebot:"
		const cleaned = p.includes(':') ? p.split(':').slice(1).join(':').trim() : p;
		if (cleaned) out.add(cleaned);
	}

	return out;
}

/**
 * Extract a canonical URL from a Link header if present.
 * Example: `Link: <https://example.com/foo>; rel="canonical"`
 */
function parseCanonicalFromLinkHeader(linkHeader) {
	if (!linkHeader) return null;

	const entries = linkHeader.split(/,(?=\s*<)/g);

	for (const entry of entries) {
		const mUrl = entry.match(/<([^>]+)>/);
		if (!mUrl) continue;

		const url = mUrl[1].trim();
		const relMatch = entry.match(/rel\s*=\s*"?([^";]+)"?/i);

		if (relMatch && relMatch[1].toLowerCase().includes('canonical')) {
			return url;
		}
	}

	return null;
}

/**
 * Returns true if the Content-Type header represents prerenderable HTML.
 */
export function isHtmlContentType(contentType) {
	if (!contentType || typeof contentType !== 'string') {
		return false;
	}

	const mimeType = contentType.split(';')[0].trim().toLowerCase();

	return mimeType === 'text/html' || mimeType === 'application/xhtml+xml';
}

const isCandidateFromHeaders = ({ url, headers }) => {
	const get = (name) => getHeader(headers, name.toLowerCase());

	const xRobots = get('x-robots-tag');
	const contentType = get('content-type');
	const linkHeader = get('link');

	const directives = parseRobotsDirectives(xRobots || '');
	const noindex = directives.has('noindex');
	const canonicalFromHeader = parseCanonicalFromLinkHeader(linkHeader || '');

	if (!isHtmlContentType(contentType)) return false;
	if (noindex) return false;
	if (canonicalFromHeader && canonicalFromHeader !== url) return false;

	return true;
};

/**
 * Decide whether an origin response is eligible to be prerendered/indexed, based
 * on the status and response headers (HTML content-type, no `noindex`, and no
 * contradicting canonical Link header).
 */
export const isPrerenderCandidate = (resource) => {
	return resource.statusCode === 200 && isCandidateFromHeaders(resource);
};
