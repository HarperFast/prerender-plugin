import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findHarperVersion, harperVersion, hostInfo, parseMeminfo, pluginVersion } from '../src/util/hostInfo.js';

test('parseMeminfo: kB means KiB, unitless lines pass through, junk is skipped', () => {
	const fields = parseMeminfo(
		[
			'MemTotal:       16384000 kB',
			'MemFree:          204800 kB',
			'MemAvailable:    8192000 kB',
			'Active(anon):     100000 kB',
			'SwapTotal:       2097152 kB',
			'SwapFree:        1048576 kB',
			'HugePages_Total:       0',
			'not a meminfo line',
			'',
		].join('\n')
	);
	assert.equal(fields.MemAvailable, 8192000 * 1024);
	assert.equal(fields.SwapTotal, 2097152 * 1024);
	assert.equal(fields['Active(anon)'], 100000 * 1024);
	assert.equal(fields.HugePages_Total, 0);
	assert.equal(Object.keys(fields).length, 7);
});

test('findHarperVersion: the NEAREST package.json decides — Harper yields its version, anything else null', () => {
	const tree = {
		'/opt/harper/package.json': { name: '@harperfast/harper-pro', version: '5.3.1' },
		'/opt/app/package.json': { name: '@harperfast/prerender', version: '0.91.0' },
		'/opt/app/node_modules/harper/package.json': { name: 'harper', version: '5.0.28' },
	};
	const read = (path) => tree[path] ?? null;

	// harper-pro's build: no package.json between dist/core/server/threads and the package root.
	assert.equal(findHarperVersion('/opt/harper/dist/core/server/threads/threadServer.js', read), '5.3.1');
	assert.equal(findHarperVersion('/opt/app/node_modules/harper/dist/server/threads/threadServer.js', read), '5.0.28');
	// A non-Harper package in between ends the walk — it never searches on for some Harper further up.
	assert.equal(findHarperVersion('/opt/app/src/util/hostInfo.js', read), null);
	// No package.json at all within reach.
	assert.equal(findHarperVersion('/elsewhere/bin/node', read), null);
});

test('findHarperVersion: the installed harper dev dependency resolves to its own version', (t) => {
	const root = new URL('../../../node_modules/harper/', import.meta.url);
	const threadServer = new URL('dist/server/threads/threadServer.js', root);
	if (!existsSync(threadServer)) return t.skip('harper is not installed at the workspace root');
	const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
	assert.equal(findHarperVersion(fileURLToPath(threadServer)), version);
});

test('versions: the plugin reads its own package.json; outside Harper the Harper version is null, not a guess', () => {
	const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.equal(pluginVersion(), own.version);
	// Under the test runner the nearest package.json is this plugin's — which must not be reported
	// as Harper's.
	assert.equal(harperVersion(), null);
});

test('hostInfo: every field present, typed or null, and it never throws without Harper globals', () => {
	// No `server` global here: the hostname is null rather than a thrown overview.
	const host = hostInfo();
	assert.deepEqual(Object.keys(host).sort(), [
		'availableMemory',
		'availableMemorySource',
		'cpus',
		'harperVersion',
		'hostname',
		'loadavg',
		'nodeVersion',
		'pluginVersion',
		'swapTotal',
		'swapUsed',
		'totalMemory',
		'uptimeSec',
	]);
	assert.equal(host.hostname, null);
	assert.ok(Number.isInteger(host.cpus) && host.cpus > 0);
	assert.ok(host.totalMemory > 0);
	assert.ok(host.availableMemory > 0);
	assert.ok(['meminfo', 'freemem'].includes(host.availableMemorySource));
	// Swap comes from /proc/meminfo or not at all: null on a host without it, never a made-up 0.
	if (host.availableMemorySource === 'freemem') {
		assert.equal(host.swapTotal, null);
		assert.equal(host.swapUsed, null);
	}
	assert.equal(host.loadavg.length, 3);
	assert.ok(Number.isInteger(host.uptimeSec));
	assert.equal(host.nodeVersion, process.version);

	globalThis.server = { hostname: 'node-a.example.com' };
	try {
		assert.equal(hostInfo().hostname, 'node-a.example.com');
	} finally {
		delete globalThis.server;
	}
});
