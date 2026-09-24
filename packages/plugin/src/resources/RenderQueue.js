import { getMutex } from '../util/coordination.js';
import { config, onConfigApplied } from '../config.js';
import { currentMinuteMs } from '../util/time.js';
import { QueueState } from './QueueState.js';
import { CacheKey } from '../util/cacheKey.js';
import { sanitizeDeviceType } from '../util/device_type.js';
import { canonicalizeUrl } from '../util/url.js';
import {
	classifyPath,
	queryAllowlistFor,
	resolveEffectiveInterval,
	resolveRenderInterval,
	PRERENDER,
} from '../util/routeClass.js';
import { decideInterval } from '../util/demandLadder.js';
import { hasObservations, recordReadinessExpectation } from '../util/readinessExpectation.js';
import { recordPageClaim } from '../util/changeProbe.js';
import { backoffWait } from '../util/failureBackoff.js';
import { recordUnroutedPath } from '../util/unrouted.js';
import { metrics } from '../metrics.js';
import { Target, countedStrikes } from './Target.js';
import { getDesiredPause, setDesiredPause } from '../util/queueControl.js';
import { getResidencyByUrl } from '../util/residency.js';
import {
	claimSchedules,
	sweepReadySet,
	deleteSchedule,
	deriveQueueStatus,
	getScheduleRow,
	maybeResetFloor,
	reconcileLeaseGauge,
	releaseLease,
	resetFloorNow,
	writeSchedule,
} from '../util/renderSchedule.js';

const protocol = server.hostname === 'localhost' ? 'http' : 'https';
const port = protocol === 'https' ? server.config.http.securePort || server.config.http.port : server.config.http.port;

// The `RenderSchedule` table is deliberately NOT destructured here. Every read, write and delete
// of it goes through `util/renderSchedule.js`, which owns the due-time write and the claim-floor
// lowering together — a raw write from this file would file a row behind the floor and silently
// end that URL's rendering. `test/queueFunnel.test.js` enforces that mechanically.

const mutex = getMutex('render_queue');

// Rate limit for the wedged-row warning below. Per worker, which is the cheap and correct-enough
// direction: the pin AGE it gates on is node-wide (it lives in the shared header), so every worker
// agrees about when to start warning, and the worst case is one message per worker per window rather
// than one per node. Sharing a timestamp across workers would mean another header word and a CAS to
// suppress log lines.
let lastFloorPinWarnAt = 0;

// Browsers ≥ v1.16.0 post `outcome` — the single field result handling keys on: 'rendered'
// (content present; a rendered-through client-side redirect is still a rendered page),
// 'redirected' (ended at navigation, no content), 'non-indexable' (the page said don't), or
// 'error'. Older browsers don't post it; infer it from the legacy signals with the same
// precedence the old condition chain applied, so a mixed fleet lands in the branches it
// always did.
const legacyOutcome = (result) => {
	if ((result.statusCode === 200 && result.content) || result.isIndexable === true) return 'rendered';
	if (result.redirectedTo) return 'redirected';
	if (result.isIndexable === false) return 'non-indexable';
	return 'error';
};

const authShaped = (statusCode) => statusCode === 401 || statusCode === 403;
const transientShaped = (statusCode) => statusCode === 408 || statusCode === 429 || statusCode >= 500;
const hasContent = (variant) => variant.statusCode === 200 && !!variant.content;

/**
 * The devices a URL job renders. A copy, so a job never aliases live config. Never empty: the
 * schema marks `deviceTypes.default` `nonEmpty`, so an emptied list is refused at apply time and
 * the default kept — validated where config is applied, not guessed at here, which is also what
 * keeps this and `describeJob`'s fold rule reading the same list.
 */
const defaultDeviceTypes = () => [...config.deviceTypes.default];

/** A wire field that should be an array, read defensively — anything else is treated as empty. */
const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * One posted result, whatever shape the browser used, as `{ rowKey, url, asked, variants }`.
 *
 *   rowKey    the schedule row the job came from (`id`, echoed verbatim by every browser version) —
 *             the URL, or a cacheKey for a per-device row (see `describeJob`).
 *   url       the URL that row stands for.
 *   asked     the devices the job asked for; a device here with no variant below did not render.
 *   variants  what the browser posted, one per device attempted.
 *
 * A browser >= 1.23.0 answering a URL job posts `variants` (and `deviceTypes`, what it was asked).
 * Every earlier shape is one device and the envelope IS the variant: its device is the row's when
 * the row is per-device (every pre-0.66.0 result), else what the browser posted, else the first
 * default device — which is exactly what `claim` puts in `deviceType` for a renderer that predates
 * the list, so a pre-1.23.0 renderer given a URL job is attributed to the device it actually
 * rendered.
 */
const normalizeJobResult = (result) => {
	const rowKey = String(result.id);
	const url = CacheKey.urlOf(rowKey);
	if (Array.isArray(result.variants)) {
		const variants = result.variants.map((variant) => ({
			...variant,
			deviceType: sanitizeDeviceType(variant?.deviceType),
		}));
		const asked =
			Array.isArray(result.deviceTypes) && result.deviceTypes.length
				? result.deviceTypes.map(sanitizeDeviceType)
				: variants.map((variant) => variant.deviceType);
		return { rowKey, url, asked, variants };
	}
	const rowDevice = CacheKey.deviceOf(rowKey);
	const deviceType = rowDevice ?? sanitizeDeviceType(result.deviceType ?? defaultDeviceTypes()[0]);
	const { id, url: _url, deviceTypes, ...variant } = result;
	// A FLAT RESULT ON A URL ROW IS A RENDERER THAT MISSED THE UPGRADE, and it is the one failure in
	// this change that is otherwise completely silent. The job named every default device; a
	// pre-1.23.0 worker rendered only the first and posted it flat. `asked` stays the one device on
	// purpose — turning the others into `not-attempted` would put every URL that pod touches into
	// the retry lanes and burn the corpus's strikes against a fleet that is merely old — but then
	// nothing else says it happened either: the URL reschedules as a success, the outcome counters
	// read healthy, and the unrendered device's pages quietly expire across everything that pod
	// claims. So say it, loudly and cheaply.
	if (!rowDevice) reportLegacyRenderer(url, deviceType);
	return { rowKey, url, asked: [deviceType], variants: [{ ...variant, deviceType }] };
};

let lastLegacyRendererWarnAt = 0;

/**
 * A renderer too old for URL jobs, reported once an hour per node and counted on every result.
 *
 * Hourly rather than per result because a stale pod produces one of these for every job it claims,
 * and a log line per render would bury the thing it is warning about. The counter is what makes the
 * scale readable — if it is non-zero at all, some pod never took the fleet upgrade.
 */
const reportLegacyRenderer = (url, deviceType) => {
	metrics.legacyRenderer(deviceType);
	const now = Date.now();
	if (now - lastLegacyRendererWarnAt < 3600000) return;
	lastLegacyRendererWarnAt = now;
	logger.warn(
		`Prerender received a single-device result for a URL job (${url}, ${deviceType}) — that renderer predates ` +
			`browser 1.23.0, so it rendered ONE of the job's devices and the rest went unrendered. Their cached pages ` +
			`will expire and those bots will be served from the origin until the fleet is upgraded. This is counted in ` +
			`prerender_ops legacy_renderer.`
	);
};

/**
 * What the row a job came from means for scheduling.
 *
 *   perDevice  the row is keyed by cacheKey and renders one device: a pre-0.66.0 row that has not
 *              converted yet, or a deliberate one-device render (`renderNow` for a device outside
 *              `deviceTypes.default`).
 *   fold       this result may write the URL row. True for the URL row itself and for a per-device
 *              row of a DEFAULT device — that row is a fragment of the URL's rotation and converts
 *              into the URL row here. False for a non-default device: a one-off beside the rotation,
 *              which must not move the URL row.
 *   rowGone    set by whichever branch deleted the row (or the whole target), so the end-of-result
 *              cleanup does not delete it a second time — Harper records a delete of an absent key in
 *              the audit log.
 */
const describeJob = (rowKey, url) => {
	const device = CacheKey.deviceOf(rowKey);
	const perDevice = device !== null;
	return { rowKey, url, perDevice, fold: !perDevice || config.deviceTypes.default.includes(device), rowGone: false };
};

/**
 * A per-device row is deleted once its result is processed — folded into the URL row, or spent as a
 * one-off — unless the lease is being HELD (fast retry lane): the row is what the lease expiry
 * re-grants, so it must stay for the retry, and goes on the result that finally settles it.
 */
const retireRowIfConverted = async (job, held) => {
	if (held || job.rowGone || !job.perDevice) return;
	await deleteSchedule(job.rowKey);
	job.rowGone = true;
};

/**
 * Retire the job's URL: `Target.delete` drops the target, its pages, its URL row and its DEFAULT
 * device rows (`scheduleKeysOf`) — which is every row a folding job can have come from, but NOT a
 * one-device row for a non-default device. So the row is only known gone when the job folds; a
 * `|tablet` one-off whose URL turned out to redirect is left to `retireRowIfConverted`, and would
 * otherwise sit at its current-minute due time and be re-granted on every claim pass, forever.
 */
const retireSource = async (job) => {
	await Target.delete(job.url);
	job.rowGone = job.fold;
};

/** A row carries a cadence when a recurring writer filed it; a targetless render-now files none. */
const hasCadence = (effectiveInterval) => {
	const ms = Number(effectiveInterval);
	return Number.isFinite(ms) && ms > 0;
};

/**
 * A job whose URL has NO Target on this node. Two very different things look identical here, and
 * every branch that met them used to treat both as the first:
 *
 *   - a ONE-OFF — a render-now for a URL nothing tracks. Its row is targetless by construction: it
 *     renders once, stores its page (the render-now poller is waiting on it) and the row is dropped.
 *   - a RECURRING row whose Target has not reached this node. `Target` and `RenderSchedule` are
 *     separate databases, so a newly created target can arrive after its schedule row, and a replica
 *     can be missing a target outright. Dropping that row is terminal and silent — nothing re-creates
 *     a schedule for a target that exists (see util/reconcile.js). Measured on a four-node
 *     deployment: 734 live, mostly sitemap-declared targets lost their rows exactly this way during
 *     three days of write overload on `render_service`, and went unrendered for five weeks.
 *
 * The row says which it is: every recurring writer files a cadence (`effectiveInterval`) and a
 * targetless render-now files none. A per-device row for a non-default device is a one-off beside
 * the rotation whatever it carries. The read is node-local and authoritative: a result is processed
 * on the node that granted its claim, which is the row's owner.
 */
const readTargetlessRow = async (job) => {
	if (!job.fold) return { kind: 'one-off' };
	const row = await getScheduleRow(job.rowKey, ['cacheKey', 'fromSitemap', 'effectiveInterval', 'targetMissingSince']);
	if (!row) return { kind: 'gone' };
	return hasCadence(row.effectiveInterval) ? { kind: 'recurring', row } : { kind: 'one-off' };
};

/**
 * Settle a job whose URL has no Target on this node (see `readTargetlessRow`). A one-off's row is
 * dropped, as it always was. A recurring row is DEFERRED — re-filed `render.targetMissing.deferMs`
 * out, stamped with when its target was first found missing — and dropped only once that target has
 * been missing for `render.targetMissing.graceMs`, when "not replicated yet" has stopped being the
 * likely story. The drop warns, because it ends a rotation.
 *
 * The deferral is written to the URL row, so a pre-0.66.0 device row folds into it here exactly as a
 * normal result would convert it (`retireRowIfConverted` then drops the device row).
 *
 * @returns {Promise<'dropped'|'deferred'>}
 */
const settleTargetless = async (job, targetless) => {
	if (targetless.kind === 'gone') {
		job.rowGone = true;
		return 'dropped';
	}
	if (targetless.kind === 'one-off') {
		await deleteSchedule(job.rowKey);
		job.rowGone = true;
		return 'dropped';
	}
	const { row } = targetless;
	const now = Date.now();
	const stamped = Number(row.targetMissingSince);
	const since = Number.isFinite(stamped) && stamped > 0 ? stamped : now;
	const { deferMs, graceMs } = config.render.targetMissing;
	if (now - since >= graceMs) {
		logger.warn(
			`[prerender] ${job.url} has had no Target on this node for ${Math.round((now - since) / 60_000)}m — ` +
				`dropping its schedule row. If the target exists on other nodes, this replica has diverged; ` +
				`restore it with POST /prerender_admin/revalidate once the target is back.`
		);
		await deleteSchedule(job.rowKey);
		job.rowGone = true;
		return 'dropped';
	}
	logger.info(
		`[prerender] ${job.url} has no Target on this node (missing since ${new Date(since).toISOString()}) — ` +
			`deferring its row ${Math.round(deferMs / 60_000)}m instead of dropping it; no page stored`
	);
	await writeSchedule(job.url, {
		nextRenderTime: currentMinuteMs() + deferMs,
		fromSitemap: !!row.fromSitemap,
		effectiveInterval: row.effectiveInterval,
		targetMissingSince: since,
	});
	return 'deferred';
};

/** The variant a device the browser was asked for and never posted back reduces to. */
const notAttemptedVariant = (deviceType) => ({
	deviceType,
	outcome: 'error',
	reason: 'not-attempted',
	error: {
		name: 'Error',
		message: 'the renderer did not attempt this device (its lease ran short, or it began draining)',
		phase: 'not-attempted',
	},
	headers: {},
});

/**
 * Resolve one variant's outcome and keys, in place. Pure with respect to the database.
 *
 *   cacheKey      the page key this variant renders for.
 *   storeKey      where its content goes — `cacheKey`, or the destination's key after a refile.
 *   outcome       posted (browser >= v1.16.0) or inferred from the legacy signals.
 *   redirect      set when `redirectedTo` canonicalizes to a DIFFERENT key: `{ redirectKey,
 *                 destinationUrl, redirectPath, landedOn }`. A target whose page URL collapses back
 *                 to the same key (trailing slash, param reorder, encoding) is not a redirect.
 */
const classifyVariant = (variant, job) => {
	variant.headers ??= {};
	variant.cacheKey = CacheKey.toCacheKey({ url: job.url, deviceType: variant.deviceType });
	variant.storeKey = variant.cacheKey;
	// The browser's OWN verdict about the landed document, captured before the domain coercion
	// below — "the page said noindex" and "the host is outside our allowlist" must not be
	// conflated: only the former means the destination was inspected.
	variant.inspectedNonIndexable = variant.isIndexable === false;

	// The domain allowlist runs BEFORE the outcome is resolved so a legacy result for a foreign
	// host still infers 'non-indexable' the way the old chain coerced it.
	try {
		const domain = URL.parse(variant.redirectedTo || job.url)?.hostname;
		// Empty allowlist = allow all hosts.
		if (config.domains.length && !config.domains.includes(domain)) variant.isIndexable = false;
	} catch (e) {
		logger.error(e, job.rowKey);
	}

	variant.outcome = variant.outcome ?? legacyOutcome(variant);

	if (variant.redirectedTo) {
		// The browser posts the RAW final page URL as `redirectedTo`. Canonicalize it the same way
		// serving does — with the allowlist a bot READ of that target would use (route-aware) — so
		// the rendered content is stored under the key that read computes.
		const redirectKey = CacheKey.toCacheKey({
			deviceType: variant.deviceType,
			url: canonicalizeUrl(variant.redirectedTo, queryAllowlistFor(variant.redirectedTo)),
		});
		if (redirectKey !== variant.cacheKey) {
			const redirectPath = URL.parse(variant.redirectedTo)?.pathname;
			variant.redirect = {
				redirectKey,
				destinationUrl: CacheKey.extractUrl(redirectKey),
				redirectPath,
				landedOn: redirectPath === undefined ? PRERENDER : classifyPath(redirectPath).routeClass,
			};
		}
	}
	return variant;
};

/**
 * Resolve this node's desired pause intent from the replicated `QueueControl` table and
 * store it into the node-local queue flag; when not paused, derive empty/queued. Caller must
 * hold `mutex`.
 *
 * This is what makes pause/resume work cluster-wide: `claim` reads a non-replicated,
 * node-local flag, so a remote node can't be addressed directly — but every node runs
 * this on its own status-sync interval, so a replicated intent write converges everywhere
 * within one `queue.statusSyncInterval`.
 *
 * THE STATUS RECOMPUTE NO LONGER SCANS. It used to run a second head-seeking query
 * (`nextRenderTime <= now`, limit 1) against the same index `claim` walks — measured at ~700ms
 * of synchronous native iteration per minute on an aged node, on worker 0, which also serves bot
 * traffic. Once a claim floor exists the answer is derivable from it plus the last claim outcome
 * at zero database cost, so the scan is gone. `test/queueStatusDerived.test.js` pins its absence
 * by installing a `search` that throws.
 */
async function syncQueueState(force = false, pending = null) {
	const desired = await getDesiredPause(server.hostname, pending);

	if (desired.paused) {
		await QueueState.reportStatus('paused');
		return { status: 'paused', ...desired };
	}

	// The intent says "run". If the local flag still holds `paused`, the report must be
	// forced: reportStatus's non-forced path is a compareExchange between empty<->queued,
	// which by design cannot move a flag currently holding `paused`.
	const liftingPause = QueueState.status === 'paused';

	// The floor reset rides here because this function already holds the claim mutex, which is
	// exactly the serialization a reset needs against a concurrent `advanceFloor`. It is the only
	// recovery for a due time written below the floor by the operations API or the exported REST
	// surface — nothing in-process can observe those writes.
	maybeResetFloor(Date.now());

	// And the lease-gauge walk rides here for the same reason, on the same cadence. It is NOT
	// bookkeeping: the gauge only ever drifts UP (a lease that expires without a result has nobody to
	// decrement it) and it SIZES the claim scan, so unreconciled it climbs until every claim pass
	// drains the full `queue.claimScanCap` — measured at 820 against 20 truly in flight after ~80
	// minutes, and minutes rather than hours during a broad origin outage. One walk fixes the number
	// for every worker, because the buffer is shared.
	reconcileLeaseGauge();

	const status = deriveQueueStatus(Date.now());
	await QueueState.reportStatus(status, force || liftingPause);
	return { status, ...desired };
}

export class RenderQueue extends Resource {
	static loadAsInstance = false;

	static refreshQueueStatus = async (force = false) => {
		await mutex.lock();
		try {
			return await syncQueueState(force);
		} catch (e) {
			logger.error(e);
		} finally {
			mutex.unlock();
		}
	};

	/**
	 * Record a pause intent and immediately re-resolve it for this node.
	 *
	 * `scope` is a hostname (per-node override) or 'all' (cluster-wide default); `paused`
	 * is true, false (explicitly run), or null (delete the row — for a node scope, inherit
	 * 'all' again). Remote nodes pick the change up on their next status sync.
	 */
	static setPause = mutex.withLock(async ({ scope, paused, updatedBy } = {}) => {
		const target = scope ?? server.hostname;
		const intent = await setDesiredPause(target, paused, updatedBy);
		// Re-resolve rather than assuming the write applies here: a cluster-wide pause does
		// not pause a node carrying an explicit `paused: false` override, and vice versa.
		//
		// The just-written scope is passed as `pending` instead of being re-read: a row
		// deleted earlier in this request is still visible to a read here, so re-reading it
		// resolves a resume straight back to "paused" and returns the opposite of what
		// actually happened. The other scope is read normally — this write didn't touch it.
		// `intent.paused`, not the raw argument: setDesiredPause normalizes (an absent `paused`
		// is written as `false`), so threading the raw value could resolve "no opinion" while
		// the row on disk says `false`. Using what was actually written keeps the resolved
		// state and the persisted state identical by construction.
		const local = await syncQueueState(true, { scope: target, paused: intent.paused });
		return { ...intent, node: server.hostname, local };
	});

	// Node-scoped pause: this node stops claiming until resumed. Resume CLEARS the node's
	// override (rather than writing `paused: false`) so it restores the inherited state
	// instead of silently punching a hole in a deliberate cluster-wide pause.
	//
	// Named explicitly rather than via `this` so the binding survives being destructured or
	// passed as a callback (`const { pause } = RenderQueue`), and so a subclass can't
	// accidentally redirect it.
	static pause = ({ updatedBy } = {}) => RenderQueue.setPause({ scope: server.hostname, paused: true, updatedBy });

	static resume = ({ updatedBy } = {}) => RenderQueue.setPause({ scope: server.hostname, paused: null, updatedBy });

	/**
	 * The body of a posted result, decoded: the JSON envelope with its content bytes attached.
	 *
	 * Two shapes. A browser >= 1.23.0 answering a URL job posts `{ id, url, deviceTypes, variants:
	 * [...] }` followed by the variants' encoded bodies concatenated in order, each variant's
	 * `contentLength` saying how many of those bytes are its own — attached here as `variant.content`.
	 * Every earlier shape is one device: the envelope IS the variant and whatever follows the JSON is
	 * its body, attached as `result.content` exactly as before. `normalizeJobResult` folds the two
	 * into one.
	 *
	 * Throws on a variants body whose lengths do not account for exactly the bytes present: a result
	 * whose bytes cannot be attributed to devices must not be stored under any of them.
	 */
	static decodeJobResult(buffer, metadataSize) {
		const metadataBuffer = buffer.subarray(0, metadataSize);
		const result = JSON.parse(metadataBuffer.toString('utf8'));
		if (Array.isArray(result.variants)) {
			let offset = metadataSize;
			for (const variant of result.variants) {
				const length = Number(variant?.contentLength) || 0;
				if (length < 0 || offset + length > buffer.byteLength) {
					throw new Error(`variant contentLength ${variant?.contentLength} overruns a ${buffer.byteLength}-byte body`);
				}
				if (length > 0) variant.content = buffer.subarray(offset, offset + length);
				offset += length;
			}
			if (offset !== buffer.byteLength) {
				throw new Error(
					`variants account for ${offset - metadataSize} of the ${buffer.byteLength - metadataSize} body byte(s)`
				);
			}
			// Nothing attempted and nothing asked: there is no device to attribute anything to, and
			// letting it through would reach the all-rendered branch with an empty list and reschedule
			// the URL as a success that stored nothing.
			if (result.variants.length === 0 && !(Array.isArray(result.deviceTypes) && result.deviceTypes.length)) {
				throw new Error('a variants result must name at least one device (variants or deviceTypes)');
			}
		} else if (metadataBuffer.byteLength < buffer.byteLength) {
			result.content = buffer.subarray(metadataSize);
		}
		return result;
	}

	static async processJobResult(data, ctx) {
		const metadataSize = parseInt(ctx.headers.get('x-metadata-size'));

		// A missing or unparseable header used to make `subarray(0, NaN)` produce an empty buffer
		// and `JSON.parse('')` throw, which surfaced as a bare 500 with no clue what was wrong.
		// Nothing can be recovered from such a post — without a decoded `id` there is not even a
		// lease to release, so the lease just expires and the job is re-granted — so say so
		// legibly instead of leaving a mystery 500 in the log.
		if (!Number.isFinite(metadataSize) || metadataSize <= 0 || metadataSize > data.byteLength) {
			logger.error(
				`[prerender] job_result rejected: x-metadata-size is ${ctx.headers.get('x-metadata-size')} for a ` +
					`${data.byteLength}-byte body. The render's lease will expire and the job be re-granted.`
			);
			return new Response(
				JSON.stringify({ error: 'x-metadata-size must be a positive integer no larger than the request body' }),
				{ status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } }
			);
		}

		let result;
		try {
			result = this.decodeJobResult(data, metadataSize);
		} catch (e) {
			// Same reasoning as above: a body that cannot be decoded, or whose variants do not account for
			// its bytes, leaves nothing to release and nothing safe to store. A 4xx tells the browser not
			// to retry the same bytes; the lease expires and the job is re-granted.
			logger.error(
				`[prerender] job_result rejected: ${e?.message ?? String(e)}. The lease will expire and the job be re-granted.`
			);
			return new Response(JSON.stringify({ error: `undecodable job_result: ${e?.message ?? String(e)}` }), {
				status: 400,
				headers: { 'content-type': 'application/json; charset=utf-8' },
			});
		}

		// THE key the lease was granted under. Everything below is keyed off the job description built
		// from it rather than off this string, so nothing can re-point it (the redirect refile used to
		// reassign the working key, and releasing by that would have leaked the SOURCE's lease on every
		// rendered client-side redirect — the row would then pin the claim floor for a full lease).
		const claimKey = result.id;
		// Set true by the branches whose retry pacing IS the lease (see retryAfterFailure): they
		// must keep it, or the row — which still carries its original overdue due time now that
		// the lease has left `nextRenderTime` — becomes immediately re-claimable and hot-loops.
		let holdLease = false;
		try {
			return await this.processDecodedJobResult(result, {
				holdLease: () => {
					holdLease = true;
				},
			});
		} catch (e) {
			// A THROW MUST HOLD THE LEASE. `holdLease` is only set by branches that ran to
			// completion, so without this a throw would release it — and a throw is precisely the
			// case where nothing moved the row forward. Worse, the throw propagates out of the
			// request handler, so Harper ABORTS the ambient transaction and rolls back whatever this
			// result did commit (the `PrerenderedPage.put` included). The row keeps its original
			// overdue due time and the floor is at or below its minute by construction, so a freed
			// lease means the next pass re-grants it seconds later: an unpaced re-render loop against
			// whatever is throwing, at claim frequency rather than once per lease.
			//
			// Reachable, not theoretical: a `PrerenderedPage.put`/`createBlob` failure, a
			// `Target.get`/`Target.patch` rejection. Holding the lease paces the retry at
			// `queue.jobLeaseTime`, exactly like the fast-retry lanes below, and the 500 is what says
			// the result was not processed.
			holdLease = true;
			throw e;
		} finally {
			// THE SINGLE RELEASE POINT. One lease, one result, one release — by `claimKey`.
			if (!holdLease && claimKey) releaseLease(claimKey);
		}
	}

	/**
	 * ONE RESULT, ONE URL, ONE SCHEDULING DECISION.
	 *
	 * A result carries every device variant of one URL (a browser >= 1.23.0 answering a URL job), or
	 * one device (any earlier shape, and a per-device row's job). `normalizeJobResult` makes the two
	 * the same thing — a list of variants — and everything below reasons about the LIST: pages are
	 * stored per variant, because content is per device; the schedule is written once, because the
	 * rotation is per URL. That single write is what keeps a URL's devices aligned. When each device
	 * had its own row and its own result, every per-device path (the retry lanes, render-now,
	 * reconcile) moved one device and not the other, and "a split pair" became a normal production
	 * state — with a per-URL `strikes` counter fed twice per cycle, and the probe's per-URL page claim
	 * written by whichever device happened to render last.
	 *
	 * ── PRECEDENCE ACROSS VARIANTS ──────────────────────────────────────────────────────────────
	 *
	 * A URL is not "mostly rendered". The verdicts a single device used to deliver for the whole URL
	 * still do, in the order the old per-device code effectively applied them:
	 *
	 *   1. a REDIRECT the browser bailed on at navigation, on ANY device, decides the URL (a mobile
	 *      301 to an m-dot host retires the URL, as it always did — the desktop row went with it);
	 *   2. a genuine NON-INDEXABLE verdict on ANY device (noindex, canonical elsewhere, 404/410,
	 *      other non-auth, non-transient http-error) SUPPRESSES the URL, whatever the other devices
	 *      rendered — the pages go with the suppression, so none are stored;
	 *   3. otherwise every RENDERED variant's page is stored under its own cacheKey, and then
	 *   4. a FAILED variant (renderer error, auth-shaped or transient status, or a device the
	 *      browser was asked for and did not attempt) puts the URL in the retry lanes — the stored
	 *      pages stay servable, the whole URL re-renders on the lane's pacing, and the good side is
	 *      rendered again so the pair stays aligned;
	 *   5. all rendered: reschedule the URL at its cadence, reset strikes, lift a suppression.
	 *
	 * ── WHICH ROW ────────────────────────────────────────────────────────────────────────────────
	 *
	 * The row this job came from is `posted.id` — the URL (the normal case), or a cacheKey: a
	 * pre-0.66.0 per-device row that has not yet converted, or a deliberate one-device render
	 * (`renderNow` for a device outside `deviceTypes.default`). The URL's rotation lives on the URL
	 * row, so a per-device row for a DEFAULT device FOLDS into it here — its result writes the URL
	 * row and deletes the device row; two siblings converge on one row within a cycle at no extra
	 * renders — while a per-device row for a NON-default device is a one-off: its page is stored and
	 * the row deleted, and the URL row is not touched. `describeJob` decides which, once.
	 */
	static async processDecodedJobResult(posted, { holdLease: hold }) {
		const { rowKey, url, asked, variants } = normalizeJobResult(posted);
		const job = describeJob(rowKey, url);
		let held = false;
		const holdLease = () => {
			held = true;
			hold();
		};

		for (const variant of variants) classifyVariant(variant, job);

		// A device the browser was asked for and did not post back is a render that did not happen:
		// the lease ran short between variants, or the worker began draining. It fails like any other
		// so the URL takes a retry lane for it, rather than the missing device silently keeping its old
		// page until the next cadence.
		for (const deviceType of asked) {
			if (!variants.some((variant) => variant.deviceType === deviceType)) {
				variants.push(classifyVariant(notAttemptedVariant(deviceType), job));
			}
		}

		// One `time_ms` sample per variant the browser timed. A redirect bail gets its own lane so
		// navigation-only renders do not read as fast full renders.
		for (const variant of variants) {
			if (typeof variant.renderTime !== 'number') continue;
			const candidacy =
				variant.outcome === 'redirected' && variant.redirect
					? 'redirect'
					: typeof variant.isIndexable === 'boolean'
						? variant.isIndexable || hasContent(variant)
							? 'candidate'
							: 'non-candidate'
						: 'unknown';
			metrics.renderTime(variant.renderTime, variant.statusCode, candidacy);
		}

		// What each governed render's completeness contract said. This is the whole point of contracts
		// being on the wire: a render that finished INCOMPLETE is otherwise indistinguishable from a
		// good one — 200, non-empty, indexable, and nothing anywhere saying it is missing a widget.
		// Measured under CPU contention, 8 of 15 renders finished with their contract unsatisfied and
		// every one of them reported outcome=ok.
		for (const variant of variants) {
			const readiness = variant.readiness;
			if (!readiness || typeof readiness !== 'object') continue; // no contract governed this render
			// Exactly one verdict per governed VARIANT — a two-device job emits two — so the series sums
			// to rendered devices (`render.time_ms`), not to posted results (`render.outcome`). A
			// rebaseline is a separate series (emitted by the expectation store, which is the only thing
			// that can know).
			metrics.renderReadiness(readiness.contract, readiness.satisfied ? 'satisfied' : 'unsatisfied');
			// Per CLAUSE, so a contract that has rotted against a template change reads as one clause
			// failing across every render of its page type rather than as an unexplained slowdown.
			// `Array.isArray`, not `?? []`: this runs before anything is committed and outside any
			// try/catch, and the poster is not authenticated — a non-iterable here would throw the whole
			// result away with a 500 and hold the lease.
			for (const clause of asArray(readiness.unmet)) metrics.renderReadinessUnmet(readiness.contract, clause);
			for (const shortfall of asArray(readiness.shortfalls))
				metrics.renderReadinessShortfall(readiness.contract, shortfall?.name);
			// How long it took to first hold — the distribution `timeoutMs` should be tuned from. Only
			// when it held: an unsatisfied contract has no such time, and emitting its timeout here would
			// drag the percentile toward the very ceiling the reader is checking against.
			if (typeof readiness.firstSatisfiedMs === 'number')
				metrics.renderReadinessMs(readiness.firstSatisfiedMs, readiness.contract);
		}

		// 1. A redirect the browser bailed on at navigation, or a rendered-through client-side redirect
		// that produced nothing. Decided by `processRedirectResult` for the whole URL, exactly as one
		// device's result decided it before. The lane comes back so the fast-retry branch inside it
		// holds its lease like the two below — one release point, three deciders.
		const bailed = variants.find((variant) => variant.outcome === 'redirected' && variant.redirect);
		if (bailed) {
			const lane = await this.processRedirectResult(bailed, job);
			if (lane === 'fast') holdLease();
			await retireRowIfConverted(job, held);
			return;
		}

		// 2. A verdict about the page itself, on any device. BEFORE the refile below, which is what
		// the documented precedence has always said (redirect, then verdict, then rendered) and what
		// the per-key code did when one device's result decided everything. Running the refile first
		// inverted it destructively on a split result — one device client-side-redirecting while the
		// other returned a genuine noindex: the refile deleted the target and its pages, and then
		// `Target.suppress` CREATED the row again (it mints one when absent), re-minting the target
		// that had just been deleted, as suppressed and carrying a strike, while the redirect
		// destination went nowhere. A verdict suppresses the URL; nothing destructive may precede it.
		//
		// `reason` (browser >= v1.16.0) says WHY:
		// 'noindex', 'canonical-mismatch', 'http-error', 'redirect-loop', or (>= v1.17.0)
		// 'canonical-variant' — the canonical names this very document RE-SPELLED as a different
		// cache key. Suppressed identically; the split keeps a wave of duplicate spellings legible.
		//
		// Note which urls can reach here at all: a sitemap-listed one is serialized even when
		// non-indexable, so its variant arrives with content and `rendered` wins — the declared
		// corpus is structurally out of this branch's reach, and only urls we DISCOVERED can be
		// suppressed by a canonical verdict.
		//
		// EXCEPT 401/403 and 408/429/5xx, which are failures (step 4), not verdicts: an auth-shaped
		// error is almost never a statement about the page — a broken renderer credential, an
		// origin bot-mitigation rule change, an origin auth outage — and a transient one means the
		// origin failed to serve the page, not that it disavowed it. Striking toward deletion would
		// suppress (and after maxStrikes DELETE) swathes of healthy targets exactly when such a
		// failure hits everything at once. Keep the target, keep its cached pages, retry.
		const verdict = variants.find(
			(variant) =>
				variant.outcome === 'non-indexable' && !authShaped(variant.statusCode) && !transientShaped(variant.statusCode)
		);
		if (verdict) {
			metrics.renderOutcome('suppressed', verdict.reason ?? 'unspecified');
			// info, not warn: a suppression is a normal verdict (the page declared itself
			// non-indexable) and it self-heals on its own recheck cadence. The alertable event is
			// MASS suppression, which is the render_outcome counter's job.
			logger.info(
				`Suppressing prerendered url: ${url} (${verdict.deviceType}${verdict.reason ? `, ${verdict.reason}` : ''})`
			);
			// Suppress writes the URL row (its recheck) and drops every device's page; the verdict
			// SUPPRESSES the target rather than deleting it — see Target.suppress, which also grades
			// http-error verdicts by status (404/410 recheck less, die sooner).
			const { deleted } = await Target.suppress(url, { reason: verdict.reason, statusCode: verdict.statusCode });
			// At maxStrikes the suppression DELETED the target, and `Target.delete` took the URL's default
			// device rows with it — so a folding row is already gone (a second delete would only write a
			// tombstone), while a non-default one-device row still needs retiring below.
			if (deleted) job.rowGone = job.fold;
			await retireRowIfConverted(job, held);
			return;
		}

		// 3. A rendered result whose landed URL keys elsewhere (client-side redirect that produced a
		// real page): the long-standing refile semantics, per variant. Onto a route we serve, the page
		// is stored under the DESTINATION's key and the source is retired — once, by URL, taking its
		// device siblings with it: a page does not redirect for one device and serve for another.
		// Onto a class we never serve, the render is discarded and the target kept (see the warn).
		let refiledTo = null;
		for (const variant of variants) {
			if (variant.outcome !== 'rendered' || !variant.redirect) continue;
			if (variant.redirect.landedOn === PRERENDER) {
				if (!refiledTo) {
					logger.info(`Skipped prerendered url due to redirect: ${rowKey} redirected to ${variant.redirectedTo}`);
					await retireSource(job);
					refiledTo = variant.redirect.destinationUrl;
				}
				variant.storeKey = variant.redirect.redirectKey;
				variant.refiled = true;
			} else {
				// The redirect target is a class we never serve from cache, so re-keying onto it
				// would file the render where no read will ever look — and deleting this target
				// would silently end the URL's rendering for good (see util/reconcile.js on how
				// undiagnosable that state is). The route list may simply be incomplete, so
				// report it and leave the target alone rather than destroy it on that evidence.
				// The render is wasted each interval until the redirect or the routes are fixed.
				logger.warn(
					`Prerendered url ${rowKey} redirected to ${variant.redirectedTo}, which is ${variant.redirect.landedOn} — ` +
						`discarding the render and keeping the target (no key to store it under)`
				);
				recordUnroutedPath(variant.redirect.landedOn, variant.redirect.redirectPath, 'redirect');
				variant.discardContent = true;
			}
		}

		// The scheduling target: the URL's own, or — after a refile — the destination's, which is what
		// the old per-key code consulted once it had re-pointed the working key at the destination.
		const scheduleUrl = refiledTo ?? url;
		const scheduleJob = refiledTo ? describeJob(refiledTo, refiledTo) : job;
		const renderTarget = await Target.get({
			id: scheduleUrl,
			select: ['renderInterval', 'sitemapUrl', 'state', 'strikes', 'demandInterval'],
		});
		// No target here: a one-off, or a recurring row whose target has not reached this node. The
		// latter must not store its pages — a page with no target is never re-rendered and never
		// reclaimed — and must not lose its row. A refile already retired the source and schedules the
		// destination below; its no-destination case keeps the long-standing one-off handling.
		const targetless = renderTarget || refiledTo ? null : await readTargetlessRow(job);
		const withheld = targetless?.kind === 'recurring';

		// Schedule the next render relative to when THIS one completed (now), not a fixed wall-clock
		// time — so renders stay spread across the interval instead of realigning into a daily herd,
		// and the cadence self-paces to fleet throughput. Cadence precedence: matched route's
		// renderInterval, else the target's stored interval (sitemap changefreq / explicit API write;
		// invalid values — including NaN from an arbitrary API PUT — are rejected), else the default.
		// Resolved here on every cycle, so a route-cadence config change applies on each URL's next
		// render without touching stored rows.
		const base = resolveRenderInterval(scheduleUrl, renderTarget?.renderInterval);
		// The demand ladder reallocates cadence WITHIN `base` (which stays the ceiling) by whether bots
		// actually visit this URL. Off / dry-run / cold filter all return `base` unchanged.
		const demand = decideInterval(scheduleUrl, base, renderTarget?.demandInterval);
		const interval = demand.interval;
		// The cached pages expire when the next render is due; the swrTtl window then keeps them served
		// while the re-render lands, so render latency up to swrTtl never causes a cache miss.
		const nextRenderTime = currentMinuteMs() + interval;

		// Store every rendered variant's page — before the retry decision, so a device that rendered
		// is served fresh even while the URL retries for a sibling that did not.
		const rendered = variants.filter((variant) => variant.outcome === 'rendered');
		// Content is what gets stored, whatever the status the browser reported beside it — the same
		// test the per-key path applied. (`hasContent`, with its 200 check, is the metrics candidacy.)
		// A SIBLING OF A REFILED VARIANT HAS NOWHERE TO GO. `retireSource` ran `Target.delete` on the
		// source URL above, which took the target, its schedule row and all of its pages; a variant
		// that did NOT redirect still carries the source's own store key, so writing it here would
		// leave a page blob for a URL with no target and no schedule row — never re-rendered, never
		// reclaimed (only the resource-class delete cascades), and still served to bots as a 200 for
		// a URL the origin redirects away from. The per-key code could not reach this state: each
		// device carried its own result, so once one device's refile deleted the target the other
		// device's row was already gone. The destination is scheduled below and renders both devices
		// on its own next pass.
		const orphaned = refiledTo ? rendered.filter((variant) => !variant.refiled) : [];
		if (orphaned.length) {
			logger.info(
				`Prerender ${url} refiled to ${refiledTo}; discarding the ${orphaned
					.map((variant) => variant.deviceType)
					.join(', ')} render whose target was retired with it`
			);
		}
		const stored = rendered.filter(
			(variant) => !!variant.content && !variant.discardContent && !(refiledTo && !variant.refiled) && !withheld
		);
		if (stored.length) {
			// ONE timestamp for every page and for the claim recorded alongside them. Taken once rather
			// than per use because `recordPageClaim` stores it as the basis a per-URL verification
			// certifies, and the serve path tests each device key with `lastCached >= basisAt` — a
			// device stamped milliseconds later than the claim would fail its own test. Sharing it
			// across the variants is also what makes the pair's `basisAt` exact rather than aligned.
			const cachedAt = Date.now();
			// What this render CLAIMS, for the probe to compare the origin against on its next pass —
			// once per URL, from the first variant that ran the extraction (the offers are a property of
			// the document, not of the viewport: measured, desktop and mobile agreed byte-for-byte in
			// 39/40 samples, the exception being a pair rendered 41h apart). Best-effort and awaited only
			// for its (node-local) write: a render must not fail because a probe optimisation could not
			// be recorded.
			const claiming = stored.find((variant) => variant.structuredOffers !== undefined) ?? stored[0];
			// The page record, chosen the same way from the variant that ran ITS extraction (browser
			// >= 1.37.0). It is one record for the URL, so it only vouches for the URL when this result
			// replaced EVERY default device's page: after a partial render (one device failed) or a
			// one-device render, the other device's cached page is older than the record would claim,
			// and a record that "caught up" with a change would then skip re-rendering a page that did not.
			const describing = stored.find((variant) => variant.pageFacts !== undefined) ?? stored[0];
			const everyDevice = defaultDeviceTypes().every((device) =>
				stored.some((variant) => variant.deviceType === device)
			);
			// CONCURRENTLY, because these all sit inside ONE request-scoped transaction and its duration
			// is the thing to keep short. A result now carries every device of the URL, so where the
			// per-key path wrote one page blob per transaction this writes one per device, in series —
			// and a page blob is the largest write this plugin makes. The writes are independent (a
			// different key each, and the claim is a different database entirely), so awaiting them
			// together brings the transaction's wall time back to roughly one write rather than N.
			//
			// This is a BOUNDED fan-out, which is the whole distinction from the bulk-delete incident
			// that taught us to serialize: the width is `deviceTypes.default`, so two here and a
			// config change away from a handful — never the hundreds of in-flight writes that pushed
			// the commit queue past its outstanding limit and had a thread reject every unrelated
			// application write, this endpoint's own included.
			//
			// `recordPageClaim` never rejects (it catches and warns internally), so it cannot fail the
			// result from inside this set — a probe optimisation must not cost a render.
			// The readiness observations, compared against what this PAGE last produced — per stored
			// variant, under its own device's key, because the desktop and mobile renders of one URL are
			// different pages with different counts (measured: a 59% `img` gap on the home page, against
			// a shortfall rule that fires at 50%). Rides in the same concurrent set as the page writes and
			// the probe claim: one node-local point read and one small write each, and like
			// `recordPageClaim` it never rejects — a regression signal must not cost a render.
			const observed = stored.filter((variant) => hasObservations(variant.readiness?.learned));
			await Promise.all([
				recordPageClaim(scheduleUrl, claiming.structuredOffers, cachedAt, {
					pageFacts: describing.pageFacts,
					complete: everyDevice,
				}),
				...observed.map((variant) =>
					recordReadinessExpectation({ url: scheduleUrl, deviceType: variant.deviceType }, variant.readiness)
				),
				...stored.map((variant) => {
					variant.headers['x-harper-rendered'] = '1';
					return databases.page_cache.PrerenderedPage.put(variant.storeKey, {
						statusCode: variant.statusCode,
						lastCached: cachedAt,
						content: createBlob(variant.content),
						headers: JSON.stringify(variant.headers),
						expiresAt: nextRenderTime,
						isIndexable: typeof variant.isIndexable === 'boolean' ? variant.isIndexable : null,
					});
				}),
			]);
		}

		// 4. A failed variant puts the URL in the retry lanes: fast retries on the held lease, then
		// escalation to a backed-off due time (`retryAfterFailure`). The stored pages above stay
		// servable meanwhile. One outcome emit per result, for the class the worst variant fell in —
		// auth-shaped first (it is the one that signals a broken credential), then transient, then a
		// plain failure — and one log line per failed variant, at the level that class warrants.
		//
		// "Failed" is THE COMPLEMENT of rendered, not a list of failure shapes: an `outcome` this code
		// does not know, or a `redirected` whose destination re-keyed to the SAME cache key (the browser's
		// own redirect check uses a default allowlist, the plugin's is per route, so they can disagree —
		// step 1 deliberately did not claim it), must land here and retry, exactly where the per-key
		// code's final `else` sent them. Listing failure shapes instead let anything unlisted fall
		// through to step 5 and reschedule a URL as a success that stored nothing.
		const failed = variants.filter(
			(variant) =>
				variant.outcome !== 'rendered' &&
				!(
					variant.outcome === 'non-indexable' &&
					!authShaped(variant.statusCode) &&
					!transientShaped(variant.statusCode)
				)
		);
		if (failed.length && refiledTo) {
			// The source was just retired by the refile above: there is no row of its own to retry under,
			// and holding ITS lease would pin the claim floor at a row that no longer exists. The
			// destination renders on its own row and cadence, so a failed sibling here is logged and let
			// go — its device simply has no page until the destination renders.
			for (const variant of failed) {
				logger.warn(
					`Prerender ${url} (${variant.deviceType}) did not render (${variant.reason || variant.outcome}) — not ` +
						`retried: the URL was retired in favour of ${refiledTo} by a sibling's client-side redirect`
				);
			}
		} else if (failed.length) {
			const auth = failed.find((variant) => authShaped(variant.statusCode));
			const transient = failed.find((variant) => transientShaped(variant.statusCode));
			if (auth) metrics.renderOutcome('auth-failure', auth.statusCode);
			else if (transient) metrics.renderOutcome('transient', transient.statusCode);
			else metrics.renderOutcome('failed', failed[0].error?.phase ?? 'unknown');
			for (const variant of failed) {
				const where = `${url} (${variant.deviceType})`;
				if (authShaped(variant.statusCode)) {
					logger.error(
						`Prerender got ${variant.statusCode} for ${where} — auth-shaped, NOT suppressing. ` +
							`If these are widespread, check the renderer's origin-bypass credential and the CDN/origin access rules.`
					);
				} else if (transientShaped(variant.statusCode)) {
					// info, not warn: by-design tolerance of an origin blip. The aggregate (a transient
					// BURST is origin trouble) is render_outcome's job, not a per-URL log flood's.
					logger.info(`Prerender got transient ${variant.statusCode} for ${where} — keeping target and cached page`);
				} else {
					// The browser posts `reason` and the failed attempt's error (name/message/phase) since
					// v1.16.0; without them this can only say "unknown". `phase: 'navigation'` means the
					// document never arrived (slow/refusing origin) — a different problem from a render
					// that failed mid-settle; 'not-attempted' means the browser never started this device.
					const detail = variant.error
						? ` — ${variant.error.name}${variant.error.phase ? ` [${variant.error.phase}]` : ''}: ${variant.error.message}`
						: '';
					logger.warn(`Prerender failed for ${where} (${variant.reason || 'no reason reported'})${detail}`);
				}
			}
			// This branch used to hold the lease unconditionally and forever for a renderer failure —
			// no strike, no escalation — so a permanently-crashing render re-rendered once per
			// `queue.jobLeaseTime` for the life of the target. The waste was never the renders; it was
			// the CLAIM FLOOR, which a held lease pins at its row's due minute. Escalating returns
			// 'slow', which releases the lease and lets the floor advance.
			if ((await this.retryAfterFailure(scheduleJob)) === 'fast') holdLease();
			await retireRowIfConverted(job, held);
			return;
		}

		// 5. Every variant rendered. One render outcome per posted result: `refiled` = the client-side
		// redirect re-key above moved the pages onto the destination's keys; `discarded` = it landed on
		// a class we never serve and the content was dropped; `no-content` = a legacy worker's
		// isIndexable-only result (legacyOutcome calls it rendered, but there is nothing to store).
		metrics.renderOutcome(
			'rendered',
			stored.length
				? stored.some((variant) => variant.refiled)
					? 'refiled'
					: 'stored'
				: withheld
					? 'target-missing'
					: rendered.some((variant) => variant.discardContent)
						? 'discarded'
						: 'no-content'
		);

		if (renderTarget) {
			// A target owns this URL → recurring. Reschedule relative to completion using the resolved
			// interval (so a target lacking an explicit renderInterval falls back to the default instead
			// of getting stuck re-claiming every lease period). Refresh fromSitemap from the live target
			// so it self-corrects if the URL has since left its sitemap.
			//
			// This is the highest-volume schedule write in the system, and it writes `now + interval` —
			// i.e. FORWARD. The funnel's floor lowering is a CAS-min, so this path costs one atomic load
			// and moves the floor not at all. That is load-bearing: a lowering on every completed render
			// would rewind the floor to the current minute continuously and the whole 14× seek win would
			// evaporate.
			//
			// A one-device render (a per-device row for a non-default device) does NOT reschedule: the
			// URL's rotation is on the URL row, and this result was an extra render beside it.
			if (scheduleJob.fold) {
				await writeSchedule(scheduleUrl, {
					nextRenderTime,
					fromSitemap: !!renderTarget.sitemapUrl,
					// `interval`, i.e. the rung `decideInterval` JUST chose — not the route ceiling. This is
					// the writer every target passes through on every cycle, so it is what backfills the
					// cadence across the corpus, and it is the only site holding a rung fresher than the
					// stored one. The ready-set sweep divides lateness by this to rank the row.
					effectiveInterval: interval,
				});

				// Persist the rung ONLY on an actual move. 'held' must not write even when the stored field
				// is absent — absence already resolves to the base ceiling, so writing it would be
				// redundant, and on first evaluation it would be a corpus-wide storm of replicated Target
				// patches (~one per render for a full cycle), in dry-run too. A converged corpus therefore
				// pays nothing here, on the system's hottest path.
				if (demand.action === 'promoted' || demand.action === 'demoted') {
					await Target.patch(scheduleUrl, { demandInterval: demand.level });
				}
			}

			// A suppressed URL that rendered indexable again has healed — put it back in normal
			// rotation, so the recheck cadence stops and discovery may see it again. Every variant
			// rendered, so any device's indexable verdict is the URL's.
			if (renderTarget.state === 'suppressed' && rendered.some((variant) => variant.isIndexable === true)) {
				logger.info(`Prerendered url ${scheduleUrl} is indexable again — lifting its suppression`);
				await Target.reactivate(scheduleUrl);
			} else if (renderTarget.state !== 'suppressed' && renderTarget.strikes > 0) {
				// Strikes are CONSECUTIVE failures by definition: a successful render resets the
				// count, so redirect blips months apart never accumulate toward retirement.
				// Guarded by strikes > 0 — the hot path (healthy target, no strikes) pays no
				// extra write.
				await Target.patch(scheduleUrl, { strikes: 0 });
			}
		} else if (!job.rowGone) {
			// No target owns this URL on this node: a one-off's row is dropped, a recurring row is
			// deferred (see `settleTargetless`).
			//
			// A drop does NOT release the key's lease (see util/renderSchedule.js): the slot keeps
			// holding the claim floor at this row's old due minute until it expires. That is the
			// conservative direction — releasing here would let the floor advance past a row whose
			// result may still be arriving from a duplicate renderer.
			await settleTargetless(job, targetless ?? { kind: 'one-off' });
		}
		await retireRowIfConverted(job, held);
	}

	/**
	 * A render that ended as a redirect with no content. Usually the browser bailed at
	 * navigation on an HTTP redirect (`variant.statusCode` is the FIRST hop's 3xx — the origin's
	 * statement about the job URL itself); a client-side redirect that rendered through to a
	 * page that produced nothing lands here too (statusCode 200, permanence unknowable). What's
	 * decided is what happens to the source target, and whether the destination becomes a
	 * target of its own so it gets rendered under its own job context instead of being cached
	 * from a render that ran as another URL.
	 *
	 * `variant` is the device that observed the redirect; `job` names the URL and the row. The
	 * decision is about the URL — a page does not redirect for one device and serve for another —
	 * so it retires or reschedules the whole URL, as one device's result always did.
	 *
	 * Returns the retry lane when it took one (`'fast'`/`'slow'`/`'dropped'`), so the caller — the
	 * single lease-release point — knows whether this result's pacing is the lease itself.
	 */
	static async processRedirectResult(variant, job) {
		const { redirectKey, destinationUrl, landedOn, redirectPath } = variant.redirect;
		const { url: sourceUrl, rowKey } = job;

		// Same status rules as the failure branch, applied BEFORE anything retires or strikes
		// the source. Only a rendered-through client-side redirect can carry these statuses
		// (a bail-at-nav result posts the first hop's 3xx), so `statusCode` here is the LANDED
		// document's: an auth-shaped or transient-shaped landing is a credential/origin
		// problem, not a verdict on either URL. Without this, a page whose client-side
		// redirect lands on a 401/403 would delete its source target on the FIRST such result
		// (via the inspectedNonIndexable branch below) — the exact mass-deletion the failure
		// branch's guard exists to prevent.
		const auth = authShaped(variant.statusCode);
		const transient = transientShaped(variant.statusCode);
		if (auth || transient) {
			metrics.renderOutcome('redirect', auth ? 'landed-auth' : 'landed-transient');
			// error for auth (credential/mitigation trouble), info for transient (origin blip) —
			// same split as the failure branch.
			logger[auth ? 'error' : 'info'](
				`Prerendered url ${rowKey} redirected to ${variant.redirectedTo}, which returned ${variant.statusCode} — ` +
					`${auth ? 'auth-shaped' : 'transient'}, keeping the target`
			);
			return await this.retryAfterFailure(job);
		}

		if (landedOn !== PRERENDER) {
			// The destination is a class we never serve from cache — adopting it would file
			// renders where no read looks, and deleting the source on ONE such result would end
			// its rendering on evidence as weak as an incomplete route list. Keep the source and
			// retry at its normal cadence (the retry costs a navigation, not a full settle) —
			// but count the strike: a source that answers this way every interval is de facto
			// permanently redirected, and recordRedirectStrike retires it after maxStrikes.
			metrics.renderOutcome('redirect', 'unrouted-destination');
			logger.warn(
				`Prerendered url ${rowKey} redirected (${variant.statusCode}) to ${variant.redirectedTo}, which is ` +
					`${landedOn} — keeping the target (no key to schedule the destination under)`
			);
			recordUnroutedPath(landedOn, redirectPath, 'redirect');
			await this.recordRedirectStrike(job, `to unserved ${landedOn} destination`);
			return;
		}

		if (variant.inspectedNonIndexable) {
			// The landed document was actually loaded and inspected (a rendered-through
			// client-side redirect) and it is non-indexable: the source now leads to a page we
			// would never cache. Retire the source and suppress the destination, so neither
			// keeps rendering at full cadence. (This keys on the browser's posted verdict, not
			// the domain-coerced one — a foreign host was never inspected, and a suppressed
			// foreign row would be registry noise nothing ever reads.)
			metrics.renderOutcome('redirect', 'non-indexable-destination');
			logger.info(
				`Prerendered url ${rowKey} redirected to non-indexable ${variant.redirectedTo}` +
					`${variant.reason ? ` (${variant.reason})` : ''} — retiring the target`
			);
			await retireSource(job);
			const domain = URL.parse(destinationUrl)?.hostname;
			// Auth-shaped and transient statuses never reach here (guarded above), so this
			// suppression is a genuine content/gone verdict about the destination.
			if (!config.domains.length || config.domains.includes(domain)) {
				await Target.suppress(destinationUrl, { reason: variant.reason, statusCode: variant.statusCode });
			}
			return;
		}

		if (variant.statusCode !== 301 && variant.statusCode !== 308) {
			// No proof of permanence (302/303/307 — failover, geo bounce, outage page — or a
			// client-side redirect's 200). The source is expected to come back — keep its target
			// AND its cached pages, and look again next interval. But a source that answers with
			// a temp redirect EVERY interval is a permanent redirect wearing a temporary status:
			// each result costs a strike and recordRedirectStrike retires the source after
			// maxStrikes rather than paying a navigation every interval forever.
			metrics.renderOutcome('redirect', 'temporary');
			logger.info(
				`Prerendered url ${rowKey} temporarily redirected (${variant.statusCode}) to ${variant.redirectedTo} — ` +
					`keeping the target and retrying at its normal cadence`
			);
			await this.recordRedirectStrike(job, `temporary ${variant.statusCode} to ${variant.redirectedTo}`);
			return;
		}

		// Permanent move onto a route we serve: retire the source — Target.delete drops the URL's
		// row, its schedule rows and every device's cached page — and adopt the destination in its
		// place. A mutual 301 pair (A↔B) ping-pongs create/delete at the targets' cadence; each
		// hop is a navigation-only render surfaced by this warn, so a broken site costs noise,
		// not settles.
		metrics.renderOutcome('redirect', 'permanent');
		logger.info(
			`Prerendered url ${rowKey} permanently redirected (${variant.statusCode}) to ${variant.redirectedTo} — ` +
				`retiring the target in favor of ${redirectKey}`
		);
		const source = await Target.get({ id: sourceUrl, select: ['renderInterval'] });
		await retireSource(job);

		// An existing destination row — active OR suppressed — wins: active means it's already
		// in rotation under its own cadence; suppressed means a render already proved it
		// non-indexable, and a redirect pointing at it is no reason to resurrect it.
		const existingTarget = await Target.get({ id: destinationUrl, select: 'url' });
		if (existingTarget) return;

		// Same gate the bot-traffic discovery applies: a host outside the allowlist can never
		// be marked indexable.
		const domain = URL.parse(destinationUrl)?.hostname;
		if (config.domains.length && !config.domains.includes(domain)) return;

		// Due now, not jittered: adoptions arrive one per source render, already spread by the
		// sources' own schedule jitter, and the source's cached pages were just deleted — the
		// sooner the destination renders, the shorter the window a bot gets neither page.
		const target = { nextRenderTime: currentMinuteMs() };
		if (Number.isFinite(source?.renderInterval) && source.renderInterval > 0) {
			target.renderInterval = source.renderInterval;
		}
		await Target.put(destinationUrl, target);
	}

	/**
	 * A redirect result that keeps its source in rotation still costs a strike: one temp
	 * redirect is failover noise, but `render.redirects.maxStrikes` consecutive ones mean the
	 * "temporary" status is a lie (or the route list will never serve the destination) and the
	 * source is retired outright. Retiring is safe, not destructive — bot traffic for the URL
	 * proxies to the origin, which serves its own redirect, and on-demand discovery re-creates
	 * whatever the origin actually serves. The strike counter is the target's one shared
	 * `strikes` field (suppression uses it too); any successful render clears it.
	 */
	static async recordRedirectStrike(job, why) {
		const sourceUrl = job.url;
		// One read serves both the strike decision and the reschedule below.
		const renderTarget = await Target.get({
			id: sourceUrl,
			// `demandInterval` rides along on a point read this path already makes, so the cadence filed
			// on the schedule row is the ladder's rung rather than the route ceiling.
			select: ['strikes', 'renderInterval', 'sitemapUrl', 'demandInterval'],
		});
		if (!renderTarget) {
			await settleTargetless(job, await readTargetlessRow(job));
			return;
		}
		const strikes = countedStrikes(renderTarget.strikes) + 1;
		const maxStrikes = config.render.redirects.maxStrikes;
		if (Number.isFinite(maxStrikes) && maxStrikes > 0 && strikes >= maxStrikes) {
			logger.info(
				`Prerendered url ${sourceUrl} kept redirecting ${strikes} consecutive times (${why}) — retiring it; ` +
					`bots get the origin's own redirect and discovery re-creates what it actually serves`
			);
			await retireSource(job); // drops the target, its pages, and every folding row
			return;
		}
		await Target.patch(sourceUrl, { strikes });
		await this.rescheduleAtTargetCadence(job, renderTarget);
	}

	/**
	 * Retry shape for auth-shaped (401/403) and transient (408/429/5xx) failures and renderer
	 * errors — the ones that never suppress. Two lanes, split by the target's strike count
	 * (`render.failureRetry.fastRetries`):
	 *
	 *   FAST — the schedule row is left alone AND THE CALLER KEEPS THE CLAIM LEASE, so the retry
	 *   comes on lease expiry (`queue.jobLeaseTime`, minutes). An origin blip recovers fast, and
	 *   the cached pages' swrTtl window keeps serving bots across a lease-sized wait.
	 *
	 *   SLOW — after `fastRetries` consecutive failures this is not a blip: drop to the
	 *   target's normal cadence so a persistently failing page can't hot-loop renders all
	 *   day. The kept pages' expiry is deliberately NOT extended: `swrTtl` is the product
	 *   bound on how stale we serve as if fresh, and past it bots fall through to the
	 *   origin — whose answer (a live page for auth-shaped failures, an honest 5xx for
	 *   transient ones) is the truth. Serving arbitrarily old snapshots while users get
	 *   errors would break bot/user parity.
	 *
	 * Strikes are the target's one shared counter (suppression and redirect strikes use it
	 * too); any successful render clears it. One result per URL means one strike per failed
	 * cycle — when each device posted its own result, two devices failing counted two, and the
	 * fast lane was exhausted in a single cycle. A targetless key (render-now one-off) has its
	 * row dropped, as everywhere else.
	 *
	 * WHAT CHANGED IN v0.34.0, AND WHY IT HAD TO. The fast lane used to work purely by omission:
	 * `claim` wrote `now + jobLeaseTime` into `nextRenderTime`, so "leave the schedule untouched"
	 * meant "the row is due again at lease expiry". With the lease moved out of the row (see
	 * util/renderLease.js), "untouched" means the row still carries its ORIGINAL overdue due time
	 * and is immediately re-claimable — a paced retry silently becomes a hot loop re-rendering a
	 * failing page as fast as the fleet can claim it. So the fast lane now returns `'fast'` and
	 * the caller does NOT release the lease. The timing is deliberately unchanged: the lease
	 * expires at CLAIM + jobLeaseTime, so a render that fails 30s in retries in
	 * jobLeaseTime − 30s. The lease is NOT re-armed to `now + jobLeaseTime` on failure — that
	 * would quietly lengthen a documented wait.
	 *
	 * The cost, which belongs in the operator's head: a held lease holds the claim floor, so
	 * `fastRetries: 2` can pin it for 2 × jobLeaseTime (20 minutes on defaults), and during a
	 * broad origin 5xx or a bot-mitigation rule change EVERY job takes this lane and no lease is
	 * released at all for that window.
	 *
	 * @returns {Promise<'fast'|'slow'|'dropped'>} which lane was taken. `'fast'` means the caller
	 *   must keep the lease; the other two mean release it (the row is now in the future or gone,
	 *   and holding a lease for it would pin the claim floor for a full lease for nothing).
	 */
	static async retryAfterFailure(job) {
		const sourceUrl = job.url;
		const renderTarget = await Target.get({
			id: sourceUrl,
			// `demandInterval` rides along on a point read this path already makes, so the cadence filed
			// on the schedule row is the ladder's rung rather than the route ceiling.
			select: ['strikes', 'renderInterval', 'sitemapUrl', 'demandInterval'],
		});
		if (!renderTarget) {
			// A deferred row is in the future, like a slow-lane backoff: the caller releases the lease.
			return (await settleTargetless(job, await readTargetlessRow(job))) === 'deferred' ? 'slow' : 'dropped';
		}
		const strikes = countedStrikes(renderTarget.strikes) + 1;
		await Target.patch(sourceUrl, { strikes });

		if (strikes <= config.render.failureRetry.fastRetries) {
			logger.debug(`Retrying ${job.rowKey} on its claim lease (failure strike ${strikes})`);
			// Schedule untouched, lease held by the caller — the lease expiry drives the retry.
			return 'fast';
		}

		if (!job.fold) {
			// A one-device render beside the URL's rotation has no backoff row of its own: the URL row
			// renders this device's siblings on cadence regardless, and a per-device row that lingered
			// here would be one more thing the rotation does not know about.
			await deleteSchedule(job.rowKey);
			job.rowGone = true;
			return 'slow';
		}

		const interval = resolveRenderInterval(sourceUrl, renderTarget.renderInterval);
		const fromSitemap = !!renderTarget.sitemapUrl;
		const wait = backoffWait(interval, strikes, fromSitemap);
		// THE CADENCE, NOT `wait`. The backoff is how long until the retry; the cadence is how often the
		// page wants to render. Filing `wait` here would tell the sweep a repeatedly-failing 1h page is
		// on a multi-hour cadence and rank it as barely late — rewarding failure with lower priority on
		// every strike. `backoffWait` is derived FROM the cadence, so both are in hand.
		const cadence = resolveEffectiveInterval(sourceUrl, renderTarget);
		const nextRenderTime = currentMinuteMs() + wait;
		logger.debug(
			`Retrying ${sourceUrl} in ${Math.round(wait / 60000)}m (failure strike ${strikes}` +
				`${fromSitemap ? '' : ', non-sitemap'})`
		);
		await writeSchedule(sourceUrl, { nextRenderTime, fromSitemap, effectiveInterval: cadence });
		return 'slow';
	}

	/**
	 * Keep a redirecting source in its rotation. Mirrors the post-render scheduling in
	 * processDecodedJobResult: a target-backed URL comes due one interval from completion (so
	 * cadence self-paces instead of realigning into a herd); a targetless key (render-now one-off,
	 * orphaned row) — and a one-device row beside a URL's rotation — has its row dropped so the
	 * lease doesn't re-claim it forever.
	 *
	 * `preloaded` (a row already read with at least renderInterval + sitemapUrl, e.g. by
	 * recordRedirectStrike) skips the point read.
	 */
	static async rescheduleAtTargetCadence(job, preloaded) {
		const sourceUrl = job.url;
		const renderTarget =
			preloaded ??
			(await Target.get({
				id: sourceUrl,
				select: ['renderInterval', 'sitemapUrl', 'demandInterval'],
			}));
		if (!job.fold) {
			await deleteSchedule(job.rowKey);
			job.rowGone = true;
			return;
		}
		if (!renderTarget) {
			await settleTargetless(job, await readTargetlessRow(job));
			return;
		}
		// Same cadence resolution as the post-render path above (route > stored > default).
		const interval = resolveRenderInterval(sourceUrl, renderTarget.renderInterval);
		await writeSchedule(sourceUrl, {
			nextRenderTime: currentMinuteMs() + interval,
			fromSitemap: !!renderTarget.sitemapUrl,
			// The ladder rung when the row carried one, else the ceiling. A caller-supplied `preloaded`
			// row is documented as "at least renderInterval + sitemapUrl", so an absent `demandInterval`
			// means "not read" rather than "not promoted" — resolving to the ceiling is the safe reading,
			// and the next render files the true rung either way. (`recordRedirectStrike`, the one
			// in-tree preloader, now selects it.)
			effectiveInterval: resolveEffectiveInterval(sourceUrl, renderTarget),
		});
	}

	/**
	 * Grant up to `limit` due jobs.
	 *
	 * THE RESPONSE SHAPE IS A CONTRACT: HTTP 200 with a bare JSON array, `[]` when there is
	 * nothing to grant. The render fleet's consumer treats only 200 as success and immediately
	 * `.map`s the body — a 204, an object wrapper, or a new status code circuit-breaks a
	 * perfectly healthy node.
	 *
	 * WHAT NO LONGER HAPPENS HERE: the per-job lease write. `claim` used to write
	 * `nextRenderTime = now + jobLeaseTime` back onto every granted row, which was a second
	 * write per render landing on the hot head of the very index the scan seeks from. The lease
	 * now lives in a node-local shared buffer (util/renderLease.js) and recording it is an atomic
	 * store, so one render costs exactly ONE schedule write — the reschedule when its result
	 * lands. That halves queue write volume and audit bytes (~87 → ~44 MB/day/node).
	 *
	 * `expiresAt` is therefore no longer minute-floored either. The flooring only ever existed
	 * because the value doubled as a `nextRenderTime`, and it silently cost up to 59,999 ms of
	 * lease — which matters because the fleet discards any granted job with under 30s of lease
	 * left (hence `queue.jobLeaseTime`'s two-minute minimum).
	 */
	static claim = mutex.withLock(async ({ limit = 20 } = {}) => {
		if (QueueState.status === 'paused') {
			return [];
		}

		// Bound the batch server-side so no consumer can over-claim: the whole pass runs under
		// this mutex, and one worker must not be able to hold it while hoarding a burst other
		// renderers should share.
		limit = Math.min(Math.max(1, limit | 0), config.queue.maxClaimLimit);

		// One pass: floored scan, drained before anything is leased, leases granted from memory,
		// floor advanced to the first due row the pass saw. All of it in util/renderSchedule.js —
		// this function owns the wire format and the status report, nothing else.
		const scanStarted = performance.now();
		const pass = await claimSchedules({ grantLimit: limit });
		// The queue's leading indicator: this duration degrades (measured 17x once) when dead index
		// entries pile at the seek point, before any backlog shows. Two clock reads and one buffered
		// emit per pass — nothing on the per-row path.
		metrics.claimScan(
			performance.now() - scanStarted,
			pass.scanTruncated ? 'capped' : pass.jobs.length ? 'granted' : 'empty'
		);

		// WHERE the batch came from. Two emits per claim at most, on a path that runs a few times a
		// second — and the only evidence that the ready set is doing anything, since it moves no totals.
		const fromReady = pass.fromReady ?? 0;
		if (fromReady > 0) metrics.claimSource(fromReady, 'ready');
		if (pass.jobs.length - fromReady > 0) metrics.claimSource(pass.jobs.length - fromReady, 'index');

		const jobs = [];
		let notOwnedHere = 0;

		for (const granted of pass.jobs) {
			// ONE JOB PER ROW, AND A ROW IS A URL. The job carries every device to render — the configured
			// default set for a URL row; exactly the one device a per-device row names (a pre-0.66.0 row
			// that has not converted yet, or a deliberate one-device render) — and the browser renders
			// them in turn and posts one result. `deviceType` (the first) is kept for a renderer that
			// predates `deviceTypes`: it renders that one device and posts the flat legacy shape, which
			// `processJobResult` attributes to that device. Degraded, not broken — the render fleet is
			// deployed first.
			const url = CacheKey.urlOf(granted.cacheKey);
			const device = CacheKey.deviceOf(granted.cacheKey);
			const deviceTypes = device ? [device] : defaultDeviceTypes();

			// Detection only, deliberately. `claim`'s lease write used to purge a stale local
			// record on a node that is no longer the residency owner, as a side effect; that purge
			// is gone with the write. The corrective write is a new write on the hot claim path with
			// residency semantics that could not be verified, so Stage 1 ships the count and leaves
			// the repair to `render.reconcile` (which restores the row on the new owner) until this
			// number proves it happens.
			if (getResidencyByUrl(url) !== server.hostname) notOwnedHere++;

			jobs.push({
				id: granted.cacheKey,
				url,
				deviceTypes,
				deviceType: deviceTypes[0],
				expiresAt: granted.expiresAtMs,
				callbackOrigin: `${protocol}://${server.hostname}:${port}`,
				// `fromSitemap` is denormalized onto the schedule row, so the job is built with no
				// per-job Target read.
				isFromSitemap: !!granted.fromSitemap,
			});
		}

		if (pass.leaseRefused) {
			// Deliberately not "all N slots are in use": a grant is also refused when the key's
			// 8-slot probe window is full (occupancy can be a fraction of maxLeases) or when its
			// publish CAS lost a race. Report the occupancy and let it say which.
			logger.warn(
				`[prerender] claim could not record a lease for a due row: ${pass.occupancy} of ` +
					`${config.queue.maxLeases} slots occupied. Granted ${jobs.length} of ${limit}. If the occupancy is ` +
					`near the table size, raise queue.maxLeases (restart-scoped); if it is nowhere near it, the key's ` +
					`probe window is full and the next pass will place it elsewhere.`
			);
		} else if (pass.scanTruncated && jobs.length < limit) {
			logger.warn(
				`[prerender] claim hit its ${pass.scanLimit}-row scan cap with ${pass.occupancy} lease(s) in flight and ` +
					`granted ${jobs.length} of ${limit}, without reaching a not-yet-due row. In-flight work is filling ` +
					`the scan window — raise queue.claimScanCap, or look at ${pass.floorHeldBy ?? 'the oldest due row'}, ` +
					`which is holding the claim floor at minute ${pass.floorTo}.`
			);
		}

		// A SEPARATE CHECK, deliberately not chained onto the branches above. The wedged row this names
		// is one due row that never reschedules on an otherwise HEALTHY node: every pass still reaches a
		// not-yet-due row, so `scanTruncated` is false and `leaseRefused` is false, and the branch above
		// stays silent for as long as the node runs. That was the whole failure — the single scenario the
		// `floorHeldBy` report was added for was the one scenario that could never print it, while the
		// scan quietly degraded past the cost the floor was introduced to remove.
		//
		// The threshold is what the retry design itself can explain and no more: the fast-retry lane
		// holds its lease, and therefore the floor, for `fastRetries` full leases before the slow lane
		// writes the row forward, so one further lease beyond that is not a lane — it is a row whose
		// result never comes. Rate-limited to one line per window per worker, so a genuinely stuck row
		// says so about twice before `queue.claimFloor.unpinAfter` pushes it forward on its own.
		// Gated on the floor being ON: with it off the scan seeks from the absolute index minimum anyway,
		// so a row that never moves costs nothing extra and there is nothing to warn about.
		if (config.queue.claimFloor.enabled) {
			const explainable = config.queue.jobLeaseTime * (Math.max(0, config.render.failureRetry.fastRetries | 0) + 1);
			if (pass.floorPinnedForMs > explainable && Date.now() - lastFloorPinWarnAt >= explainable) {
				lastFloorPinWarnAt = Date.now();
				const unpin = config.queue.claimFloor.unpinAfter;
				logger.warn(
					`[prerender] ${pass.floorHeldBy} has held the claim floor at minute ${pass.floorTo} for ` +
						`${Math.round(pass.floorPinnedForMs / 60_000)} minute(s) — longer than the retry lanes can account ` +
						`for (${Math.round(explainable / 60_000)} min), so its render is failing in a way that posts no ` +
						`result and reschedules nothing. Everything due behind it is waiting and the nextRenderTime index ` +
						`is degrading above it. ` +
						(unpin > 0
							? `It will be pushed forward automatically after ${Math.round(unpin / 60_000)} min.`
							: `queue.claimFloor.unpinAfter is 0, so this will NOT resolve on its own — repair or delete the URL.`)
				);
			}
		}

		if (notOwnedHere) {
			logger.warn(
				`[prerender] claim granted ${notOwnedHere} job(s) for URL(s) this node does not own by residency. ` +
					`Stale local schedule rows on a former owner are no longer purged at claim time; the schedule ` +
					`reconcile sweep restores them on the new owner.`
			);
		}

		if (jobs.length === 0) {
			// TRI-STATE, and the distinction is not cosmetic. "Saw due rows but granted none" means
			// a large backlog is entirely in flight (or the scan cap was consumed by it) — reporting
			// `empty` there tells every consumer in the fleet to back off to its idle interval while
			// there is work, and nothing corrects it until the next status sync.
			QueueState.reportStatus(pass.sawDue ? 'queued' : 'empty');
		}

		return jobs;
	});

	/**
	 * Reset the claim floor now instead of waiting out `queue.claimFloor.resetInterval`.
	 *
	 * The operator escape hatch for the one write this plugin cannot see: a due time written
	 * below the floor through the operations API or the exported `RenderSchedule` REST surface.
	 * Under the claim mutex, so it cannot interleave with a pass's `advanceFloor`.
	 */
	static resetClaimFloor = mutex.withLock(async () => ({ ...resetFloorNow(), node: server.hostname }));

	async post(target, data) {
		const ctx = this.getContext();
		switch (target.id) {
			// Deliberately node-scoped: this resource sets `loadAsInstance = false`, which
			// skips Harper's allow* permission checks (see Resource.ts), so it must not be
			// able to pause the whole cluster. Cluster-scoped control lives on the
			// super-user-gated admin resource.
			case 'pause':
				return RenderQueue.pause({ updatedBy: ctx?.user?.username ?? 'render_queue-api' });
			case 'resume':
				return RenderQueue.resume({ updatedBy: ctx?.user?.username ?? 'render_queue-api' });
			case 'claim':
				return RenderQueue.claim(data, ctx);
			case 'job_result':
				return RenderQueue.processJobResult(data, ctx);
			default:
				break;
		}
	}
}

let queueStatusSyncStarted = false;

/**
 * Start the periodic queue-status refresh on worker 0. Called from
 * handleApplication after config is applied (so the interval reflects overrides).
 * Idempotent. The interval follows `queue.statusSyncInterval` changes without a restart.
 */
/**
 * The ready-set sweep, on worker 0, on its own interval.
 *
 * SEPARATE FROM `startQueueStatusSync` DESPITE THE SIMILAR SHAPE, and the reason is the claim mutex.
 * The status sync deliberately runs inside it — the floor reset and the lease-gauge walk both need
 * that serialization. The sweep must NOT: it holds a read cursor over the due set for hundreds of
 * milliseconds, and taking the claim mutex for that long would block every claim on the node for the
 * duration of a scan whose entire purpose is to keep claims off the index.
 *
 * It needs no mutex of its own either. It writes nothing to the database, and its only shared-memory
 * write is `publish`, which fills the inactive slot and flips one atomic — so a concurrent claim
 * either sees the previous generation or the next one, never a partial set. Two overlapping sweeps
 * would merely duplicate work, and `sweeping` prevents that within a worker.
 */
let readySweepStarted = false;

/**
 * `e?.message`, never `e.message`: anything can be thrown, and `null.message` is a TypeError raised
 * from inside the very handler that exists to keep this path alive. Same helper and same reasoning as
 * `util/configOverride.js`.
 */
const messageOf = (e) => e?.message ?? String(e);

/**
 * Node's `setInterval` ceiling. Past 2^31-1 ms the delay overflows: node warns and then fires the
 * callback after ONE MILLISECOND. So an over-large sweep interval does not merely slow the sweep
 * down, it converts it into a hot loop re-reading the due set on worker 0 — the opposite of what the
 * number asked for. The schema rejects anything larger with a warning, which is the loud path; this
 * clamp is here so that the loud path working is not the only thing between a typo and that loop.
 */
const MAX_TIMER_MS = 2147483647;

export function startReadySweep() {
	if (server.workerIndex !== 0 || readySweepStarted) return;
	readySweepStarted = true;

	let sweeping = false;

	const sweep = () => {
		if (sweeping || !config.queue.ready.enabled) return;
		sweeping = true;
		const started = performance.now();
		// THE SYNCHRONOUS INVOCATION IS INSIDE THE TRY, not just the promise chain. `sweeping` is a
		// latch: if the call throws before returning a promise, `finally` never runs, the latch is never
		// released, and the sweep is permanently dead for the life of the process — with claims quietly
		// falling back to the index scan and nothing saying why. That silent-forever failure is worth
		// more than the narrow chance of the throw.
		try {
			sweepReadySet()
				.then((result) => {
					if (result?.skipped) return;
					metrics.readySweep(performance.now() - started, result.truncated ? 'capped' : 'complete');
					metrics.readyPublished(result.published);
					// Both halves, every sweep, so the ratio is readable without needing the total from a
					// second series — and so `carried: 0` is an explicit observation rather than an absence.
					metrics.readyCadenceSource(result.cadenceCarried, 'carried');
					metrics.readyCadenceSource(result.due - result.cadenceCarried, 'resolved');
					if (result.truncated) {
						// The rows past the cap are the YOUNGEST, so a truncated sweep leaves recently-due pages
						// unranked — precisely the pages this feature exists to protect. That makes it a warning
						// rather than a statistic.
						logger.warn(
							`[prerender] ready-set sweep read its ${config.queue.ready.sweepCap}-row cap without reaching a ` +
								`not-yet-due row: ${result.due} due row(s) seen, ${result.published} published. The ordering ` +
								`covers only the oldest part of the backlog, so recently-due pages are going unranked. Raise ` +
								`queue.ready.sweepCap, or reduce the backlog.`
						);
					}
				})
				.catch((e) => logger.error(messageOf(e)))
				.finally(() => {
					sweeping = false;
				});
		} catch (e) {
			logger.error(messageOf(e));
			sweeping = false;
		}
	};

	// Once immediately, so a restarted worker generation does not serve a whole interval of claims
	// from the index before the set exists.
	sweep();

	const arm = (ms) => {
		const timer = ms > 0 ? setInterval(sweep, Math.min(MAX_TIMER_MS, ms)) : null;
		timer?.unref?.();
		return timer;
	};

	let armed = config.queue.ready.sweepInterval;
	let timer = arm(armed);

	onConfigApplied(() => {
		if (config.queue.ready.sweepInterval === armed) return;
		if (timer) clearInterval(timer);
		armed = config.queue.ready.sweepInterval;
		timer = arm(armed);
	});
}

export function startQueueStatusSync() {
	if (server.workerIndex !== 0 || queueStatusSyncStarted) return;
	queueStatusSyncStarted = true;

	let refreshing = false;

	const refresh = () => {
		if (refreshing) return;

		refreshing = true;
		RenderQueue.refreshQueueStatus()
			.catch(logger.error)
			.finally(() => {
				refreshing = false;
			});
	};

	refresh();

	let armedInterval = config.queue.statusSyncInterval;
	let timer = setInterval(refresh, armedInterval);
	timer.unref?.();

	onConfigApplied(() => {
		if (config.queue.statusSyncInterval === armedInterval) return;
		clearInterval(timer);
		armedInterval = config.queue.statusSyncInterval;
		timer = setInterval(refresh, armedInterval);
		timer.unref?.();
	});
}
