/**
 * `block.urlPatterns` matching, shared by request interception and the post-processing strip so the
 * two can never disagree about what "blocked" means.
 *
 * A plain entry is a substring test, as it always was. An entry prefixed `re:` is a JavaScript
 * regular expression (no flags) tested against the full request URL.
 *
 * The prefix exists for resources served from RANDOMISED paths that no substring can name.
 * Measured on a production storefront: a tag-manager container proxied first-party from
 * `/public/<44 hex>` and `/<6 alnum>/<43 base64>` — five scripts, ~2.5 MB per mobile render, and
 * 15-18% of the page's main-thread samples — where a substring entry pinned to today's path stops
 * matching the day the path rotates, and fails OPEN: the scripts load again and render CPU climbs
 * with no config change to point at.
 *
 * A regex that does not compile is a config error (see `validate` in config.ts), not a pattern that
 * silently matches nothing.
 */
export const REGEX_PREFIX = 're:';

export type UrlMatcher = (url: string) => boolean;

/** Compile once per render; the request handler calls the result for every request. */
export const compileUrlPatterns = (patterns: readonly string[]): UrlMatcher => {
	const substrings: string[] = [];
	const regexes: RegExp[] = [];
	for (const pattern of patterns) {
		if (pattern.startsWith(REGEX_PREFIX)) regexes.push(new RegExp(pattern.slice(REGEX_PREFIX.length)));
		else substrings.push(pattern);
	}
	if (substrings.length === 0 && regexes.length === 0) return () => false;
	return (url) => substrings.some((s) => url.includes(s)) || regexes.some((r) => r.test(url));
};
