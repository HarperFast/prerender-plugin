/**
 * Helpers for reading headers from either a WHATWG `Headers` instance or a plain
 * object (upstream responses arrive as plain objects).
 */

export const headersToObject = (headers) => {
	if (typeof headers === 'string') return JSON.parse(headers);
	if (headers instanceof Headers) {
		const obj = {};
		headers.forEach((val, key) => {
			obj[key] = val;
		});
		return obj;
	}
	return headers;
};

export const getHeader = (headers, key) => {
	if (headers instanceof Headers) return headers.get(key);

	const v = headers[key];
	if (Array.isArray(v)) return v.join(', ');
	return v || null;
};
