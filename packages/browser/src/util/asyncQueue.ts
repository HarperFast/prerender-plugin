/**
 * A bounded FIFO between one async producer and one async consumer: `put` waits while the queue is
 * at capacity, `take` waits while it is empty, and `close` releases both sides. The worker's prefetch
 * pipeline holds its claimed-and-prefetching jobs in one of these, so the worker never runs ahead of
 * its render slots by more than `capacity` claims — that bound is what keeps the lease exposure and
 * the memory held in prefetched documents small and predictable.
 */
export class BoundedAsyncQueue<T> {
	private items: T[] = [];
	private takers: Array<(item: T | undefined) => void> = [];
	private putters: Array<() => void> = [];
	private closed = false;

	private _capacity: number;

	constructor(capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error(`BoundedAsyncQueue: capacity must be a positive integer, got ${capacity}`);
		}
		this._capacity = capacity;
	}

	get capacity(): number {
		return this._capacity;
	}

	/**
	 * Raise the capacity by one and let a waiting producer through. The pool deepens itself when a
	 * consumer found its work not ready — see the prefetch pipeline: depth is only ever "enough" or
	 * "not yet", and the worker cannot know which from configuration alone.
	 */
	grow(): void {
		this._capacity++;
		this.putters.shift()?.();
	}

	get size(): number {
		return this.items.length;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Resolves once there is room for one more item, or the queue has been closed. */
	async waitForRoom(): Promise<void> {
		while (!this.closed && this.items.length >= this._capacity) {
			await new Promise<void>((resolve) => this.putters.push(resolve));
		}
	}

	/**
	 * Queue `item`, waiting while the queue is at capacity. Resolves true once queued; false when the
	 * queue closed first — the item was NOT queued, and the caller decides what that means for it.
	 */
	async put(item: T): Promise<boolean> {
		await this.waitForRoom();
		if (this.closed) return false;
		const taker = this.takers.shift();
		if (taker) taker(item);
		else this.items.push(item);
		return true;
	}

	/** The next item in order, waiting while the queue is empty; `undefined` once closed AND drained. */
	async take(): Promise<T | undefined> {
		if (this.items.length > 0) {
			const item = this.items.shift()!;
			// Room appeared: let one waiting producer through.
			this.putters.shift()?.();
			return item;
		}
		if (this.closed) return undefined;
		return new Promise<T | undefined>((resolve) => this.takers.push(resolve));
	}

	/**
	 * Stop accepting items. Waiting producers resolve false, waiting consumers resolve `undefined`;
	 * items already queued stay takeable so a consumer can drain them.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const resolve of this.takers.splice(0)) resolve(undefined);
		for (const resolve of this.putters.splice(0)) resolve();
	}
}
