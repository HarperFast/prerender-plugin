import { config } from '../config.js';

/**
 * HARPER'S PRIMARY-KEY LIMIT: a key must encode to at most this many bytes (`MAX_KEY_BYTES` in
 * Harper's `resources/Table.ts`, 5.x). A read or write keyed by anything longer throws a 400
 * `ClientError` ("Primary key size is too large") before it touches storage, so an over-limit URL
 * cannot be cached, scheduled or recorded at all — only proxied. Ordered-binary encodes a string as its
 * UTF-8 bytes, plus an escape byte per character up to U+0004 in a short string and one leading byte when
 * the first character is below U+001C. A canonical URL is printable ASCII starting with `h` (WHATWG `URL`
 * percent-encodes every control and non-ASCII character), so for these keys the UTF-8 length is the exact
 * encoded length — pinned against the encoder in test/cacheKey.test.js.
 */
export const MAX_KEY_BYTES = 1978;

/**
 * Builds and parses cache keys. The delimiter and attribute list come from
 * `config.cacheKey` and are read lazily so host overrides apply.
 */
export class CacheKey {
	static toCacheKey(obj) {
		const { delimiter, attributes } = config.cacheKey;
		return attributes.map((name) => obj[name] || '').join(delimiter);
	}

	static parse(cacheKeyString) {
		const { delimiter, attributes } = config.cacheKey;
		const values = cacheKeyString.split(delimiter);
		const parsed = {};
		for (let i = 0; i < attributes.length; i++) {
			parsed[attributes[i]] = values[i];
		}
		return parsed;
	}

	static extractUrl(cacheKey) {
		return cacheKey.substring(0, cacheKey.indexOf(config.cacheKey.delimiter));
	}

	/** True when this one key fits `MAX_KEY_BYTES` (see `fitsKeyLimit` for the URL-level bound). */
	static keyFits(key) {
		const str = String(key ?? '');
		if (str.length * 3 <= MAX_KEY_BYTES) return true;
		if (str.length > MAX_KEY_BYTES) return false;
		return Buffer.byteLength(str) <= MAX_KEY_BYTES;
	}

	/**
	 * True when every table key this canonical URL can produce fits `MAX_KEY_BYTES`. The longest is
	 * its cacheKey for the longest supported device — `Target`, `ProbeState` and a URL-keyed
	 * `RenderSchedule` row use the bare URL, the page, raw and negative caches the cacheKey — so the
	 * bound is checked where a URL arrives (bot request, sitemap ingest, redirect destination). A Target
	 * created before that check may still be one of the URLs that fit while their page keys do not, so the
	 * key lists in resources/Target.js leave out any key past the limit and the render-result path retires
	 * such a target. Counted in UTF-16 units first: nearly every URL is decided without measuring its
	 * bytes, since a unit costs at least one UTF-8 byte and at most three.
	 */
	static fitsKeyLimit(url) {
		const str = String(url ?? '');
		// Everything a cacheKey adds to the URL: a delimiter per extra attribute, and the device when
		// it is one of them (`toCacheKey` is only ever handed a url and a deviceType).
		const { delimiter, attributes } = config.cacheKey;
		let device = '';
		if (attributes.includes('deviceType')) {
			for (const d of config.deviceTypes.supported) if (d.length > device.length) device = d;
		}
		const delimiters = Math.max(0, attributes.length - 1);
		const units = str.length + delimiters * delimiter.length + device.length;
		if (units * 3 <= MAX_KEY_BYTES) return true;
		if (units > MAX_KEY_BYTES) return false;
		const bytes = Buffer.byteLength(str) + delimiters * Buffer.byteLength(delimiter) + Buffer.byteLength(device);
		return bytes <= MAX_KEY_BYTES;
	}

	// ── schedule keys ──────────────────────────────────────────────────────────────────────────
	//
	// A `RenderSchedule` row is keyed by URL (one row per URL, every device rendered in one job) since
	// v0.66.0. Before that it was keyed by cacheKey, one row per device, and those rows are NOT
	// migrated in place: each converts the first time it renders (see `RenderQueue.processJobResult`),
	// so for one full render cycle after the upgrade the table holds both shapes. A device-keyed row
	// also remains the shape of a deliberate one-device render (`renderNow` for a device outside
	// `deviceTypes.default`). Every reader of a schedule key therefore goes through these three,
	// never through `extractUrl`/`parse` directly — `extractUrl` on a URL-shaped key returns '' (the
	// delimiter is absent, `indexOf` is -1), which resolves a route for the empty string and files
	// a row nobody asked for.
	//
	// The shape test is "ends in <delimiter><supported device>", NOT "contains the delimiter".
	// `canonicalizeUrl` percent-encodes a literal `|` out of the URL half (util/url.js step 7), but
	// `cacheKey.delimiter` is configurable and any other choice can legitimately occur inside a URL;
	// keying on the device tail is sound for every delimiter (a URL that itself ends in
	// `<delimiter><device>` is the one false positive, and no canonical URL does).

	/** Where the device tail of a cacheKey starts, or -1 when `str` is not shaped like one. */
	static #deviceTailAt(str) {
		const delimiter = config.cacheKey.delimiter;
		const at = str.lastIndexOf(delimiter);
		if (at === -1) return -1;
		return config.deviceTypes.supported.includes(str.slice(at + delimiter.length)) ? at : -1;
	}

	/** True when `key` is a cacheKey (`<url><delimiter><device>`), i.e. a per-device schedule row. */
	static isCacheKey(key) {
		return CacheKey.#deviceTailAt(String(key ?? '')) !== -1;
	}

	/** The URL a schedule key stands for: the URL half of a cacheKey, or the key itself. */
	static urlOf(key) {
		const str = String(key ?? '');
		const at = CacheKey.#deviceTailAt(str);
		return at === -1 ? str : str.slice(0, at);
	}

	/** The device a per-device schedule key names, or `null` for a URL-keyed row. */
	static deviceOf(key) {
		const str = String(key ?? '');
		const at = CacheKey.#deviceTailAt(str);
		return at === -1 ? null : str.slice(at + config.cacheKey.delimiter.length);
	}
}
