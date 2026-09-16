import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RenderWorker from '../dist/Worker.js';
import RenderJob from '../dist/RenderJob.js';
import { resolveSettings } from '../dist/settings.js';

// The worker's render loop over a multi-device job (plugin >= 0.66.0): every device rendered in
// turn on the job's one slot, each on a page of its own, then ONE result posted — partial when
// the lease runs short between variants. Driven with a stub browser and a fake queue endpoint, so
// no Chrome is involved: what is under test is the loop and the accounting, not rendering.

let server: http.Server;
let callbackOrigin = '';
const posted: Array<{ id: string; deviceTypes?: string[]; variants?: Array<{ deviceType: string; outcome: string }> }> =
	[];

before(async () => {
	resolveSettings({ harper: {} }, { requireHarper: false });
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			const metadataSize = parseInt(String(req.headers['x-metadata-size']));
			posted.push(JSON.parse(body.subarray(0, metadataSize).toString('utf8')));
			res.writeHead(204);
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	callbackOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

// A browser that hands out inert pages and counts them. `getBrowser()` returns `worker.browser`
// when set, so no launch happens.
const stubBrowser = () => {
	const browser = {
		jobRefs: 0,
		activePages: 0,
		opened: 0,
		closed: 0,
		maxJobRefs: 0,
		closing: false,
		getPage: async () => {
			browser.opened++;
			browser.activePages++;
			browser.maxJobRefs = Math.max(browser.maxJobRefs, browser.jobRefs);
			return { isClosed: () => false };
		},
		closePage: async () => {
			browser.closed++;
			browser.activePages--;
		},
		close: async () => {},
	};
	return browser;
};

const makeWorker = (renderer: (page: unknown, job: RenderJob) => Promise<string | undefined>) => {
	const worker = new RenderWorker({ renderer: renderer as never, maxConcurrency: 1 });
	const browser = stubBrowser();
	worker.browser = browser as never;
	return { worker, browser };
};

const urlJob = (expiresInMs = 60_000, deviceTypes = ['desktop', 'mobile']) =>
	new RenderJob({
		id: 'https://site.example.com/product/x',
		url: 'https://site.example.com/product/x',
		expiresAt: Date.now() + expiresInMs,
		deviceType: deviceTypes[0],
		deviceTypes,
		callbackOrigin,
		isFromSitemap: false,
	});

test('a multi-device job renders every device in turn, one page each, and posts ONE result', async () => {
	const seen: string[] = [];
	const { worker, browser } = makeWorker(async (_page, job) => {
		seen.push(job.deviceType);
		job.httpResponse = { statusCode: 200, headers: {} };
		job.isIndexable = true;
		return `<html>${job.deviceType}</html>`;
	});
	posted.length = 0;
	try {
		await worker.render(urlJob());
	} finally {
		await worker.destroy();
	}

	assert.deepEqual(seen, ['desktop', 'mobile'], 'sequential, in the order the plugin asked');
	assert.equal(browser.opened, 2, 'a page per variant');
	assert.equal(browser.closed, 2, 'every page closed');
	assert.equal(browser.jobRefs, 0, 'the job ref is released after each variant');
	assert.equal(browser.maxJobRefs, 1, 'never more than one ref held — variants do not overlap');
	assert.equal(posted.length, 1, 'one result for the whole job');
	assert.deepEqual(posted[0].deviceTypes, ['desktop', 'mobile']);
	assert.deepEqual(
		posted[0].variants?.map((v) => [v.deviceType, v.outcome]),
		[
			['desktop', 'rendered'],
			['mobile', 'rendered'],
		]
	);
});

test('a variant that throws is reported as error and does not stop the others', async () => {
	const { worker } = makeWorker(async (_page, job) => {
		if (job.deviceType === 'desktop') throw new Error('settle exploded');
		job.httpResponse = { statusCode: 200, headers: {} };
		job.isIndexable = true;
		return '<html>mobile</html>';
	});
	posted.length = 0;
	try {
		await worker.render(urlJob());
	} finally {
		await worker.destroy();
	}
	assert.deepEqual(
		posted[0].variants?.map((v) => [v.deviceType, v.outcome]),
		[
			['desktop', 'error'],
			['mobile', 'rendered'],
		]
	);
});

test('when the lease runs short between variants the result is posted PARTIAL rather than late', async () => {
	// 31s of lease: the first variant runs (the run loop already admitted the job), then a
	// ~1.5s render leaves ~29.5s, under the 30s floor, so the second variant is skipped.
	const seen: string[] = [];
	const { worker } = makeWorker(async (_page, job) => {
		seen.push(job.deviceType);
		await new Promise((r) => setTimeout(r, 1500));
		job.httpResponse = { statusCode: 200, headers: {} };
		job.isIndexable = true;
		return `<html>${job.deviceType}</html>`;
	});
	posted.length = 0;
	try {
		await worker.render(urlJob(31_000));
	} finally {
		await worker.destroy();
	}
	assert.deepEqual(seen, ['desktop']);
	assert.equal(posted.length, 1, 'a partial result is still posted — silence would cost the whole lease');
	assert.deepEqual(posted[0].deviceTypes, ['desktop', 'mobile']);
	assert.deepEqual(
		posted[0].variants?.map((v) => v.deviceType),
		['desktop']
	);
});

test('a legacy per-device job renders once and posts the legacy shape', async () => {
	const { worker, browser } = makeWorker(async (_page, job) => {
		job.httpResponse = { statusCode: 200, headers: {} };
		job.isIndexable = true;
		return '<html>ok</html>';
	});
	posted.length = 0;
	try {
		await worker.render(
			new RenderJob({
				id: 'https://site.example.com/product/x|desktop',
				url: 'https://site.example.com/product/x',
				expiresAt: Date.now() + 60_000,
				deviceType: 'desktop',
				callbackOrigin,
				isFromSitemap: false,
			})
		);
	} finally {
		await worker.destroy();
	}
	assert.equal(browser.opened, 1);
	assert.equal(posted.length, 1);
	assert.equal(posted[0].id, 'https://site.example.com/product/x|desktop');
	assert.equal(posted[0].variants, undefined, 'an older plugin reads the flat shape');
});

test('a browser that cannot be relaunched between variants still posts what already rendered', async () => {
	// `renderVariant` handles render failures itself, but it opens with `getBrowser()` — outside
	// that handling. A variant that retires the browser on a timeout, followed by a relaunch that
	// fails, used to reject straight out of the render loop: the completed first render was thrown
	// away, nothing was posted, and the row kept pinning the claim floor with no result to release it.
	const seen: string[] = [];
	const { worker } = makeWorker(async (_page, job) => {
		seen.push(job.deviceType);
		job.httpResponse = { statusCode: 200, headers: {} };
		job.isIndexable = true;
		return `<html>${job.deviceType}</html>`;
	});
	let calls = 0;
	worker.getBrowser = (async () => {
		if (++calls > 1) throw new Error('Failed to launch the browser process');
		return worker.browser;
	}) as never;

	posted.length = 0;
	try {
		await worker.render(urlJob());
	} finally {
		await worker.destroy();
	}

	assert.deepEqual(seen, ['desktop'], 'only the first variant ran');
	assert.equal(posted.length, 1, 'the completed render was posted rather than discarded');
	assert.deepEqual(posted[0].deviceTypes, ['desktop', 'mobile'], 'the job still reports what it was asked for');
	assert.deepEqual(
		posted[0].variants?.map((v) => [v.deviceType, v.outcome]),
		[['desktop', 'rendered']],
		'mobile is simply absent, which the plugin reads as not-attempted and retries'
	);
});

test('a first variant that cannot start still rejects, exactly as a single-device job always did', async () => {
	// The complement of the case above, and deliberately unchanged: with nothing rendered there is
	// nothing to post, so the failure propagates to the run loop's handler as it does today.
	const { worker } = makeWorker(async () => '<html>never</html>');
	worker.getBrowser = (async () => {
		throw new Error('Failed to launch the browser process');
	}) as never;

	posted.length = 0;
	try {
		await assert.rejects(() => worker.render(urlJob()), /Failed to launch/);
	} finally {
		await worker.destroy();
	}
	assert.equal(posted.length, 0);
});
