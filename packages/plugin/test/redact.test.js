import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactConfig, SECRET_PATHS } from '../src/util/redact.js';

test('the redaction list is derived from the schema (secret: true options)', () => {
	assert.deepEqual(SECRET_PATHS.sort(), ['origin.securityToken.value', 'renderNow.token'].sort());
});

test('secrets are replaced with a presence marker, not disclosed', () => {
	const out = redactConfig({
		origin: {
			securityToken: { header: 'x-harper-renderer-bypass', value: 'super-secret-token', valueEnv: 'TOKEN_ENV' },
		},
		renderNow: { enabled: true, token: 'abcd', header: 'x-harper-render-now' },
	});

	assert.equal(out.origin.securityToken.value, '<set: 18 chars>');
	assert.equal(out.renderNow.token, '<set: 4 chars>');
	// Header and env-var NAMES are not secrets and stay visible — an operator needs them to
	// verify the deployment wiring.
	assert.equal(out.origin.securityToken.header, 'x-harper-renderer-bypass');
	assert.equal(out.origin.securityToken.valueEnv, 'TOKEN_ENV');
	assert.equal(out.renderNow.enabled, true);
});

test('an unset secret is reported as empty rather than looking configured', () => {
	const out = redactConfig({ origin: { securityToken: { value: '' } }, renderNow: { token: '' } });
	assert.equal(out.origin.securityToken.value, '<empty>');
	assert.equal(out.renderNow.token, '<empty>');
});

test('the input config is never mutated', () => {
	const input = { origin: { securityToken: { value: 'keep-me' } }, renderNow: { token: 'keep-me-too' } };
	redactConfig(input);
	assert.equal(input.origin.securityToken.value, 'keep-me');
	assert.equal(input.renderNow.token, 'keep-me-too');
});

test('nested objects and arrays are deep-cloned, not shared', () => {
	const input = { domains: ['a.com'], ingress: { routes: [{ path: '/x', queryParams: ['CN'] }] } };
	const out = redactConfig(input);

	out.domains.push('b.com');
	out.ingress.routes[0].queryParams.push('utm');

	assert.deepEqual(input.domains, ['a.com']);
	assert.deepEqual(input.ingress.routes[0].queryParams, ['CN']);
});

test('a redaction path missing from the config does not invent a key', () => {
	// Guards against the redaction list drifting out of sync with the config shape and
	// reporting a phantom `<empty>` secret that does not exist.
	const out = redactConfig({ page: { ttl: 1 } });
	assert.deepEqual(out, { page: { ttl: 1 } });
	assert.equal('origin' in out, false);
});
