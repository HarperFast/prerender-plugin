import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `util/pageCheck.js` — the replicated record of a check.
 *
 * What must hold:
 *   - A ROW IS SMALL. It is written for nearly every URL the nightly pass probes and replicates to every
 *     node, so an agreeing check stores a 16-character digest of its observation, never the observation
 *     (~1 KB on a product endpoint).
 *   - THE SKIP IS UNCHANGED BY IT. The sweep skips a row exactly when the digest of its own baseline equals
 *     the stored one: the same observation, the same rule, an agreement since the pass began.
 *   - EVERY FAILURE READS AS "NOT CHECKED".
 */

let pageCheck;
const rows = new Map();
let failReads = false;

before(async () => {
	globalThis.server = { hostname: 'node-a', recordAnalytics() {} };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		verification: {
			PageCheck: {
				async get({ id, select }) {
					if (failReads) throw new Error('read fault');
					const row = rows.get(id);
					return row ? Object.fromEntries(select.map((key) => [key, row[key]])) : undefined;
				},
				async put(id, record) {
					rows.set(id, record);
				},
			},
		},
	};
	pageCheck = await import('../src/util/pageCheck.js');
});

beforeEach(() => {
	rows.clear();
	failReads = false;
});

const URL_A = 'https://shop.example.com/product/prd-a/red-shoe.jsp';
// A product observation as the probe signs it: every SKU's tuple, the description, the crumbs.
const OBSERVATION = JSON.stringify([
	29.99,
	19.99,
	19.99,
	'In Stock',
	['19.99'],
	true,
	'/product/prd-a/red-shoe.jsp',
	'SALE',
	33,
	null,
	[],
	false,
	false,
	false,
	'Red Shoe',
	'Acme',
	'Red Shoe | Shop',
	'A red shoe for every day, in every size, with a cushioned sole and a breathable upper.',
	'https://media.example.com/i/a?wid=350',
	[{ name: 'Shoes' }, { name: 'Sneakers' }],
	Array.from({ length: 20 }, (_, i) => [`a-${i}`, 'In Stock', 19.99]),
]);

test('an agreeing check stores a 16-character digest of its observation, never the observation', async () => {
	await pageCheck.writePageCheck(URL_A, 1_000, { outcome: 'agree', signature: OBSERVATION });
	const stored = rows.get(URL_A);
	assert.equal(stored.observedDigest, pageCheck.observationDigest(OBSERVATION));
	assert.equal(stored.observedDigest.length, 16);
	assert.ok(!JSON.stringify(stored).includes('cushioned sole'), 'the observation itself is not stored');
	assert.ok(JSON.stringify(stored).length < 300, `row ${JSON.stringify(stored).length} bytes`);
	const read = await pageCheck.readPageCheck(URL_A);
	assert.equal(read.outcome, 'agree');
	assert.equal(read.observedDigest, stored.observedDigest);
	assert.equal(read.basisAtMs, 1_000);
});

test('the sweep skips exactly when its baseline is the observation the check saw', async () => {
	const rule = { fingerprint: 'f1' };
	const since = Date.now() - 60_000;
	await pageCheck.writePageCheck(URL_A, 1_000, { outcome: 'agree', signature: OBSERVATION });
	const check = await pageCheck.readPageCheck(URL_A);
	const baseline = { signature: OBSERVATION, fingerprint: 'f1' };
	assert.equal(pageCheck.checkSparesProbe(check, baseline, rule, since), true);
	// One slot moved: a different observation, a different digest.
	const moved = { signature: OBSERVATION.replace('29.99', '34.99'), fingerprint: 'f1' };
	assert.equal(pageCheck.checkSparesProbe(check, moved, rule, since), false);
	// Another rule's baseline, a check before the pass, a non-agreement: never.
	assert.equal(pageCheck.checkSparesProbe(check, { ...baseline, fingerprint: 'f0' }, rule, since), false);
	assert.equal(pageCheck.checkSparesProbe(check, baseline, rule, Date.now() + 60_000), false);
	await pageCheck.writePageCheck(URL_A, 1_000, { outcome: 'mismatch', field: '0:title', evidence: 'ab' });
	assert.equal(pageCheck.checkSparesProbe(await pageCheck.readPageCheck(URL_A), baseline, rule, since), false);
	// The outcome check refuses on its own: a non-agreement carrying the very digest is still no skip.
	for (const outcome of ['mismatch', 'held', 'inconclusive', 'failed']) {
		assert.equal(pageCheck.checkSparesProbe({ ...check, outcome }, baseline, rule, since), false, outcome);
	}
	// No observation stored (a document check, a disagreement): no digest, and an empty baseline never
	// matches a missing one.
	assert.equal(pageCheck.observationDigest(null), null);
	assert.equal(pageCheck.observationDigest(''), null);
	assert.equal(
		pageCheck.checkSparesProbe({ ...check, observedDigest: null }, { signature: '', fingerprint: 'f1' }, rule, since),
		false
	);
});

test('the digest is lossless over the string: distinct lone surrogates digest differently', () => {
	const digests = ['\uD800', '\uDBFF', '\uDC00', '\uFFFD'].map((s) => pageCheck.observationDigest(s));
	assert.equal(new Set(digests).size, 4);
});

test('a failed read is "not checked"', async () => {
	failReads = true;
	const read = await pageCheck.readPageCheck(URL_A);
	assert.ok(Number.isNaN(read.checkedAtMs));
	assert.equal(read.observedDigest, null);
	assert.equal(pageCheck.coveredAt(0, -1, read), false);
});
