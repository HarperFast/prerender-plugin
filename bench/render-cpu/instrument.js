/**
 * Measurement plumbing: what we sent over CDP, and what Chrome burned doing it.
 *
 * Three instruments, because each one lies on its own:
 *
 *  - `cdpCounter` counts protocol messages. A message is not a cost — most are sub-millisecond —
 *    but the COUNT is the thing "reduce the number of CDP calls" asks about, and it is exact.
 *  - `page.metrics()` (CDP `Performance.getMetrics`) attributes MAIN-THREAD time to script, layout
 *    and style recalc. It is the only instrument that says WHERE in-page time went. It does not see
 *    the compositor, raster or network threads, so it always undercounts total CPU.
 *  - `processTreeCpu` reads the OS's own accounting for the whole Chrome process tree, which sees
 *    every thread. It cannot attribute anything, and it must be sampled while the page is still
 *    OPEN: each render gets its own browser context, whose renderer process exits at teardown and
 *    takes its CPU accounting with it.
 *
 * Read together they cross-check: if TaskDuration falls but tree CPU does not, the work moved to
 * another thread rather than disappearing.
 */

import { execFileSync } from 'node:child_process';
import { Connection } from 'puppeteer-core/lib/esm/puppeteer/cdp/Connection.js';

/** The counter the patched prototype writes into; swapped per run by `cdpCounter`. */
let active = null;
let patched = false;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/**
 * Patch the Connection prototype ONCE, before any browser is launched.
 *
 * It has to be the prototype, not an instance: the constructor does
 * `this.#transport.onmessage = this.onMessage.bind(this)`, so a per-instance override installed
 * later is never what the transport calls. Patching the prototype first means the bind picks our
 * method up. `_rawSend` is the single funnel every session's `send` goes through, so one patch
 * counts browser-wide traffic including per-target sessions.
 */
function patchConnection() {
	if (patched) return;
	patched = true;

	const rawSend = Connection.prototype._rawSend;
	Connection.prototype._rawSend = function (callbacks, method, params, sessionId, options) {
		if (active) bump(active.sent, method);
		return rawSend.call(this, callbacks, method, params, sessionId, options);
	};

	const onMessage = Connection.prototype.onMessage;
	Connection.prototype.onMessage = function (message) {
		if (active) {
			// Deliberately NOT JSON.parse: a single postProcess return is multiple megabytes and
			// parsing it here would add that cost to every measured render. The method name is in the
			// first few dozen bytes of an event, and a command RESULT has no `method` at all — which
			// is how the two are told apart.
			const head = typeof message === 'string' ? message.slice(0, 200) : '';
			const m = /"method"\s*:\s*"([^"]+)"/.exec(head);
			if (m) bump(active.events, m[1]);
			else bump(active.events, '<command-result>');
			active.bytesIn += typeof message === 'string' ? message.length : 0;
		}
		return onMessage.call(this, message);
	};
}

/**
 * Start counting. Returns a handle whose `stop()` yields the totals. Counting is global (one
 * browser at a time), which the bench guarantees by running renders single-flight.
 */
export function cdpCounter() {
	patchConnection();
	const counter = { sent: new Map(), events: new Map(), bytesIn: 0 };
	active = counter;
	return {
		stop() {
			if (active === counter) active = null;
			const sum = (map) => [...map.values()].reduce((a, b) => a + b, 0);
			return {
				sent: sum(counter.sent),
				events: sum(counter.events) - (counter.events.get('<command-result>') ?? 0),
				commandResults: counter.events.get('<command-result>') ?? 0,
				bytesIn: counter.bytesIn,
				bySent: Object.fromEntries([...counter.sent].sort((a, b) => b[1] - a[1])),
				byEvent: Object.fromEntries([...counter.events].sort((a, b) => b[1] - a[1])),
			};
		},
	};
}

/** `[[dd-]hh:]mm:ss[.cc]` (ps TIME) → seconds. */
function parsePsTime(value) {
	const text = value.trim();
	if (!text) return 0;
	const [dayPart, rest] = text.includes('-') ? text.split('-') : [null, text];
	const parts = rest.split(':').map(Number);
	let seconds = parts.pop() ?? 0;
	let minutes = parts.pop() ?? 0;
	let hours = parts.pop() ?? 0;
	if (dayPart) hours += Number(dayPart) * 24;
	return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Cumulative CPU seconds of `rootPid` and every descendant, from one `ps` snapshot.
 *
 * Chrome is a process tree — browser, renderer(s), GPU, network, utility — and the work we are
 * trying to cut (layout, raster, script) happens in the RENDERER, a child. Summing the tree is the
 * only reading that covers threads `Performance.getMetrics` cannot see.
 */
export function processTreeCpu(rootPid) {
	if (!rootPid) return null;
	let out;
	try {
		// `-ww` + `command=` so the FULL argv survives: Chrome's own `--type=` is the only thing that
		// says whether a CPU second went to the renderer, the GPU process, the network service or a
		// utility, and `--renderer-client-id` separates one render's renderer from another's. Without
		// it the tree is one number that attributes nothing (the old behaviour).
		out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,time=,rss=,command='], {
			encoding: 'utf8',
			maxBuffer: 32 << 20,
		});
	} catch {
		return null; // no ps (or not permitted) — the other two instruments still work
	}
	const children = new Map();
	const cpu = new Map();
	const rss = new Map();
	const argv = new Map();
	for (const line of out.split('\n')) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const pid = Number(m[1]);
		const ppid = Number(m[2]);
		cpu.set(pid, parsePsTime(m[3]));
		rss.set(pid, Number(m[4]));
		argv.set(pid, m[5]);
		if (!children.has(ppid)) children.set(ppid, []);
		children.get(ppid).push(pid);
	}
	if (!cpu.has(rootPid)) return null;
	let total = 0;
	let processes = 0;
	let rssKb = 0;
	const byType = new Map();
	const clientIds = new Set();
	const stack = [rootPid];
	while (stack.length) {
		const pid = stack.pop();
		const seconds = cpu.get(pid) ?? 0;
		const kb = rss.get(pid) ?? 0;
		total += seconds;
		rssKb += kb;
		processes++;
		const bucket = chromeProcessType(pid === rootPid ? null : argv.get(pid));
		const acc = byType.get(bucket) ?? { cpuSeconds: 0, rssKb: 0, processes: 0 };
		acc.cpuSeconds += seconds;
		acc.rssKb += kb;
		acc.processes++;
		byType.set(bucket, acc);
		const clientId = /--renderer-client-id=(\d+)/.exec(argv.get(pid) ?? '');
		if (clientId) clientIds.add(clientId[1]);
		for (const child of children.get(pid) ?? []) stack.push(child);
	}
	// Process count and RSS ride along because on this fleet a CPU win that costs memory is not a win,
	// and because the process count answers "are cross-origin frames getting their own renderer?"
	// without touching a Chrome flag.
	return {
		cpuSeconds: total,
		processes,
		rssMb: Math.round(rssKb / 1024),
		byType: Object.fromEntries(
			[...byType]
				.sort((a, b) => b[1].cpuSeconds - a[1].cpuSeconds)
				.map(([k, v]) => [
					k,
					{ cpuSeconds: Number(v.cpuSeconds.toFixed(2)), rssMb: Math.round(v.rssKb / 1024), processes: v.processes },
				])
		),
		rendererClientIds: clientIds.size,
	};
}

/**
 * Which Chrome process is this. Chrome puts `--type=<kind>` on every child it spawns and nothing on
 * the browser process itself; the network service and the storage service are both `--type=utility`
 * and are told apart by `--utility-sub-type=`, which is where a surprising amount of a render's CPU
 * can sit when every response is being fulfilled over CDP.
 */
function chromeProcessType(command) {
	if (!command) return 'browser';
	const type = /--type=([\w-]+)/.exec(command);
	if (!type) return 'browser';
	if (type[1] === 'utility') {
		const sub = /--utility-sub-type=([\w.-]+)/.exec(command);
		if (sub) return `utility:${sub[1].replace(/\.mojom\..*$/, '')}`;
		return 'utility';
	}
	return type[1];
}

/**
 * Read `Performance.getMetrics` through PUPPETEER'S OWN session, not a fresh one.
 *
 * `page.metrics()` filters the result to a fixed allowlist and drops the four counters that matter
 * most here — TaskOtherDuration, V8CompileDuration, DevToolsCommandDuration and ProcessTime. A CDP
 * session of our own is no use either: the Performance agent starts accumulating at `enable()`, so
 * a session opened after the render reports a few idle microseconds. Puppeteer enables the domain
 * at page creation, so its session is the one whose counters span the whole render.
 */
export async function readMetrics(page) {
	const frame = page.mainFrame();
	const client = frame.client ?? frame._client?.();
	if (!client) return {};
	const { metrics } = await client.send('Performance.getMetrics');
	return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** The counters worth reporting, renamed to what they actually mean. */
export function pageMetrics(metrics) {
	if (!metrics) return {};
	return {
		taskMs: Math.round((metrics.TaskDuration ?? 0) * 1000),
		// TaskOther is task time that is neither script, layout nor style recalc — parsing, DOM
		// construction, and the per-response work of every fulfilled request. On the first baseline
		// it was 95% of main-thread time, which is why it is reported rather than inferred.
		taskOtherMs: Math.round((metrics.TaskOtherDuration ?? 0) * 1000),
		// MAIN-THREAD compile only, and sub-millisecond even for a megabyte of bundles — V8 streams and
		// compiles script on background threads inside the renderer, and lazily. Reported to two
		// decimals so "0" is visibly a real zero rather than a rounded number, but the instrument that
		// can see compile work is processTreeCpu, not this counter.
		v8CompileMs: Number(((metrics.V8CompileDuration ?? 0) * 1000).toFixed(2)),
		// Main-thread time spent servicing CDP commands — what "a CDP call costs", measured inside
		// the renderer rather than inferred from a message count.
		devtoolsMs: Math.round((metrics.DevToolsCommandDuration ?? 0) * 1000),
		// Main-thread CPU, and whole-renderer-process CPU, as the renderer itself accounts for them.
		threadTimeMs: Math.round((metrics.ThreadTime ?? 0) * 1000),
		processTimeMs: Math.round((metrics.ProcessTime ?? 0) * 1000),
		layoutObjects: metrics.LayoutObjects ?? 0,
		resources: metrics.Resources ?? 0,
		scriptMs: Number(((metrics.ScriptDuration ?? 0) * 1000).toFixed(1)),
		layoutMs: Math.round((metrics.LayoutDuration ?? 0) * 1000),
		recalcStyleMs: Math.round((metrics.RecalcStyleDuration ?? 0) * 1000),
		layoutCount: metrics.LayoutCount ?? 0,
		recalcStyleCount: metrics.RecalcStyleCount ?? 0,
		nodes: metrics.Nodes ?? 0,
		jsHeapMb: Math.round((metrics.JSHeapUsedSize ?? 0) / (1 << 20)),
	};
}

/** Median of a numeric list (nulls dropped). Reported instead of a mean: one GC pause skews a mean. */
export function median(values) {
	const list = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
	if (!list.length) return null;
	const mid = list.length >> 1;
	return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
}
