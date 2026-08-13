import { getSab } from '../util/coordination.js';

export const QueueStatusCode = {
	empty: 0,
	queued: 1,
	paused: 2,
};
export const QueueStatusByCode = {
	0: 'empty',
	1: 'queued',
	2: 'paused',
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
	 * Publish this node's observed queue status.
	 *
	 * `heartbeat` decides what happens when the status did NOT change: normally nothing (the
	 * hot callers — the claim pass and the bot serve path — must not put a replicated write
	 * behind every request), but the periodic status sync passes it so the row is rewritten
	 * every `queue.statusSyncInterval` whether or not anything moved.
	 *
	 * That rewrite is what makes `updatedTime` mean "last reported" instead of "last CHANGED",
	 * and it is the meaning everything downstream already assumes — the QueueControl schema
	 * comment ("each node rewrites its own row every status sync"), and PrerenderAdmin's
	 * staleness rule, which calls a row stale after two sync intervals. Without it a healthy
	 * node that simply stays `queued` stops writing, goes stale after two minutes and never
	 * recovers, so every node in a busy cluster is permanently flagged — and the node that
	 * genuinely stopped reporting, the only case the flag exists for, looks exactly the same.
	 * Measured on a 4-node cluster before this: all four flagged stale, rows 8.7 minutes to
	 * 5.4 hours old, every node alive and claiming.
	 *
	 * A heartbeat writes the flag's CURRENT value, never the requested one. Requesting
	 * `queued` while this node holds `paused` is a no-op by design (the compareExchange below
	 * cannot move a flag holding `paused`), and a heartbeat that wrote the argument would
	 * quietly publish `queued` for a paused node — turning a liveness signal into a false
	 * status report.
	 */
	static reportStatus(status, force = status === 'paused', { heartbeat = false } = {}) {
		const statusCode = QueueStatusCode[status];

		if (statusCode === undefined) {
			logger.warn(`Unsupported Queue Status: ${status}`);
			return;
		}

		let nextState = null;

		if (statusCode === QueueStatusCode.paused || force) {
			Atomics.store(this.i32a, 0, statusCode);
			nextState = {
				status,
				updatedTime: Date.now(),
			};
		} else {
			const oppositeCode = statusCode === QueueStatusCode.empty ? QueueStatusCode.queued : QueueStatusCode.empty;
			if (Atomics.compareExchange(this.i32a, 0, oppositeCode, statusCode) === oppositeCode) {
				nextState = {
					status,
					updatedTime: Date.now(),
				};
			}
		}

		if (!nextState && heartbeat) {
			nextState = {
				status: this.status,
				updatedTime: Date.now(),
			};
		}

		if (nextState) {
			return databases.render_service.QueueStatus.put(server.hostname, nextState);
		}
	}
}
