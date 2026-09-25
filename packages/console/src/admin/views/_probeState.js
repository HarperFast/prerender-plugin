/**
 * The change probe's state, derived: what each node's probe is doing now, when it runs next, and
 * which health conditions hold. Pure functions over the plugin's `change-probe` payload — no DOM —
 * so every rule here is tested directly (test/probeState.test.js) and the view only draws.
 *
 * WHY THIS IS A SEPARATE MODULE. The panel it feeds exists because the old one answered "what is the
 * probe doing" with the LAST pass that ended, beside a bare "running": for the nine hours an anchored
 * pass runs, every number on it was yesterday's, and an operator once read a pre-deploy pass's
 * failures as the new release's. The logic that keeps "now" and "last" apart, and that says which
 * numbers a node's plugin cannot report, is the substance of the fix — it earns its own tests.
 *
 * EVERY TIME IS THE NODE'S. Ages and ETAs are computed against `nodeClock`, which is the node's own
 * `serverTime` (plugin v0.91.0) carried forward by however long ago the payload was fetched — not
 * against the browser's clock, which can be minutes off and would make a healthy heartbeat look late.
 *
 * OLDER PLUGINS ARE A FIRST-CLASS CASE. A node below v0.91.0 (`statusVersion` absent) reports no
 * running-pass counters, no start time for the running pass and no next run. Those read as
 * UNAVAILABLE here, never as zero: a blank rendered as 0 is how a missing signal reads as healthy.
 */

import { duration } from '../ui.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The plugin version that first reported each pass field, for "not reported by this node" notes. */
export const SINCE = Object.freeze({
	running: '0.91.0',
	startedBy: '0.91.0',
	nextRunAt: '0.91.0',
	outOfScope: '0.89.0',
	caughtUp: '0.88.0',
	ignored: '0.88.0',
	slotChanges: '0.88.0',
	fieldMismatch: '0.88.0',
	fieldGuard: '0.88.0',
	extended: '0.86.0',
	queued: '0.71.0',
	triggerQueueDepth: '0.71.0',
	rebaselined: '0.65.0',
	behindBatches: '0.60.0',
	pageMismatch: '0.58.0',
	fresh: '0.56.0',
	throttled: '0.56.0',
});

// Thresholds, each named for the decision it makes.
/** Above this share of failed probes the rule no longer fits the endpoint (the plugin logs it too). */
export const FAILURE_BAD = 0.5;
/** Above this share failures are no longer the background noise of a healthy origin. */
export const FAILURE_WARN = 0.1;
/** Pushback above this share of probes is the origin shedding load, not a stray timeout. */
export const PUSHBACK_WARN = 0.01;
/** A re-baselined share above this is a rule edit, not the odd legacy row. */
export const REBASELINE_WARN = 0.05;
/** Trigger-queue depth above this share of `maxPending` is close to deferring detected changes. */
export const QUEUE_NEAR_FULL = 0.8;
/** A partial pass must have probed this many before its failure share means anything. */
const MIN_SAMPLE = 200;

export const SEVERITY_RANK = { bad: 3, warn: 2, info: 1 };

/** Epoch ms from a number or an ISO string, or null. */
export const msOf = (value) => {
	if (value === null || value === undefined || value === '') return null;
	const n = typeof value === 'number' ? value : Date.parse(value);
	return Number.isFinite(n) ? n : null;
};

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Every node's own payload. Under the cluster merge that is `perNode` (console v0.16.0+); at node
 * scope the status IS the one node's payload.
 */
export const nodeBodies = (status) => {
	if (Array.isArray(status?.perNode)) {
		return status.perNode.map((body) => ({ hostname: body.hostname ?? body.node ?? '?', body }));
	}
	return status ? [{ hostname: status.node ?? 'this node', body: status }] : [];
};

/**
 * "Now" on the node's clock: its `serverTime`, carried forward by the time since the payload was
 * fetched. Falls back to the browser clock for a plugin that does not send one.
 */
export const nodeClock = (body, fetchedAt, now = Date.now()) =>
	Number.isFinite(body?.serverTime) && Number.isFinite(fetchedAt) ? body.serverTime + (now - fetchedAt) : now;

/**
 * The next instant after `now` at which the wall clock in `timeZone` reads `anchorTime` ("HH:MM"),
 * or null when either cannot be resolved.
 *
 * The console computes this ONLY for a node whose plugin does not publish it (before v0.91.0 the
 * published value was null on every worker but the scheduler's — #176). The offset is taken at the
 * candidate instant rather than at `now`, so a DST change between now and the anchor lands right.
 */
export function nextAnchorAt(anchorTime, timeZone, now) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(String(anchorTime ?? '').trim());
	if (!match || !Number.isFinite(now)) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	let format;
	try {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone: timeZone || 'UTC',
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
		});
	} catch {
		return null;
	}
	// The zone's wall clock at `t`, as if it were UTC, to the minute.
	const wall = (t) => {
		const parts = Object.fromEntries(format.formatToParts(new Date(t)).map((part) => [part.type, part.value]));
		return Date.UTC(
			Number(parts.year),
			Number(parts.month) - 1,
			Number(parts.day),
			Number(parts.hour) % 24,
			Number(parts.minute)
		);
	};
	const offsetAt = (t) => wall(t) - (t - (((t % MINUTE) + MINUTE) % MINUTE));
	const today = new Date(wall(now));
	for (let day = 0; day <= 2; day++) {
		const guess = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hours, minutes);
		let at = guess - offsetAt(guess);
		at = guess - offsetAt(at);
		if (at > now) return at;
	}
	return null;
}

/**
 * The probe settings a node runs with: its own (v0.91.0 reports them) or the console's config read,
 * which is the best available for an older plugin. `source` says which, because a setting read from
 * the config endpoint is what the config SAYS, not what the node reports it is running.
 */
const settingsFor = (body, fallback) =>
	body?.settings ? { ...body.settings, source: 'node' } : fallback ? { ...fallback, source: 'config' } : null;

/** A pass record that walked its whole slice — the only kind whose `matched` can size the next. */
const completed = (run) => Boolean(run) && !run.error && !run.aborted && Number.isFinite(run.matched);

/**
 * When a node's next sweep starts.
 *
 * `source` is 'node' when the plugin published it, 'config' when the console computed it from the
 * anchor settings (older plugin, anchored mode), 'estimate' when it is extrapolated from the last
 * pass's start (older plugin, interval mode). `basis` is what drives it: 'anchor', 'interval',
 * 'startup', 'continuous', or null when nothing is armed.
 */
function nextRunOf(body, settings, version, now) {
	const sweep = body?.sweep ?? {};
	if (version >= 2) {
		return { at: msOf(sweep.nextRunAt), basis: sweep.nextRunBasis ?? null, source: 'node' };
	}
	const armed = sweep.armedInterval ?? null;
	if (armed === null) return { at: null, basis: null, source: null };
	const mode = body?.mode ?? settings?.mode ?? null;
	if (mode === 'anchored' || (typeof armed === 'string' && armed.startsWith('anchored:'))) {
		const published = msOf(sweep.nextAnchoredRunAt);
		if (published !== null) return { at: published, basis: 'anchor', source: 'node' };
		// Before v0.91.0 this field was module state on the scheduler's worker, so every other
		// worker answered null (#176). The anchor itself is in the config.
		const [time, zone] = typeof armed === 'string' ? armed.slice('anchored:'.length).split('|') : [];
		const at = nextAnchorAt(time || settings?.anchorTime, zone || settings?.anchorTimezone, now);
		return { at, basis: 'anchor', source: at === null ? null : 'config' };
	}
	if (armed === 'continuous' || mode === 'continuous') return { at: null, basis: 'continuous', source: 'node' };
	const every = Number(armed);
	const lastStart = msOf(sweep.lastRun?.startedAt);
	if (every > 0 && lastStart !== null) {
		const at = lastStart + Math.max(1, Math.ceil((now - lastStart) / every)) * every;
		return { at, basis: 'interval', source: 'estimate' };
	}
	return { at: null, basis: 'interval', source: null };
}

/**
 * One node's probe, described.
 *
 * `state` is exactly one of:
 *   running     a sweep holds the row and is heartbeating
 *   stalled     the row claims a sweep whose heartbeat stopped (plugin v0.91.0 can say so)
 *   idle        armed, between passes
 *   disabled    `changeProbe.enabled` is false
 *   no-rules    enabled, but no rule compiled — nothing is armed
 *   unreadable  the state row could not be read: everything about this node is unknown
 */
export function describeNode(
	body,
	{ hostname = body?.node ?? 'this node', now = Date.now(), fallbackSettings = null } = {}
) {
	const version = Number.isFinite(body?.statusVersion) ? body.statusVersion : 1;
	const settings = settingsFor(body, fallbackSettings);
	const mode = body?.mode ?? settings?.mode ?? null;
	const sweep = body?.sweep ?? {};
	const current = sweep.current ?? null;
	const progress = sweep.progress ?? null;
	const last = sweep.lastRun ?? null;
	const heartbeat = body?.heartbeat ?? { intervalMs: 30_000, staleAfterMs: 5 * MINUTE };
	const stateUpdatedAt = msOf(body?.stateUpdatedAt);
	const rowAgeMs = stateUpdatedAt === null ? null : Math.max(0, now - stateUpdatedAt);

	let state = 'idle';
	if (body?.stateAvailable === false) state = 'unreadable';
	else if (sweep.running) state = 'running';
	else if (current?.stale) state = 'stalled';
	else if (body?.enabled === false) state = 'disabled';
	else if (!(body?.rules ?? []).length) state = 'no-rules';

	let running = null;
	if (state === 'running' || state === 'stalled') {
		const startedAt = msOf(current?.startedAt);
		// Before v0.91.0 the running pass's own heartbeat was not reported, but the row's `updatedAt`
		// is bumped by every heartbeat — the best available reading of "last heard from".
		const heartbeatAt = msOf(current?.heartbeatAt) ?? (version < 2 && state === 'running' ? stateUpdatedAt : null);
		const heartbeatAgeMs = heartbeatAt === null ? null : Math.max(0, now - heartbeatAt);
		const lateAfterMs = Math.max(4 * (heartbeat.intervalMs ?? 30_000), 2 * MINUTE);
		const examined = finite(progress?.examined) ?? finite(progress?.examinedApprox);
		const matched = finite(progress?.matched);
		const probed = finite(progress?.probed);
		const slice = finite(current?.sliceEstimate) ?? (completed(last) ? last.matched : null);
		const fraction = matched !== null && slice > 0 ? Math.min(0.999, matched / slice) : null;
		// Counters are as of the last heartbeat, so the elapsed time they cover ends there.
		const countersAt = msOf(current?.heartbeatAt);
		const elapsedMs = startedAt !== null && countersAt !== null ? Math.max(0, countersAt - startedAt) : null;
		const avgRate = probed !== null && elapsedMs > 0 ? probed / (elapsedMs / 1000) : null;
		const phase = current?.phase ?? progress?.phase ?? null;
		let etaAt = null;
		let etaBasis = null;
		if (phase === 'draining') {
			const depth = finite(progress?.triggerQueueDepth);
			const rate = finite(settings?.trigger?.ratePerSecond);
			if (depth !== null && rate > 0 && countersAt !== null) {
				etaAt = countersAt + (depth / rate) * 1000;
				etaBasis = 'draining';
			}
		} else if (fraction !== null && matched > 0 && elapsedMs >= MINUTE) {
			etaAt = Math.max(countersAt, startedAt + elapsedMs / (matched / slice));
			etaBasis = 'slice';
		}
		running = {
			startedAt,
			heartbeatAt,
			heartbeatAgeMs,
			heartbeatLate: state === 'running' && heartbeatAgeMs !== null && heartbeatAgeMs > lateAfterMs,
			lateAfterMs,
			staleAfterMs: heartbeat.staleAfterMs ?? 5 * MINUTE,
			startedBy: current?.startedBy ?? null,
			dryRun: typeof current?.dryRun === 'boolean' ? current.dryRun : null,
			label: current?.label ?? null,
			phase,
			// Older plugins publish only a rounded count of rows walked.
			hasCounters: finite(progress?.examined) !== null,
			examined,
			examinedApprox: finite(progress?.examined) === null && examined !== null,
			matched,
			probed,
			slice,
			sliceSource: finite(current?.sliceEstimate) !== null ? 'node' : slice !== null ? 'last pass' : null,
			fraction,
			elapsedMs,
			avgRate,
			recentRate: finite(progress?.recentRate),
			etaAt,
			etaBasis,
			progress,
		};
	}

	const finishedAt = msOf(last?.finishedAt);
	const lastStartedAt = msOf(last?.startedAt);
	const lastPass = last
		? {
				record: last,
				finishedAt,
				startedAt: lastStartedAt,
				durationMs: finishedAt !== null && lastStartedAt !== null ? finishedAt - lastStartedAt : null,
				agoMs: finishedAt === null ? null : Math.max(0, now - finishedAt),
				outcome: last.error ? 'error' : last.abortedOnDistress ? 'gave-up' : last.aborted ? 'interrupted' : 'complete',
			}
		: null;

	return {
		hostname,
		version,
		state,
		mode,
		dryRun: body?.dryRun,
		enabled: body?.enabled,
		armed: sweep.armedInterval ?? null,
		settings,
		now,
		rowAgeMs,
		stateUpdatedAt,
		running,
		next:
			state === 'disabled' || state === 'no-rules'
				? { at: null, basis: null, source: null }
				: nextRunOf(body, settings, version, now),
		last: lastPass,
		canary: body?.canary ?? null,
		body,
	};
}

// ---------------------------------------------------------------- health flags

const pctText = (part, whole) => {
	if (!(whole > 0)) return '—';
	const share = (part / whole) * 100;
	return share > 0 && share < 0.1 ? '<0.1%' : `${share < 10 ? share.toFixed(1) : Math.round(share)}%`;
};
const count = (n) => Number(n ?? 0).toLocaleString();
const list = (nodes) => nodes.join(', ');

/** One flag. `summary(nodes)` names every node the grouped flag covers; `detail` is this node's line. */
const flag = (id, severity, summary, detail = null) => ({ id, severity, summary, detail });

/**
 * The health conditions that hold on ONE node, each worded so it needs no interpretation. Pure:
 * `desc` is `describeNode`'s result.
 */
export function nodeFlags(desc) {
	const flags = [];
	const { hostname: node, running, last, settings, now } = desc;
	const add = (f) => flags.push({ ...f, node });

	if (desc.state === 'unreadable') {
		add(
			flag(
				'state-unreadable',
				'bad',
				(nodes) =>
					`The change-probe state row could not be read on ${list(nodes)}. Running or not, last pass, schedule — ` +
					'all unknown, not idle: the sweep may well be running. The node’s log says why the read failed.'
			)
		);
		return flags;
	}

	if (desc.state === 'stalled') {
		add(
			flag(
				'stalled',
				'bad',
				(nodes) =>
					`A sweep stopped heartbeating on ${list(nodes)} and is presumed dead (its worker crashed or restarted). ` +
					'Nothing needs restarting: the next scheduled pass takes the claim over.',
				`${node}: last heartbeat ${ago(running?.heartbeatAt, now)}${running?.startedAt ? `, started ${ago(running.startedAt, now)}` : ''}`
			)
		);
	}
	if (running?.heartbeatLate) {
		add(
			flag(
				'heartbeat-late',
				'warn',
				(nodes) =>
					`The running sweep’s heartbeat is late on ${list(nodes)}. A healthy pass beats about every 30s; at ` +
					`${duration(running.staleAfterMs)} of silence it is presumed dead and the claim becomes takeable.`,
				`${node}: last heard ${ago(running.heartbeatAt, now)}`
			)
		);
	}

	// Pass outcomes, for the last pass that ENDED and — separately labelled — the one running now.
	const passes = [];
	if (last?.record) passes.push({ label: 'last sweep', run: last.record });
	if (running?.hasCounters && (running.probed ?? 0) >= MIN_SAMPLE)
		passes.push({ label: 'running sweep', run: running.progress, live: true });

	for (const { label, run, live } of passes) {
		const probed = finite(run.probed) ?? 0;
		const failed = finite(run.failed) ?? 0;
		const share = probed > 0 ? failed / probed : null;
		if (share !== null && share > FAILURE_WARN) {
			const bad = share > FAILURE_BAD;
			add(
				flag(
					bad ? 'failures-dominate' : 'failures-high',
					bad ? 'bad' : 'warn',
					(nodes) =>
						bad
							? `Most probes are failing on ${list(nodes)} — the shape a changed endpoint or markup makes. A failed ` +
								'probe changes nothing, so those pages are back on interval-only freshness until the rule fits again.'
							: `Probe failures are above ${Math.round(FAILURE_WARN * 100)}% on ${list(nodes)} — well past the ` +
								'background noise of a healthy origin. The failure samples below say what the origin answered.',
					`${node} (${label}): ${count(failed)} of ${count(probed)} failed (${pctText(failed, probed)})`
				)
			);
		}
		const throttled = finite(run.throttled) ?? 0;
		const heavy = probed > 0 && throttled / probed >= PUSHBACK_WARN;
		// A trace of pushback is worth one line from the last finished pass, not a second from the
		// running one; pushback heavy enough to matter is flagged from whichever pass shows it.
		if (throttled > 0 && (heavy || !live)) {
			add(
				flag(
					heavy ? 'pushback' : 'pushback-trace',
					heavy ? 'warn' : 'info',
					(nodes) =>
						heavy
							? `The origin pushed back on ${list(nodes)} (429/502/503/504 or timeouts) — it is asking for room. ` +
								'Take it to whoever runs the origin before raising changeProbe.ratePerSecond.'
							: `A trace of origin pushback on ${list(nodes)} — a handful of timeouts, well under ` +
								`${Math.round(PUSHBACK_WARN * 100)}% of probes. Normal for a healthy origin; worth a look only if it grows.`,
					`${node} (${label}): ${count(throttled)} of ${count(probed)} probes (${pctText(throttled, probed)})`
				)
			);
		}
		const level = finite(run.throttleLevel) ?? 1;
		if (level > 1) {
			add(
				flag(
					'backoff',
					'bad',
					(nodes) =>
						`The origin backoff is engaged on ${list(nodes)}: the sweep is pacing slower than its configured rate, ` +
						'so it covers the slice more slowly than the settings say.',
					live
						? `${node}: pacing at ${level}× the normal window right now`
						: `${node}: the last sweep ended still backed off (${level}× normal)`
				)
			);
		}
		const rebaselined = finite(run.rebaselined) ?? 0;
		if (probed > 0 && rebaselined >= 100 && rebaselined / probed >= REBASELINE_WARN) {
			add(
				flag(
					'rebaselined',
					'warn',
					(nodes) =>
						`A large share of rows were re-baselined on ${list(nodes)} — their stored baseline was taken under a ` +
						'different rule (a rule edit). They were stored, not compared, so a change on them this pass went undetected.',
					`${node} (${label}): ${count(rebaselined)} of ${count(probed)} (${pctText(rebaselined, probed)})`
				)
			);
		}
		const deferred = finite(run.deferred) ?? 0;
		if (deferred > 0) {
			add(
				flag(
					'deferred',
					'warn',
					(nodes) =>
						`Detected changes were deferred on ${list(nodes)} — past maxTriggersPerSweep or a full trigger queue. ` +
						'Their baselines stay stale, so the next pass re-detects and retries them; until then those pages wait.',
					`${node} (${label}): ${count(deferred)} deferred`
				)
			);
		}
		const maxPending = finite(settings?.trigger?.maxPending);
		const depth = finite(run.triggerQueueDepth);
		if (maxPending > 0 && depth !== null && depth >= QUEUE_NEAR_FULL * maxPending) {
			add(
				flag(
					'queue-near-full',
					'warn',
					(nodes) =>
						`The trigger queue is close to changeProbe.trigger.maxPending on ${list(nodes)}. Past it, detected ` +
						'changes are refused and deferred for want of queue rather than of budget.',
					`${node} (${label}): ${count(depth)} of ${count(maxPending)}${live ? ' now' : ' at its deepest'}`
				)
			);
		}
		const behind = finite(run.behindBatches) ?? 0;
		if (desc.mode === 'continuous' && behind > 0) {
			add(
				flag(
					'cycle-behind',
					'warn',
					(nodes) =>
						`The continuous sweep cannot meet its cycle target on ${list(nodes)} at the agreed rate ceiling — ` +
						'the corpus has outgrown ratePerSecond, or cycleTarget is too ambitious.',
					`${node} (${label}): ${count(behind)} batches wanted more than ratePerSecond`
				)
			);
		}
	}

	if (last?.outcome === 'error') {
		add(
			flag('pass-error', 'bad', (nodes) => `The last sweep failed on ${list(nodes)}.`, `${node}: ${last.record.error}`)
		);
	}
	if (last?.outcome === 'gave-up') {
		add(
			flag(
				'gave-up',
				'bad',
				(nodes) =>
					`The last sweep STOPPED EARLY on ${list(nodes)}: the origin refused changeProbe.abortAfterDistress probes ` +
					'in a row — down, not busy. It covered only part of the slice; the next scheduled pass is the retry.',
				`${node}: gave up ${ago(last.finishedAt, now)}`
			)
		);
	}
	const unreadable = finite(last?.record?.unreadable) ?? 0;
	if (unreadable > 0) {
		add(
			flag(
				'unreadable-rows',
				'warn',
				(nodes) =>
					`Registry rows could not be decoded on ${list(nodes)} and the walk stepped over them — those targets are ` +
					'never probed. A storage-layer fault for the database team, not a setting here.',
				`${node}: ${count(unreadable)} rows`
			)
		);
	}
	const disarmed = [];
	for (const [rule, fields] of Object.entries(last?.record?.fieldGuard ?? {})) {
		for (const [field, entry] of Object.entries(fields ?? {}))
			if (entry?.armed === false) disarmed.push(`${rule} ${field}`);
	}
	if (disarmed.length) {
		add(
			flag(
				'field-disarmed',
				'bad',
				(nodes) =>
					`A mapped page field is DISARMED on ${list(nodes)}: it disagreed with the origin on too many witnessed ` +
					'comparisons to be a correct mapping. Its mismatches no longer trigger re-renders until the mapping is ' +
					'edited or the process restarts — check the extract path it reads.',
				`${node}: ${disarmed.join(', ')}`
			)
		);
	}

	// The schedule.
	const nextAt = desc.next.at;
	if (desc.mode === 'anchored' && desc.armed !== null) {
		if (desc.version >= 2 && desc.next.basis === 'anchor' && nextAt === null) {
			add(
				flag(
					'no-next-run',
					'bad',
					(nodes) =>
						`Anchored mode has no next run on ${list(nodes)} — anchorTime/anchorTimezone cannot be resolved, ` +
						'so nothing is armed (the canary keeps running). The plugin log names which setting.'
				)
			);
		}
		if (running && nextAt !== null) {
			if (now > nextAt) {
				add(
					flag(
						'overran-anchor',
						'bad',
						(nodes) =>
							`The sweep on ${list(nodes)} is still running past its next anchor, so that anchored run is skipped — ` +
							'the next pass starts at the anchor after this one ends.',
						`${node}: anchor was ${ago(nextAt, now)}`
					)
				);
			} else if (running.etaAt !== null && running.etaAt > nextAt) {
				add(
					flag(
						'will-overrun',
						'warn',
						(nodes) =>
							`At its current rate the sweep on ${list(nodes)} is projected to still be running at the next anchor, ` +
							'which would then be skipped.',
						`${node}: projected end ${ago(running.etaAt, now)}, next anchor ${ago(nextAt, now)}`
					)
				);
			}
		}
	}

	// A schedule that looks armed but has not produced a pass when it should have.
	if (desc.state === 'idle' && desc.armed !== null) {
		const allowance = scheduleAllowance(desc);
		if (last?.finishedAt && allowance !== null && now - last.finishedAt > allowance) {
			add(
				flag(
					'last-pass-old',
					'warn',
					(nodes) =>
						`The last completed sweep on ${list(nodes)} is older than the schedule allows — a pass that should ` +
						'have run did not finish. Check the node’s log for the pass that ran (or failed to start).',
					`${node}: finished ${ago(last.finishedAt, now)}; the ${desc.mode ?? 'interval'} schedule implies at most ${duration(allowance)}`
				)
			);
		}
		if (!last) {
			add(
				flag(
					'never-swept',
					'info',
					(nodes) =>
						`No sweep has finished on ${list(nodes)} yet — their slice is missing from every pass figure below.`
				)
			);
		}
	}

	const perRule = desc.canary?.lastRun?.perRule ?? [];
	const tripped = perRule.filter((entry) => entry.tripped).map((entry) => entry.rule);
	if (tripped.length) {
		add(
			flag(
				'canary-tripped',
				'info',
				(nodes) =>
					`The canary’s last pass tripped on ${list(nodes)} — a mass change in that node’s cohort (see Canary).`,
				`${node}: ${tripped.join(', ')}`
			)
		);
	}
	return flags;
}

/**
 * How long after its last finish a healthy node's next sweep must have finished, or null when the
 * schedule gives no bound. Generous on purpose: this flag is for a pass that did not happen, not
 * for one that took a little longer.
 */
function scheduleAllowance(desc) {
	const s = desc.settings;
	if (desc.mode === 'anchored') return DAY + Math.max(12 * HOUR, finite(s?.anchorWindow) ?? 0);
	if (desc.mode === 'continuous') return finite(s?.cycleTarget) ? 2 * s.cycleTarget + HOUR : null;
	const every = finite(Number(desc.armed)) ?? finite(s?.sweepInterval);
	return every ? 2 * every + HOUR : null;
}

/** Cluster-wide findings: the nodes disagreeing with one another. */
export function clusterFlags(status, descs) {
	const flags = [];
	if (descs.length < 2) return flags;
	const disabled = descs.filter((d) => d.enabled === false).map((d) => d.hostname);
	if (disabled.length && disabled.length < descs.length) {
		flags.push(
			flag(
				'disabled-some',
				'bad',
				() =>
					`changeProbe.enabled is false on ${list(disabled)}. The URLs those nodes own are never probed, so their ` +
					'pages fall back to interval-only freshness while every cluster number keeps looking healthy.'
			)
		);
	}
	if (status?.rulesDiverge) {
		flags.push(
			flag(
				'rules-diverge',
				'bad',
				() =>
					'The nodes do not agree on the rule list (label, pattern, page check, or the rule fingerprint) — a deploy ' +
					'or an override that did not reach every node. The rules shown below are one node’s.'
			)
		);
	}
	const modes = [...new Set(descs.map((d) => d.mode).filter(Boolean))];
	if (modes.length > 1) {
		flags.push(
			flag(
				'mode-diverge',
				'bad',
				() => `The nodes run different sweep modes: ${descs.map((d) => `${d.hostname} ${d.mode ?? '?'}`).join(', ')}.`
			)
		);
	}
	if (status?.settingsDiverge) {
		flags.push(
			flag(
				'settings-diverge',
				'warn',
				() => 'The nodes report different probe settings — see Configuration below for which differ.'
			)
		);
	}
	const live = descs.filter((d) => d.dryRun === false).map((d) => d.hostname);
	if (live.length && live.length < descs.length) {
		flags.push(
			flag(
				'dry-run-split',
				'warn',
				() => `The probe acts (not dry run) on ${list(live)} only; the other nodes detect and trigger nothing.`
			)
		);
	}
	return flags;
}

/**
 * Flags grouped by condition, worst first: one entry per condition, naming every node it holds on,
 * with each node's own line under it.
 */
export function groupFlags(flags) {
	const groups = new Map();
	for (const f of flags) {
		const group = groups.get(f.id) ?? { id: f.id, severity: f.severity, nodes: [], details: [], summary: f.summary };
		if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[group.severity]) group.severity = f.severity;
		if (f.node && !group.nodes.includes(f.node)) group.nodes.push(f.node);
		if (f.detail) group.details.push(f.detail);
		groups.set(f.id, group);
	}
	return [...groups.values()]
		.map((group) => ({ ...group, text: group.summary(group.nodes) }))
		.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

// ---------------------------------------------------------------- formatting

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** "05:05 UTC", or with the date when it is not within the next/last 20 hours. */
export function fmtUtc(ms, now) {
	if (ms === null || ms === undefined) return '—';
	const d = new Date(ms);
	const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
	return Math.abs(ms - now) < 20 * HOUR
		? hm
		: `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hm}`;
}

/** The same instant on the reader's own clock. */
export function fmtLocal(ms, now) {
	if (ms === null || ms === undefined) return '—';
	const near = Math.abs(ms - now) < 20 * HOUR;
	return new Date(ms).toLocaleString(
		undefined,
		near
			? { hour: '2-digit', minute: '2-digit' }
			: { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
	);
}

/** "in 5h 8m" / "3m ago", against the node's clock. */
export function relative(ms, now) {
	if (ms === null || ms === undefined) return '—';
	return ms >= now ? `in ${duration(ms - now)}` : `${duration(now - ms)} ago`;
}

const ago = (ms, now) => relative(ms, now);

/** "00:05 local · 05:05 UTC (in 5h 8m)". */
export const fmtWhen = (ms, now) =>
	ms === null || ms === undefined ? '—' : `${fmtLocal(ms, now)} local · ${fmtUtc(ms, now)} (${relative(ms, now)})`;

/** Who started a pass, in words. */
export const STARTED_BY = Object.freeze({
	anchor: 'the daily anchor',
	interval: 'the sweep interval',
	continuous: 'the continuous loop',
	startup: 'the startup sweep',
	manual: 'an operator (manual run)',
	reseed: 'a canary trip (reseed)',
});
