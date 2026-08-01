import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { actionForExisting, canSkipLookup, createRefreshRun, TargetAction } from '../src/util/sitemapRun.js';
import { PASSTHROUGH, UNCLASSIFIED } from '../src/util/routeClass.js';

beforeEach(() => applyOptions({}));

const SITEMAP = 'https://x/sitemap.xml';

// Mirrors how Harper projects a `select`, so these tests exercise the shape the call site
// actually receives: an ARRAY select builds a record, a STRING select returns the bare value.
const project = (row, select) => {
	if (Array.isArray(select)) {
		const projected = {};
		for (const attribute of select) projected[attribute] = row[attribute];
		return projected;
	}
	return row[select];
};

// --- actionForExisting: what to do with a target the prune scan didn't already vouch for ---

test('a target already attributed to this sitemap is skipped', () => {
	const existing = project({ cacheKey: 'https://x/a|desktop', sitemapUrl: SITEMAP }, ['sitemapUrl']);
	assert.equal(actionForExisting(existing, SITEMAP), TargetAction.SKIP);
});

test('a target that moved in from another sitemap is re-attached, not re-created', () => {
	const existing = project({ cacheKey: 'https://x/a|desktop', sitemapUrl: 'https://x/old.xml' }, ['sitemapUrl']);
	assert.equal(actionForExisting(existing, SITEMAP), TargetAction.REATTACH);
});

test('a target pruned out of every sitemap is re-attached when it returns', () => {
	const existing = project({ cacheKey: 'https://x/a|desktop', sitemapUrl: null }, ['sitemapUrl']);
	assert.equal(actionForExisting(existing, SITEMAP), TargetAction.REATTACH);
});

test('no target at all is a create', () => {
	assert.equal(actionForExisting(undefined, SITEMAP), TargetAction.CREATE);
	assert.equal(actionForExisting(null, SITEMAP), TargetAction.CREATE);
});

test('REATTACH is distinct from CREATE so attribution changes never reset the render clock', () => {
	// The whole point of the split. CREATE goes through `RenderTarget.put`, which recomputes
	// getInitialRenderTime; REATTACH goes through `patch`, which leaves the schedule row alone.
	// A URL listed in two sitemaps flip-flops between them on every pass — if that took the
	// CREATE path it would push its own next render forward forever.
	const moved = project({ sitemapUrl: 'https://x/other.xml' }, ['sitemapUrl']);
	assert.notEqual(actionForExisting(moved, SITEMAP), TargetAction.CREATE);
});

// --- first writer wins: a URL listed by two sitemaps in the same walk ---

test('a target claimed by an EARLIER sitemap in this walk is left alone', () => {
	// The ping-pong this prevents: A claims it, B takes it, next walk A takes it back, forever.
	const visited = new Set(['https://x/index.xml', 'https://x/sm-a.xml']);
	const existing = project({ sitemapUrl: 'https://x/sm-a.xml' }, ['sitemapUrl']);
	assert.equal(actionForExisting(existing, 'https://x/sm-b.xml', visited), TargetAction.DUPLICATE);
});

test('a target owned by a sitemap NOT in this walk is still re-attached', () => {
	// It genuinely moved — e.g. shuffled across a paginated product sitemap boundary.
	const visited = new Set(['https://x/index.xml', 'https://x/sm-b.xml']);
	const existing = project({ sitemapUrl: 'https://x/old.xml' }, ['sitemapUrl']);
	assert.equal(actionForExisting(existing, 'https://x/sm-b.xml', visited), TargetAction.REATTACH);
});

test('an unlinked target (sitemapUrl null) is re-attached, never treated as a duplicate', () => {
	// `claimedThisWalk.has(null)` must not be reachable — null is "owned by nobody".
	const visited = new Set(['https://x/sm-a.xml']);
	const existing = project({ sitemapUrl: null }, ['sitemapUrl']);
	assert.equal(actionForExisting(existing, 'https://x/sm-b.xml', visited), TargetAction.REATTACH);
});

test('ownership converges: the second walk produces no writes at all', () => {
	// Walk 1: A creates it. Walk 2: A skips via knownKeys, B sees A in visited -> DUPLICATE.
	// Neither walk writes, so `updated` returns to zero and becomes a usable change signal.
	const visited = new Set(['https://x/sm-a.xml', 'https://x/sm-b.xml']);
	const ownedByA = project({ sitemapUrl: 'https://x/sm-a.xml' }, ['sitemapUrl']);
	assert.equal(actionForExisting(ownedByA, 'https://x/sm-a.xml', visited), TargetAction.SKIP);
	assert.equal(actionForExisting(ownedByA, 'https://x/sm-b.xml', visited), TargetAction.DUPLICATE);
});

test('omitting claimedThisWalk keeps the old re-attach behaviour', () => {
	const existing = project({ sitemapUrl: 'https://x/sm-a.xml' }, ['sitemapUrl']);
	assert.equal(actionForExisting(existing, 'https://x/sm-b.xml'), TargetAction.REATTACH);
});

test('a STRING select still reads as changed — the bug this guards', () => {
	// Documents why the call site must pass an array. A string select returns the bare value, so
	// `.sitemapUrl` is undefined and every known target looks re-attachable. The blast radius is
	// now a redundant patch rather than a re-put that resets the schedule, but it is still wrong.
	const scalar = project({ cacheKey: 'https://x/a|desktop', sitemapUrl: SITEMAP }, 'sitemapUrl');
	assert.equal(scalar, SITEMAP, 'a string select returns the bare value');
	assert.equal(actionForExisting(scalar, SITEMAP), TargetAction.REATTACH);
});

// --- canSkipLookup: the point read the prune scan already answered ---

test('a key the prune scan returned skips the point read', () => {
	const knownKeys = new Set(['https://x/a|desktop']);
	assert.equal(canSkipLookup({ revalidate: false, knownKeys, cacheKey: 'https://x/a|desktop' }), true);
});

test('a key the scan did not return still gets looked up', () => {
	const knownKeys = new Set(['https://x/a|desktop']);
	assert.equal(canSkipLookup({ revalidate: false, knownKeys, cacheKey: 'https://x/b|desktop' }), false);
});

test('the fast path is a cache, not an authority: an absent or capped set just costs a read', () => {
	assert.equal(canSkipLookup({ revalidate: false, knownKeys: undefined, cacheKey: 'k' }), false);
	assert.equal(canSkipLookup({ revalidate: false, knownKeys: new Set(), cacheKey: 'k' }), false);
});

test('revalidate never skips — it must re-put every target with an immediate render time', () => {
	const knownKeys = new Set(['k']);
	assert.equal(canSkipLookup({ revalidate: true, knownKeys, cacheKey: 'k' }), false);
});

// --- createRefreshRun: the tally, and the things the old result shape lost ---

test('duplicates are counted so an otherwise invisible overlap is reported', () => {
	const run = createRefreshRun();
	run.count('duplicates', 95);
	assert.equal(run.snapshot().duplicates, 95);
});

test('counts accumulate and filtered totals merge per class', () => {
	const run = createRefreshRun();
	run.count('created', 3);
	run.count('created');
	run.count('skipped', 10);
	run.addFiltered({ [PASSTHROUGH]: 2, [UNCLASSIFIED]: 5 });
	run.addFiltered({ [PASSTHROUGH]: 1, [UNCLASSIFIED]: 0 });

	const snapshot = run.snapshot();
	assert.equal(snapshot.created, 4);
	assert.equal(snapshot.skipped, 10);
	assert.equal(snapshot.filtered[PASSTHROUGH], 3);
	assert.equal(snapshot.filtered[UNCLASSIFIED], 5);
});

test('removed is an exact count with a BOUNDED sample, not every record', () => {
	// The old result pushed a full target record for every unlinked target from every child into
	// one array and returned it in the HTTP body — unbounded in both memory and response size.
	const run = createRefreshRun({ removedSampleCap: 3 });
	run.addRemoved(Array.from({ length: 500 }, (_, i) => ({ cacheKey: `k${i}` })));

	const snapshot = run.snapshot();
	assert.equal(snapshot.removed, 500, 'the count stays exact');
	assert.equal(snapshot.removedSample.length, 3, 'the sample is capped');
	assert.deepEqual(snapshot.removedSample, ['k0', 'k1', 'k2']);
});

test('removed accumulates across children', () => {
	const run = createRefreshRun({ removedSampleCap: 2 });
	run.addRemoved([{ cacheKey: 'a' }, { cacheKey: 'b' }]);
	run.addRemoved([{ cacheKey: 'c' }]);

	const snapshot = run.snapshot();
	assert.equal(snapshot.removed, 3);
	assert.deepEqual(snapshot.removedSample, ['a', 'b'], 'the cap holds across calls');
});

test('failures are recorded with their message and capped, with the overflow counted', () => {
	const run = createRefreshRun({ failedCap: 2 });
	run.addFailure('https://x/1.xml', new Error('503 Service Unavailable'));
	run.addFailure('https://x/2.xml', new Error('socket hang up'));
	run.addFailure('https://x/3.xml', new Error('dropped'));

	const snapshot = run.snapshot();
	assert.equal(snapshot.failed.length, 2);
	assert.deepEqual(snapshot.failed[0], { url: 'https://x/1.xml', error: '503 Service Unavailable' });
	assert.equal(snapshot.failedOverflow, 1, 'a capped list must still say how much it dropped');
});

test('a non-Error rejection still yields a readable message', () => {
	const run = createRefreshRun();
	run.addFailure('https://x/1.xml', 'plain string rejection');
	assert.equal(run.snapshot().failed[0].error, 'plain string rejection');
});

test('a truncated prune scan is reported rather than silently partial', () => {
	const run = createRefreshRun();
	run.addTruncatedScan('https://x/child.xml', 250000, 100000);

	assert.deepEqual(run.snapshot().truncatedScans, [
		{ sitemapUrl: 'https://x/child.xml', examined: 250000, collected: 100000 },
	]);
});

test('the healthy case reports empty arrays, not absent fields', () => {
	const snapshot = createRefreshRun().snapshot();
	assert.deepEqual(snapshot.failed, []);
	assert.deepEqual(snapshot.truncatedScans, []);
	assert.deepEqual(snapshot.removedSample, []);
	assert.equal(snapshot.failedOverflow, 0);
});

test('a snapshot is a copy, so persisting it mid-walk cannot be mutated afterwards', () => {
	const run = createRefreshRun();
	run.addFailure('https://x/1.xml', new Error('boom'));
	const first = run.snapshot();

	run.addFailure('https://x/2.xml', new Error('later'));
	run.count('created');

	assert.equal(first.failed.length, 1, 'the earlier snapshot is unchanged');
	assert.equal(first.created, 0);
	assert.equal(run.snapshot().failed.length, 2);
});
