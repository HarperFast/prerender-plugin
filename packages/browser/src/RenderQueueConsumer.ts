import { setTimeout as sleep } from 'timers/promises';
import RenderJob from './RenderJob.js';
import logger from './util/Logger.js';
import { request } from './external/http.js';
import { connectMqtt } from './external/mqtt.js';
import { settings } from './settings.js';

const SLEEP_DELAY = 60 * 1000;

export const Topic = {
	// Matches the plugin's QueueStatus export name (@export(name: "queue_status")).
	queueState: 'queue_status/#',
} as const;

enum ProducerStatus {
	queued = 'queued',
	empty = 'empty',
	paused = 'paused',
}

interface ProducerState {
	hostname: string;
	status: ProducerStatus;
	lastUpdated: Date;
}

export async function* RenderQueueConsumer(signal?: AbortSignal) {
	const mqttClient = await connectMqtt();

	const producerStates = new Map<string, ProducerState>();

	mqttClient.on('message', (_topic, payload) => {
		const queueState = JSON.parse(payload.toString());
		producerStates.set(queueState.hostname, queueState);
	});

	await mqttClient.subscribeAsync(Topic.queueState, { qos: 1, rh: 0 });

	const pickAvailableQueueHost: () => string | null = () => {
		const eligibleHosts: string[] = [];

		producerStates.forEach((producer) => {
			if (producer.status === ProducerStatus.queued) {
				eligibleHosts.push(producer.hostname);
			}
		});

		if (eligibleHosts.length === 0) return null;

		return eligibleHosts[Math.floor(Math.random() * eligibleHosts.length)];
	};

	const claimJobs = async (host: string, limit: number): Promise<RenderJob[]> => {
		try {
			const res = await request(`http://${host}:${settings.queuePort}`, {
				method: 'POST',
				path: '/render_queue/claim',
				body: JSON.stringify({
					limit,
				}),
				headers: {
					'content-type': 'application/json',
				},
			});
			if (res.statusCode === 200) {
				const jobs: any = await res.body.json();
				return jobs.map((job: any) => new RenderJob(job));
			} else {
				logger.error(res.body.json());
				return [];
			}
		} catch (e) {
			logger.error(e);
			return [];
		}
	};

	try {
		while (!signal?.aborted) {
			const host = pickAvailableQueueHost();

			if (!host) {
				try {
					// Abortable so a graceful shutdown doesn't wait out the (up to 60s) idle poll.
					await sleep(Math.random() * SLEEP_DELAY, undefined, { signal });
				} catch {
					break; // aborted during the idle sleep
				}
				continue;
			}

			const jobs = await claimJobs(host, settings.jobClaimLimit);

			for (const job of jobs) {
				if (signal?.aborted) return;
				yield job;
			}
		}
	} finally {
		await mqttClient.endAsync().catch(() => {});
	}
}
