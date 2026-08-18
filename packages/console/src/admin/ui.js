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
	traffic: 'M3 17V9.5M7.5 17V4.5M12 17v-6M16.5 17V8',
	invalidations: ['M10 3a7 7 0 100 14 7 7 0 000-14', 'M5.5 5.5l9 9'],
	metrics: ['M3 4.5h14M3 9.5h14M3 14.5h9'],
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

// ---- configuration editing -------------------------------------------------------------------
//
// The console can write the plugin's config: `render_service.ConfigOverride` holds one row per
// option path, layered over the deployed `config.yaml`. Everything below renders that, and the
// hard part is not the inputs — it is never letting a value look like it took effect when it did
// not. Four states have to stay visually distinct: what the deployed file says, what an override
// says, what is STAGED in this browser and not yet written, and what the cluster is actually
// running. A control that showed only the last of those would be a config editor that lies during
// exactly the minute an operator is changing something.

/**
 * Which layer produced the running value.
 *
 * `override-rejected` is the one that matters: the row exists, the console lists it, and the
 * cluster is NOT honouring it because the value failed validation. It reads as bad, not as a
 * variant of "override", because the operator's setting is not in force.
 */
export const originPill = (source) =>
	({
		'default': () => muted('default'),
		'file': () => pill('config.yaml', 'info'),
		'override': () => pill('override', 'warn'),
		'override-rejected': () => pill('override REJECTED — not in effect', 'bad'),
	})[source]?.() ?? muted(String(source ?? '—'));

/**
 * Split `text` on `term` into text nodes and `<mark>` runs.
 *
 * Exists so that highlighting a search match never becomes a reason to reach for an HTML string —
 * the one rule this whole client is built on.
 */
export function highlight(text, term) {
	const value = String(text ?? '');
	if (!term) return [value];
	const parts = [];
	const needle = term.toLowerCase();
	let index = 0;
	for (;;) {
		const at = value.toLowerCase().indexOf(needle, index);
		if (at === -1) break;
		if (at > index) parts.push(value.slice(index, at));
		parts.push(el('mark', { text: value.slice(at, at + needle.length) }));
		index = at + needle.length;
	}
	parts.push(value.slice(index));
	return parts;
}

// Units an operator actually thinks in. The canonical stored value is always milliseconds; this is
// only how it is typed and read back, so that `86400000` is entered and reviewed as `1d`.
const DURATIONS = [
	['ms', 1],
	['s', 1000],
	['m', 60000],
	['h', 3600000],
	['d', 86400000],
];

/** The largest unit that divides `ms` exactly, so a round value round-trips as a round value. */
const bestDurationUnit = (ms) => {
	for (let i = DURATIONS.length - 1; i > 0; i--) {
		const [, size] = DURATIONS[i];
		if (Number.isFinite(ms) && ms !== 0 && ms % size === 0) return DURATIONS[i];
	}
	return DURATIONS[0];
};

/**
 * A duration as a number plus a unit, staging canonical milliseconds.
 *
 * Most of this plugin's numeric options are `unit: 'ms'` and several are days expressed as eight
 * digits. Typing those by hand is how a TTL becomes 10x what was meant, and the schema's `min`/`max`
 * cannot catch it because the wrong value is usually in range.
 */
export function durationInput(ms, { min, max, onChange, invalid = false } = {}) {
	let [unitName, unitSize] = bestDurationUnit(ms);
	// Both bounds are re-expressed in the CURRENT unit, so the browser's own validation stays true
	// after a unit switch. `page.blobReadBudgetMs` is the reason `max` matters: past 2147483647 a
	// setTimeout delay overflows its signed 32-bit field and fires after 1ms instead of never, which
	// would time out every cache hit and send all traffic to the origin.
	const amount = el('input', {
		type: 'number',
		cls: `dur-amount${invalid ? ' invalid' : ''}`,
		value: Number.isFinite(ms) ? String(ms / unitSize) : '',
		min: Number.isFinite(min) ? String(min / unitSize) : null,
		max: Number.isFinite(max) ? String(max / unitSize) : null,
		oninput: () => emit(),
	});
	const unit = el(
		'select',
		{ cls: 'dur-unit', onchange: () => switchUnit() },
		DURATIONS.map(([name]) => el('option', { value: name, selected: name === unitName ? '' : null, text: name }))
	);
	const readout = el('span', { cls: 'dur-ms muted mono' });

	const emit = () => {
		const next = Number(amount.value) * unitSize;
		readout.textContent = Number.isFinite(next) ? `${next.toLocaleString()} ms` : '';
		onChange?.(Number.isFinite(next) ? next : null);
	};
	// Changing the unit re-expresses the SAME duration rather than reinterpreting the number: going
	// from `30 m` to hours must mean 0.5h, not 30h. Silently multiplying by 60 here would be a
	// config editor that changes a value nobody edited.
	const switchUnit = () => {
		const current = Number(amount.value) * unitSize;
		[unitName, unitSize] = DURATIONS.find(([name]) => name === unit.value) ?? DURATIONS[0];
		amount.value = String(current / unitSize);
		if (Number.isFinite(min)) amount.setAttribute('min', String(min / unitSize));
		if (Number.isFinite(max)) amount.setAttribute('max', String(max / unitSize));
		emit();
	};

	emit();
	return el('span', { cls: 'dur' }, [amount, unit, readout]);
}

/**
 * An ordered list of scalars, one per line.
 *
 * A textarea rather than a row of inputs: every one of these options is a short list an operator
 * pastes or reorders wholesale, and line-per-entry is both the fastest edit and the shape the YAML
 * they already know uses. Empty lines are dropped rather than stored as empty strings, which
 * several of these options reject outright.
 */
export function listEditor(values, { numeric = false, placeholder = '', onChange, invalid = false } = {}) {
	const area = el('textarea', {
		cls: `list-editor${invalid ? ' invalid' : ''}`,
		rows: String(Math.min(10, Math.max(3, (values?.length ?? 0) + 1))),
		placeholder,
		oninput: (event) => {
			const lines = event.target.value
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line !== '');
			onChange?.(numeric ? lines.map(Number) : lines);
		},
	});
	area.value = (values ?? []).join('\n');
	return area;
}

/**
 * The control for one option, chosen from its schema node.
 *
 * NEVER returns an editable node for an option the server marked `uiEditable: false`. That is not
 * a cosmetic disable: the two reasons an option carries the flag are that it is a secret (the API
 * only ever sends back `<set: N chars>`, so a form round-trip would store the redaction marker as
 * the token) and that editing it removes the ability to edit (`management.enabled`, and the
 * override machinery itself). Both are refused server-side too; this is the half that explains why.
 */
export function control(opt, value, onChange, { invalid = false } = {}) {
	if (opt.uiEditable === false) {
		return el('span', { cls: 'ctl-locked' }, [
			mono(formatValue(value)),
			muted(
				opt.secret ? ' — secret, set through its environment variable' : ' — deliberately not editable from the console'
			),
		]);
	}

	if (opt.type === 'boolean') {
		return el('label', { cls: 'toggle' }, [
			el('input', { type: 'checkbox', checked: value ? '' : null, onchange: (e) => onChange(e.target.checked) }),
			el('span', { text: value ? 'on' : 'off' }),
		]);
	}

	if (opt.enum) {
		return el(
			'select',
			{ cls: invalid ? 'invalid' : null, onchange: (e) => onChange(e.target.value) },
			opt.enum.map((choice) => el('option', { value: choice, selected: choice === value ? '' : null, text: choice }))
		);
	}

	if (opt.type === 'number') {
		if (opt.unit === 'ms') return durationInput(value, { min: opt.min, max: opt.max, onChange, invalid });
		return el('input', {
			type: 'number',
			cls: `num${invalid ? ' invalid' : ''}`,
			value: String(value ?? ''),
			min: opt.min ?? null,
			max: opt.max ?? null,
			oninput: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)),
		});
	}

	if (opt.type === 'array') {
		// A closed item set is a checkbox set, not free text: `cacheKey.decodeReserved` rejects the
		// WHOLE list when one entry is not allowed, so an editor that lets you type a rogue entry is
		// an editor whose mistakes cost the entire option.
		if (opt.itemEnum) {
			const selected = new Set(value ?? []);
			return el(
				'div',
				{ cls: 'checkset' },
				opt.itemEnum.map((item) =>
					el('label', null, [
						el('input', {
							type: 'checkbox',
							checked: selected.has(item) ? '' : null,
							onchange: (e) => {
								if (e.target.checked) selected.add(item);
								else selected.delete(item);
								onChange(opt.itemEnum.filter((entry) => selected.has(entry)));
							},
						}),
						mono(item),
					])
				)
			);
		}
		const numeric = Array.isArray(opt.default) && opt.default.every((entry) => typeof entry === 'number');
		return listEditor(value, { numeric, placeholder: 'one per line', onChange, invalid });
	}

	return el('input', {
		type: 'text',
		cls: `mono${invalid ? ' invalid' : ''}`,
		value: value ?? '',
		oninput: (e) => onChange(e.target.value),
	});
}

/** Render any config value for display. Objects and arrays are shown as compact JSON. */
export const formatValue = (value) => {
	if (value === undefined) return '—';
	if (typeof value === 'string') return value === '' ? '(empty)' : value;
	return JSON.stringify(value);
};

/**
 * The layer strip: what each layer says, and a revert when an override is in play.
 *
 * The file value is shown even when an override wins, because "what does the repo say" is the
 * question an operator has right before deciding whether the override is still wanted — and the
 * answer is otherwise only in a git checkout on another machine.
 */
export function layerStrip(row, { onRevert, busy } = {}) {
	const cells = [['default', row.default]];
	if (row.fileDiffersFromDefault) cells.push(['config.yaml', row.file]);
	if (row.overridden) cells.push(['override', row.override]);

	return el('div', { cls: 'layers' }, [
		...cells.map(([label, value]) => el('span', { cls: 'layer' }, [muted(label), mono(formatValue(value))])),
		row.overridden &&
			el('button', {
				cls: 'link',
				text: 'revert to config.yaml',
				disabled: busy,
				title: 'Deletes the stored override for this option. The deployed value takes over.',
				onclick: () => onRevert?.(row.path),
			}),
	]);
}

/**
 * One option: identity, control, provenance, and every way it can be not-what-it-looks-like.
 *
 * `staged` is a pending edit in this browser that has not been written. It is rendered as a
 * distinct state rather than by just showing the new value, because a staged edit and an applied
 * one are the difference between "I am about to do this" and "the cluster is doing this".
 */
export function settingRow(opt, { staged, invalid, pendingRestart, divergent, busy, onStage, onRevert } = {}) {
	const isStaged = staged !== undefined;
	const shown = isStaged ? staged : opt.effective;

	return el('div', { cls: `setting${isStaged ? ' staged' : ''}${invalid ? ' invalid' : ''}` }, [
		el('div', { cls: 'setting-head' }, [
			el('code', { cls: 'path', text: opt.path }),
			originPill(opt.source),
			opt.scope === 'restart' && pill('restart to take effect', 'warn'),
			pendingRestart && pill('changed — still running the boot value', 'bad'),
			divergent && pill('differs between nodes', 'bad'),
			isStaged && pill('staged, not written', 'info'),
		]),
		opt.description && el('p', { cls: 'setting-desc', text: opt.description }),
		el('div', { cls: 'setting-ctl' }, [
			control(opt, shown, (next) => onStage?.(opt.path, next), { invalid: !!invalid }),
		]),
		invalid && el('div', { cls: 'note bad', text: invalid }),
		layerStrip(opt, { onRevert, busy }),
	]);
}

/**
 * The staged-change tray: what is about to be written, and the two-step that writes it.
 *
 * PREVIEW IS THE PRIMARY ACTION, matching the invalidation flow. The preview is not a local diff —
 * it is the server resolving a prospective config through the same merge and the same schema
 * constraints the real apply uses, so it reports the three things a client-side diff cannot: a
 * value that would be REJECTED, a change that is a no-op, and routes that would be silently
 * dropped as invalid. Applying is a second, explicit click from inside that answer.
 */
export function stagedTray({ count, invalid, preview, busy, onPreview, onApply, onDiscard }) {
	if (!count) return null;

	return el('div', { cls: 'tray' }, [
		el('div', { cls: 'tray-head' }, [
			el('strong', { text: `${count} staged change${count === 1 ? '' : 's'}` }),
			invalid > 0 && pill(`${invalid} invalid`, 'bad'),
			spacer(),
			el('button', { cls: 'link', text: 'Discard', disabled: busy, onclick: onDiscard }),
			el('button', {
				cls: 'primary',
				text: 'Preview (writes nothing)',
				disabled: busy || invalid > 0,
				onclick: onPreview,
			}),
		]),
		preview && previewBody(preview, { busy, onApply }),
	]);
}

const previewBody = (preview, { busy, onApply }) => {
	if (preview.error) return el('div', { cls: 'note bad', text: preview.error });

	const rows = (preview.changes ?? []).map((change) =>
		el('tr', null, [
			el('td', { cls: 'mono', text: change.path }),
			el('td', { cls: 'mono muted', text: formatValue(change.from) }),
			el('td', { cls: 'mono', text: formatValue(change.to) }),
			el('td', null, [change.willTakeEffect ? pill('live', 'ok') : pill('staged until restart', 'warn')]),
		])
	);

	return el('div', { cls: 'tray-preview' }, [
		el('div', { cls: 'note info' }, [
			el('strong', { text: 'Preview — nothing has been written. ' }),
			'This is the same body the write returns.',
		]),
		table(['option', 'from', 'to', 'effect'], rows, 'No effective change.'),
		...(preview.noop ?? []).map((path) =>
			note('warn', [
				el('strong', { text: `${path} is already this value. ` }),
				'Writing it would store an override that changes nothing.',
			])
		),
		...(preview.rejected ?? []).map((entry) =>
			note('bad', [
				el('strong', { text: `${entry.path ?? entry} would be rejected. ` }),
				'It would be stored and NOT honoured — the cluster would keep the value it has.',
			])
		),
		preview.routes?.dropped > 0 &&
			note('bad', [
				el('strong', { text: `${preview.routes.dropped} route(s) would be dropped as invalid. ` }),
				'An invalid route is discarded, not rejected — the paths it covers would silently stop being prerendered.',
			]),
		...(preview.warnings ?? []).map((warning) =>
			note(warning.severity === 'warn' ? 'warn' : 'info', [
				el('strong', { cls: 'mono', text: `${warning.key}: ` }),
				warning.message,
			])
		),
		preview.appliesRemotelyWithinMs
			? el('p', {
					cls: 'muted chart-note',
					text:
						`One node takes the write and the rows replicate; every node converges in about a second, ` +
						`or within ${Math.round(preview.appliesRemotelyWithinMs / 1000)}s if a node's subscription is not live.`,
				})
			: null,
		el('div', { cls: 'toolbar' }, [
			spacer(),
			el('button', { cls: 'danger', text: 'Apply to the cluster', disabled: busy, onclick: onApply }),
		]),
	]);
};
