import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, resolveConfigForJob } from '../dist/config.js';
import type { ConfigOverride } from '../dist/config.js';

const PRODUCT = 'https://site.example.com/product/prd-1/a.jsp';
const HOME = 'https://site.example.com/';

const withOverrides = (overrides: ConfigOverride[]) => mergeConfig({ overrides });

test('no overrides configured resolves the base config by identity', () => {
	const config = mergeConfig();
	const resolved = resolveConfigForJob(config, { url: PRODUCT, deviceType: 'desktop' });
	assert.equal(resolved.config, config, 'an unconfigured deployment must pay nothing and change nothing');
	assert.deepEqual(resolved.applied, []);
});

test('a path-scoped override applies only to matching paths', () => {
	const config = withOverrides([{ name: 'pdp-settle', pathPattern: '^/product/', config: { scroll: { stepMs: 15 } } }]);
	const onProduct = resolveConfigForJob(config, { url: PRODUCT, deviceType: 'desktop' });
	assert.equal(onProduct.config.scroll.stepMs, 15);
	assert.deepEqual(onProduct.applied, ['pdp-settle']);

	const onHome = resolveConfigForJob(config, { url: HOME, deviceType: 'desktop' });
	assert.equal(onHome.config.scroll.stepMs, config.scroll.stepMs, 'home keeps the base settle');
	assert.deepEqual(onHome.applied, []);
	assert.equal(onHome.config, config, 'a non-match must not clone the config');
});

test('scopes AND together: path AND device must both match', () => {
	const config = withOverrides([
		{
			name: 'pdp-desktop',
			pathPattern: '^/product/',
			devices: ['desktop'],
			config: { navigation: { networkIdleTimeoutMs: 4000 } },
		},
	]);
	assert.deepEqual(resolveConfigForJob(config, { url: PRODUCT, deviceType: 'desktop' }).applied, ['pdp-desktop']);
	assert.deepEqual(resolveConfigForJob(config, { url: PRODUCT, deviceType: 'mobile' }).applied, []);
	assert.deepEqual(resolveConfigForJob(config, { url: HOME, deviceType: 'desktop' }).applied, []);
});

test('overrides apply in array order and the last match wins a contested key', () => {
	const config = withOverrides([
		{ name: 'all-pages', config: { scroll: { stepMs: 20, topSettleMs: 111 } } },
		{ name: 'product-pages', pathPattern: '^/product/', config: { scroll: { stepMs: 40 } } },
	]);
	const r = resolveConfigForJob(config, { url: PRODUCT, deviceType: 'desktop' });
	assert.deepEqual(r.applied, ['all-pages', 'product-pages']);
	assert.equal(r.config.scroll.stepMs, 40, 'the later override wins the key both set');
	assert.equal(r.config.scroll.topSettleMs, 111, 'and the earlier one still contributes its own keys');
});

test('a partial patch leaves every untouched key alone', () => {
	const base = mergeConfig();
	const config = withOverrides([{ name: 'p', pathPattern: '^/product/', config: { scroll: { stepMs: 5 } } }]);
	const r = resolveConfigForJob(config, { url: PRODUCT, deviceType: 'desktop' }).config;
	assert.equal(r.scroll.stepMs, 5);
	assert.equal(r.scroll.stepFraction, base.scroll.stepFraction);
	assert.equal(r.navigation.networkIdleTimeoutMs, base.navigation.networkIdleTimeoutMs);
	assert.deepEqual(r.block.resourceTypes, base.block.resourceTypes);
});

test('waitFor rules can be replaced per route', () => {
	const config = withOverrides([
		{
			name: 'pdp-waits',
			pathPattern: '^/product/',
			config: { waitFor: [{ selector: '#reviews', waitForSelector: '.loaded', minCount: 1 }] },
		},
	]);
	const r = resolveConfigForJob(config, { url: PRODUCT, deviceType: 'desktop' }).config;
	assert.equal(r.waitFor?.length, 1);
	assert.equal(r.waitFor?.[0].selector, '#reviews');
	assert.equal(resolveConfigForJob(config, { url: HOME, deviceType: 'desktop' }).config.waitFor, undefined);
});

test('an unparseable URL matches only the unscoped overrides', () => {
	const config = withOverrides([
		{ name: 'everywhere', config: { scroll: { stepMs: 7 } } },
		{ name: 'products', pathPattern: '^/product/', config: { scroll: { stepMs: 9 } } },
	]);
	const r = resolveConfigForJob(config, { url: 'not a url', deviceType: 'desktop' });
	assert.deepEqual(r.applied, ['everywhere'], 'a path-scoped rule must not fire on an unknown path');
	assert.equal(r.config.scroll.stepMs, 7);
});

// ── validation ────────────────────────────────────────────────────────────────────────────────

test('a name is required and must be unique', () => {
	assert.throws(() => withOverrides([{ config: {} } as unknown as ConfigOverride]), /name must be a non-empty string/);
	assert.throws(
		() =>
			withOverrides([
				{ name: 'dup', config: { scroll: { stepMs: 1 } } },
				{ name: 'dup', config: { scroll: { stepMs: 2 } } },
			]),
		/not unique/
	);
});

test('an invalid pathPattern regex is rejected at config load, never at render time', () => {
	assert.throws(() => withOverrides([{ name: 'bad', pathPattern: '^/product/(', config: {} }]), /not a valid regex/);
});

test('a patch whose VALUE is invalid is caught, because it is validated as applied', () => {
	// The patch alone looks like a plain object; only merging it over the base reveals that it
	// replaced a validated default with a nonsense value.
	assert.throws(
		() => withOverrides([{ name: 'bad-value', config: { scroll: { stepMs: -5 } } }]),
		/is invalid once applied.*scroll\.stepMs must be a non-negative number/
	);
	assert.throws(
		() => withOverrides([{ name: 'bad-frac', config: { scroll: { stepFraction: 0 } } }]),
		/is invalid once applied.*stepFraction must be a positive number/
	);
});

test('the settle dwells are validated on the base config too, not only in overrides', () => {
	assert.throws(() => mergeConfig({ scroll: { topSettleMs: -1 } }), /topSettleMs must be a non-negative number/);
	assert.throws(
		() => mergeConfig({ scroll: { settleStablePasses: 0 } }),
		/settleStablePasses must be a positive integer/
	);
});

test('the blocks that are decided above a render cannot be scoped', () => {
	assert.throws(
		() => withOverrides([{ name: 'n', config: { overrides: [] } as never }]),
		/may not set "overrides" — overrides cannot nest/
	);
	assert.throws(
		() => withOverrides([{ name: 'n', config: { cacheKey: { plusIsSpace: true } } as never }]),
		/may not set "cacheKey"/
	);
	assert.throws(
		() => withOverrides([{ name: 'n', config: { documentReuse: { enabled: false } } as never }]),
		/may not set "documentReuse"/
	);
	assert.throws(
		() => withOverrides([{ name: 'n', config: { variantContext: { shared: true } } as never }]),
		/may not set "variantContext"/
	);
});

test('a device name that is not a real profile is rejected, not silently non-matching', () => {
	assert.throws(
		() => withOverrides([{ name: 'typo', devices: ['moblile'], config: {} }]),
		/names unknown device "moblile".*never apply/s
	);
	assert.doesNotThrow(() => withOverrides([{ name: 'ok', devices: ['mobile'], config: {} }]));
});

test('a settle dwell past the timer ceiling is rejected — it would become NO dwell', () => {
	// setTimeout fires after 1ms past 2^31-1, so the dwell silently disappears.
	assert.throws(() => mergeConfig({ scroll: { topSettleMs: 2147483648 } }), /at most 2147483647/);
	assert.throws(() => mergeConfig({ scroll: { stepMs: 2147483648 } }), /at most 2147483647/);
});

test('devices and pathPattern shapes are validated', () => {
	assert.throws(() => withOverrides([{ name: 'n', devices: [''], config: {} }]), /devices must be an array/);
	assert.throws(
		() => withOverrides([{ name: 'n', pathPattern: '   ', config: {} }]),
		/pathPattern must be a non-empty string/
	);
	assert.throws(
		() => withOverrides([{ name: 'n', config: 'nope' } as unknown as ConfigOverride]),
		/config must be an object/
	);
});

test('two configs sharing an overrides array resolve independently', () => {
	// THE REGRESSION. The resolved-config cache used to be keyed by the identity of
	// `config.overrides` and cleared only when that array changed — so a config derived from another
	// by spreading it and changing a field resolved to the FIRST config's cached result, for every
	// URL that matched an override, for the rest of the process. A URL matching NO override was
	// unaffected, because that path returns before the cache, which is what made it present as "this
	// setting works on the home page and nowhere else".
	const overrides: ConfigOverride[] = [
		{ name: 'product', pathPattern: '^/product/', config: { navigation: { networkIdleMs: 111 } } },
	];
	const first = mergeConfig({ overrides, scroll: { topSettleMs: 300 } });
	const second = mergeConfig({ overrides, scroll: { topSettleMs: 900 } });

	const a = resolveConfigForJob(first, { url: 'https://example.com/product/x', deviceType: 'mobile' });
	const b = resolveConfigForJob(second, { url: 'https://example.com/product/x', deviceType: 'mobile' });

	assert.deepEqual(a.applied, ['product']);
	assert.deepEqual(b.applied, ['product']);
	assert.equal(a.config.navigation.networkIdleMs, 111, 'the override still applies');
	assert.equal(b.config.navigation.networkIdleMs, 111);
	assert.equal(a.config.scroll.topSettleMs, 300);
	assert.equal(b.config.scroll.topSettleMs, 900, 'the second config must not resolve to the first');
});
