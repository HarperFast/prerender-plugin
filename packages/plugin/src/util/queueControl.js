/**
 * Desired-pause-state (intent) resolution for the render queue.
 *
 * The queue's *effective* pause flag lives in a node-local SharedArrayBuffer
 * (`QueueState`), which is what `claim` reads — fast, cross-worker, and deliberately
 * not replicated. That makes it unreachable from another node, so pausing the cluster
 * used to mean hitting `POST /render_queue/pause` on every node individually.
 *
 * The `QueueControl` table carries the *intent* instead, and is replicated: a write on
 * any node reaches all of them. Each node's periodic `refreshQueueStatus` (worker 0)
 * resolves the intent for itself and stores it into its local flag — so a pause
 * converges everywhere within one `queue.statusSyncInterval` with no RPC and no
 * node-to-node addressing.
 *
 * Precedence: a per-node row wins over the cluster-wide `all` row, so one node can be
 * held out of (or explicitly kept in) rotation independently.
 */

export const CLUSTER_SCOPE = 'all';

/**
 * Resolve the desired pause state from the two intent records.
 *
 * A record only participates when its `paused` is an actual boolean — a row that exists
 * with `paused: null`/absent (e.g. written by a bare API PUT) is treated as "no opinion"
 * and falls through to the next level, rather than being coerced to `false` and silently
 * overriding the cluster default.
 *
 * @param {{paused?: unknown} | null | undefined} nodeControl per-node row (scope = hostname)
 * @param {{paused?: unknown} | null | undefined} clusterControl cluster row (scope = 'all')
 * @returns {{paused: boolean, source: 'node' | 'cluster' | 'default'}}
 */
export const resolveDesiredPause = (nodeControl, clusterControl) => {
	if (typeof nodeControl?.paused === 'boolean') {
		return { paused: nodeControl.paused, source: 'node' };
	}
	if (typeof clusterControl?.paused === 'boolean') {
		return { paused: clusterControl.paused, source: 'cluster' };
	}
	return { paused: false, source: 'default' };
};

/**
 * Read both intent records for `hostname` and resolve them. Kept separate from the pure
 * resolver above so the precedence rules stay unit-testable outside Harper.
 */
export const getDesiredPause = async (hostname) => {
	const { QueueControl } = databases.render_service;

	const [nodeControl, clusterControl] = await Promise.all([
		QueueControl.get({ id: hostname, select: 'paused' }),
		QueueControl.get({ id: CLUSTER_SCOPE, select: 'paused' }),
	]);

	return resolveDesiredPause(nodeControl, clusterControl);
};

/**
 * Record an intent. `paused: null` deletes the row — for a node scope that means
 * "inherit the cluster default" (there is nothing above `all` to inherit, so deleting it
 * just means "not paused").
 */
export const setDesiredPause = async (scope, paused, updatedBy) => {
	const { QueueControl } = databases.render_service;

	if (paused === null) {
		await QueueControl.delete(scope);
		return { scope, paused: null, inherited: true };
	}

	await QueueControl.put(scope, { paused: !!paused, updatedBy: updatedBy ?? null });
	return { scope, paused: !!paused, inherited: false };
};
