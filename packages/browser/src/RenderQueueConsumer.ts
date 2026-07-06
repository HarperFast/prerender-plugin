import RenderJob from './RenderJob.js';
import logger from './util/Logger.js';
import { request } from './external/http.js';
import { connectMqtt } from './external/mqtt.js';
import { settings } from './settings.js';
import { getHostHealth, parseRetryAfter } from './HostHealth.js';

export const Topic = {
	// Matches the plugin's QueueStatus export name (@export(name: "queue_status")).
	queueState: 'queue_status/#',
} as const;

// Claim responses that mean "host overloaded/unavailable" (vs. a real bug) — these
// circuit-break the host with escalating backoff instead of tight-looping.
const UNAVAILABLE_STATUS = new Set([429, 502, 503, 504]);

type ClaimOutcome = 'jobs' | 'empty' | 'unavailable' | 'error';

/** Coerce a producer `updatedTime` (number epoch-ms or ISO string) to ms, or undefined. */
const toEpochMs = (value: unknown): number | undefined => {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const t = Date.parse(value);
		if (!Number.isNaN(t)) return t;
	}
	return undefined;
};

export async function* RenderQueueConsumer(signal?: AbortSignal) {
	const mqttClient = await connectMqtt();
	const health = getHostHealth();

	// try wraps ALL setup after connectMqtt (message handler, subscribe, loop) so a failure
	// during setup — e.g. subscribeAsync throwing — still closes the MQTT client in `finally`
	// instead of leaking the connection.
	try {
		mqttClient.on('message', (_topic, payload) => {
			// Runs async in the event loop, so a JSON.parse throw would bypass the
			// surrounding try/finally and crash the worker — guard it.
			try {
				const queueState = JSON.parse(payload.toString());
				if (!queueState?.hostname) return;
				health.applyMqttStatus(queueState.hostname, queueState.status, toEpochMs(queueState.updatedTime));
			} catch (err) {
				logger.error({ err }, 'failed to parse queue_status message');
			}
		});

		await mqttClient.subscribeAsync(Topic.queueState, { qos: 1, rh: 0 });

		const claimJobs = async (
			host: string,
			limit: number
		): Promise<{ jobs: RenderJob[]; outcome: ClaimOutcome; retryAfterMs?: number }> => {
			try {
				// The queue API port is TLS in every real deployment; only a local dev Harper
				// is plaintext. Speaking http:// to the TLS port gets the connection closed with
				// no response (undici "other side closed"), so default to https and use http only
				// for a localhost origin — mirrors the plugin's callbackOrigin scheme choice.
				const scheme = host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https';
				const res = await request(`${scheme}://${host}:${settings.queuePort}`, {
					method: 'POST',
					path: '/render_queue/claim',
					body: JSON.stringify({ limit }),
					headers: { 'content-type': 'application/json' },
				});
				if (res.statusCode === 200) {
					const jobs: any = await res.body.json();
					const renderJobs = jobs.map((job: any) => new RenderJob(job));
					return { jobs: renderJobs, outcome: renderJobs.length ? 'jobs' : 'empty' };
				}
				// res.body.json() is a Promise (and can reject on a non-JSON error body) — await
				// text() so we log the actual response, not a pending Promise / unhandled rejection.
				const body = await res.body.text().catch(() => '');
				if (UNAVAILABLE_STATUS.has(res.statusCode)) {
					const retryAfterMs = parseRetryAfter(res.headers['retry-after'] as string | string[] | undefined);
					logger.warn({ host, statusCode: res.statusCode, retryAfterMs }, 'queue host unavailable — backing off');
					return { jobs: [], outcome: 'unavailable', retryAfterMs };
				}
				logger.error({ host, statusCode: res.statusCode, body }, 'failed to claim jobs');
				return { jobs: [], outcome: 'error' };
			} catch (e) {
				// Network error / host unreachable — treat as unavailable and circuit-break.
				logger.warn({ host, err: e }, 'queue host unreachable — backing off');
				return { jobs: [], outcome: 'unavailable' };
			}
		};

		while (!signal?.aborted) {
			const host = health.pickEligible();

			if (!host) {
				// Abortable, and woken early when a host becomes eligible (a `queued` status
				// arrives), so a freshly-enqueued job is picked up without waiting out the timer.
				await health.wait(health.nextWakeDelay(), signal);
				continue;
			}

			const { jobs, outcome, retryAfterMs } = await claimJobs(host, settings.jobClaimLimit);
			switch (outcome) {
				case 'jobs':
					health.recordJobs(host);
					break;
				case 'empty':
					health.recordEmpty(host);
					break;
				case 'unavailable':
					health.recordUnavailable(host, retryAfterMs);
					break;
				case 'error':
					health.recordError(host);
					break;
			}

			for (const job of jobs) {
				if (signal?.aborted) return;
				yield job;
			}
		}
	} finally {
		await mqttClient.endAsync().catch(() => {});
	}
}
