/**
 * A JSON document one worker writes and every worker reads, in one named shared buffer.
 *
 * The queue keeper lives on worker 0, but an admin request lands on whichever worker its connection
 * did. So worker 0 publishes the keeper's state here and any worker serves it, with no database work
 * and no cross-thread messaging.
 *
 * Same discipline as `util/readyQueue.js`: two slots, write the inactive one, flip an atomic, so a
 * reader always decodes one complete document. A reader copies its slot and then checks that the
 * generation did not move while it copied; the writer publishes every few seconds and a read takes
 * microseconds, so a retry is rare and two in a row rarer still. A document too large for a slot is
 * refused rather than truncated: half a JSON document is not a smaller document.
 *
 * NO DEPENDENCIES, deliberately: `test/sharedSnapshot.test.js` drives it against a plain ArrayBuffer.
 */

// Header, Int32 slots: 0 active slot, 1 generation, 2 length of slot 0, 3 length of slot 1.
const H_ACTIVE = 0;
const H_GENERATION = 1;
const H_LENGTH_0 = 2;
const HEADER_INT32 = 4;
const HEADER_BYTES = HEADER_INT32 * 4;

/** Byte size of a buffer whose slots each hold `slotBytes`. */
export const snapshotBufferBytes = (slotBytes) => HEADER_BYTES + 2 * Math.max(1, slotBytes | 0);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const createSharedSnapshot = ({ buffer }) => {
	const i32 = new Int32Array(buffer, 0, HEADER_INT32);
	const bytes = new Uint8Array(buffer);
	const slotBytes = Math.floor((buffer.byteLength - HEADER_BYTES) / 2);
	const slotBase = (slot) => HEADER_BYTES + slot * slotBytes;

	return {
		slotBytes,

		/** Publish `document`. Returns `{ ok, bytes }`; `ok` is false when it does not fit a slot. */
		write(document) {
			const encoded = encoder.encode(JSON.stringify(document));
			if (encoded.length > slotBytes) return { ok: false, bytes: encoded.length };
			const target = Atomics.load(i32, H_ACTIVE) === 0 ? 1 : 0;
			bytes.set(encoded, slotBase(target));
			Atomics.store(i32, H_LENGTH_0 + target, encoded.length);
			Atomics.store(i32, H_ACTIVE, target);
			Atomics.add(i32, H_GENERATION, 1);
			return { ok: true, bytes: encoded.length };
		},

		/** The last published document, or null if none has been published (or it cannot be read). */
		read() {
			for (let attempt = 0; attempt < 3; attempt++) {
				const generation = Atomics.load(i32, H_GENERATION);
				if (generation === 0) return null;
				const slot = Atomics.load(i32, H_ACTIVE);
				const length = Atomics.load(i32, H_LENGTH_0 + slot);
				if (length <= 0 || length > slotBytes) return null;
				// `slice`, not `subarray`: a copy the writer cannot touch while it is decoded.
				const copy = bytes.slice(slotBase(slot), slotBase(slot) + length);
				if (Atomics.load(i32, H_GENERATION) !== generation) continue;
				try {
					return JSON.parse(decoder.decode(copy));
				} catch {
					return null;
				}
			}
			return null;
		},

		get generation() {
			return Atomics.load(i32, H_GENERATION);
		},
	};
};
