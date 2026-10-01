/**
 * Harper's primary-key check, for the fake tables: a string key whose encoding exceeds the limit throws a
 * 400 before any storage is touched (`checkValidId` in Harper's `resources/Table.ts`). Defined here rather
 * than imported from the plugin, so a fake that enforces it catches the plugin's bound drifting too;
 * test/cacheKey.test.js pins both numbers to the installed Harper's own.
 *
 * Measured as UTF-8 bytes, which is ordered-binary's length for every canonical URL (no control or
 * non-ASCII characters) — also pinned in test/cacheKey.test.js.
 */
export const HARPER_MAX_KEY_BYTES = 1978;

export const checkHarperKey = (id) => {
	if (typeof id === 'string' && Buffer.byteLength(id) > HARPER_MAX_KEY_BYTES) {
		const error = new Error(`Primary key size is too large: ${id.length}`);
		error.statusCode = 400;
		throw error;
	}
};
