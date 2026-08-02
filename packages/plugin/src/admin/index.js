/**
 * The management console's static assets.
 *
 * This used to be one 900-line template literal, which meant the client script could not use
 * template literals (the file WAS one), was invisible to eslint and prettier, and forced
 * `unsafe-inline` for both script and style in the page's CSP. It is now a small tree of real
 * files served from disk.
 *
 * WHY DISK READS ARE SAFE HERE. The template literal existed so the page would work "however
 * the component is deployed". But `jsResource` already loads this very module graph from disk,
 * so by the time anything can call into here, these files are on disk by definition. Reads are
 * LAZY and memoized: a deployment that never opens the console pays nothing, and one that does
 * pays a handful of reads once per worker.
 *
 * WHY AN EXPLICIT ALLOWLIST, NOT A PATH JOIN. The asset id comes from `RequestTarget`, which
 * hands multi-segment paths through as a decoded string — so `../../../etc/passwd` arrives
 * intact. `ASSETS` maps a fixed set of ids to a fixed set of filenames and nothing else
 * resolves. There is no user-controlled component in any path this module opens.
 *
 * WHY THE FONTS ARE VENDORED. See the note at the top of app.css: this page's CSP is
 * `default-src 'none'`, and it is the tool you open when production is broken. A font CDN
 * would mean a hole in that CSP plus a third party in the console's own critical path, to
 * save 264KB in a tarball. Their licenses ship beside them (fonts/LICENSE-*.txt).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const JS = 'text/javascript; charset=utf-8';

// id -> [filename relative to this directory, content type]. The id is what appears in the URL
// after the resource root; nothing outside this table is readable.
const ASSETS = new Map([
	['app.css', ['app.css', 'text/css; charset=utf-8']],
	['app.js', ['app.js', JS]],
	['ui.js', ['ui.js', JS]],
	['api.js', ['api.js', JS]],
	['views/overview.js', ['views/overview.js', JS]],
	['views/queue.js', ['views/queue.js', JS]],
	['views/sitemaps.js', ['views/sitemaps.js', JS]],
	['views/pages.js', ['views/pages.js', JS]],
	['views/explain.js', ['views/explain.js', JS]],
	['views/config.js', ['views/config.js', JS]],
	['fonts/ubuntu-300.woff2', ['fonts/ubuntu-300.woff2', 'font/woff2']],
	['fonts/ubuntu-400.woff2', ['fonts/ubuntu-400.woff2', 'font/woff2']],
	['fonts/ubuntu-400-italic.woff2', ['fonts/ubuntu-400-italic.woff2', 'font/woff2']],
	['fonts/ubuntu-500.woff2', ['fonts/ubuntu-500.woff2', 'font/woff2']],
	['fonts/ubuntu-700.woff2', ['fonts/ubuntu-700.woff2', 'font/woff2']],
	['fonts/fira-code-400.woff2', ['fonts/fira-code-400.woff2', 'font/woff2']],
	['fonts/fira-code-500.woff2', ['fonts/fira-code-500.woff2', 'font/woff2']],
	['fonts/fira-code-700.woff2', ['fonts/fira-code-700.woff2', 'font/woff2']],
]);

/** Ids whose bytes are pinned to their filename, so the browser never needs to revalidate. */
const IMMUTABLE = (id) => id.startsWith('fonts/');

const cache = new Map();

const read = (file) => readFileSync(new URL(file, import.meta.url));

/**
 * One asset by id, or null when the id is not in the allowlist.
 *
 * Returns the raw Buffer: fonts are binary, and decoding them to a string to hand back would
 * corrupt them. The ETag is a short content hash computed once, alongside the read.
 */
export const getAdminAsset = (id) => {
	const entry = ASSETS.get(id);
	if (!entry) return null;

	let asset = cache.get(id);
	if (!asset) {
		const [file, contentType] = entry;
		const body = read(file);
		asset = {
			body,
			contentType,
			etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
			immutable: IMMUTABLE(id),
		};
		cache.set(id, asset);
	}
	return asset;
};

/** Asset ids, for tests that assert every one of them resolves. */
export const adminAssetIds = () => [...ASSETS.keys()];

/**
 * The console shell. Static: its asset URLs are relative, so it needs no base-path
 * substitution — the resource 308s the slashless root to `prerender_admin/` and everything
 * resolves from there, deployment prefix included.
 */
export const renderAdminPage = () => read('page.html').toString('utf8');
