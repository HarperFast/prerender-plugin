import { getSab } from '../util/coordination.js';

/**
 * This node's observed queue status, as the render fleet reads it (the replicated `QueueStatus` row).
 *
 *   empty    nothing due
 *   queued   due rows exist (in flight included)
 *   paused   the pause intent holds; only a forced report moves off it
 *   unready  the queue keeper is not serving claims — waiting for peers, loading, retrying a failed
 *            load, or gone quiet (`GET /prerender_admin/queue-state` `trust.phase` says which). A
 *            status of its own so that becoming ready is a CHANGE, and is broadcast: the fleet wakes on
 *            `queued` at once, where a node that had reported `queued` all along would be found only on
 *            its next idle poll. A consumer that predates it treats an unknown status as `empty` — back
 *            off to the idle interval — which is right for a node that can grant nothing.
 */
export const QueueStatusCode = {
	empty: 0,
	queued: 1,
	paused: 2,
	unready: 3,
};
export const QueueStatusByCode = {
	0: 'empty',
	1: 'queued',
	2: 'paused',
	3: 'unready',
};

const sab = await getSab('queue_status', 4);

export class QueueState extends Resource {
	static loadAsInstance = false;

	static i32a = new Int32Array(sab);

	static get status() {
		const statusCode = Number(Atomics.load(this.i32a, 0));
		return QueueStatusByCode[statusCode];
	}

	/**
	 * Record `status` and write the row, but only on a CHANGE: this is called per claim and per bot
	 * request, and the node-local flag is what keeps those from each becoming a replicated write.
	 * Unforced, it moves the flag from any status except `paused` (a pause is lifted only by a forced
	 * report, from the status sync).
	 */
	static reportStatus(status, force = status === 'paused') {
		const statusCode = QueueStatusCode[status];

		if (statusCode === undefined) {
			logger.warn(`Unsupported Queue Status: ${status}`);
			return;
		}

		let changed = false;
		if (force) {
			// Forced (a pause, or the status sync lifting one): always stored and written.
			Atomics.store(this.i32a, 0, statusCode);
			changed = true;
		} else {
			for (;;) {
				const current = Atomics.load(this.i32a, 0);
				if (current === statusCode || current === QueueStatusCode.paused) break;
				if (Atomics.compareExchange(this.i32a, 0, current, statusCode) === current) {
					changed = true;
					break;
				}
			}
		}

		if (changed) {
			return databases.render_service.QueueStatus.put(server.hostname, { status, updatedTime: Date.now() });
		}
	}

	/**
	 * "Work just arrived": `empty` → `queued`, and nothing else. A hint from a path that wrote a due row
	 * (render-now, revalidate) must not move `unready` — the fleet would poll, be granted nothing, and the
	 * claim would report `unready` straight back — nor `paused`.
	 */
	static noteWork() {
		if (
			Atomics.compareExchange(this.i32a, 0, QueueStatusCode.empty, QueueStatusCode.queued) === QueueStatusCode.empty
		) {
			return databases.render_service.QueueStatus.put(server.hostname, { status: 'queued', updatedTime: Date.now() });
		}
	}
}
