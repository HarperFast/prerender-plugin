import { config } from '../config.js';

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
