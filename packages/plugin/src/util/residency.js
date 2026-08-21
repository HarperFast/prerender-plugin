import { fnv1a32 } from './hash.js';

/**
 * Rendezvous (HRW) hashing: deterministically picks the node responsible for a
 * given URL, so every node agrees on the owner without coordination.
 *
 * THE NODE LIST MUST BE READ LAZILY, AND AN EMPTY PEER LIST IS NEVER AN ANSWER.
 *
 * `server.nodes` is derived state, not configuration. harper-pro initialises it to `[]` at
 * module scope and only fills it when `subscribeToNodeUpdates` runs a full `hdb_nodes` scan
 * (`replication/knownNodes.ts`), so anything evaluated before that scan sees no peers on a
 * healthy multi-node cluster — and that ordering repeats for every worker start, not only the
 * first. Later rebuilds do empty and refill the array, but synchronously (the scan is a plain
 * `for...of`, and the per-update path filters and pushes before its first await), so they are
 * atomic to any observer and are NOT a window of their own. What they establish is that this
 * list is rebuilt from a table rather than fixed at boot, which is why capturing it once is
 * wrong in principle and not merely unlucky.
 *
 * With no peers, HRW makes this node the owner of every URL. `RenderSchedule.setResidencyById`
 * then reports self for every key, so Harper stores every schedule row LOCALLY instead of
 * routing it to its owner (`core/resources/Table.ts`, which omits the local record only when
 * the computed residency excludes `server.hostname`). That is silent and permanent: nothing
 * deletes a schedule row from a node that does not own it, the owner never gets the row, and
 * the non-owner re-claims and re-renders it forever because its own reschedule routes away.
 * Capturing the list at module load made one unlucky evaluation poison a worker for its whole
 * lifetime, which has been observed in production as a multi-percent share of a corpus.
 *
 * So: the last non-empty list wins over an empty one, and any non-empty list is adopted
 * immediately (a genuine membership change must still take effect). Before any peer has ever
 * been seen, self-only is the only answer available — and the correct one for a single-node
 * deployment, which is why this warns rather than throws.
 */

// Cache identity AND length: `knownNodes.ts` both reassigns `server.nodes` (filter-then-push)
// and pushes onto the existing array, so neither check alone sees every change. Steady state is
// two comparisons, which matters because the reconcile and orphan sweeps call this once per row
// over the whole corpus. It would miss a same-length rename mutated into the array in place;
// `knownNodes.ts` has no such path, and every mutation it does perform changes one or the other.
let cachedFrom;
let cachedLength = -1;
let resolvedNodes = [];
let selfOnly;
let warnedPeerless = false;

function currentNodes() {
	const peers = server.nodes;
	const length = peers?.length ?? 0;

	if (length !== 0 && (peers !== cachedFrom || length !== cachedLength)) {
		cachedFrom = peers;
		cachedLength = length;
		// A decode-miss descriptor can reach `server.nodes` without a name. Left in, it sorts
		// into the ring as `undefined` and — when it wins the hash — makes this function return
		// undefined, which Harper reads as a residency that excludes every node and stores the
		// record nowhere at all.
		const names = peers.map((node) => node?.name).filter(Boolean);
		// Latch only a list that actually contains a peer: a populated `server.nodes` that
		// yields no usable name is "not known yet" for the same reason an empty one is, and
		// must not be allowed to overwrite a good list with a self-only one.
		if (names.length) resolvedNodes = [...new Set([server.hostname, ...names])].sort();
	}

	if (resolvedNodes.length) return resolvedNodes;

	if (!warnedPeerless) {
		warnedPeerless = true;
		// `globalThis.logger`, not a bare `logger`: optional chaining does not guard an
		// UNDECLARED identifier, and a residency throw makes Harper drop the record — the
		// diagnostic must not be able to break the decision it reports on.
		globalThis.logger?.warn?.(
			`[prerender] residency has never seen a peer, so ${server.hostname} maps to itself for every URL. ` +
				`Schedule rows written now are stored locally instead of on their owner, and nothing removes ` +
				`them later. Expected only on a single-node deployment; on a cluster it means this process ` +
				`started before hdb_nodes was populated.`
		);
	}

	// Cached like the peered list: a single-node deployment takes this branch on every call.
	return (selfOnly ??= [server.hostname]);
}

/** The cluster's known node names, self included. Sorted, deduplicated, never empty. */
export const getNodes = () => currentNodes();

export function getResidencyByUrl(url) {
	const nodes = currentNodes();
	let bestIdx = 0;
	let bestScore = -1;

	for (let i = 0; i < nodes.length; i++) {
		const score = fnv1a32(`${url}|${nodes[i]}`);

		if (score > bestScore) {
			bestScore = score;
			bestIdx = i;
		}
	}

	return nodes[bestIdx];
}
