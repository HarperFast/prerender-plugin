/**
 * Point-in-time host facts for the console's per-node health strip, computed by the worker that
 * answers `GET /prerender_admin/overview`. The console fans that route out to every node, so each
 * node describes itself; nothing here is cluster-wide.
 *
 * COST: no scan, no table read, no await. Everything is a syscall-sized `os`/`process` call, one
 * read of `/proc/meminfo` (procfs — generated in memory, never touches a disk), and two small
 * package.json reads memoized for the life of the worker. It runs on every overview request, on
 * workers that also serve bot traffic, so it has to stay that cheap.
 *
 * NEVER THROWS. Each field is guarded on its own: a failure costs that field (null), not the
 * overview. A health strip that 500s the page it sits on is worse than one with a gap.
 *
 * CONTAINER CAVEAT. `/proc/meminfo`, `os.totalmem()` and `os.loadavg()` describe the HOST kernel,
 * not a cgroup: inside a container with a memory limit they report the machine's figures.
 */

import os from 'node:os';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A field that fails is null, never a thrown overview. */
const safe = (fn) => {
	try {
		return fn() ?? null;
	} catch {
		return null;
	}
};

/**
 * `/proc/meminfo` as bytes, keyed by its own field names (`MemAvailable`, `SwapTotal`, …). The file
 * says `kB` and means KiB. Lines without a unit (`HugePages_Total`) are counts and pass through.
 */
export function parseMeminfo(text) {
	const fields = {};
	for (const line of String(text).split('\n')) {
		const match = /^([\w()]+):\s+(\d+)(\s+kB)?\s*$/.exec(line);
		if (match) fields[match[1]] = Number(match[2]) * (match[3] ? 1024 : 1);
	}
	return fields;
}

/**
 * Memory the way an operator should read it. `MemAvailable` is the kernel's own estimate of what a
 * new allocation can get without swapping — it counts reclaimable page cache. `os.freemem()` is
 * `MemFree`, which does not, so on a database host whose page cache has grown into spare RAM it reads
 * as nearly full while the box is healthy. The fallback is kept for non-Linux hosts and labelled, so
 * the console can tell the two apart instead of comparing one against the other's threshold.
 */
function memory() {
	const meminfo = safe(() => parseMeminfo(readFileSync('/proc/meminfo', 'utf8')));
	const finite = (name) => (Number.isFinite(meminfo?.[name]) ? meminfo[name] : null);
	const memAvailable = finite('MemAvailable');
	const swapTotal = finite('SwapTotal');
	const swapFree = finite('SwapFree');
	const freemem = memAvailable === null ? safe(() => os.freemem()) : null;
	// /proc/meminfo and os.totalmem() describe the HOST. In a container with a cgroup memory limit the
	// process can be near its own ceiling while the host looks roomy, so report that ceiling too: Node's
	// cgroup-aware readers (22+). An unconstrained process reports 0, or on some cgroup setups a
	// near-2^63 sentinel — anything not below host RAM is not a real limit, and reads as null.
	const total = safe(() => os.totalmem());
	const limit = safe(() => process.constrainedMemory?.());
	const memoryLimit = Number.isFinite(limit) && limit > 0 && (!Number.isFinite(total) || limit < total) ? limit : null;
	const underLimit = memoryLimit !== null ? safe(() => process.availableMemory?.()) : null;
	return {
		availableMemory: memAvailable ?? freemem,
		availableMemorySource: memAvailable !== null ? 'meminfo' : freemem !== null ? 'freemem' : null,
		swapUsed: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
		swapTotal,
		memoryLimit,
		memoryLimitAvailable: Number.isFinite(underLimit) ? underLimit : null,
	};
}

const readJson = (path) => {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
};

// Memoized on first use: both files are fixed for the life of the process (a deploy restarts it).
let pluginVersionMemo;
let harperVersionMemo;

/** This package's version, from the package.json two levels above this file (src/util/ → root). */
export function pluginVersion() {
	if (pluginVersionMemo === undefined) {
		const pkg = safe(() => readJson(new URL('../../package.json', import.meta.url)));
		// Checked by name, so an unexpected install layout yields null rather than another package's version.
		pluginVersionMemo = pkg?.name === '@harperfast/prerender' && typeof pkg.version === 'string' ? pkg.version : null;
	}
	return pluginVersionMemo;
}

const HARPER_PACKAGES = new Set(['harper', 'harperdb', '@harperfast/harper', '@harperfast/harper-pro']);

/**
 * The version of the Harper package that contains `startFile`, found by walking up to the NEAREST
 * package.json — or null when that package is not Harper. Stopping at the nearest one, rather than
 * searching on for a Harper package further up, is what keeps a test runner or a component's own
 * file from reporting some unrelated install.
 */
export function findHarperVersion(startFile, read = readJson, maxDepth = 8) {
	let dir = dirname(startFile);
	for (let i = 0; i < maxDepth; i++) {
		const pkg = read(join(dir, 'package.json'));
		if (pkg) return HARPER_PACKAGES.has(pkg.name) && typeof pkg.version === 'string' ? pkg.version : null;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * The running Harper's version. Harper exposes none at runtime — `server` carries no version, and
 * inside a component `import 'harper'` resolves to a synthetic module with no file behind it. What
 * a worker does have is `process.argv[1]`: the script its thread was started from, which for an
 * HTTP worker is Harper's own `server/threads/threadServer.js`. Walking up from it is the same
 * find-up Harper's `utility/packageUtils.js` uses to read its own `packageJson.version`, so the
 * answer matches what Harper logs at startup. Checked against an installed `harper` 5.0
 * (dist/server/threads/…) and a `@harperfast/harper-pro` 5.3 build (dist/core/server/threads/…, no
 * package.json in between). Null outside Harper, or on any layout that does not end in a Harper
 * package — never a guess.
 */
export function harperVersion() {
	if (harperVersionMemo === undefined) {
		harperVersionMemo = safe(() => findHarperVersion(realpathSync(process.argv[1])));
	}
	return harperVersionMemo;
}

/** The overview's `host` block. See the module header for what each figure does and does not mean. */
export function hostInfo() {
	return {
		hostname: safe(() => server.hostname),
		cpus: safe(() => os.availableParallelism?.() ?? os.cpus().length),
		totalMemory: safe(() => os.totalmem()),
		...memory(),
		loadavg: safe(() => os.loadavg()),
		// The Harper PROCESS's uptime (process-wide even from a worker thread), so a restart shows as a
		// reset here. A recycled worker thread does not reset it.
		uptimeSec: safe(() => Math.round(process.uptime())),
		pluginVersion: pluginVersion(),
		harperVersion: harperVersion(),
		nodeVersion: safe(() => process.version),
	};
}
