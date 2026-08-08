import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * "One concept, one home", enforced MECHANICALLY rather than by convention.
 *
 * The claim scan starts from a floor, and a schedule row written BELOW that floor is never read
 * again: the URL stops rendering forever and reports nothing (see util/reconcile.js's module
 * comment on how undiagnosable that state is). The only thing standing between the codebase and
 * that bug is that the due-time write and the floor lowering happen together — which is true only
 * as long as nothing writes the table directly. There were eight such call sites across five files
 * before this release, and "remember to lower the floor" is not an invariant sixteen call sites can
 * be trusted with.
 *
 * So it is a source scan, in the idiom of test/adminAssets.test.js. A regex is a blunt instrument,
 * but it fails at build time on the one mistake that would otherwise cost a silent outage.
 */

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

const sources = readdirSync(srcDir, { recursive: true })
	.map(String)
	.map((path) => path.replaceAll('\\', '/'))
	.filter((path) => path.endsWith('.js'))
	.map((path) => [path, readFileSync(`${srcDir}${path}`, 'utf8')]);

// The funnel. The ONLY module allowed to write the render queue.
const FUNNEL = 'util/renderSchedule.js';
// The backlog snapshot is allowed to READ (search) it, deliberately: it is the only scan that still
// seeks the absolute index minimum, which makes it the only detector of a below-floor row.
const SEARCH_ALLOWED = new Set([FUNNEL, 'util/backlogSnapshot.js']);

test('exactly one file writes RenderSchedule — the funnel', () => {
	const writer = /RenderSchedule\s*\.\s*(?:put|delete)\s*\(/;

	for (const [path, source] of sources) {
		if (path === FUNNEL) continue;
		assert.equal(
			writer.test(source),
			false,
			`${path} writes RenderSchedule directly. Route it through util/renderSchedule.js: a raw put files ` +
				`the row without lowering the claim floor, and a row below the floor is never claimed again — ` +
				`the URL stops rendering permanently, with no error and no metric to notice it by.`
		);
	}
});

test('only the funnel and the backlog snapshot search RenderSchedule', () => {
	const searcher = /RenderSchedule\s*\.\s*search\s*\(/;

	for (const [path, source] of sources) {
		if (SEARCH_ALLOWED.has(path)) continue;
		assert.equal(
			searcher.test(source),
			false,
			`${path} scans RenderSchedule. That index is the render queue's hot path — the claim scan is in ` +
				`util/renderSchedule.js and the only other permitted walk is the backlog snapshot.`
		);
	}
});

test('every RenderSchedule.get passes { replicateFrom: false }', () => {
	// An unowned point read on a residency-pinned table takes Harper's replication fetch, which has
	// NO TIMEOUT and can hang the caller forever. On a four-node cluster ~75% of keys are unowned, so
	// one call site missing this is a hang for three requests in four.
	const getCall = /RenderSchedule\s*\.\s*get\s*\(([\s\S]{0,400}?)\)\s*[;,)]/g;
	let checked = 0;

	for (const [path, source] of sources) {
		for (const [, args] of source.matchAll(getCall)) {
			checked++;
			assert.ok(
				args.includes('replicateFrom: false'),
				`a RenderSchedule.get in ${path} does not pass { replicateFrom: false }:\n${args.trim()}`
			);
		}
	}

	assert.ok(checked > 0, 'the regex matched nothing — it has drifted from the source and is asserting nothing');
});

test('no schedule write hardcodes fromSitemap: false — put REPLACES the record', () => {
	// The funnel makes `fromSitemap` REQUIRED, which caught the writes that omitted it. It cannot
	// catch the next mistake, which has now happened twice: satisfying the argument with a literal
	// `false`. `put` replaces the record, so that CLEARS the flag for a sitemap-listed URL; `claim`
	// then hands the renderer `isFromSitemap: false`, and the renderer skips serializing a
	// non-indexable sitemap-listed page — so one on-demand render quietly stops that page being
	// cached at all, with no error anywhere. Every writer must derive it from the live target
	// (`!!target.sitemapUrl`) or from the row it is rewriting.
	//
	// A genuinely targetless one-off (the render-now shape) reads `!!undefined` off an absent target,
	// which is `false` without a literal — so this rule costs that case nothing.
	const literal = /fromSitemap:\s*false/;

	for (const [path, source] of sources) {
		assert.equal(
			literal.test(source),
			false,
			`${path} passes a literal fromSitemap: false to a schedule write. Derive it from the target ` +
				`(!!target.sitemapUrl) — a hardcoded false silently un-flags a sitemap-listed URL.`
		);
	}
});

test('the funnel owns the claim floor: nothing else touches the lease table’s floor primitives', () => {
	// `advanceFloor`/`resetFloor`/`lowerFloorTo` are the correctness surface. A caller outside the
	// funnel could advance the floor past a row it never observed, which is exactly the 14%-stranding
	// rule the design rejects. (`resources/RenderQueue.js` reaches the reset through the funnel's
	// `resetFloorNow`, and the console reads through `floorState`, so neither needs these.)
	const primitives = /\b(?:advanceFloor|lowerFloorTo|resetFloor)\s*\(/;

	for (const [path, source] of sources) {
		if (path === FUNNEL || path === 'util/renderLease.js') continue;
		assert.equal(
			primitives.test(source),
			false,
			`${path} manipulates the claim floor directly. The floor may only move through ` +
				`util/renderSchedule.js, which is what keeps "the floor never advances past a row a pass ` +
				`observed" true by construction.`
		);
	}
});

test('no table in the schema disables audit — the audit store IS the redo log', () => {
	// Measured: with `audit: false`, 0 of 500 acknowledged writes survived an unclean shutdown, and a
	// 45s wait did not help. Table data runs WAL-off and `replayLogs()` replays from the audit store,
	// so turning audit off to halve write volume silently trades durability for bytes. Halving the
	// queue's write COUNT (which is what this release does) is the safe version of that idea.
	// Matches the DIRECTIVE, not the word. It used to forbid the word `audit` anywhere in the file,
	// which was a false positive waiting to happen: audit VOLUME is the measured justification for
	// several design decisions in here (bulk invalidation records a 102-byte row precisely because
	// rewriting the corpus costs 61.8 MB of it per node), so a table comment has every reason to say
	// the word. Forbidding the assignment is what this test actually means.
	const schema = readFileSync(fileURLToPath(new URL('../src/schemas/schema.graphql', import.meta.url)), 'utf8');
	assert.equal(/audit\s*:/i.test(schema), false, 'schema.graphql must not set an `audit:` directive on any table');
	assert.equal(/@audit/i.test(schema), false, 'nor an @audit annotation');
});
