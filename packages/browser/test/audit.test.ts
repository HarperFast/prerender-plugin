import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSelfCheckResults } from '../dist/audit/selfCheck.js';

// The audit ships its own correctness suite (runSelfCheckResults): the pure diff classifier on synthetic
// fingerprints + the Diff-2 detectors against self-contained golden fixtures (no network/origin). We run
// it once here and surface each assertion as an individual node:test case so a regression names itself.
const results = await runSelfCheckResults();

test('audit self-check produced the full assertion set', () => {
	assert.ok(results.length >= 11, `only ${results.length} self-checks ran (expected ≥ 11)`);
});

for (const r of results) {
	test(`self-check: ${r.name}`, () => {
		assert.ok(r.pass, r.detail);
	});
}
