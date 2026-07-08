import { readFileSync, readdirSync } from 'node:fs';
import { cpus } from 'node:os';

/**
 * Per-window CPU sampling for the render worker. There are N worker processes per container,
 * each with its own browser, so two scopes are measured and kept distinct:
 *
 *  - **Worker CPU** — THIS worker only: the Node process (`process.cpuUsage()`, free) plus its
 *    own Chrome process tree (the browser PID and all descendant renderer/GPU processes, summed
 *    from `/proc/<pid>/stat`). Self-contained and additive across workers, and it's the number
 *    that yields cores-per-render for tuning this worker's concurrency.
 *  - **Container CPU** — the whole pod, from the cgroup CPU accounting file. This is the same
 *    value for every worker in the container (they share the cgroup), so it's reported under a
 *    separate `container` key and must NOT be read as this worker's usage. It answers "are we
 *    saturating the container's cores?".
 *
 * A per-render CDP `Performance.getMetrics` call would measure one page's Chrome CPU with
 * per-render overhead; this is a handful of small procfile reads once per stats window.
 *
 * All `/proc` and cgroup reads degrade to null on a host without them (e.g. macOS dev), leaving
 * only Node CPU.
 */

// Linux clock ticks per second for utime/stime in /proc/<pid>/stat. USER_HZ is 100 on
// effectively all modern Linux kernels; sysconf(_SC_CLK_TCK) isn't exposed to Node.
const USER_HZ = 100;

const CGROUP_V2_USAGE = '/sys/fs/cgroup/cpu.stat';
const CGROUP_V2_MAX = '/sys/fs/cgroup/cpu.max';
const CGROUP_V1_USAGE = '/sys/fs/cgroup/cpuacct/cpuacct.usage';
const CGROUP_V1_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const CGROUP_V1_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

/** Total CPU microseconds consumed by the whole cgroup so far, or null if unreadable. */
function readCgroupUsageUsec(): number | null {
	try {
		const stat = readFileSync(CGROUP_V2_USAGE, 'utf8');
		const match = stat.match(/^usage_usec\s+(\d+)/m);
		if (match) return Number(match[1]);
	} catch {
		/* not cgroup v2 — fall through */
	}
	try {
		const ns = Number(readFileSync(CGROUP_V1_USAGE, 'utf8').trim());
		if (Number.isFinite(ns)) return Math.floor(ns / 1000);
	} catch {
		/* no cgroup CPU accounting available */
	}
	return null;
}

/**
 * The container's CPU-core limit, read once (it can't change without a pod restart). Falls back
 * to the host core count when the cgroup is unlimited or unreadable, so `utilization` keeps a
 * sensible denominator.
 */
function readLimitCores(): number {
	const hostCores = Math.max(1, cpus().length);
	try {
		const [quota, period] = readFileSync(CGROUP_V2_MAX, 'utf8').trim().split(/\s+/);
		if (quota !== 'max') {
			const cores = Number(quota) / Number(period);
			if (Number.isFinite(cores) && cores > 0) return cores;
		}
		return hostCores;
	} catch {
		/* not cgroup v2 — try v1 */
	}
	try {
		const quota = Number(readFileSync(CGROUP_V1_QUOTA, 'utf8').trim());
		const period = Number(readFileSync(CGROUP_V1_PERIOD, 'utf8').trim());
		if (quota > 0 && period > 0) return quota / period;
	} catch {
		/* no quota configured */
	}
	return hostCores;
}

/**
 * Cumulative CPU ticks of `rootPid` and all its descendants, or null if the root isn't
 * readable. Scans `/proc` once to build the parent→child map — Chrome renderers are children
 * (or grandchildren via a zygote) of the launched browser process.
 *
 * Each node contributes utime+stime AND cutime+cstime (the CPU of its reaped, exited children).
 * Chrome cycles renderer/utility processes constantly; counting only live processes would drop
 * an exited renderer's ticks out of the tree total, underreporting usage and producing negative
 * deltas across a window. A parent accumulates a child's full lifetime CPU into cutime/cstime
 * when it reaps the child, so including them keeps the tree total monotonic. No double count:
 * cutime/cstime cover only exited children, while live children are summed as their own nodes.
 */
function readProcTreeTicks(rootPid: number): number | null {
	let entries: string[];
	try {
		entries = readdirSync('/proc');
	} catch {
		return null; // no procfs (non-Linux)
	}

	const ticksOf = new Map<number, number>();
	const childrenOf = new Map<number, number[]>();

	for (const name of entries) {
		if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue; // fast numeric-only filter
		const pid = Number(name);
		if (!Number.isInteger(pid)) continue;
		let stat: string;
		try {
			stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		} catch {
			continue; // process exited between readdir and read
		}
		// The comm field (2) is wrapped in parens and may contain spaces/parens; parse the
		// fixed-position fields AFTER the last ')'. Post-comm indices (0-based): [0]=state,
		// [1]=ppid, [11]=utime, [12]=stime.
		const rparen = stat.lastIndexOf(')');
		if (rparen < 0) continue;
		const rest = stat.slice(rparen + 2).split(' ');
		const ppid = Number(rest[1]);
		const utime = Number(rest[11]);
		const stime = Number(rest[12]);
		// cutime/cstime: CPU of this process's reaped (exited) children — preserves the ticks of
		// Chrome renderers that came and went between samples.
		const cutime = Number(rest[13]);
		const cstime = Number(rest[14]);
		if (!Number.isFinite(utime) || !Number.isFinite(stime)) continue;
		ticksOf.set(pid, utime + stime + (Number.isFinite(cutime) ? cutime : 0) + (Number.isFinite(cstime) ? cstime : 0));
		if (Number.isFinite(ppid)) {
			const siblings = childrenOf.get(ppid);
			if (siblings) siblings.push(pid);
			else childrenOf.set(ppid, [pid]);
		}
	}

	if (!ticksOf.has(rootPid)) return null;

	// Iterative DFS over the subtree (avoids recursion on deep/adversarial trees).
	let total = 0;
	const stack = [rootPid];
	const seen = new Set<number>();
	while (stack.length) {
		const pid = stack.pop()!;
		if (seen.has(pid)) continue; // guard against pathological ppid cycles
		seen.add(pid);
		total += ticksOf.get(pid) ?? 0;
		const kids = childrenOf.get(pid);
		if (kids) stack.push(...kids);
	}
	return total;
}

type Sample = {
	tsMs: number;
	nodeUsec: number;
	cgroupUsec: number | null;
	browserPid: number | undefined;
	browserTicks: number | null;
};

export type CpuWindow = {
	/** Avg cores the Node process used this window. */
	nodeCores: number;
	/** Avg cores this worker's Chrome process tree used, or null if the tree wasn't readable. */
	browserCores: number | null;
	/** Node + browser — this worker's total, or null when the browser tree wasn't measurable. */
	workerCores: number | null;
	container: {
		limitCores: number;
		/** Avg cores busy across the WHOLE container (all workers), or null if cgroup unreadable. */
		usedCores: number | null;
		/** usedCores / limitCores, 0..1, or null. */
		utilization: number | null;
	};
};

const round2 = (n: number) => Number(n.toFixed(2));

export class CpuSampler {
	private readonly limitCores: number;
	private last: Sample;

	/** @param getBrowserPid read fresh each sample — the browser is relaunched on retirement, so the PID changes. */
	constructor(private readonly getBrowserPid: () => number | undefined) {
		this.limitCores = readLimitCores();
		this.last = this.sample();
	}

	private sample(): Sample {
		const node = process.cpuUsage();
		const browserPid = this.getBrowserPid();
		return {
			tsMs: Date.now(),
			nodeUsec: node.user + node.system,
			cgroupUsec: readCgroupUsageUsec(),
			browserPid,
			browserTicks: browserPid !== undefined ? readProcTreeTicks(browserPid) : null,
		};
	}

	/** Consume the interval since the last call and reset the baseline. */
	next(): CpuWindow {
		const prev = this.last;
		const cur = this.sample();
		this.last = cur;

		const windowSec = Math.max(0.001, (cur.tsMs - prev.tsMs) / 1000);

		const nodeCores = round2((cur.nodeUsec - prev.nodeUsec) / 1e6 / windowSec);

		// Browser delta is only meaningful when the PID is unchanged across the window; a
		// relaunch (browser retirement) resets the tree, so that window is reported as null
		// rather than a bogus negative — the next full window is accurate. cutime/cstime keep the
		// tree total monotonic for a stable PID, but a still-unreaped exiting renderer can briefly
		// shrink it, so a negative delta is also reported as null rather than a nonsensical value.
		let browserCores: number | null = null;
		if (
			cur.browserPid !== undefined &&
			cur.browserPid === prev.browserPid &&
			cur.browserTicks !== null &&
			prev.browserTicks !== null
		) {
			const deltaTicks = cur.browserTicks - prev.browserTicks;
			if (deltaTicks >= 0) browserCores = round2(deltaTicks / USER_HZ / windowSec);
		}

		const usedCores =
			cur.cgroupUsec !== null && prev.cgroupUsec !== null
				? round2((cur.cgroupUsec - prev.cgroupUsec) / 1e6 / windowSec)
				: null;

		return {
			nodeCores,
			browserCores,
			workerCores: browserCores !== null ? round2(nodeCores + browserCores) : null,
			container: {
				limitCores: round2(this.limitCores),
				usedCores,
				utilization: usedCores !== null ? Number((usedCores / this.limitCores).toFixed(3)) : null,
			},
		};
	}
}
