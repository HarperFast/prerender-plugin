/**
 * A cursor-chunked walk over a URL-keyed table that survives UNREADABLE rows.
 *
 * Found in production: rows whose key attribute fails to decode. Depending on the read path, the
 * store either yields such a row with `url` missing, or silently ENDS the projected iterator at
 * it. Under the naive walk (`chunk.length < chunkSize` = end of range) that second behavior makes
 * a purge, census, or probe sweep report "finished" after covering an arbitrary fraction of the
 * range — measured stopping at 13,529 of 1.4M rows, with the operator told the walk completed.
 * The rules that repair that:
 *
 *   1. A row without a string `url` is SKIPPED and counted (`onUnreadable`), never compared or
 *      yielded — it cannot be probed, purged, or used as a cursor, but it must not end the walk
 *      when the iterator tolerates it. (Unreadable rows in a full chunk's tail are counted on the
 *      re-read that follows the next cursor advance, not twice.)
 *   2. A short chunk is VERIFIED before being believed: a forward probe past the last readable
 *      key (projection-free — the tolerant read path), and when that is inconclusive, a
 *      descending probe from the top of the range, which can prove rows remain without crossing
 *      the row the forward read chokes on.
 *   3. When rows provably remain but no readable cursor can advance the walk — including a FULL
 *      chunk containing no readable row, which could never advance — it THROWS: partial coverage
 *      must surface as an error the caller records, never as a clean finish. When the evidence is
 *      ambiguous (an unreadable row sits past the cursor and no probe can place it inside or
 *      outside the range), the walk also throws: a false alarm is recoverable, a silent lie is
 *      not.
 *
 * `endBound` (exclusive) keeps the verification probes inside the caller's range so a row from
 * the next keyspace region can neither resume nor fail a prefix-scoped walk. The bounded probe
 * shape (two conditions on the key) falls back to an unbounded probe filtered in code when the
 * store rejects it. Residual (documented, not fixable from this layer): a range whose LAST key is
 * itself unreadable can still end a walk early when every probe path aborts on it; escalate such
 * rows to the database layer.
 */
export async function* walkUrlRange(table, { startAt = '', select, chunkSize, onUnreadable, endBound }) {
	let cursor = null;
	let inclusiveStart = startAt;
	let lastResume = null;

	const cannotAdvance = () =>
		new Error(
			`url walk cannot advance past an unreadable row after ${JSON.stringify(cursor)} — ` +
				`the range was NOT fully covered; treat this pass as partial and escalate the row to the database layer`
		);

	const search = async (conditions, descending, limit) => {
		const out = [];
		for await (const row of table.search({
			conditions,
			sort: descending ? { attribute: 'url', descending: true } : { attribute: 'url' },
			limit,
		})) {
			out.push(row);
			if (out.length >= limit) break;
		}
		return out;
	};

	/**
	 * One projection-free row past the cursor (ascending) or the last row of the range
	 * (descending). Returns `null` only when no supported query shape can answer — the caller must
	 * treat that as unknown, never as empty.
	 */
	const probeSearch = async (descending) => {
		const range = [{ attribute: 'url', comparator: 'greater_than', value: cursor ?? '' }];
		const bounded = endBound ? [...range, { attribute: 'url', comparator: 'less_than', value: endBound }] : range;
		try {
			return await search(bounded, descending, 1);
		} catch {
			// The two-condition shape is refused here. Ascending degrades cleanly: probe unbounded
			// and apply the bound in code — a READABLE first row at or past endBound is proof the
			// range itself is clear. Descending cannot degrade (the table's top row says nothing
			// about this range), so it reports unknown.
			if (descending) return null;
			try {
				const rows = await search(range, false, 1);
				if (rows.length && typeof rows[0]?.url === 'string' && endBound && rows[0].url >= endBound) return [];
				return rows;
			} catch {
				return null;
			}
		}
	};

	while (true) {
		const chunk = [];
		for await (const row of table.search({
			conditions: [
				{
					attribute: 'url',
					comparator: inclusiveStart !== null ? 'greater_than_equal' : 'greater_than',
					value: inclusiveStart !== null ? inclusiveStart : cursor,
				},
			],
			sort: { attribute: 'url' },
			...(select ? { select } : {}),
			limit: chunkSize,
		})) {
			chunk.push(row);
		}
		inclusiveStart = null;

		let lastReadableIndex = -1;
		for (let i = 0; i < chunk.length; i++) {
			if (typeof chunk[i]?.url === 'string') lastReadableIndex = i;
		}
		const full = chunk.length >= chunkSize;
		// A full chunk with no readable row can never advance the cursor: re-querying returns the
		// same rows forever. Rule 3 — loud, not looping.
		if (full && lastReadableIndex === -1) throw cannotAdvance();
		for (let i = 0; i < chunk.length; i++) {
			const row = chunk[i];
			if (typeof row?.url !== 'string') {
				// Unreadable rows AFTER the last readable key of a full chunk are re-read by the
				// next query (the cursor sits before them) — counting them now would double-count.
				if (!full || i < lastReadableIndex) onUnreadable?.();
				continue;
			}
			lastResume = null;
			cursor = row.url;
			yield row;
		}

		if (full) continue;

		// Short chunk: either the range is exhausted, or the projected iterator gave up at a row
		// it could not read. Ask once, projection-free, from the last key we can address.
		const probe = await probeSearch(false);
		if (probe && probe.length && typeof probe[0]?.url === 'string') {
			// The projected walk stopped early but the range continues at a readable key — resume
			// from it inclusively (if only the row's PROJECTED read breaks, resuming at it yields
			// it and nothing is lost). A repeat of the same resume key means the projected read
			// can never hand the row over: skip it exclusively, counting it, and keep walking.
			if (probe[0].url === lastResume) {
				cursor = probe[0].url;
				lastResume = null;
				onUnreadable?.();
				continue;
			}
			lastResume = probe[0].url;
			inclusiveStart = probe[0].url;
			continue;
		}
		if (probe && probe.length) {
			// A row exists past the cursor but its key is unreadable. Without an endBound it is
			// in-range by definition. With one, it may belong to the next region — only the
			// bounded descending probe can tell; an in-range readable key above the cursor means
			// rows remain, an empty answer means the unreadable row (and anything above it) sits
			// outside or is the documented last-key residual.
			if (!endBound) throw cannotAdvance();
			const top = await probeSearch(true);
			if (top === null) throw cannotAdvance();
			if (top.length && typeof top[0]?.url === 'string') throw cannotAdvance();
			return;
		}
		if (probe === null) {
			// The forward probe could not run at all — verify via the top of the range before
			// trusting the short chunk.
			const top = await probeSearch(true);
			if (top && top.length && typeof top[0]?.url === 'string') throw cannotAdvance();
			if (top === null) return; // no probe shape works here — the chunk walk's answer stands
			return;
		}

		// Forward probe ran and the range past the cursor is empty. One descending look catches
		// the store that aborts ascending reads at the poison row but can still read from the top.
		const top = await probeSearch(true);
		if (top && top.length && typeof top[0]?.url === 'string' && top[0].url !== cursor) throw cannotAdvance();
		return;
	}
}
