import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HTTPRequest, HTTPResponse } from 'puppeteer';
import type { ResolvedResourceCache } from './settings.js';
import logger from './util/Logger.js';

// The renderer aborts image/media/font requests before cache lookup, so only
// script/stylesheet ever reach the cache. Keeping this set tight makes the
// policy auditable.
const CACHEABLE_RESOURCE_TYPES = new Set(['stylesheet', 'script']);

// Stamped onto every cache-served response so the renderer's response handler
// can tell its own replay apart from a real network response and skip
// re-caching what we just synthesized.
export const CACHE_REPLAY_HEADER = 'x-render-resource-cache';

// Headers that must not be replayed when serving from cache. Includes hop-by-hop
// headers (RFC 7230 §6.1), set-cookie (never replay another response's cookies),
// content-encoding (we store the decoded body), and content-length (let the
// transport recompute it).
const NON_REPLAYABLE_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-encoding',
	'content-length',
	'set-cookie',
]);

// Defensive cap when parsing the meta length prefix off disk. Real meta is
// well under this; a header claiming gigabytes is a sign of corruption.
const MAX_META_BYTES = 1 << 16;

// Parallelism for the init-time disk walk. Bound by libuv's default thread
// pool, larger doesn't help.
const INIT_SCAN_CONCURRENCY = 8;

export type CacheMetadata = {
	url: string;
	status: number;
	headers: Record<string, string>;
	storedAt: number;
	expiresAt: number;
};

export type CacheEntry = CacheMetadata & {
	body: Buffer;
};

export type CachePolicy = {
	cacheable: boolean;
	ttlMs: number;
};

type IndexEntry = {
	expiresAt: number;
	size: number; // body byte length on disk
};

function filterReplayHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (!NON_REPLAYABLE_HEADERS.has(k.toLowerCase())) out[k] = v;
	}
	return out;
}

type ResourceCacheConfig = {
	dir: string;
	maxEntryBytes: number;
	maxTotalBytes: number;
	maxTtlMs: number;
	allowPrivateResponses: boolean;
};

export class ResourceCache {
	private dir: string;
	private maxEntryBytes: number;
	private maxTotalBytes: number;
	private maxTtlMs: number;
	private allowPrivateResponses: boolean;

	// Authoritative record of what's cached. Map insertion order doubles as LRU
	// order: get-hits re-insert to move to the tail, evictions pop the head.
	private index = new Map<string, IndexEntry>();
	private totalBytes = 0;

	// Tracks writes currently flushing to disk (prevents redundant parallel
	// writes for the same URL within this process) and pending evictions
	// (prevents a new write from racing with the unlink of a freshly-evicted
	// key).
	private inflightWrites = new Set<string>();
	private pendingUnlinks = new Map<string, Promise<void>>();

	// Shards we've already created in this process — skips the mkdir syscall
	// on every write after the first hit per shard.
	private knownShards = new Set<string>();

	// ready=false short-circuits get/set so a broken cache dir doesn't generate
	// per-request log noise or wasted IO.
	private ready = false;

	hits = 0;
	misses = 0;
	stores = 0;
	evictions = 0;
	indexedOnInit = 0;
	droppedOnInit = 0;

	constructor(config: ResourceCacheConfig) {
		this.dir = config.dir;
		this.maxEntryBytes = config.maxEntryBytes;
		this.maxTotalBytes = config.maxTotalBytes;
		this.maxTtlMs = config.maxTtlMs;
		this.allowPrivateResponses = config.allowPrivateResponses;
	}

	isCacheableRequest(req: HTTPRequest): boolean {
		if (req.method() !== 'GET') return false;
		if (req.isNavigationRequest()) return false;
		if (!CACHEABLE_RESOURCE_TYPES.has(req.resourceType())) return false;

		const headers = req.headers();
		// User-specific requests must not be served from a shared cache.
		if (headers['authorization'] || headers['cookie']) return false;

		return true;
	}

	getCachePolicy(res: HTTPResponse): CachePolicy {
		if (res.status() !== 200) return { cacheable: false, ttlMs: 0 };

		const headers = res.headers();

		// A response that sets cookies cannot be safely shared.
		if (headers['set-cookie']) return { cacheable: false, ttlMs: 0 };

		const cc = (headers['cache-control'] || '').toLowerCase();
		if (cc.includes('no-store') || cc.includes('no-cache')) {
			return { cacheable: false, ttlMs: 0 };
		}
		if (cc.includes('private') && !this.allowPrivateResponses) {
			return { cacheable: false, ttlMs: 0 };
		}

		// Vary indicates the response depends on request headers. Since our
		// cache key is the URL only, we refuse to cache anything that varies
		// on anything other than accept-encoding (which we already normalize
		// out by storing the decoded body).
		const vary = (headers['vary'] || '').toLowerCase();
		if (vary === '*') return { cacheable: false, ttlMs: 0 };
		if (vary) {
			for (const v of vary.split(',')) {
				if (v.trim() !== 'accept-encoding') return { cacheable: false, ttlMs: 0 };
			}
		}

		let ttlMs = 0;
		const maxAge = cc.match(/(?:^|[,\s])max-age=(\d+)/);
		if (maxAge) {
			ttlMs = parseInt(maxAge[1], 10) * 1000;
		} else if (headers['expires']) {
			const exp = Date.parse(headers['expires']);
			if (!isNaN(exp)) ttlMs = exp - Date.now();
		}

		if (ttlMs <= 0) return { cacheable: false, ttlMs: 0 };
		if (ttlMs > this.maxTtlMs) ttlMs = this.maxTtlMs;

		return { cacheable: true, ttlMs };
	}

	async init(): Promise<void> {
		try {
			await fs.mkdir(this.dir, { recursive: true });
			// Probe writability so we fail fast at startup instead of on every
			// first cacheable request.
			const probe = path.join(this.dir, `.probe.${randomBytes(4).toString('hex')}`);
			await fs.writeFile(probe, '');
			await fs.unlink(probe).catch(() => {});
		} catch (err) {
			this.ready = false;
			logger.error({ err, dir: this.dir }, 'resource cache disabled — init failed');
			return;
		}

		const startedAt = Date.now();
		await this.rebuildIndex();
		// After rebuild, the cache may be over cap (e.g. cap was lowered);
		// evict before serving traffic so steady state is bounded.
		await this.evictIfOverCap();
		this.ready = true;

		logger.info(
			{
				durationMs: Date.now() - startedAt,
				entries: this.index.size,
				bytes: this.totalBytes,
				indexedOnInit: this.indexedOnInit,
				droppedOnInit: this.droppedOnInit,
			},
			'resource cache index built'
		);
	}

	isReady(): boolean {
		return this.ready;
	}

	private keyFor(url: string): string {
		return createHash('sha256').update(url).digest('hex');
	}

	private pathsForKey(key: string): { dir: string; file: string } {
		const shard = key.substring(0, 2);
		const dir = path.join(this.dir, shard);
		return {
			dir,
			file: path.join(dir, `${key}.entry`),
		};
	}

	private async rebuildIndex(): Promise<void> {
		let shards: string[];
		try {
			shards = await fs.readdir(this.dir);
		} catch {
			return;
		}

		// Collect all file paths first, then process with bounded concurrency.
		const files: string[] = [];
		for (const shard of shards) {
			if (shard.length !== 2) continue;
			const shardDir = path.join(this.dir, shard);
			this.knownShards.add(shardDir);
			try {
				const entries = await fs.readdir(shardDir);
				for (const name of entries) {
					files.push(path.join(shardDir, name));
				}
			} catch {
				/* skip unreadable shard */
			}
		}

		// Worker loop pulling from a shared index — keeps INIT_SCAN_CONCURRENCY
		// reads in flight without spawning a promise per file.
		let cursor = 0;
		const worker = async () => {
			while (cursor < files.length) {
				const idx = cursor++;
				await this.indexFileOnInit(files[idx]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(INIT_SCAN_CONCURRENCY, files.length) }, worker));
	}

	private async indexFileOnInit(filePath: string): Promise<void> {
		const name = path.basename(filePath);

		// Any tmp file is orphaned from a prior crash — no in-flight writes
		// exist yet since we haven't admitted traffic.
		if (name.endsWith('.tmp')) {
			await fs.unlink(filePath).catch(() => {});
			this.droppedOnInit++;
			return;
		}

		if (!name.endsWith('.entry') || name.length !== 6 + 64) {
			// Not a recognized entry name — leave it alone.
			return;
		}
		const key = name.slice(0, 64);

		let fd: fs.FileHandle | null = null;
		try {
			const stat = await fs.stat(filePath);
			fd = await fs.open(filePath, 'r');

			const head = Buffer.alloc(4);
			const headRead = await fd.read(head, 0, 4, 0);
			if (headRead.bytesRead < 4) {
				await fd.close();
				fd = null;
				await fs.unlink(filePath).catch(() => {});
				this.droppedOnInit++;
				return;
			}
			const metaLen = head.readUInt32BE(0);
			if (metaLen === 0 || metaLen > MAX_META_BYTES || 4 + metaLen > stat.size) {
				await fd.close();
				fd = null;
				await fs.unlink(filePath).catch(() => {});
				this.droppedOnInit++;
				return;
			}

			const metaBuf = Buffer.alloc(metaLen);
			await fd.read(metaBuf, 0, metaLen, 4);
			await fd.close();
			fd = null;

			const meta = JSON.parse(metaBuf.toString('utf-8')) as CacheMetadata;
			if (meta.expiresAt < Date.now()) {
				await fs.unlink(filePath).catch(() => {});
				this.droppedOnInit++;
				return;
			}

			const bodySize = stat.size - 4 - metaLen;
			if (bodySize <= 0) {
				await fs.unlink(filePath).catch(() => {});
				this.droppedOnInit++;
				return;
			}

			this.index.set(key, { expiresAt: meta.expiresAt, size: bodySize });
			this.totalBytes += bodySize;
			this.indexedOnInit++;
		} catch {
			if (fd) await fd.close().catch(() => {});
			await fs.unlink(filePath).catch(() => {});
			this.droppedOnInit++;
		}
	}

	async get(url: string): Promise<CacheEntry | null> {
		if (!this.ready) return null;
		const key = this.keyFor(url);
		const indexEntry = this.index.get(key);

		if (!indexEntry) {
			this.misses++;
			return null;
		}

		if (indexEntry.expiresAt < Date.now()) {
			// Lazy expiry. Drop from index now; unlink in the background.
			this.removeFromIndex(key, indexEntry);
			this.unlinkInBackground(key);
			this.misses++;
			return null;
		}

		// Touch for LRU: re-insert moves the key to the tail.
		this.index.delete(key);
		this.index.set(key, indexEntry);

		const paths = this.pathsForKey(key);
		let buf: Buffer;
		try {
			buf = await fs.readFile(paths.file);
		} catch {
			// File vanished out from under us (manual rm, fs error). Drop the
			// stale index entry and report a miss.
			this.removeFromIndex(key, indexEntry);
			this.misses++;
			return null;
		}

		if (buf.length < 4) {
			this.removeFromIndex(key, indexEntry);
			this.unlinkInBackground(key);
			this.misses++;
			return null;
		}
		const metaLen = buf.readUInt32BE(0);
		const metaEnd = 4 + metaLen;
		if (metaEnd > buf.length) {
			this.removeFromIndex(key, indexEntry);
			this.unlinkInBackground(key);
			this.misses++;
			return null;
		}

		let meta: CacheMetadata;
		try {
			meta = JSON.parse(buf.toString('utf-8', 4, metaEnd)) as CacheMetadata;
		} catch {
			this.removeFromIndex(key, indexEntry);
			this.unlinkInBackground(key);
			this.misses++;
			return null;
		}

		this.hits++;
		// Buffer.from copies so the larger underlying buffer can be GC'd.
		return { ...meta, body: Buffer.from(buf.subarray(metaEnd)) };
	}

	async set(entry: CacheEntry): Promise<void> {
		if (!this.ready) return;
		if (entry.body.length === 0 || entry.body.length > this.maxEntryBytes) return;

		const key = this.keyFor(entry.url);

		// Wait for any pending eviction-unlink for this key so its delete
		// doesn't race with our rename.
		const pendingUnlink = this.pendingUnlinks.get(key);
		if (pendingUnlink) await pendingUnlink;

		if (this.inflightWrites.has(key)) return;
		this.inflightWrites.add(key);

		const paths = this.pathsForKey(key);
		const { body, ...meta } = entry;
		const metaBuf = Buffer.from(JSON.stringify(meta), 'utf-8');
		if (metaBuf.length > MAX_META_BYTES) {
			// Defensive — should never happen for legitimate responses.
			this.inflightWrites.delete(key);
			return;
		}
		// [4 bytes: meta length (uint32 BE)][meta JSON][body]. Written and
		// renamed as a single file so a reader either sees the whole prior
		// version or the whole new version — never a mix.
		const header = Buffer.alloc(4);
		header.writeUInt32BE(metaBuf.length, 0);
		const payload = Buffer.concat([header, metaBuf, body], 4 + metaBuf.length + body.length);

		const suffix = randomBytes(6).toString('hex');
		const tmp = `${paths.file}.${suffix}.tmp`;

		try {
			if (!this.knownShards.has(paths.dir)) {
				await fs.mkdir(paths.dir, { recursive: true });
				this.knownShards.add(paths.dir);
			}
			await fs.writeFile(tmp, payload);
			await fs.rename(tmp, paths.file);

			// Update the index. If this key was already cached, accounting
			// moves from old size → new size.
			const prior = this.index.get(key);
			if (prior) this.totalBytes -= prior.size;
			this.totalBytes += body.length;
			// Delete + re-set puts the key at the LRU tail.
			this.index.delete(key);
			this.index.set(key, { expiresAt: entry.expiresAt, size: body.length });

			this.stores++;
		} catch (err) {
			// ENOENT on the shard suggests a manual rm of the cache dir —
			// drop the memo so the next write recreates it.
			this.knownShards.delete(paths.dir);
			await fs.unlink(tmp).catch(() => {});
			logger.warn({ err, url: entry.url }, 'failed to write cache entry');
			return;
		} finally {
			this.inflightWrites.delete(key);
		}

		// Done outside the try so a partial-failure write doesn't trigger
		// eviction; only evict for entries successfully committed.
		await this.evictIfOverCap();
	}

	private removeFromIndex(key: string, indexEntry: IndexEntry): void {
		this.index.delete(key);
		this.totalBytes -= indexEntry.size;
	}

	private unlinkInBackground(key: string): void {
		const paths = this.pathsForKey(key);
		const p = fs
			.unlink(paths.file)
			.catch(() => {})
			.then(() => {
				this.pendingUnlinks.delete(key);
			});
		this.pendingUnlinks.set(key, p);
	}

	private async evictIfOverCap(): Promise<void> {
		if (this.totalBytes <= this.maxTotalBytes) return;
		const toEvict: string[] = [];
		for (const [key, entry] of this.index) {
			if (this.totalBytes <= this.maxTotalBytes) break;
			// Don't evict an entry whose own write is still in flight.
			if (this.inflightWrites.has(key)) continue;
			this.totalBytes -= entry.size;
			toEvict.push(key);
			this.evictions++;
		}
		for (const key of toEvict) {
			this.index.delete(key);
			this.unlinkInBackground(key);
		}
	}

	async delete(url: string): Promise<void> {
		const key = this.keyFor(url);
		const entry = this.index.get(key);
		if (entry) this.removeFromIndex(key, entry);
		this.unlinkInBackground(key);
	}

	toRespondPayload(entry: CacheEntry): {
		status: number;
		headers: Record<string, string>;
		body: Buffer;
	} {
		const headers = filterReplayHeaders(entry.headers);
		headers[CACHE_REPLAY_HEADER] = '1';
		return {
			status: entry.status,
			headers,
			body: entry.body,
		};
	}
}

// The active resource cache for this process. `startWorker` creates it from the
// resolved settings via initResourceCache(); the renderer reads it lazily.
let activeCache: ResourceCache | null = null;

export const getResourceCache = (): ResourceCache | null => activeCache;

/**
 * Create and initialize the resource cache from resolved settings (or disable it).
 * Sets the process-wide active cache and resolves once the on-disk index is built —
 * the entry point awaits this before the worker pulls jobs, so the first renders
 * don't run against an empty index while the disk is warm.
 */
export const initResourceCache = async (config: ResolvedResourceCache): Promise<ResourceCache | null> => {
	if (!config.enabled) {
		activeCache = null;
		return null;
	}
	const cache = new ResourceCache({
		dir: config.dir,
		maxEntryBytes: config.maxEntryBytes,
		maxTotalBytes: config.maxTotalBytes,
		maxTtlMs: config.maxTtlMs,
		allowPrivateResponses: config.allowPrivateResponses,
	});
	activeCache = cache;
	await cache.init().catch((err) => {
		logger.error({ err, dir: config.dir }, 'failed to initialize resource cache');
	});
	return cache;
};
