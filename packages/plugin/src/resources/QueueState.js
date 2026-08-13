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

	static reportStatus(status, force = status === 'paused') {
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

		if (nextState) {
			return databases.render_service.QueueStatus.put(server.hostname, nextState);
		}
	}
}
