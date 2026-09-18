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
			default:
				return res.end(page('<p>ok</p>'));
		}
	});
	await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

after(() => origin.close());

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
