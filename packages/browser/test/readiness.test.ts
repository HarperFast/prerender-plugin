import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';

// Readiness contracts: stop a render when the page says it is complete AND has gone quiet, instead
// of when a timer expires — and report which clauses held, so an incomplete render is a fact on the
// wire rather than a silence.
//
// Every test here pins a property that has already been violated in practice at least once:
//   - a clause must not be satisfiable by a document that has not parsed (measured: a contract
//     declared a page complete at 4ms and stored zero review nodes);
//   - "all islands hydrated" is vacuously true when there are no islands;
//   - a page that declares no reviews must not wait for them (measured: +385% wall);
//   - a clause that can never hold must stand aside rather than burn its whole timeout on every
//     render, because templates change;
//   - the quiet window, not the contract, is what protects content nothing can name.

let origin: http.Server;
let base = '';
// A second origin (same host, other port): "third-party" to pages served from `base`.
let third: http.Server;
let thirdBase = '';
// Responses deliberately left unanswered by `/hang`; destroyed in `after` so the server can close.
const hanging: http.ServerResponse[] = [];

const page = (body: string, head = '') =>
	`<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

before(async () => {
	origin = http.createServer((req, res) => {
		const path = (req.url ?? '').split('?')[0];
		res.setHeader('content-type', 'text/html');
		switch (path) {
			// Content that arrives late, so a contract naming it must actually wait.
			case '/late':
				return res.end(
					page(
						'<div id="host"></div>',
						`<script>setTimeout(() => { document.getElementById('host').innerHTML =
							'<div class="item">a</div><div class="item">b</div>'; }, 300);</script>`
					)
				);
			// A page that satisfies its contract at once and then never stops changing: a ticker appends
			// elements past any sane tolerance for as long as the page lives.
			case '/churn':
				return res.end(
					page(
						'<div class="item">a</div><div class="item">b</div><div id="ticker"></div>',
						`<script>setInterval(() => { const t = document.getElementById('ticker'); if (!t) return;
							for (let i = 0; i < 20; i++) t.appendChild(document.createElement('span')); }, 40);</script>`
					)
				);
			// Content that lands LATE — after any sane contract timeout — so the contract must give up and
			// the fallback settle is what actually captures it.
			case '/late-rails':
				return res.end(
					page(
						'<div id="host"></div>',
						`<script>setTimeout(() => { document.getElementById('host').innerHTML =
							'<i class="rail">a</i><i class="rail">b</i><i class="rail">c</i>'; }, 1200);</script>`
					)
				);
			// A page that is QUIET but not FINISHED: it holds a same-origin request open while a required
			// clause is still false. This is the shape of a CPU-starved commerce page.
			case '/hang':
				hanging.push(res);
				return; // deliberately never answered within the test
			case '/quiet-but-fetching':
				return res.end(page('<p>started</p>', `<script>fetch('/hang');</script>`));
			// Islands that shed their marker on "hydration", plus one that never does.
			case '/islands':
				return res.end(
					page(
						'<my-island ssr></my-island><my-island ssr></my-island><my-island ssr id="stuck"></my-island>',
						`<script>setTimeout(() => { for (const el of document.querySelectorAll('my-island:not(#stuck)'))
							el.removeAttribute('ssr'); }, 200);</script>`
					)
				);
			case '/no-islands':
				return res.end(page('<p>nothing to hydrate</p>'));
			// A page whose structured data declares reviews, and one that declares none.
			case '/declares-reviews':
				return res.end(
					page(
						'<div id="widget"></div>',
						`<script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingCount":12}}</script>
						 <script>setTimeout(() => { document.getElementById('widget').innerHTML =
							'<div class="review">r</div>'; }, 250);</script>`
					)
				);
			case '/declares-none':
				return res.end(
					page('<div id="widget"></div>', '<script type="application/ld+json">{"@type":"Product","name":"x"}</script>')
				);
			// Containers that are all filled, and a page with none at all.
			case '/rails':
				return res.end(page('<div class="rail"><span class="slide">1</span></div>'));
			case '/no-rails':
				return res.end(page('<p>none</p>'));
			// A grid with products, and one that is legitimately empty.
			case '/grid':
				return res.end(page('<div class="grid"><div class="tile"><img src="/x.png"></div></div>'));
			case '/grid-empty':
				return res.end(page('<div class="grid"></div><p class="no-results">nothing</p>'));
			// Content in two waves: one rail in the document, three more once a same-origin API answers.
			case '/two-waves':
				return res.end(
					page(
						'<div class="rail"><span class="slide">1</span></div><div id="more"></div>',
						`<script>setTimeout(() => { fetch('/slow-json').then((r) => r.json()).then(() => {
							document.getElementById('more').innerHTML =
								'<div class="rail"><span class="slide">2</span></div><div class="rail"><span class="slide">3</span></div>'; }); }, 100);</script>`
					)
				);
			case '/slow-json':
				setTimeout(() => {
					res.setHeader('content-type', 'application/json');
					res.end('{"ok":true}');
				}, 700);
				return;
			// The content is added by a THIRD-PARTY script that is slow to arrive: nothing same-origin is
			// in flight, the DOM is quiet, and the document has not loaded.
			case '/third-party-late':
				return res.end(page('<p>ok</p>', `<script async src="${thirdBase}/slow.js"></script>`));
			// Hydration that starts, pauses, then finishes — the shape of a starved idle callback.
			case '/islands-paused':
				return res.end(
					page(
						'<my-island ssr></my-island><my-island ssr></my-island><my-island ssr id="late"></my-island>',
						`<script>setTimeout(() => { for (const el of document.querySelectorAll('my-island:not(#late)'))
							el.removeAttribute('ssr'); }, 150);
						setTimeout(() => document.getElementById('late').removeAttribute('ssr'), 1200);</script>`
					)
				);
			// A main thread that is never idle: a MessageChannel loop keeps a task queued for 3s, and the
			// content hydrates in a requestIdleCallback with no timeout.
			case '/idle-starved':
				return res.end(
					page(
						'<div id="host"></div>',
						`<script>
							requestIdleCallback(() => { document.getElementById('host').innerHTML = '<div class="hydrated">h</div>'; });
							const until = Date.now() + 3000;
							const ch = new MessageChannel();
							ch.port1.onmessage = () => { const end = Date.now() + 30; while (Date.now() < end) {} if (Date.now() < until) ch.port2.postMessage(0); };
							ch.port2.postMessage(0);
						</script>`
					)
				);
			// A script at a randomised-looking path that would add `.junk`, and one at a stable path that
			// adds `.keep`; only a regex can name the first.
			case '/regex-block':
				// Scripts at the end of BODY, so `document.body` exists when they run.
				return res.end(page('<p>ok</p><script src="/a1b2c3/xlqcP1U7"></script><script src="/keep.js"></script>'));
			case '/a1b2c3/xlqcP1U7':
			case '/keep.js': {
				res.setHeader('content-type', 'application/javascript');
				const cls = path === '/keep.js' ? 'keep' : 'junk';
				return res.end(`document.body.insertAdjacentHTML('beforeend', '<div class="${cls}">x</div>');`);
			}
			default:
				return res.end(page('<p>ok</p>'));
		}
	});
	await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

	third = http.createServer((req, res) => {
		res.setHeader('content-type', 'application/javascript');
		// Slow to arrive, and the only thing that produces the content the contract names.
		setTimeout(() => res.end(`document.body.insertAdjacentHTML('beforeend', '<div class="late">x</div>');`), 700);
	});
	await new Promise<void>((resolve) => third.listen(0, '127.0.0.1', resolve));
	thirdBase = `http://127.0.0.1:${(third.address() as AddressInfo).port}`;
});

after(() => {
	for (const res of hanging) res.destroy();
	origin.close();
	third.close();
});

const render = async (
	path: string,
	contract: Record<string, unknown>,
	extra: Record<string, unknown> = {},
	navigation: Record<string, unknown> = {}
) => {
	const result = await renderOnce({
		url: `${base}${path}`,
		captureNonIndexable: true,
		config: {
			navigation: {
				networkIdleMs: 50,
				networkIdleTimeoutMs: 200,
				domStableMs: 0,
				domStableTimeoutMs: 500,
				...navigation,
			},
			scroll: { enabled: false },
			readiness: { onSatisfied: 'quiet', quietMs: 100, contracts: [contract], ...extra },
		} as never,
	});
	return result;
};

test('a contract holds the render until the content it names arrives', async () => {
	const result = await render('/late', {
		name: 'late',
		require: [{ name: 'items', selector: '.item', minCount: 2 }],
		timeoutMs: 5000,
	});
	assert.equal(result.job.readiness?.satisfied, true);
	assert.match(result.html ?? '', /class="item"/);
	// It cannot have been satisfied before the content existed.
	assert.ok((result.job.readiness?.firstSatisfiedMs ?? 0) >= 200, 'must not report success before the content landed');
});

test('a clause is not satisfiable by a document that has not parsed', async () => {
	// `absent` is the shape that fails this way: nothing matches an empty document, so the clause is
	// trivially true before the page exists — and the page is quiet for the same reason.
	const result = await render('/late', {
		name: 'absent-only',
		require: [
			{ name: 'no-skeletons', absent: '.skeleton' },
			{ name: 'items', selector: '.item', minCount: 2 },
		],
		timeoutMs: 5000,
	});
	assert.equal(result.job.readiness?.satisfied, true);
	assert.match(result.html ?? '', /class="item"/, 'the late content still had to arrive');
});

test('"every island hydrated" requires islands to exist, and honours maxRemaining', async () => {
	// One island never sheds its marker, so the strict form can never hold.
	const strict = await render('/islands', {
		name: 'strict',
		require: [{ name: 'hydrated', selector: 'my-island', shed: 'ssr' }],
		timeoutMs: 1200,
	});
	assert.equal(strict.job.readiness?.satisfied, false);
	assert.equal(strict.job.readiness?.require.find((r) => r.name === 'hydrated')?.count, 1);

	const tolerant = await render('/islands', {
		name: 'tolerant',
		require: [{ name: 'hydrated', selector: 'my-island', shed: 'ssr', maxRemaining: 1 }],
		timeoutMs: 5000,
	});
	assert.equal(tolerant.job.readiness?.satisfied, true);

	// A page with NO islands: vacuously "all hydrated", which is what an unparsed document looks like.
	const none = await render('/no-islands', {
		name: 'none',
		require: [{ name: 'hydrated', selector: 'my-island', shed: 'ssr' }],
		timeoutMs: 800,
	});
	assert.equal(none.job.readiness?.satisfied, false, 'no islands must not read as fully hydrated');

	const allowed = await render('/no-islands', {
		name: 'allowed',
		require: [{ name: 'hydrated', selector: 'my-island', shed: 'ssr', allowNone: true }],
		timeoutMs: 5000,
	});
	assert.equal(allowed.job.readiness?.satisfied, true);
});

test('a guarded clause applies only when the page declares the content', async () => {
	const declared = await render('/declares-reviews', {
		name: 'declared',
		require: [
			{
				name: 'reviews',
				selector: '.review',
				minCount: 1,
				onlyIf: { jsonLdNumber: 'aggregateRating.ratingCount', atLeast: 1 },
			},
		],
		timeoutMs: 5000,
	});
	assert.equal(declared.job.readiness?.satisfied, true);
	assert.equal(declared.job.readiness?.require[0].skipped, undefined, 'the page declared 12, so it was checked');
	assert.ok((declared.job.readiness?.firstSatisfiedMs ?? 0) >= 200, 'and it waited for them');

	// The same contract on a page whose structured data carries no such field: the page is saying
	// there are none. Measured on a live product page, failing this instead cost +385% wall.
	const none = await render('/declares-none', {
		name: 'undeclared',
		require: [
			{
				name: 'reviews',
				selector: '.review',
				minCount: 1,
				onlyIf: { jsonLdNumber: 'aggregateRating.ratingCount', atLeast: 1 },
			},
		],
		timeoutMs: 5000,
	});
	assert.equal(none.job.readiness?.satisfied, true);
	assert.equal(none.job.readiness?.require[0].skipped, true, 'skipped, and reported as skipped rather than passed');
});

test('a DOM-guarded clause stands aside when the page has none of the thing', async () => {
	const empty = await render('/grid-empty', {
		name: 'empty-grid',
		require: [
			{ name: 'grid-or-zero', anyOf: [{ selector: '.tile', minCount: 1 }, { selector: '.no-results' }] },
			{ name: 'tiles-imaged', every: '.tile', contains: 'img', onlyIf: { present: '.tile', atLeast: 1 } },
		],
		timeoutMs: 5000,
	});
	assert.equal(empty.job.readiness?.satisfied, true);
	assert.equal(empty.job.readiness?.require.find((r) => r.name === 'tiles-imaged')?.skipped, true);

	const populated = await render('/grid', {
		name: 'grid',
		require: [{ name: 'tiles-imaged', every: '.tile', contains: 'img', onlyIf: { present: '.tile', atLeast: 1 } }],
		timeoutMs: 5000,
	});
	assert.equal(populated.job.readiness?.satisfied, true);
	assert.equal(populated.job.readiness?.require[0].skipped, undefined, 'a populated grid IS checked');
});

test('"every container is filled" is not satisfied by having no containers', async () => {
	const none = await render('/no-rails', {
		name: 'rails',
		require: [{ name: 'rails', every: '.rail', contains: '.slide' }],
		timeoutMs: 800,
	});
	assert.equal(none.job.readiness?.satisfied, false, 'zero of zero filled is true and means nothing');

	const filled = await render('/rails', {
		name: 'rails',
		require: [{ name: 'rails', every: '.rail', contains: '.slide' }],
		timeoutMs: 5000,
	});
	assert.equal(filled.job.readiness?.satisfied, true);
});

test('a clause that can never hold stands aside instead of burning the whole timeout', async () => {
	// THE ROT VALVE. A renamed class makes a clause permanently false; without this the contract waits
	// out `timeoutMs` on every render of the page type, for as long as nobody notices.
	const started = Date.now();
	const result = await render(
		'/no-islands',
		{
			name: 'rotted',
			require: [
				{ name: 'fine', selector: 'p', minCount: 1 },
				{ name: 'renamed-away', selector: '.this-class-no-longer-exists', minCount: 1 },
			],
			timeoutMs: 20000,
		},
		{ unmetGraceMs: 300 }
	);
	const waited = Date.now() - started;

	assert.equal(result.job.readiness?.satisfied, false, 'and it is reported as unsatisfied');
	assert.equal(result.job.readiness?.require.find((r) => r.name === 'renamed-away')?.ok, false);
	assert.ok(waited < 10000, `gave up in ${waited}ms rather than waiting out the 20s timeout`);
	assert.ok(result.html, 'the render still produced content — a rotted contract costs time, never content');
});

test('the render still serializes when a contract is never satisfied', async () => {
	const result = await render('/no-islands', {
		name: 'impossible',
		require: [{ name: 'nope', selector: '#absent', minCount: 1 }],
		timeoutMs: 700,
	});
	assert.equal(result.job.readiness?.satisfied, false);
	assert.match(result.html ?? '', /nothing to hydrate/);
});

test('report mode reports the verdict and changes nothing about the render', async () => {
	// The rollout mode. A contract naming content that never arrives must NOT hold the render — the
	// whole point is that the timeout can be chosen from the fleet's own distribution later, at no
	// risk now.
	const gated = await render('/no-islands', {
		name: 'impossible',
		require: [{ name: 'nope', selector: '#absent', minCount: 1 }],
		timeoutMs: 3000,
	});

	const started = Date.now();
	const reported = await render(
		'/no-islands',
		{ name: 'impossible', require: [{ name: 'nope', selector: '#absent', minCount: 1 }], timeoutMs: 3000 },
		{ onSatisfied: 'report' }
	);
	const reportedMs = Date.now() - started;

	// Both know the contract did not hold, and name the clause.
	assert.equal(gated.job.readiness?.satisfied, false);
	assert.equal(reported.job.readiness?.satisfied, false);
	assert.equal(reported.job.readiness?.require[0].name, 'nope');
	// But report mode did not spend the contract's wait on it.
	assert.ok(
		reportedMs < (gated.renderTimeMs ?? 3000) + 1500,
		`report mode must not gate: took ${reportedMs}ms against a gated ${gated.renderTimeMs}ms`
	);
	assert.match(reported.html ?? '', /nothing to hydrate/);
});

test('report mode still times how long a satisfiable contract took to hold', async () => {
	// This is the number the gate's timeoutMs is meant to be tuned from, so it has to survive the
	// mode that exists to collect it. The settle is given enough room to reach the late content ON
	// ITS OWN — report mode must not extend it, so a settle that ends first would (correctly) report
	// the render as incomplete, which is a different test.
	const result = await render(
		'/late',
		{ name: 'late', require: [{ name: 'items', selector: '.item', minCount: 2 }], timeoutMs: 5000 },
		{ onSatisfied: 'report' },
		{ domStableMs: 300, domStableTimeoutMs: 3000 }
	);
	assert.equal(result.job.readiness?.satisfied, true);
	assert.ok(
		(result.job.readiness?.firstSatisfiedMs ?? 0) >= 200,
		'it must report WHEN the content arrived, not merely that it did'
	);
});

test('the stop waits for a request the page has open to its own origin', async () => {
	// Content arrives in waves. After the first rail the contract holds and the DOM is quiet, but the
	// page has a same-origin fetch in flight whose answer adds two more rails. Measured on a live
	// product page: one rail stored out of four. The stop must hold while that request is young.
	const result = await render('/two-waves', {
		name: 'rails',
		require: [{ name: 'rails-filled', every: '.rail', contains: '.slide' }],
		timeoutMs: 5000,
	});
	const rails = (result.html ?? '').match(/class="rail"/g)?.length ?? 0;
	assert.equal(rails, 3, `all three rails were serialized (got ${rails})`);
	assert.equal(result.job.readiness?.stopped, true, 'and the contract, not a timer, ended the render');
	assert.ok(
		(result.job.readiness?.waitedMs ?? 0) >= 600,
		`held through the fetch (${result.job.readiness?.waitedMs}ms)`
	);
});

test('the rot valve does not stand a clause aside before the document has loaded', async () => {
	// Nothing same-origin is in flight, the DOM is quiet, and the clause has never been true — every
	// signal the valve used to read as rot. But a third-party script the document itself named has not
	// arrived yet, so the page is not done; `load` has not fired.
	const result = await render(
		'/third-party-late',
		{ name: 'late', require: [{ name: 'late', selector: '.late', minCount: 1 }], timeoutMs: 5000 },
		{ unmetGraceMs: 200 }
	);
	assert.equal(result.job.readiness?.satisfied, true, 'the clause held once the script ran');
	assert.equal(result.job.readiness?.stopped, true);
	assert.ok((result.job.readiness?.waitedMs ?? 0) >= 500, `waited for load (${result.job.readiness?.waitedMs}ms)`);
});

test('the rot valve does not stand a hydration clause aside while hydration is in progress', async () => {
	// Two of three islands shed the marker, then nothing for a second: an attribute change the DOM
	// monitor cannot see, so the page reads as quiet. A count that has fallen and not reached its
	// target is hydration mid-way, not rot — measured as 11 of 27 islands left for 8 s on a starved page.
	const result = await render(
		'/islands-paused',
		{ name: 'hydrated', require: [{ name: 'hydrated', selector: 'my-island', shed: 'ssr' }], timeoutMs: 5000 },
		{ unmetGraceMs: 200 }
	);
	assert.equal(result.job.readiness?.satisfied, true, 'the last island hydrated and the clause held');
	assert.equal(result.job.readiness?.stopped, true);
	assert.ok(
		(result.job.readiness?.waitedMs ?? 0) >= 1000,
		`waited through the pause (${result.job.readiness?.waitedMs}ms)`
	);
});

test('a capped requestIdleCallback fires on a main thread that is never idle', async () => {
	// The page hydrates in an idle callback with no timeout while a task is always queued. With the cap
	// the browser runs the callback as an ordinary task once the cap elapses; the render then holds and
	// stops. This is the mechanism behind deferred islands that never hydrate on a saturated pod.
	const contract = {
		name: 'hydrated',
		require: [{ name: 'hydrated', selector: '.hydrated', minCount: 1 }],
		timeoutMs: 6000,
	};
	const capped = await render('/idle-starved', contract, {}, { idleCallbackTimeoutMs: 100 });
	assert.equal(capped.job.readiness?.satisfied, true, 'hydrated under the cap');
	assert.ok(
		(capped.job.readiness?.firstSatisfiedMs ?? Infinity) < 2000,
		`held well before the busy loop ended (${capped.job.readiness?.firstSatisfiedMs}ms)`
	);
	assert.match(capped.html ?? '', /class="hydrated"/);
});

test('a block pattern may be a regular expression, honoured by interception and the strip alike', async () => {
	const junkPath = '/a1b2c3/xlqcP1U7';
	const result = await renderOnce({
		url: `${base}/regex-block`,
		captureNonIndexable: true,
		config: {
			navigation: { networkIdleMs: 50, networkIdleTimeoutMs: 200, domStableMs: 0, domStableTimeoutMs: 300 },
			scroll: { enabled: false },
			block: { urlPatterns: ['re:/[a-z0-9]{6}/[A-Za-z0-9]{8}$'] },
			postProcess: { stripScripts: false, stripBlockedResources: true },
		} as never,
	});
	const html = result.html ?? '';
	assert.match(html, /class="keep"/, 'the stable script ran');
	assert.doesNotMatch(html, /class="junk"/, 'the regex-matched script was aborted');
	assert.ok(!html.includes(junkPath), 'and its element was stripped from the output');
	assert.match(html, /keep\.js/, 'while the other script element stayed');
});

test('an invalid regular expression in block.urlPatterns is rejected at config load', async () => {
	await assert.rejects(
		renderOnce({ url: `${base}/no-islands`, config: { block: { urlPatterns: ['re:('] } } as never }),
		/urlPatterns/
	);
});

test('a contract with an unusable number or pattern is rejected at config load', async () => {
	// A NaN or negative timeout makes the gate's deadline NaN, the loop never runs, and the contract
	// is silently disabled — a config that looks enabled and protects nothing, which is the worst of
	// the available outcomes. Same rule `waitFor` already applies to its numerics.
	const { mergeConfig } = await import('../dist/config.js');
	const contract = (over: Record<string, unknown>) => ({
		readiness: {
			onSatisfied: 'quiet',
			contracts: [{ name: 'c', require: [{ name: 'x', selector: 'p' }], ...over }],
		},
	});

	assert.throws(() => mergeConfig(contract({ timeoutMs: Number.NaN }) as never), /timeoutMs must be a non-negative/);
	assert.throws(() => mergeConfig(contract({ quietMs: -1 }) as never), /quietMs must be a non-negative/);
	assert.throws(() => mergeConfig(contract({ pollMs: 'soon' }) as never), /pollMs must be a positive/);
	// A zero poll interval is a tight loop calling into the page as fast as the event loop allows.
	assert.throws(() => mergeConfig(contract({ pollMs: 0 }) as never), /pollMs must be a positive/);
	// Past the timer ceiling setTimeout fires after 1ms, so an over-large dwell becomes NO dwell —
	// the same trap `scroll.topSettleMs` already guards against.
	assert.throws(() => mergeConfig(contract({ timeoutMs: 2147483648 }) as never), /up to 2147483647/);
	assert.doesNotThrow(() => mergeConfig(contract({ timeoutMs: 5000, quietMs: 250, pollMs: 250 }) as never));

	// The top-level knobs and the expectation policy are validated too — every one of them ends up in
	// a setTimeout or a comparison that silently does nothing when it is wrong.
	const top = (over: Record<string, unknown>) => ({
		readiness: { onSatisfied: 'quiet', contracts: [{ name: 'c', require: [{ name: 'x', selector: 'p' }] }], ...over },
	});
	assert.throws(() => mergeConfig(top({ quietMs: -5 }) as never), /readiness.quietMs/);
	assert.throws(() => mergeConfig(top({ unmetGraceMs: 2147483648 }) as never), /readiness.unmetGraceMs/);
	assert.throws(() => mergeConfig(top({ expectations: { tolerance: 1.5 } }) as never), /tolerance must be a number/);
	assert.throws(
		() => mergeConfig(top({ expectations: { rebaselineAfter: 0 } }) as never),
		/rebaselineAfter must be a positive integer/
	);
	assert.doesNotThrow(() =>
		mergeConfig(
			top({ quietMs: 250, unmetGraceMs: 1000, expectations: { tolerance: 0.5, rebaselineAfter: 3 } }) as never
		)
	);

	// A malformed regex used to fail only at evaluation time, where it threw out of the whole
	// evaluator and discarded every other clause's result for that tick.
	assert.throws(
		() =>
			mergeConfig({
				readiness: {
					onSatisfied: 'quiet',
					contracts: [{ name: 'c', require: [{ name: 'x', selector: 'p', nonEmptyText: true, textMatches: '([' }] }],
				},
			} as never),
		/invalid textMatches/
	);

	assert.throws(
		() =>
			mergeConfig({
				readiness: {
					onSatisfied: 'quiet',
					contracts: [{ name: 'c', require: [{ name: 'x', selector: 'p', minCount: -3 }] }],
				},
			} as never),
		/minCount must be a non-negative/
	);
});

// The stop condition is "held AND quiet", and the deadline is the one exit that could quietly drop the
// second half: a page whose clauses all hold but that never stops changing runs the loop out, and
// `satisfied` (every clause held) is true. Treating that as a stop skipped the quiet window, the
// fallback settle, every `waitFor` gate and the final plateau — the stop-on-contract-alone behaviour
// measured to lose 99% of a product page's links. Reproduced on a live page with an unreachable
// `quietMs`: settle ended at exactly the timeout and no gate ran.
test('a contract that holds but never sees the page go quiet falls back to the ordinary settle', async () => {
	const result = await renderOnce({
		url: `${base}/churn`,
		captureNonIndexable: true,
		config: {
			navigation: {
				networkIdleMs: 50,
				networkIdleTimeoutMs: 200,
				domStableMs: 0,
				domStableTimeoutMs: 500,
				domStableTolerance: 5,
			},
			scroll: { enabled: false },
			// The witness: a gate the fallback settle runs and a contract stop skips.
			waitFor: [{ name: 'witness', selector: '.item', minCount: 1, timeoutMs: 500, scrollIntoView: false }],
			readiness: {
				onSatisfied: 'quiet',
				quietMs: 100,
				contracts: [{ name: 'churn', require: [{ name: 'items', selector: '.item', minCount: 2 }], timeoutMs: 600 }],
			},
		} as never,
	});
	assert.equal(
		result.waitForResults.map((g) => g.name).join(),
		'witness',
		'the ordinary settle, gates included, must have run — the contract never saw the page quiet'
	);
	const readiness = result.job.readiness;
	assert.equal(readiness?.satisfied, true, 'every clause held the whole time, and the report says so');
	assert.equal(readiness?.stopped, false, 'but it did not stop the render');
	assert.ok((readiness?.waitedMs ?? 0) >= 600, `it waited out its timeout (waited ${readiness?.waitedMs}ms)`);
});

// The armed path used to report from the moment it GAVE UP, not from the DOM it serialized: the
// fallback settle, the gates and the final plateau all run after the contract's loop exits. Measured
// on the fleet, 14 of 14 product pages reported `product-links: 0` while the HTML actually stored for
// those pages carried 204-470 of them — and because `assessExpectations` skips an expectation of 0,
// seeding those zeros SILENTLY DISABLES the shortfall detector for the page.
test('an unsatisfied contract restates its verdict against the DOM that was serialized', async () => {
	const result = await renderOnce({
		url: `${base}/late-rails`,
		captureNonIndexable: true,
		config: {
			navigation: { networkIdleMs: 50, networkIdleTimeoutMs: 200, domStableMs: 0, domStableTimeoutMs: 500 },
			scroll: { enabled: false },
			// The fallback holds the render until the late content lands, exactly as a production gate does.
			waitFor: [{ name: 'rails-gate', selector: '.rail', minCount: 3, timeoutMs: 5000, scrollIntoView: false }],
			readiness: {
				onSatisfied: 'quiet',
				quietMs: 100,
				contracts: [
					{
						name: 'late',
						// 400ms: the contract cannot win, so it abandons and the fallback finishes the job.
						timeoutMs: 400,
						require: [{ name: 'rails', selector: '.rail', minCount: 3 }],
						observe: [{ name: 'rail-count', selector: '.rail' }],
					},
				],
			},
		} as never,
	});
	const readiness = result.job.readiness;
	assert.equal(readiness?.stopped, false, 'the contract did not stop this render');
	assert.equal(readiness?.satisfied, true, 'but the page WAS complete when it was serialized');
	assert.equal(
		readiness?.firstSatisfiedMs,
		null,
		'it never held inside the contract window — the tuning signal stays honest'
	);
	assert.equal(
		readiness?.learned?.['rail-count'],
		3,
		'the learned count must describe the stored page, not the abandoned one'
	);
	assert.match(result.html ?? '', /class="rail"/);
});

// The rot valve infers "this clause will never be true" from DOM quiet. A CPU-starved page is quiet
// because it has not STARTED, not because it has finished — measured on a contended pod, the valve
// stood the rails clause aside after ~1.1s while the API filling those rails had not yet been
// requested (it went out at 7.9-10.0s), and 2 of 3 renders then serialized without them.
test('the rot valve does not stand a clause aside while the page is still fetching from its own origin', async () => {
	const started = Date.now();
	const result = await renderOnce({
		url: `${base}/quiet-but-fetching`,
		captureNonIndexable: true,
		config: {
			navigation: { networkIdleMs: 50, networkIdleTimeoutMs: 200, domStableMs: 0, domStableTimeoutMs: 500 },
			scroll: { enabled: false },
			readiness: {
				onSatisfied: 'quiet',
				quietMs: 100,
				// Tiny grace: without the in-flight check the valve fires almost immediately.
				unmetGraceMs: 150,
				contracts: [
					{ name: 'starved', timeoutMs: 1500, require: [{ name: 'never', selector: '#never', minCount: 1 }] },
				],
			},
		} as never,
	});
	const readiness = result.job.readiness;
	assert.equal(readiness?.satisfied, false, 'the clause genuinely never holds');
	assert.ok(
		(readiness?.waitedMs ?? 0) >= 1400,
		`the contract must wait out its timeout while same-origin work is outstanding (waited ${readiness?.waitedMs}ms)`
	);
	assert.ok(Date.now() - started >= 1400);
});
