/**
 * The management UI: one self-contained HTML page, no build step, no external requests.
 *
 * Kept as a template literal (rather than a file read at runtime) so it works identically
 * however the component is deployed — npm-installed, packaged, or extracted.
 *
 * Two conventions in the client script below, both deliberate:
 *   - No template literals. This file IS one, so an inner `${` would interpolate here.
 *     String concatenation avoids a wall of escapes.
 *   - No innerHTML. Everything is built with the `el()` helper and set via textContent, so
 *     the URLs, cache keys, and config values this page displays cannot inject markup.
 */

const PAGE = `<title>Prerender Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
	:root {
		color-scheme: light dark;
		--bg: #f6f7f9;
		--panel: #ffffff;
		--border: #d8dce2;
		--text: #1b1f24;
		--muted: #656d76;
		--accent: #2f6feb;
		--ok: #1a7f37;
		--warn: #9a6700;
		--bad: #cf222e;
		--bar: #2f6feb;
		--code-bg: #f0f2f5;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #0d1117;
			--panel: #161b22;
			--border: #30363d;
			--text: #e6edf3;
			--muted: #8b949e;
			--accent: #4c8dff;
			--ok: #3fb950;
			--warn: #d29922;
			--bad: #f85149;
			--bar: #4c8dff;
			--code-bg: #0d1117;
		}
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		background: var(--bg);
		color: var(--text);
		font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	}
	code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
	header {
		display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
		padding: 12px 20px; background: var(--panel);
		border-bottom: 1px solid var(--border);
	}
	header h1 { font-size: 15px; margin: 0; font-weight: 650; }
	header .spacer { flex: 1; }
	main { max-width: 1100px; margin: 0 auto; padding: 20px; }
	.panel {
		background: var(--panel); border: 1px solid var(--border);
		border-radius: 8px; padding: 16px; margin-bottom: 16px;
	}
	.panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em;
		color: var(--muted); margin: 0 0 12px; font-weight: 650; }
	button {
		font: inherit; padding: 6px 12px; border-radius: 6px;
		border: 1px solid var(--border); background: var(--panel);
		color: var(--text); cursor: pointer;
	}
	button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
	button:disabled { opacity: .5; cursor: default; }
	button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
	button.primary:hover:not(:disabled) { color: #fff; filter: brightness(1.08); }
	button.danger:hover:not(:disabled) { border-color: var(--bad); color: var(--bad); }
	input, select {
		font: inherit; padding: 6px 10px; border-radius: 6px;
		border: 1px solid var(--border); background: var(--bg); color: var(--text);
	}
	input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
	th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
	tr:last-child td { border-bottom: none; }
	.badge {
		display: inline-block; padding: 1px 8px; border-radius: 999px;
		font-size: 12px; font-weight: 600; border: 1px solid currentColor;
	}
	.badge.ok { color: var(--ok); }
	.badge.warn { color: var(--warn); }
	.badge.bad { color: var(--bad); }
	.badge.mute { color: var(--muted); }
	.muted { color: var(--muted); }
	.tabs { display: flex; gap: 4px; }
	.tabs button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
	.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
	.stat { border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
	.stat .label { font-size: 12px; color: var(--muted); }
	.stat .value { font-size: 22px; font-weight: 650; margin-top: 2px; }
	.stat .sub { font-size: 12px; color: var(--muted); }
	.chart { display: flex; align-items: flex-end; gap: 2px; height: 140px;
		border-bottom: 1px solid var(--border); padding-top: 8px; }
	.chart .col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end;
		height: 100%; min-width: 0; }
	.chart .bar { background: var(--bar); border-radius: 2px 2px 0 0; min-height: 1px; }
	.chart-labels { display: flex; gap: 2px; margin-top: 4px; }
	.chart-labels div { flex: 1; text-align: center; font-size: 10px; color: var(--muted);
		min-width: 0; overflow: hidden; }
	pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px;
		padding: 12px; overflow-x: auto; font-size: 12px; margin: 0; }
	.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; align-items: baseline; }
	.kv dt { color: var(--muted); font-size: 13px; }
	.kv dd { margin: 0; word-break: break-all; }
	.note { border-left: 3px solid var(--warn); padding: 8px 12px; background: var(--code-bg);
		border-radius: 0 6px 6px 0; margin-bottom: 8px; font-size: 13px; }
	.note.bad { border-left-color: var(--bad); }
	.note.ok { border-left-color: var(--ok); }
	.note.info { border-left-color: var(--accent); }
	.login { max-width: 340px; margin: 60px auto; }
	.login .row { margin-bottom: 12px; display: flex; flex-direction: column; gap: 4px; }
	.login label { font-size: 13px; color: var(--muted); }
	.login input { width: 100%; }
	.err { color: var(--bad); font-size: 13px; margin-top: 8px; }
	.row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
	.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
	.scroll { overflow-x: auto; }
</style>
<div id="app"></div>
<script>
(function () {
	'use strict';

	// The page is served AT the resource root, so its own pathname is the API base. Derived
	// rather than hardcoded so any deployment base-URL prefix is picked up automatically.
	var BASE = location.pathname.replace(/\\/+$/, '');

	var state = { view: 'overview', session: null, overview: null, config: null, explain: null, busy: false };

	function el(tag, props, children) {
		var node = document.createElement(tag);
		if (props) {
			Object.keys(props).forEach(function (key) {
				var value = props[key];
				if (key === 'text') node.textContent = value === null || value === undefined ? '' : String(value);
				else if (key === 'cls') node.className = value || '';
				else if (key === 'style') Object.assign(node.style, value);
				else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
				else if (value !== null && value !== undefined) node.setAttribute(key, value);
			});
		}
		(children || []).forEach(function (child) {
			if (child === null || child === undefined || child === false) return;
			node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
		});
		return node;
	}

	function api(path, options) {
		return fetch(BASE + '/' + path, Object.assign({ headers: { 'content-type': 'application/json' } }, options))
			.then(function (res) {
				return res.json().catch(function () { return {}; }).then(function (body) {
					return { status: res.status, ok: res.ok, body: body };
				});
			});
	}

	function post(path, data) {
		return api(path, { method: 'POST', body: JSON.stringify(data || {}) });
	}

	// ---- formatting helpers ----

	function num(value) {
		if (value === null || value === undefined) return '—';
		return Number(value).toLocaleString();
	}

	function ago(ms) {
		if (!ms) return 'never';
		var delta = Date.now() - ms;
		if (delta < 0) return 'in ' + duration(-delta);
		return duration(delta) + ' ago';
	}

	function duration(ms) {
		var s = Math.round(Math.abs(ms) / 1000);
		if (s < 60) return s + 's';
		var m = Math.floor(s / 60);
		if (m < 60) return m + 'm';
		var h = Math.floor(m / 60);
		if (h < 24) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
		return Math.floor(h / 24) + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
	}

	function statusBadge(status) {
		var cls = status === 'paused' ? 'bad' : status === 'queued' ? 'ok' : status === 'empty' ? 'mute' : 'warn';
		return el('span', { cls: 'badge ' + cls, text: status || 'unknown' });
	}

	function boolBadge(value, trueText, falseText) {
		return el('span', {
			cls: 'badge ' + (value ? 'bad' : 'ok'),
			text: value ? trueText : falseText
		});
	}

	function kv(pairs) {
		var dl = el('dl', { cls: 'kv' });
		pairs.forEach(function (pair) {
			if (!pair) return;
			dl.appendChild(el('dt', { text: pair[0] }));
			var value = pair[1];
			dl.appendChild(el('dd', { cls: pair[2] ? 'mono' : null },
				[typeof value === 'string' || typeof value === 'number' ? String(value) : value]));
		});
		return dl;
	}

	// ---- shell ----

	function render() {
		var app = document.getElementById('app');
		app.textContent = '';

		if (!state.session) { app.appendChild(el('main', null, [el('p', { cls: 'muted', text: 'Loading…' })])); return; }
		if (!state.session.authenticated || !state.session.superUser) { app.appendChild(renderLogin()); return; }

		app.appendChild(renderHeader());
		var main = el('main');
		if (state.view === 'overview') main.appendChild(renderOverview());
		if (state.view === 'explain') main.appendChild(renderExplain());
		if (state.view === 'config') main.appendChild(renderConfig());
		app.appendChild(main);
	}

	function renderHeader() {
		var tabs = el('div', { cls: 'tabs' }, [
			tabButton('overview', 'Overview'),
			tabButton('explain', 'URL explainer'),
			tabButton('config', 'Config')
		]);

		return el('header', null, [
			el('h1', { text: 'Prerender Admin' }),
			el('span', { cls: 'muted mono', text: state.session.node || '' }),
			tabs,
			el('span', { cls: 'spacer' }),
			el('span', { cls: 'muted', text: state.session.username || '' }),
			el('button', { text: 'Sign out', onclick: signOut })
		]);
	}

	function tabButton(view, label) {
		return el('button', {
			cls: state.view === view ? 'active' : '',
			text: label,
			onclick: function () { state.view = view; load(); }
		});
	}

	function renderLogin() {
		var username = el('input', { type: 'text', autocomplete: 'username', autofocus: 'autofocus' });
		var password = el('input', { type: 'password', autocomplete: 'current-password' });
		var error = el('div', { cls: 'err' });
		var button = el('button', { cls: 'primary', text: 'Sign in' });

		function submit() {
			error.textContent = '';
			button.disabled = true;
			post('login', { username: username.value, password: password.value }).then(function (res) {
				button.disabled = false;
				if (!res.ok) { error.textContent = res.body.error || 'Sign-in failed'; return; }
				password.value = '';
				load();
			});
		}

		button.addEventListener('click', submit);
		[username, password].forEach(function (input) {
			input.addEventListener('keydown', function (event) { if (event.key === 'Enter') submit(); });
		});

		var notice = null;
		if (state.session && state.session.authenticated && !state.session.superUser) {
			notice = el('div', { cls: 'note bad', text: 'Signed in as ' + (state.session.username || 'a user') +
				', but this account is not a super_user.' });
		} else if (state.session && state.session.sessionsEnabled === false) {
			notice = el('div', { cls: 'note bad', text: 'Cookie sessions are disabled on this instance. ' +
				'Set authentication.enableSessions: true in the Harper config.' });
		}

		return el('main', null, [
			el('div', { cls: 'panel login' }, [
				el('h2', { text: 'Prerender Admin' }),
				notice,
				el('div', { cls: 'row' }, [el('label', { text: 'Harper username' }), username]),
				el('div', { cls: 'row' }, [el('label', { text: 'Password' }), password]),
				button,
				error
			])
		]);
	}

	function signOut() {
		post('logout', {}).then(function () { state.overview = null; state.config = null; load(); });
	}

	// ---- overview ----

	function renderOverview() {
		var data = state.overview;
		if (!data) return el('div', { cls: 'panel' }, [el('p', { cls: 'muted', text: 'Loading…' })]);

		return el('div', null, [
			el('div', { cls: 'toolbar' }, [
				el('button', { text: 'Refresh', disabled: state.busy ? 'disabled' : null, onclick: load }),
				el('span', { cls: 'muted', text: 'generated ' + ago(data.generatedAt) })
			]),
			state.error ? el('div', { cls: 'note bad', text: state.error }) : null,
			renderCounts(data),
			renderQueueControl(data),
			renderHistogram(data)
		]);
	}

	function renderCounts(data) {
		function stat(label, count) {
			var sub = null;
			if (count && count.estimatedRange) sub = 'estimate ±' + num(count.estimatedRange);
			else if (count && count.error) sub = count.error;
			return el('div', { cls: 'stat' }, [
				el('div', { cls: 'label', text: label }),
				el('div', { cls: 'value', text: count ? num(count.recordCount) : '—' }),
				sub ? el('div', { cls: 'sub', text: sub }) : null
			]);
		}

		var overdue = num(data.backlog.overdue) + (data.backlog.truncated ? '+' : '');

		return el('div', { cls: 'panel' }, [
			el('h2', { text: 'Scale' }),
			el('div', { cls: 'grid' }, [
				stat('Render targets', data.counts.targets),
				stat('Cached pages', data.counts.pages),
				stat('Sitemaps', data.counts.sitemaps),
				stat('Non-indexable', data.counts.nonIndexable),
				el('div', { cls: 'stat' }, [
					el('div', { cls: 'label', text: 'Due now (backlog)' }),
					el('div', { cls: 'value', text: overdue }),
					el('div', { cls: 'sub', text: data.backlog.truncated ? 'scan capped at ' + num(data.backlog.cap) : 'exact' })
				])
			])
		]);
	}

	function renderQueueControl(data) {
		var cluster = data.control.cluster;
		var clusterPaused = cluster && cluster.paused === true;

		var clusterRow = el('div', { cls: 'toolbar' }, [
			el('strong', { text: 'Cluster-wide:' }),
			cluster
				? boolBadge(clusterPaused, 'paused', 'running')
				: el('span', { cls: 'badge mute', text: 'not set (running)' }),
			cluster && cluster.updatedBy
				? el('span', { cls: 'muted', text: 'by ' + cluster.updatedBy + ' ' + ago(new Date(cluster.updatedTime).getTime()) })
				: null,
			el('span', { cls: 'spacer' }),
			el('button', {
				cls: 'danger', text: 'Pause cluster', disabled: state.busy ? 'disabled' : null,
				onclick: function () { setPause('all', true); }
			}),
			el('button', {
				text: 'Resume cluster', disabled: state.busy ? 'disabled' : null,
				onclick: function () { setPause('all', false); }
			})
		]);

		var rows = data.nodes.map(function (node) {
			var override = node.override
				? el('span', { cls: 'badge ' + (node.override.paused ? 'bad' : 'ok'),
					text: node.override.paused ? 'override: paused' : 'override: force run' })
				: el('span', { cls: 'badge mute', text: 'inherits cluster' });

			return el('tr', null, [
				el('td', { cls: 'mono' }, [
					node.hostname,
					node.isThisNode ? el('span', { cls: 'muted', text: ' (this node)' }) : null
				]),
				el('td', null, [statusBadge(node.status)]),
				el('td', null, [
					el('span', { cls: node.stale ? 'badge warn' : 'muted', text: ago(node.updatedTime) })
				]),
				el('td', null, [override]),
				el('td', null, [
					el('div', { cls: 'row-actions' }, [
						el('button', { cls: 'danger', text: 'Pause', disabled: state.busy ? 'disabled' : null,
							onclick: function () { setPause(node.hostname, true); } }),
						el('button', { text: 'Force run', disabled: state.busy ? 'disabled' : null,
							onclick: function () { setPause(node.hostname, false); } }),
						el('button', { text: 'Inherit', disabled: state.busy ? 'disabled' : null,
							onclick: function () { setPause(node.hostname, null); } })
					])
				])
			]);
		});

		var note = el('div', { cls: 'note info' }, [
			'A control write is replicated, and each node applies it on its own status sync — ' +
			'expect up to ' + duration(data.intervals.statusSyncInterval) + ' before a remote node stops claiming. ' +
			'"Status" is what each node last observed, not the intent.'
		]);

		return el('div', { cls: 'panel' }, [
			el('h2', { text: 'Queue control' }),
			clusterRow,
			note,
			el('div', { cls: 'scroll' }, [
				el('table', null, [
					el('thead', null, [el('tr', null, [
						el('th', { text: 'Node' }), el('th', { text: 'Observed status' }),
						el('th', { text: 'Last report' }), el('th', { text: 'Intent' }), el('th', { text: 'Actions' })
					])]),
					el('tbody', null, rows.length ? rows : [
						el('tr', null, [el('td', { colspan: '5', cls: 'muted',
							text: 'No nodes have reported queue status yet.' })])
					])
				])
			])
		]);
	}

	function renderHistogram(data) {
		var buckets = data.histogram.buckets || [];
		var max = buckets.reduce(function (acc, bucket) { return Math.max(acc, bucket.count); }, 0);

		var cols = buckets.map(function (bucket) {
			var height = max ? Math.max(1, Math.round((bucket.count / max) * 100)) : 0;
			var bar = el('div', { cls: 'bar', title: bucket.count + ' due in hour +' + bucket.hour });
			bar.style.height = height + '%';
			return el('div', { cls: 'col' }, [bar]);
		});

		var labels = buckets.map(function (bucket) {
			return el('div', { text: bucket.hour % 3 === 0 ? '+' + bucket.hour + 'h' : '' });
		});

		var children = [
			el('h2', { text: 'Renders due — next 24h' })
		];

		if (data.histogram.truncated) {
			children.push(el('div', { cls: 'note' }, [
				'The scan hit its ' + num(data.backlog.cap) + '-row cap on the overdue backlog, so this ' +
				'distribution is incomplete. Clear the backlog (or raise management.scanCap) to see the shape.'
			]));
		} else if (max === 0) {
			children.push(el('div', { cls: 'note ok' }, ['Nothing is due in the next 24 hours.']));
		}

		children.push(el('div', { cls: 'chart' }, cols));
		children.push(el('div', { cls: 'chart-labels' }, labels));
		children.push(el('p', { cls: 'muted', text:
			'A flat spread means the initial-render jitter is working. A single tall spike is a render herd — ' +
			'every target in that hour comes due at once.' }));

		return el('div', { cls: 'panel' }, children);
	}

	function setPause(scope, paused) {
		state.busy = true;
		state.error = null;
		render();
		post('queue', { scope: scope, paused: paused }).then(function (res) {
			state.busy = false;
			if (!res.ok) {
				state.error = res.body.error || 'Failed to apply queue control';
				render();
				return;
			}
			load();
		});
	}

	// ---- URL explainer ----

	function renderExplain() {
		var saved = state.explainInput || { url: '', deviceType: '' };
		var url = el('input', { type: 'text', value: saved.url, placeholder: 'https://www.example.com/catalog/x.jsp?CN=a',
			style: { flex: '1', minWidth: '260px' } });
		var device = el('select');
		['', 'desktop', 'mobile', 'tablet'].forEach(function (option) {
			device.appendChild(el('option', { value: option, text: option || '(default)',
				selected: option === saved.deviceType ? 'selected' : null }));
		});
		var button = el('button', { cls: 'primary', text: 'Explain' });

		function submit() {
			state.explainInput = { url: url.value, deviceType: device.value };
			button.disabled = true;
			post('explain', { url: url.value, deviceType: device.value || undefined }).then(function (res) {
				button.disabled = false;
				state.explain = res;
				render();
			});
		}

		button.addEventListener('click', submit);
		url.addEventListener('keydown', function (event) { if (event.key === 'Enter') submit(); });

		var panels = [el('div', { cls: 'panel' }, [
			el('h2', { text: 'Explain a URL' }),
			el('div', { cls: 'toolbar' }, [url, device, button]),
			el('p', { cls: 'muted', text:
				'Shows the cache key this URL resolves to and the live rows stored under it — ' +
				'the fastest way to explain a page that never seems to hit cache.' })
		])];

		if (state.explain) {
			if (!state.explain.ok) {
				panels.push(el('div', { cls: 'panel' }, [
					el('div', { cls: 'note bad', text: state.explain.body.error || 'Explain failed' })
				]));
			} else {
				panels.push(renderExplainResult(state.explain.body));
			}
		}

		return el('div', null, panels);
	}

	// Did this row's read time out? A row that could not be read is UNKNOWN, and must never be
	// rendered with the same wording as a row that was read and found absent — that turns a
	// degraded response into a confident false negative ("not scheduled", "no cached page"),
	// which is exactly the wrong thing to hand someone debugging a missing page.
	function timedOut(data, name) {
		return !!(data.degraded && data.degraded.timedOutReads.indexOf(name) !== -1);
	}

	function emptyState(data, name, absentText) {
		return el('p', {
			cls: 'muted',
			text: timedOut(data, name) ? 'Read timed out — status unknown, not necessarily absent.' : absentText
		});
	}

	function renderExplainResult(data) {
		var notes = [];

		if (data.underGlobalAllowlist.differs) {
			notes.push(el('div', { cls: 'note' }, [
				'This URL keys differently under the matched route allowlist (' +
				data.allowlist.used.join(', ') + ') than under the global url.queryParams (' +
				data.underGlobalAllowlist.allowlist.join(', ') + '). That difference is the usual cause of a ' +
				'permanent cache miss — check that the route is present and ordered correctly.'
			]));
		}
		if (data.ingress.matchedRoute === false) {
			notes.push(el('div', { cls: 'note' }, [
				'No ingress route matched this path, so all query params are kept and the page is proxied ' +
				'but never cached. Add a route for it if it should be prerendered.'
			]));
		}
		if (data.verdict.suppressedByNonIndexable) {
			notes.push(el('div', { cls: 'note bad' }, [
				'A NonIndexable row suppresses this URL: a render judged it non-indexable, which deleted its ' +
				'render target and blocks re-discovery until the row expires. If that verdict was wrong, this ' +
				'page is silently out of SEO rotation.'
			]));
		}
		if (data.eligibility.excluded) {
			notes.push(el('div', { cls: 'note' }, [
				'Matches excludePathPatterns (' + data.eligibility.excludedBy.join(', ') +
				') — proxied, never scheduled for rendering.'
			]));
		}
		if (!data.eligibility.domainAllowed) {
			notes.push(el('div', { cls: 'note' }, [
				'Host is outside the domains allowlist — it will be rendered but force-marked non-indexable.'
			]));
		}
		if (data.resolved.deviceTypeFellBack) {
			notes.push(el('div', { cls: 'note' }, [
				'The requested device type is not in deviceTypes.supported and fell back to "' +
				data.resolved.deviceType + '".'
			]));
		}
		if (data.degraded) {
			notes.push(el('div', { cls: 'note bad' }, [
				'These reads timed out and are shown as empty: ' + data.degraded.timedOutReads.join(', ') +
				'. Treat those rows as unknown, not absent.'
			]));
		}
		if (data.residency && !data.residency.scheduleReadIsAuthoritative) {
			notes.push(el('div', { cls: 'note info' }, [
				'RenderSchedule rows are pinned to the node owning the URL, and this node (' +
				data.residency.queriedNode + ') is not the owner — ' + data.residency.scheduleOwnedBy +
				' is. The schedule row below is read locally, so an absent one means "not scheduled ' +
				'on this node", not "not scheduled". Ask ' + data.residency.scheduleOwnedBy +
				' for the authoritative answer.'
			]));
		}

		var page = data.rows.prerenderedPage;
		var schedule = data.rows.renderSchedule;
		var target = data.rows.renderTarget;

		var sections = [
			el('div', { cls: 'panel' }, [
				el('h2', { text: 'Resolved key' })
			].concat(notes).concat([
				kv([
					['Cache key', el('code', { text: data.resolved.cacheKey })],
					['Canonical URL', el('code', { text: data.resolved.canonicalUrl })],
					['Device type', data.resolved.deviceType],
					['Ingress mode', data.ingress.mode],
					['Query allowlist', el('span', null, [
						el('code', { text: '[' + data.allowlist.used.join(', ') + ']' }),
						el('span', { cls: 'muted', text: '  ' + data.allowlist.source })
					])],
					data.ingress.route
						? ['Matched route', el('code', { text: data.ingress.route.match + ' ' + data.ingress.route.path })]
						: null
				])
			])),

			el('div', { cls: 'panel' }, [
				el('h2', { text: 'What a bot would get now' }),
				el('div', { cls: 'toolbar' }, [
					// A timed-out read must never render as a confident verdict: an unread page row
					// is "unknown", not "miss".
					timedOut(data, 'prerenderedPage')
						? el('span', { cls: 'badge mute', text: 'unknown — cache read timed out' })
						: page && page.fresh
							? el('span', { cls: 'badge ok', text: 'cache hit' })
							: el('span', { cls: 'badge warn', text: page ? 'stale — origin or render' : 'miss — origin or render' }),
					page && page.inStaleWhileRevalidate
						? el('span', { cls: 'badge mute', text: 'serving stale-while-revalidate' })
						: null,
					timedOut(data, 'renderTarget')
						? el('span', { cls: 'badge mute', text: 'unknown — target read timed out' })
						: data.verdict.recurring
							? el('span', { cls: 'badge ok', text: 'recurring target' })
							: el('span', { cls: 'badge warn', text: 'no render target' })
				])
			]),

			el('div', { cls: 'panel' }, [
				el('h2', { text: 'Stored rows' }),
				el('h3', { cls: 'muted', text: 'PrerenderedPage' }),
				page ? kv([
					['Status code', page.statusCode],
					['Last cached', ago(page.lastCached)],
					['Expires', page.expiresAt ? ago(page.expiresAt) : '—'],
					['Fresh', boolBadge(!page.fresh, 'no', 'yes')],
					['Indexable', page.isIndexable === null ? 'unknown' : String(page.isIndexable)]
				]) : emptyState(data, 'prerenderedPage', 'No cached page under this key.'),

				el('h3', { cls: 'muted', text: 'RenderSchedule' }),
				schedule ? kv([
					['Next render', (schedule.overdue ? 'overdue by ' : 'in ') + duration(schedule.dueInMs)],
					['From sitemap', String(!!schedule.fromSitemap)]
				]) : emptyState(data, 'renderSchedule', data.residency && !data.residency.scheduleReadIsAuthoritative
					? 'No schedule row on this node — inconclusive, since ' + data.residency.scheduleOwnedBy + ' owns it.'
					: 'Not scheduled — nothing will render this URL.'),

				el('h3', { cls: 'muted', text: 'RenderTarget' }),
				target ? kv([
					['Sitemap', target.sitemapUrl || '—'],
					['Scheduler node', target.schedulerNode || '—'],
					['Render interval', target.renderInterval ? duration(Number(target.renderInterval)) : 'default']
				]) : emptyState(data, 'renderTarget', 'No target — not in the recurring rotation.')
			])
		];

		return el('div', null, sections);
	}

	// ---- config ----

	function renderConfig() {
		var data = state.config;
		if (!data) return el('div', { cls: 'panel' }, [el('p', { cls: 'muted', text: 'Loading…' })]);

		var warnings = (data.warnings || []).map(function (warning) {
			return el('div', { cls: 'note ' + (warning.severity === 'warn' ? '' : 'info') }, [
				el('strong', { text: warning.key + ': ' }), warning.message
			]);
		});

		return el('div', null, [
			el('div', { cls: 'panel' }, [
				el('h2', { text: 'Warnings' }),
				warnings.length ? el('div', null, warnings)
					: el('div', { cls: 'note ok', text: 'No configuration warnings.' })
			]),
			el('div', { cls: 'panel' }, [
				el('h2', { text: 'Effective config' }),
				el('p', { cls: 'muted', text:
					'The live merge of defaults and host overrides on ' + data.node + ' (worker ' + data.workerIndex +
					'). Secrets show only whether they are set.' }),
				el('pre', { text: JSON.stringify(data.config, null, 2) })
			])
		]);
	}

	// ---- loading ----

	function load() {
		state.busy = true;
		api('session').then(function (res) {
			state.session = res.body;
			if (!res.body.authenticated || !res.body.superUser) { state.busy = false; render(); return; }

			var pending = state.view === 'config' ? api('config') : state.view === 'overview' ? api('overview') : null;
			if (!pending) { state.busy = false; render(); return; }

			pending.then(function (data) {
				state.busy = false;
				if (data.status === 401 || data.status === 403) { state.session = { authenticated: false }; render(); return; }
				if (state.view === 'config') state.config = data.body;
				else state.overview = data.body;
				render();
			});
		});
		render();
	}

	load();
})();
</script>
`;

export const renderAdminPage = () => PAGE;
