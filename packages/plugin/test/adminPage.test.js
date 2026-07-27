import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminPage } from '../src/admin/page.js';

const page = renderAdminPage();

const inlineScript = () => {
	const open = page.indexOf('<script>');
	const close = page.lastIndexOf('</script>');
	assert.ok(open !== -1 && close > open, 'page must contain an inline <script> block');
	return page.slice(open + '<script>'.length, close);
};

test('the inline script parses as valid JavaScript', () => {
	// The page is authored as a template literal, so a syntax slip inside it is invisible
	// until a browser loads it. Parsing (never executing) catches that at test time.
	assert.doesNotThrow(() => new Function(inlineScript()));
});

test('no template-literal interpolation leaks into the output', () => {
	// A `${` written inside the page template would be evaluated by THIS module rather than
	// shipped to the browser. Any `${` surviving into the output means the reverse: an
	// escaped sequence that will reach the browser as literal text inside a non-template
	// string, which is a bug either way.
	assert.equal(page.includes('${'), false);
});

test('the page is fully self-contained — no external resource loads', () => {
	// A strict CSP blocks external fetches anyway; this asserts the page never tries, so the
	// CSP stays a backstop rather than the thing holding the UI together.
	assert.equal(/<(?:script|link|img|iframe)[^>]*\s(?:src|href)=/i.test(page), false);
	assert.equal(page.includes('//cdn'), false);
	assert.equal(/https?:\/\/(?!www\.example\.com)/.test(page.replace(/harpersystems\.dev/g, '')), false);
});

test('the API base is derived from the page location, not hardcoded', () => {
	// The resource mount can sit under a deployment base-URL prefix; deriving the base from
	// location.pathname is what makes the UI work when it does.
	assert.match(inlineScript(), /location\.pathname/);
	assert.equal(inlineScript().includes("'/prerender_admin/"), false);
});

test('values are rendered via textContent, never innerHTML', () => {
	// This page displays operator-supplied URLs, cache keys, and config values. Building
	// with textContent is what makes it injection-safe by construction.
	const script = inlineScript();
	assert.equal(script.includes('innerHTML'), false);
	assert.equal(script.includes('outerHTML'), false);
	assert.equal(script.includes('insertAdjacentHTML'), false);
});
