import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { conditionalValidatorFor } from '../src/util/sitemapConditional.js';

globalThis.logger ??= { debug() {}, info() {}, warn() {}, error() {} };

const HOUR = 60 * 60 * 1000;
const LM = 'Wed, 16 Sep 2026 06:08:37 GMT';

const setConditional = (overrides = {}) =>
	applyOptions({ sitemap: { conditional: { enabled: true, fullPassInterval: 24 * HOUR, ...overrides } } });

const stored = (over = {}) => ({ lastModified: LM, lastRefreshed: new Date(Date.now() - HOUR), ...over });

test('a recently-ingested document with a validator is fetched conditionally', () => {
	setConditional();
	assert.equal(conditionalValidatorFor(stored(), false), LM);
});

// The repair net: a 304 skips the reconcile, and the reconcile is also what re-creates targets
// lost to anything else. Past the interval the document is re-ingested whether it changed or not.
test('a document not ingested within fullPassInterval is fetched unconditionally', () => {
	setConditional();
	assert.equal(conditionalValidatorFor(stored({ lastRefreshed: new Date(Date.now() - 25 * HOUR) }), false), null);
});

test('no stored validator means unconditional — degrade to full, never to broken', () => {
	setConditional();
	assert.equal(conditionalValidatorFor(stored({ lastModified: null }), false), null);
	assert.equal(conditionalValidatorFor(stored({ lastModified: '' }), false), null);
});

test('a document never seen before is fetched unconditionally', () => {
	setConditional();
	assert.equal(conditionalValidatorFor(null, false), null);
	assert.equal(conditionalValidatorFor(undefined, false), null);
});

// An unreadable or absent date must not read as "ingested at epoch 0" and certainly not as
// "recently ingested": NaN fails the comparison, which falls through to a full fetch.
test('an unreadable lastRefreshed falls through to unconditional', () => {
	setConditional();
	assert.equal(conditionalValidatorFor(stored({ lastRefreshed: 'not a date' }), false), null);
	assert.equal(conditionalValidatorFor(stored({ lastRefreshed: null }), false), null);
});

test('revalidate always fetches unconditionally — the operator asked for a re-ingest', () => {
	setConditional();
	assert.equal(conditionalValidatorFor(stored(), true), null);
});

test('disabling the feature restores unconditional fetching everywhere', () => {
	setConditional({ enabled: false });
	assert.equal(conditionalValidatorFor(stored(), false), null);
});

test('fullPassInterval 0 makes every fetch unconditional', () => {
	setConditional({ fullPassInterval: 0 });
	assert.equal(conditionalValidatorFor(stored({ lastRefreshed: new Date() }), false), null);
});
