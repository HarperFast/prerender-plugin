import { fnv1a32 } from './hash.js';

export const nodes = [server.hostname, ...(server.nodes?.map(({ name }) => name) ?? [])].sort();

/**
 * Rendezvous (HRW) hashing: deterministically picks the node responsible for a
 * given URL, so every node agrees on the owner without coordination.
 */
export function getResidencyByUrl(url) {
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
