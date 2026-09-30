import { Pool } from 'undici';
import { settings } from '../settings.js';

const originPoolMap = new Map<string, Pool>();

function getPool(origin: string) {
	let pool = originPoolMap.get(origin);
	if (!pool) {
		// One connection per render that may be posting its result at once.
		const renders = settings.admission.mode === 'pressure' ? settings.admission.max : settings.concurrency;
		pool = new Pool(origin, { connections: Math.max(settings.concurrency, renders) });
		originPoolMap.set(origin, pool);
	}
	return pool;
}

const baseHeaders = () => ({
	'x-worker-id': settings.harper.workerId,
	'authorization': `Basic ${Buffer.from(`${settings.harper.user}:${settings.harper.pass}`).toString('base64')}`,
});

export const request = async (origin: string, options: Parameters<Pool['request']>[0]) => {
	const pool = getPool(origin);

	return pool.request({ ...options, headers: { ...baseHeaders(), ...options.headers } });
};
