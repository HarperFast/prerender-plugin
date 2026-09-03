/**
 * CROSS-NODE INVALIDATION HEAL — forward the heal to the key's owner, default off.
 *
 * `accelerateHeal` refuses outright when this node does not own the key by residency. Measured on a
 * four-node production cluster during a route-wide invalidation, that discarded **84-85% of every
 * heal attempt** (`invalidation_reenqueue{outcome='not-owner'}` against the total). The module's
 * nominated fallback — "crawlers revisit, so the other 75% heal on a later crawl that lands on the
 * owner" — assumes bot traffic distributes the way residency does. It does not: traffic lands where
 * the CDN's geo-routing sends it and residency is rendezvous-hashed over the key, so on a
 * deployment measured at 70/21/6/3 traffic against a uniform ~25% residency share, a key owned by
 * the quietest node is requested there about 3% of the time. For a quarter of the corpus the
 * accelerator is effectively off, and no amount of revisiting fixes it.
 *
 * ── WHY FORWARD, RATHER THAN JUST WRITE FROM HERE ──────────────────────────────────────────────
 *
 * The guard's own stated reason — that a cross-node write files a row beneath the owner's claim
 * floor — is VOID, and provably so. `claim` seeks from `readFloorMinute`, which clamps:
 *
 *     Math.max(0, Math.min(stored, nowMinute - guardMinutes))
 *
 * The effective floor can never exceed `now - guard`, however far `stored` has advanced, so a due
 * time at or after the current minute clears every node's floor by the whole guard band —
 * unconditionally, with no dependence on the peer's queue state.
 *
 * But three OTHER things behind that guard are only correct on the owner, and they are why writing
 * from here anyway would be a regression rather than a fix:
 *
 *   leased       `leaseInfo(key)` reads THIS node's lease buffer. Off-owner it answers about the
 *                wrong node. (Cost of getting this wrong alone is a wasted write, not a fault.)
 *   the row      `getScheduleRow` passes `replicateFrom: false`, so off-owner it returns a stale
 *                local copy or nothing — a residency ghost, never authoritative.
 *   not-sooner   and therefore I10 — "never raise a due time" — CANNOT be evaluated off-owner. This
 *                one genuinely bites: a page inside its stale-while-revalidate window has
 *                `nextRenderTime` in the PAST, so writing `now + jitter` would push an already-late
 *                render LATER. That is the exact failure this feature's review notes record it
 *                attracting.
 *
 * So the owner has to be the one to decide. It runs `accelerateHeal` locally, where every guard
 * above is exact, and this module is only the transport.
 *
 * ── WHAT MAKES IT AFFORDABLE ───────────────────────────────────────────────────────────────────
 *
 * A call per invalidated request would be ~66,000/hr on the measured deployment. It is not: the
 * SLOT IS RESERVED BEFORE THE CALL, so `maxPerMinute` bounds calls made, exactly as it already
 * bounds writes accepted. At 40/min that is 40 calls per node per minute, whatever the traffic.
 *
 * The double-budgeting is deliberate, not redundant. The sender's slot bounds calls it MAKES; the
 * owner's bounds writes it ACCEPTS. An owner can receive forwarded traffic from every peer at once,
 * so its own limit is what protects its write and audit volume — the sender cannot know how many
 * other nodes are aimed at it.
 *
 * ── TRUST ──────────────────────────────────────────────────────────────────────────────────────
 *
 * THE EPOCH IS NOT SENT. The request body carries only `{ url, cacheKey }`, and the owner re-resolves
 * the invalidation itself. A forwarded epoch would be a value one node accepts from another to
 * decide what to stop serving; re-resolving costs the owner two point reads it would have made
 * anyway and removes the trust dependency entirely. It also means a stale sender — one whose
 * invalidation view has not caught up — cannot cause work on a scope that is no longer invalidated.
 *
 * Authenticated by the same shared cluster token as `peerRescue`, deliberately reusing that secret
 * rather than minting a second one: it is the same trust boundary (node-to-node, on the serve path,
 * with no user credential available to forward), and two secrets to rotate is worse than one. The
 * endpoint fails CLOSED — unconfigured is 404, wrong token is 403.
 */

import { Agent } from 'undici';
import { config } from '../config.js';
import { peerOrigin, isKnownNode } from './peer.js';

/** Both halves ON and a usable shared secret — the single gate for the client AND the endpoint. */
export const isPeerHealActive = () =>
	Boolean(config.invalidation.reenqueue.crossNode.enabled && config.peerRescue.token && config.peerRescue.header);

// Pooled keep-alive connections, same reasoning as util/peerRescue.js: peers are a handful of fixed
// origins and the demand is bursty. Lazily built — config is not applied at import time.
let agent;
const dispatcher = () => (agent ??= new Agent());

export const PEER_HEAL_PATH = '/prerender_peer/heal';

/**
 * Ask `owner` to run its own `accelerateHeal` for this key.
 *
 * Returns `{ ok: true, outcome }` with the OWNER's verdict (which is frequently a refusal — that is
 * the owner's guards working, not a transport failure), or `{ ok: false, reason }`.
 *
 * Never throws: this runs detached from a response that has already been sent, so every failure has
 * to end as a counted refusal rather than an unhandled rejection.
 */
export const forwardHeal = async ({ owner, url, cacheKey }) => {
	if (!isPeerHealActive()) return { ok: false, reason: 'disabled' };
	// Defence in depth, as in util/peer.js and util/peerRescue.js: the owner comes from our own
	// residency function, but validating it against the cluster's node list keeps a bug or a config
	// change from turning this into an arbitrary-host request.
	if (!isKnownNode(owner)) return { ok: false, reason: `unknown node "${owner}"` };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.invalidation.reenqueue.crossNode.timeoutMs);
	timer.unref?.();

	try {
		const response = await fetch(`${peerOrigin(owner)}${PEER_HEAL_PATH}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				[config.peerRescue.header]: config.peerRescue.token,
			},
			body: JSON.stringify({ url, cacheKey }),
			signal: controller.signal,
			dispatcher: dispatcher(),
		});
		if (!response.ok) return { ok: false, reason: `peer responded ${response.status}` };
		const body = await response.json();
		return { ok: true, outcome: body?.outcome ?? 'unknown' };
	} catch (e) {
		// Name read directly rather than via `instanceof Error`: an abort rejects with a DOMException
		// whose prototype chain differs across runtimes (the classification bug util/peer.js documents).
		const name = e?.name;
		// `String(e)` rather than `e`: anything can be thrown, and a null/undefined rejection would
		// otherwise render as the literal "null" in the reason. Same idiom as util/peer.js.
		const message = e?.message ?? String(e);
		return { ok: false, reason: name === 'AbortError' ? 'peer timed out' : `peer fetch failed: ${message}` };
	} finally {
		clearTimeout(timer);
	}
};
