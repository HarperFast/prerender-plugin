/**
 * Config redaction for the management API.
 *
 * The effective config is genuinely useful to see (it is the merge of defaults + host
 * overrides + env-sourced secrets, and there is no other way to observe it), but it holds
 * the shared origin secret and the render-now token. Those are replaced with a presence
 * marker: an operator needs to know whether a secret is set, never what it is.
 */

import { secretPaths } from '../configSchema.js';

// Dotted paths whose values are secrets — the schema's `secret: true` options.
const SECRET_PATHS = secretPaths();

// A secret is reported only as whether it is set, and how long it is — enough to spot a
// truncated/whitespace-mangled value without disclosing it. Exported because the management
// API's per-option layers view redacts one value at a time rather than a whole config object.
export const describeSecret = (value) => {
	if (typeof value !== 'string' || value.length === 0) return '<empty>';
	return `<set: ${value.length} chars>`;
};

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = (value) => {
	if (Array.isArray(value)) return value.map(clone);
	if (isPlainObject(value)) {
		const out = {};
		for (const [key, inner] of Object.entries(value)) out[key] = clone(inner);
		return out;
	}
	return value;
};

/**
 * Deep-clone `config` with every `SECRET_PATHS` entry replaced by a presence marker.
 * Returns a new object; the input is never mutated.
 */
export const redactConfig = (config) => {
	const out = clone(config);

	for (const path of SECRET_PATHS) {
		const segments = path.split('.');
		const leaf = segments.pop();

		let node = out;
		for (const segment of segments) {
			if (!isPlainObject(node)) break;
			node = node[segment];
		}

		// Only mark a key that actually exists, so a redaction path that drifts out of sync
		// with the config shape doesn't invent a phantom `<empty>` key.
		if (isPlainObject(node) && leaf in node) {
			node[leaf] = describeSecret(node[leaf]);
		}
	}

	return out;
};

export { SECRET_PATHS };
