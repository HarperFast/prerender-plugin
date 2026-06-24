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
}
