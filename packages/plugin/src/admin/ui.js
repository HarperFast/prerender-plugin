/**
 * Shared DOM helpers and presentational primitives for the console.
 *
 * ONE HARD RULE, INHERITED FROM THE PAGE THIS REPLACES: nothing here ever builds DOM from an
 * HTML string (no inner/outer-HTML assignment, no adjacent-HTML insertion). Every value this
 * console displays — URLs, cache keys, hostnames, config values, sitemap entries — is
 * operator- or origin-supplied, and building the DOM through `el()` with `textContent` is what
 * makes it injection-safe by construction rather than by remembering to escape. A test
 * enforces this by grepping for the banned APIs, which is also why this comment does not name
 * them literally.
 */

/**
 * Build an element. `props` recognises `text` (set as textContent), `cls`, `style` (an object),
 * `on*` (a listener), and treats everything else as an attribute — skipping null/undefined so
 * conditional attributes can be written inline.
 */
export function el(tag, props, children) {
	const node = document.createElement(tag);
	if (props) {
		for (const [key, value] of Object.entries(props)) {
			if (value === null || value === undefined) continue;
			if (key === 'text') node.textContent = String(value);
			else if (key === 'cls') node.className = value;
			else if (key === 'style') Object.assign(node.style, value);
			else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
			else node.setAttribute(key, value === true ? '' : value);
		}
	}
	append(node, children);
	return node;
}

/** Append children, skipping the null/false holes that conditional expressions leave behind. */
export function append(node, children) {
	for (const child of [children].flat(4)) {
		if (child === null || child === undefined || child === false || child === '') continue;
		node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
	}
	return node;
}

/**
 * An inline icon. SVG needs createElementNS — an `<svg>` built with createElement is an unknown
 * HTML element and renders nothing. `paths` are `d` strings; `shapes` are pre-built nodes.
 */
export function icon(paths, size = 16) {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('width', size);
	svg.setAttribute('height', size);
	svg.setAttribute('viewBox', '0 0 20 20');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of [paths].flat()) {
		const path = document.createElementNS(ns, 'path');
		path.setAttribute('d', d);
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.4');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	return svg;
}

export const ICONS = {
	overview: 'M2 10h3l2-6 4 12 2-6h5',
	sitemaps: ['M10 3.5v6M10 9.5H5v4M10 9.5h5v4', 'M7 1.5h6v3H7zM2 12.5h6v3H2zM12 12.5h6v3h-6z'],
	pages: ['M3 4.5h14v11H3zM3 8.5h14M8 4.5v11'],
	queue: [
		'M10 6l-6 8M10 6l6 8M6 14h8',
		'M8 4a2 2 0 104 0 2 2 0 10-4 0M2 14a2 2 0 104 0 2 2 0 10-4 0M14 14a2 2 0 104 0 2 2 0 10-4 0',
	],
	explain: ['M13.5 13.5l3.5 3.5', 'M4 9a5 5 0 1010 0A5 5 0 004 9'],
	config: [
		'M10 2.5v2m0 11v2M2.5 10h2m11 0h2M4.6 4.6l1.4 1.4m8 8l1.4 1.4M15.4 4.6L14 6m-8 8l-1.4 1.4',
		'M7 10a3 3 0 106 0 3 3 0 10-6 0',
	],
	search: ['M13.5 13.5l3.5 3.5', 'M4 9a5 5 0 1010 0A5 5 0 004 9'],
	refresh: ['M16.5 8A6.5 6.5 0 105 14.6', 'M16.5 3.5V8h-4.5'],
};

/** The Harper mark: three stacked layers, drawn rather than shipped as a binary. */
export function harperMark(size = 22) {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('width', size);
	svg.setAttribute('height', size);
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('aria-label', 'Harper');
	for (const [y, fill] of [
		[15.5, 'var(--blue-400)'],
		[11, 'var(--purple-500)'],
		[6.5, 'var(--teal-400)'],
	]) {
		const layer = document.createElementNS(ns, 'path');
		layer.setAttribute('d', `M12 ${y - 4.5}L21 ${y}l-9 4.5L3 ${y}z`);
		layer.setAttribute('fill', fill);
		svg.appendChild(layer);
	}
	return svg;
}

// ---- formatting ----

export const num = (value) => (value === null || value === undefined ? '—' : Number(value).toLocaleString());

export function duration(ms) {
	const s = Math.round(Math.abs(ms) / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return h + 'h' + (m % 60 ? ` ${m % 60}m` : '');
	const d = Math.floor(h / 24);
	return `${d}d` + (h % 24 ? ` ${h % 24}h` : '');
}

export function ago(ms) {
	if (!ms) return 'never';
	const delta = Date.now() - ms;
	return delta < 0 ? `in ${duration(-delta)}` : `${duration(delta)} ago`;
}

export const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

export const boolText = (value) => String(!!value);

/** A host+path form of a URL, for tables where the scheme and host are the same on every row. */
export function shortUrl(url) {
	try {
		const parsed = new URL(url);
		return parsed.pathname + parsed.search;
	} catch {
		return String(url ?? '');
	}
}

// ---- primitives ----

export const pill = (text, kind = '', withDot = false) =>
	el('span', { cls: `pill ${kind}`.trim() }, [withDot && el('span', { cls: 'dot' }), el('span', { text })]);

export const note = (kind, children) => el('div', { cls: `note ${kind}`.trim() }, children);

export const muted = (text) => el('span', { cls: 'muted', text });

export const mono = (text) => el('span', { cls: 'mono', text });

export const spacer = () => el('span', { cls: 'spacer' });

export const link = (text, onclick) => el('button', { cls: 'link', text, onclick });

export function card(title, { head = [], body = null, foot = null, cls = '' } = {}) {
	return el('div', { cls: `card ${cls}`.trim() }, [
		(title || head.length) &&
			el('div', { cls: 'card-head' }, [title && el('div', { cls: 'title', text: title }), head]),
		body && el('div', { cls: 'card-body' }, body),
		foot && el('div', { cls: 'card-foot' }, foot),
	]);
}

export function stat(label, value, sub, { warn = false } = {}) {
	return el('div', { cls: 'stat' }, [
		el('div', { cls: 'label', text: label }),
		el('div', { cls: `value${warn ? ' warn' : ''}`, text: value }),
		sub && el('div', { cls: 'sub' }, [sub]),
	]);
}

/** A definition list from `[term, value]` pairs; a null pair is skipped. */
export function kv(pairs) {
	const dl = el('dl', { cls: 'kv' });
	for (const pair of pairs) {
		if (!pair) continue;
		const [term, value] = pair;
		dl.appendChild(el('dt', { text: term }));
		append(dl.appendChild(el('dd')), value);
	}
	return dl;
}

export function table(headers, rows, empty = 'Nothing to show.') {
	return el('div', { cls: 'scroll' }, [
		el('table', null, [
			el('thead', null, [
				el(
					'tr',
					null,
					headers.map((header) =>
						el('th', { cls: header?.right ? 'right' : null, text: typeof header === 'string' ? header : header.text })
					)
				),
			]),
			el(
				'tbody',
				null,
				rows.length ? rows : [el('tr', null, [el('td', { colspan: headers.length, cls: 'muted', text: empty })])]
			),
		]),
	]);
}

export function chart(buckets, { label, title, color } = {}) {
	const max = buckets.reduce((acc, bucket) => Math.max(acc, bucket.count), 0);
	return el('div', null, [
		el(
			'div',
			{ cls: 'chart' },
			buckets.map((bucket) =>
				el('div', { cls: 'col' }, [
					el('div', {
						cls: `bar${color?.(bucket, max) ? ' warn' : ''}`,
						title: title?.(bucket) ?? String(bucket.count),
						style: { height: max ? `${Math.max(2, Math.round((bucket.count / max) * 100))}%` : '0' },
					}),
				])
			)
		),
		el(
			'div',
			{ cls: 'chart-labels' },
			buckets.map((bucket, index) => el('div', { text: label?.(bucket, index) ?? '' }))
		),
	]);
}

export const meter = (fraction) =>
	el('div', { cls: 'meter' }, [el('span', { style: { width: `${Math.max(0, Math.min(1, fraction || 0)) * 100}%` } })]);

/**
 * A panel whose data source does not exist yet.
 *
 * `needs` names the specific missing plumbing, so the panel is a prompt for the design
 * discussion rather than a dead rectangle. It renders NO numbers and NO sample shapes on
 * purpose: the incident that motivated widening this console was one where every green light
 * stayed green while the cache filled with gutted pages, and a panel that looks like data while
 * showing none is worse than no panel at all.
 */
export const unwired = (what, needs) =>
	el('div', { cls: 'unwired' }, [
		el('span', { cls: 'tag', text: 'not wired up' }),
		what,
		el('span', { cls: 'needs', text: `needs: ${needs}` }),
	]);

export const loading = () => el('p', { cls: 'muted', text: 'Loading…' });
