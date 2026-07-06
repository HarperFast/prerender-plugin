import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostHealth, parseRetryAfter } from '../dist/HostHealth.js';

// Deterministic clock + jitter so backoff math is exact. random=0 → idle = base*0.75,
// circuit = exp/2.
const makeHealth = (overrides: Partial<Record<string, number>> = {}) => {
	let t = 1000;
	const clock = { set: (v: number) => (t = v), advance: (d: number) => (t += d), now: () => t };
	const health = new HostHealth({
		idleMs: 1000,
		minMs: 100,
		maxMs: 1000,
		pausedMs: 5000,
		maxIdleMs: 60000,
		now: clock.now,
		random: () => 0,
		...overrides,
	});
	return { health, clock };
};

test('an unknown host is never eligible', () => {
	const { health } = makeHealth();
	assert.equal(health.isEligible('a'), false);
	assert.equal(health.pickEligible(), null);
	assert.equal(health.nextWakeDelay(), 60000); // no known hosts → full idle cap
});

test('queued makes a host eligible immediately; recordJobs keeps it eligible', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	assert.equal(health.isEligible('a'), true);
	assert.equal(health.pickEligible(), 'a');
	assert.equal(health.nextWakeDelay(), 0);
	health.recordJobs('a');
	assert.equal(health.isEligible('a'), true);
});

test('an empty claim backs off polling by (jittered) idleMs', () => {
	const { health, clock } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	health.recordEmpty('a');
	assert.equal(health.isEligible('a'), false);
	assert.equal(health.nextWakeDelay(), 750); // idleMs 1000 * (0.75 + 0)
	clock.advance(750);
	assert.equal(health.isEligible('a'), true);
});

test('an empty status message also backs off polling', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'empty', 1);
	assert.equal(health.isEligible('a'), false);
	assert.equal(health.nextWakeDelay(), 750);
});

test('paused backs off by pausedMs', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'paused', 1);
	assert.equal(health.isEligible('a'), false);
	assert.equal(health.nextWakeDelay(), 5000);
});

test('unavailable circuit-breaks with escalating backoff, then recovers', () => {
	const { health, clock } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	health.recordUnavailable('a'); // round 1: failures=1 → exp=min(1000,100)=100 → /2 = 50
	assert.equal(health.isEligible('a'), false);
	assert.equal(health.nextWakeDelay(), 50);
	clock.advance(50);
	assert.equal(health.isEligible('a'), true);

	health.recordUnavailable('a'); // round 2 (circuit expired): failures=2 → exp=200 → 100
	assert.equal(health.nextWakeDelay(), 100);
	clock.advance(100);
	health.recordUnavailable('a'); // round 3: failures=3 → exp=400 → 200
	assert.equal(health.nextWakeDelay(), 200);

	health.recordSuccess('a'); // resets the circuit
	assert.equal(health.isEligible('a'), true);
	health.recordUnavailable('a'); // failures back to 1 → 50
	assert.equal(health.nextWakeDelay(), 50);
});

test('repeated unavailability within one open window does not compound the exponent', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	health.recordUnavailable('a'); // round 1 → failures=1 → 50
	health.recordUnavailable('a'); // circuit still open, no time passed → no escalation
	health.recordUnavailable('a');
	assert.equal(health.nextWakeDelay(), 50);
});

test('circuit backoff is capped at maxMs', () => {
	const { health, clock } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	// Each failure must be its own round (circuit expired) to escalate the exponent.
	for (let i = 0; i < 20; i++) {
		if (i > 0) clock.advance(60000);
		health.recordUnavailable('a');
	}
	assert.equal(health.nextWakeDelay(), 500); // capped exp 1000 → /2
});

test('Retry-After overrides the computed backoff (capped at 2m)', () => {
	const { health, clock } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	health.recordUnavailable('a', 3000); // circuitUntil = 1000 + 3000
	assert.equal(health.nextWakeDelay(), 3000);
	clock.set(4000);
	assert.equal(health.isEligible('a'), true);

	// An oversized Retry-After is capped to 2 minutes (nextWakeDelay itself clamps the
	// *sleep* to maxIdleMs, so assert the cap via eligibility, not the sleep length).
	health.recordSuccess('a');
	health.recordUnavailable('a', 10 * 60 * 1000); // now=4000 → circuitUntil = 4000 + 120000
	clock.set(124000 - 1);
	assert.equal(health.isEligible('a'), false);
	clock.set(124000);
	assert.equal(health.isEligible('a'), true);
});

test('Retry-After of 0 (or a past date) does NOT collapse the circuit to zero backoff', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	health.recordUnavailable('a', 0); // 0 must fall through to exponential, not 0ms
	assert.equal(health.isEligible('a'), false);
	assert.equal(health.nextWakeDelay(), 50); // exponential path, failures=1
});

test('a tiny positive Retry-After is floored at minMs', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	health.recordUnavailable('a', 5); // below minMs=100 → floored, not honored verbatim
	assert.equal(health.nextWakeDelay(), 100);
});

test('queued does NOT shorten an active error circuit (has work but shedding load)', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	health.recordUnavailable('a'); // circuitUntil = now+50
	// A fresh queued status arrives while the circuit is open: still not eligible.
	health.applyMqttStatus('a', 'queued', 2);
	assert.equal(health.isEligible('a'), false);
	assert.equal(health.nextWakeDelay(), 50);
});

test('a non-retriable error escalates like an unavailable host (no ~1s re-poll spin)', () => {
	const { health, clock } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1);
	health.recordError('a'); // round 1: failures=1 → 50
	assert.equal(health.nextWakeDelay(), 50);
	clock.advance(50);
	health.recordError('a'); // round 2: failures=2 → 100
	assert.equal(health.nextWakeDelay(), 100);
});

test('stale (older-timestamped) MQTT messages are ignored', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'queued', 10); // newest we have seen
	health.applyMqttStatus('a', 'empty', 5); // out-of-order/retained older empty → ignored
	assert.equal(health.isEligible('a'), true);
});

test('a newer queued after empty re-enables the host', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'empty', 5);
	assert.equal(health.isEligible('a'), false);
	health.applyMqttStatus('a', 'queued', 6);
	assert.equal(health.isEligible('a'), true);
});

test('pickEligible returns only ready hosts', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'empty', 1); // backed off
	health.applyMqttStatus('b', 'queued', 1); // ready
	assert.equal(health.pickEligible(), 'b');
});

test('nextWakeDelay returns time until the soonest host, clamped to maxIdleMs', () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'paused', 1); // now+5000
	health.applyMqttStatus('b', 'empty', 1); // now+750 (sooner)
	assert.equal(health.nextWakeDelay(), 750);
});

test('wait resolves early on notify (a host becomes queued)', async () => {
	const { health } = makeHealth();
	const p = health.wait(10000);
	health.applyMqttStatus('a', 'queued', 1); // notifies waiters
	await p; // resolves well before 10s
	assert.ok(true);
});

test('recordSuccess wakes a sleeping consumer when it clears the circuit', async () => {
	const { health } = makeHealth();
	health.applyMqttStatus('a', 'queued', 1); // nextPollAt = 0
	health.recordUnavailable('a'); // circuit open → not eligible
	const p = health.wait(10000);
	health.recordSuccess('a'); // clears circuit → eligible now → should notify the waiter
	await p; // resolves well before 10s
	assert.ok(true);
});

test('wait resolves on abort and returns immediately if already aborted', async () => {
	const { health } = makeHealth();
	const ac = new AbortController();
	const p = health.wait(10000, ac.signal);
	ac.abort();
	await p;

	const ac2 = new AbortController();
	ac2.abort();
	await health.wait(10000, ac2.signal); // already aborted → immediate
	assert.ok(true);
});

test('parseRetryAfter handles delta-seconds, dates, arrays, and junk', () => {
	assert.equal(parseRetryAfter(undefined), undefined);
	assert.equal(parseRetryAfter(''), undefined);
	assert.equal(parseRetryAfter('5'), 5000);
	assert.equal(parseRetryAfter('0'), 0);
	assert.equal(parseRetryAfter(['3']), 3000);
	assert.equal(parseRetryAfter('not-a-number'), undefined);
	assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT'), 0); // past date → 0
});
