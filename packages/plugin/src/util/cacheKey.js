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
	// The shape test is "contains the delimiter", which is sound because `canonicalizeUrl`
	// percent-encodes a literal delimiter out of the URL half (util/url.js step 7) precisely so it can
	// never appear there.

	/** True when `key` is a cacheKey (`<url><delimiter><device>`), i.e. a per-device schedule row. */
	static isCacheKey(key) {
		return String(key ?? '').includes(config.cacheKey.delimiter);
	}

	/** The URL a schedule key stands for: the URL half of a cacheKey, or the key itself. */
	static urlOf(key) {
		const str = String(key ?? '');
		return CacheKey.isCacheKey(str) ? CacheKey.extractUrl(str) : str;
	}

	/** The device a per-device schedule key names, or `null` for a URL-keyed row. */
	static deviceOf(key) {
		const str = String(key ?? '');
		if (!CacheKey.isCacheKey(str)) return null;
		return CacheKey.parse(str).deviceType || null;
	}
}
