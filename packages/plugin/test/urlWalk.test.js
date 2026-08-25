import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkUrlRange } from '../src/util/urlWalk.js';

/**
 * The unreadable-row contract (see src/util/urlWalk.js): rows without a string `url` are skipped
 * and counted; a short chunk is verified before being believed; and when rows provably remain but
 * the walk cannot advance, it THROWS rather than reporting a clean finish. The fake below scripts
 * the two store personalities observed in production: the tolerant iterator that yields the
 * unreadable row (url missing), and the aborting iterator that silently ends the chunk at it.
 */

const U = (n) => `https://example.com/product/prd-${String(n).padStart(4, '0')}/`;

/** A table whose search answers from a scripted, ordered row list. `aborts` is a set of urls the
 *  PROJECTED read path silently stops in front of (the select-abort personality); rows with
 *  `url: undefined` model the tolerant personality. */
const fakeTable = (rows, { abortsBefore = new Set() } = {}) => ({
	calls: [],
	search({ conditions, sort, select, limit }) {
		this.calls.push({ conditions, select, limit, descending: !!sort?.descending });
		const [range, upper] = [conditions[0], conditions[1]];
		let view = rows.filter((r) => {
			const key = r.key;
			if (range.comparator === 'greater_than' ? key <= range.value : key < range.value) return false;
			if (upper && key >= upper.value) return false;
			return true;
		});
		if (sort?.descending) view = [...view].reverse();
		const out = [];
		for (const r of view) {
			// The aborting personality ends the stream in front of the poison row — but only on
			// projected (select) reads; the projection-free probe tolerates and yields it.
			if (select && abortsBefore.has(r.key)) break;
			out.push({ ...r.record });
			if (out.length >= limit) break;
		}
		return out;
	},
});

const row = (key, readable = true) => ({ key, record: readable ? { url: key } : { url: undefined } });

const collect = async (iter) => {
	const urls = [];
	for await (const r of iter) urls.push(r.url);
	return urls;
};

test('clean range: walks everything and ends on the empty probe', async () => {
	const rows = [row(U(1)), row(U(2)), row(U(3))];
	const table = fakeTable(rows);
	let unreadable = 0;
	const urls = await collect(
		walkUrlRange(table, { startAt: '', select: ['url'], chunkSize: 2, onUnreadable: () => unreadable++ })
	);
	assert.deepEqual(urls, [U(1), U(2), U(3)]);
	assert.equal(unreadable, 0);
});

test('tolerant store: an unreadable row is skipped and counted, the walk continues past it', async () => {
	const rows = [row(U(1)), row(U(2), false), row(U(3)), row(U(4))];
	const table = fakeTable(rows);
	let unreadable = 0;
	const urls = await collect(
		walkUrlRange(table, { startAt: '', select: ['url'], chunkSize: 10, onUnreadable: () => unreadable++ })
	);
	assert.deepEqual(urls, [U(1), U(3), U(4)]);
	assert.equal(unreadable, 1);
});

test('aborting store: a silently-short chunk skips the projection-poison row and keeps walking', async () => {
	// Projected reads stop in FRONT of prd-0002 forever; the projection-free probe yields it
	// readable. The walk first resumes AT it (optimistic — a projection-only failure), sees the
	// repeat, then skips it exclusively and continues. Exactly one row is lost, and counted.
	const rows = [row(U(1)), row(U(2)), row(U(3)), row(U(4))];
	const table = fakeTable(rows, { abortsBefore: new Set([U(2)]) });
	let unreadable = 0;
	const urls = await collect(
		walkUrlRange(table, { startAt: '', select: ['url'], chunkSize: 10, onUnreadable: () => unreadable++ })
	);
	assert.deepEqual(urls, [U(1), U(3), U(4)]);
	assert.equal(unreadable, 1);
});

test('unreadable everywhere: rows provably remain but the walk cannot advance — it throws', async () => {
	// The poison row is unreadable on EVERY path and the projected read aborts in front of it:
	// forward probe yields the url-less row, which proves the range is not exhausted — and gives
	// no key to advance from.
	const rows = [row(U(1)), row(U(2), false), row(U(3))];
	const table = fakeTable(rows, { abortsBefore: new Set([U(2)]) });
	let unreadable = 0;
	await assert.rejects(
		collect(walkUrlRange(table, { startAt: '', select: ['url'], chunkSize: 10, onUnreadable: () => unreadable++ })),
		/NOT fully covered/
	);
});

test('descending end-check catches the fully-blind store: probe empty, top shows rows remain', async () => {
	// Both the projected read AND the ascending probe abort in front of the poison row; only the
	// descending probe (which never crosses it) can prove rows remain.
	const rows = [row(U(1)), row(U(2), false), row(U(3))];
	const table = {
		...fakeTable(rows, { abortsBefore: new Set([U(2)]) }),
		search({ conditions, sort, limit }) {
			const upper = conditions[1];
			let view = rows.filter((r) => {
				if (conditions[0].comparator === 'greater_than' ? r.key <= conditions[0].value : r.key < conditions[0].value)
					return false;
				if (upper && r.key >= upper.value) return false;
				return true;
			});
			if (sort?.descending) view = [...view].reverse();
			const out = [];
			for (const r of view) {
				// ascending reads (projected or not) abort in front of the poison; descending never
				// reaches it because the readable top row comes first.
				if (!sort?.descending && r.key === U(2)) break;
				out.push({ ...r.record });
				if (out.length >= limit) break;
			}
			return out;
		},
	};
	await assert.rejects(
		collect(walkUrlRange(table, { startAt: '', select: ['url'], chunkSize: 10 })),
		/NOT fully covered/
	);
});

test('endBound keeps the probes inside the range: a next-region poison row cannot false-alarm the walk', async () => {
	// The unreadable row lives in the NEXT keyspace region. Bounded probes exclude it, so this
	// range finishes cleanly; unbounded probes would see it and throw a false partial-coverage
	// error for a range that was in fact fully covered.
	const inside = row('https://example.com/catalog.jsp?CN=a');
	const outsidePoison = row('https://example.com/product/prd-0001/', false);
	const rows = [inside, outsidePoison];
	const table = fakeTable(rows, { abortsBefore: new Set([outsidePoison.key]) });
	const urls = await collect(
		walkUrlRange(table, {
			startAt: 'https://example.com/catalog.jsp',
			select: ['url'],
			chunkSize: 10,
			endBound: 'https://example.com/catalog.jsq',
		})
	);
	assert.deepEqual(urls, [inside.key]);
	await assert.rejects(
		collect(
			walkUrlRange(fakeTable(rows, { abortsBefore: new Set([outsidePoison.key]) }), {
				startAt: 'https://example.com/catalog.jsp',
				select: ['url'],
				chunkSize: 10,
			})
		),
		/NOT fully covered/
	);
});
