/**
 * Console component configuration. Deliberately tiny next to the plugin's schema machinery:
 * this component has four knobs, and its README is the option reference.
 *
 * Mirrors the plugin's pattern where it matters: `config` is a live, pre-populated object
 * that modules read lazily at request time, and `applyOptions` mutates it in place so the
 * host app's `change` events (live reload) take effect without re-imports.
 */

export const getLogger = () => (typeof logger !== 'undefined' && logger ? logger : console);

export const config = {
	/**
	 * The prerender nodes this console can talk to, as origin URLs
	 * (e.g. `https://node-a.internal.example.com:9926`). ORDER IS MEANINGFUL: the first entry
	 * is the default node a fresh session lands on. Every entry must be an absolute http(s)
	 * URL; the node PICKER offers exactly this list and the proxy refuses anything else —
	 * the browser can never steer the proxy at an arbitrary host.
	 *
	 * List NODES, not a load-balanced/GTM name: sessions and the node-local views (analytics,
	 * queue, unrouted) are per node, and a name that rotates per connection would silently
	 * mix nodes across refreshes.
	 */
	nodes: [],

	/** Deadline for one proxied upstream request. */
	requestTimeout: 30_000,

	/**
	 * Verify upstream TLS certificates. Set false only for internal endpoints on
	 * unverifiable certs — the consequence is that the proxy will hand the operator's
	 * credentials to whatever answers the configured address.
	 */
	rejectUnauthorized: true,

	/** Name of the console's own session cookie (holds the per-node upstream tokens). */
	cookieName: 'prerender-console-session',
};

const isValidNodeUrl = (value) => {
	try {
		const url = new URL(String(value));
		return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.host;
	} catch {
		return false;
	}
};

/**
 * Apply host-app options onto the live config. Unknown keys warn rather than throw — a typo
 * should be visible in the log, not take the console down — but invalid node URLs are
 * DROPPED loudly, because a malformed entry would otherwise become a proxy target.
 */
export function applyOptions(options = {}) {
	const log = getLogger();
	for (const [key, value] of Object.entries(options)) {
		switch (key) {
			case 'nodes': {
				const list = Array.isArray(value) ? value : [value];
				const valid = [];
				for (const entry of list) {
					if (isValidNodeUrl(entry)) valid.push(new URL(String(entry)).origin);
					else log.error(`[prerender-console] ignoring invalid node URL in config: ${JSON.stringify(entry)}`);
				}
				config.nodes = valid;
				break;
			}
			case 'requestTimeout': {
				const ms = Number(value);
				if (Number.isFinite(ms) && ms > 0) config.requestTimeout = ms;
				else log.error(`[prerender-console] ignoring invalid requestTimeout: ${JSON.stringify(value)}`);
				break;
			}
			case 'rejectUnauthorized':
				config.rejectUnauthorized = value !== false;
				if (value === false) {
					log.warn(
						'[prerender-console] rejectUnauthorized is FALSE — upstream TLS certificates are not verified, ' +
							'and operator credentials will be sent to whatever answers the configured node addresses.'
					);
				}
				break;
			case 'cookieName':
				if (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)) config.cookieName = value;
				else log.error(`[prerender-console] ignoring invalid cookieName: ${JSON.stringify(value)}`);
				break;
			// Harper passes its own bookkeeping keys through scope.options; only flag keys that
			// look like they were meant for us.
			case 'package':
			case 'files':
				break;
			default:
				log.warn(`[prerender-console] unknown option "${key}" ignored`);
		}
	}
	if (config.nodes.length === 0) {
		log.warn('[prerender-console] no nodes configured — the console will render but cannot sign in anywhere.');
	}
}
