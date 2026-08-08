import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `queue.maxLeases` has to be read AFTER the host's options are applied.
 *
 * The lease buffer used to be acquired at MODULE SCOPE, and `extension.js` imports this module chain
 * (RenderQueue → Target → Sitemap → …) before it calls `applyOptions(scope.options.getAll())` — the
 * exact ordering `src/config.js` warns about at the top of the file. So the size came from the
 * DEFAULT: an operator who set `queue.maxLeases: 16384` got 4,096 slots, restart or no restart, and
 * the "logged loudly and then honoured" branch could never fire either, because both sides of its
 * comparison came from that same stale number. The schema's documented remedy for its documented
 * symptom did nothing.
 *
 * This file reproduces the ordering: import first, apply the option second, use the table third —
 * and asserts the table is the size the operator asked for. The size assert is exercised too, over a
 * named buffer another worker generation already sized, since that is the branch the fix makes
 * reachable.
 */

const WANTED = 16_384;

let funnel, lease, config;
const sabs = new Map();
const errors = [];

before(async () => {
	globalThis.server = { hostname: 'test-node', nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { info() {}, warn() {}, error: (message) => errors.push(String(message)) };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					// Keyed, and it keeps the FIRST buffer for a name — which is what
					// `getUserSharedBuffer` does, and the whole reason `maxLeases` is restart-scoped.
					getUserSharedBuffer: (key, buffer) => {
						if (!sabs.has(key)) sabs.set(key, buffer);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_schedule: { RenderSchedule: { put: async () => {}, delete: async () => {}, search: () => [] } },
	};

	({ config } = await import('../src/config.js'));
	lease = await import('../src/util/renderLease.js');
	// IMPORTED BEFORE THE OPTION IS APPLIED, exactly as the plugin does it. Importing must not
	// allocate anything.
	funnel = await import('../src/util/renderSchedule.js');
	assert.equal(sabs.size, 0, 'importing the funnel must not size the lease buffer');
});

test('a maxLeases set after import (i.e. by applyOptions) is honoured', () => {
	const original = config.queue.maxLeases;
	try {
		config.queue.maxLeases = WANTED;

		// First use — a lease operation, as `claim` would.
		assert.equal(funnel.leaseTable().slots, WANTED, 'the operator got the table they configured');
		assert.equal(
			sabs.get(lease.LEASE_SAB_KEY).byteLength,
			lease.leaseBufferBytes(WANTED),
			'and the shared buffer is sized to match — not to the default'
		);
		assert.equal(errors.length, 0, 'no size mismatch to report');
	} finally {
		config.queue.maxLeases = original;
	}
});

test('a buffer already sized by an earlier worker generation is honoured — never indexed past', () => {
	// The other half of the same branch: the funnel logs the mismatch (it cannot be re-driven here,
	// since the accessor memoizes its table for the process) and then honours the buffer it got.
	// Indexing past a short buffer would be silent memory corruption; a smaller table is merely a
	// smaller table.
	const buffer = new ArrayBuffer(lease.leaseBufferBytes(64));
	const table = lease.createLeaseTable({ buffer, slots: WANTED, now: () => 1_700_000_000_000 });

	assert.equal(table.slots, 64, 'the slot count comes from the buffer we actually got');
	assert.equal(table.grant('a|desktop', { dueMinute: 1, leaseExpiryMs: 1_700_000_600_000 }), true);
	assert.equal(table.isLeased('a|desktop'), true);
});
